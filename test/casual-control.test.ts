import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Competition } from '../src/server/competition';
import type { Env } from '../src/server/env';
import { GAME_HOT_RETENTION_MS, type Game } from '../src/server/game';
import type { Actor, InitGame } from '../src/shared/protocol';
import { STOCKFISH_BUILD } from '../src/shared/engine';
import { admitGameFixture, player } from './authority-helpers';

type Authority = DurableObjectStub<Competition>;
afterEach(() => vi.restoreAllMocks());

async function authority(settings: Partial<Env> = {}, existing?: Authority): Promise<Authority> {
  const stub = existing ?? env.COMPETITION.get(env.COMPETITION.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, async (instance, state) => {
    const internal = instance as unknown as { env: Env; schedule(): Promise<void> };
    internal.env = { ...internal.env, ARENAS_ENABLED: 'false', TOURNAMENTS_ENABLED: 'false', RANKED_ENABLED: 'true', ...settings };
    internal.schedule = async () => {};
    await state.storage.deleteAlarm();
  });
  return stub;
}

async function quiet(game: DurableObjectStub<Game>, settings: Partial<Env> = {}, suppressFlush = true): Promise<void> {
  await runInDurableObject(game, async (instance, state) => {
    const internal = instance as unknown as { env: Env; schedule(): Promise<void>; flush(): Promise<void> };
    internal.env = { ...internal.env, ...settings };
    internal.schedule = async () => {};
    if (suppressFlush) internal.flush = async () => {};
    await state.storage.deleteAlarm();
  });
}

describe('Competition-owned casual admission', () => {
  it('charges each permanent ID once and reclaims only retained payload capacity on repeated retirement', async () => {
    const before = await env.DB.prepare("SELECT permanent_ids,retained_payloads FROM game_admission_counts WHERE kind='tournament'")
      .first<{ permanent_ids: number; retained_payloads: number }>();
    const id = crypto.randomUUID();
    const insert = () => env.DB.prepare('INSERT OR IGNORE INTO tournament_game_admissions(game_id,tournament_id,created_at) VALUES(?,?,?)')
      .bind(id, 'counter-contract', Date.now()).run();
    await insert();
    await insert();
    expect(await env.DB.prepare("SELECT permanent_ids,retained_payloads FROM game_admission_counts WHERE kind='tournament'").first())
      .toEqual({ permanent_ids: before!.permanent_ids + 1, retained_payloads: before!.retained_payloads + 1 });
    for (let attempt = 0; attempt < 2; attempt++) await env.DB.prepare("UPDATE tournament_game_admissions SET storage_state='archived' WHERE game_id=?").bind(id).run();
    expect(await env.DB.prepare("SELECT permanent_ids,retained_payloads FROM game_admission_counts WHERE kind='tournament'").first())
      .toEqual({ permanent_ids: before!.permanent_ids + 1, retained_payloads: before!.retained_payloads });
  });

  it('holds one combined slot before initialization and releases it once with the verified terminal event', async () => {
    const competition = await authority({ ARENA_GAME_LIMIT: '1' });
    const [actor, other] = await Promise.all([player(), player()]);
    const id = crypto.randomUUID();
    await env.DB.prepare('UPDATE user SET name=? WHERE id=?').bind('Current server name', actor.id).run();
    const accepted = await competition.createCasualGame({ ...actor, name: 'Untrusted old name' }, { id, format: 'blitz' });
    expect(accepted).toMatchObject({ ok: true, created: true, snapshot: { id, white: { name: 'Current server name' } } });
    expect(await competition.createCasualGame(other, { id: crypto.randomUUID(), format: 'rapid' }))
      .toMatchObject({ ok: false, error: { code: 'SEAT_UNAVAILABLE' } });
    const game = env.GAME.get(env.GAME.idFromName(id));
    await quiet(game);
    expect(await competition.createCasualGame(actor, { id, format: 'rapid' }))
      .toMatchObject({ ok: true, created: false, snapshot: { id, format: 'blitz' } });
    const snapshot = accepted.ok ? accepted.snapshot : null;
    vi.spyOn(Date, 'now').mockReturnValue(snapshot!.readinessDeadline!);
    const result = (await game.status())!.result!;
    expect(result.outcome).toMatchObject({ score: null, reason: 'readiness-expired' });
    for (let attempt = 0; attempt < 3; attempt++) expect(await competition.settle(result)).toEqual({ accepted: true, pending: false });
    const status = await competition.health();
    expect(status.casuals.unfinished).toBe(0);
    expect(await competition.createCasualGame(other, { id: crypto.randomUUID(), format: 'rapid' })).toMatchObject({ ok: true });
  });

  it('refuses to reopen a finished game whose payload was archived before D1 recorded the tombstone', async () => {
    const competition = env.COMPETITION.get(env.COMPETITION.idFromName('global'));
    const actor = await player();
    const id = crypto.randomUUID();
    const created = await competition.createCasualGame(actor, { id, format: 'blitz' });
    expect(created).toMatchObject({ ok: true, created: true });
    const game = env.GAME.get(env.GAME.idFromName(id));
    const clock = vi.spyOn(Date, 'now').mockReturnValue(created.ok ? created.snapshot.readinessDeadline! : 0);
    const result = (await game.status())!.result!;
    await game.flush();
    await competition.flush();
    clock.mockReturnValue(result.endedAt + GAME_HOT_RETENTION_MS);
    await game.archive({ gameId: id, expectedVersion: result.version, terminalDigest: result.terminalDigest });
    expect(await env.DB.prepare('SELECT storage_state FROM casual_game_admissions WHERE game_id=?').bind(id).first('storage_state')).toBe('retained');
    expect(await competition.createCasualGame(actor, { id, format: 'blitz' }))
      .toMatchObject({ ok: false, error: { status: 410, code: 'GAME_ARCHIVED' } });
  });

  it('recovers an accepted uninitialized game after restart and stops without changing its ID, reservation or deadline', async () => {
    const original = await authority();
    const actor = await player();
    const id = crypto.randomUUID();
    await runInDurableObject(original, instance => {
      const internal = instance as unknown as { env: Env };
      const namespace = internal.env.GAME;
      internal.env = { ...internal.env, GAME: {
        idFromName: (name: string) => namespace.idFromName(name),
        get: (gameId: DurableObjectId) => {
          const game = namespace.get(gameId);
          return new Proxy(game, { get(target, property) {
            if (property === 'init') return async () => { throw new Error('lost_before_initialization'); };
            const value = Reflect.get(target, property);
            return typeof value === 'function' ? (...args: unknown[]) => Reflect.apply(value, target, args) : value;
          } });
        },
      } as unknown as Env['GAME'] };
    });
    expect(await original.createCasualGame(actor, { id, format: 'blitz' }))
      .toMatchObject({ ok: false, error: { status: 503, code: 'GAME_INITIALIZATION_PENDING' } });
    const admission = await env.DB.prepare('SELECT reservation_id,created_at FROM casual_game_admissions WHERE game_id=?')
      .bind(id).first<{ reservation_id: string; created_at: number }>();
    expect(admission?.reservation_id).toBeTruthy();
    expect((await original.health()).casuals).toMatchObject({ unfinished: 1, retrying: 1 });
    await evictDurableObject(original);
    const competition = await authority({ NEW_WORK_STOPPED: 'true', CASUAL_GAME_LIMIT: '0', CASUAL_GAME_ID_LIMIT: '0', ARENA_GAME_LIMIT: '0' }, original);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(admission!.created_at + 2_000);
    await competition.maintenance();
    const result = await competition.createCasualGame(actor, { id, format: 'blitz' });
    expect(result).toMatchObject({ ok: true, created: false, snapshot: { id, status: 'waiting', readinessDeadline: admission!.created_at + 600_000 } });
    const game = env.GAME.get(env.GAME.idFromName(id));
    await quiet(game);
    expect(await env.DB.prepare('SELECT reservation_id FROM casual_game_admissions WHERE game_id=?').bind(id).first('reservation_id')).toBe(admission!.reservation_id);
    expect(await competition.createCasualGame(actor, { id: crypto.randomUUID(), format: 'blitz' })).toMatchObject({ ok: false });
    clock.mockReturnValue(admission!.created_at + 600_000);
    await competition.maintenance();
    expect((await game.status())!.status).toBe('finished');
    expect((await competition.health()).casuals.unfinished).toBe(0);
  });

  it('refuses new disabled practice while finishing a legacy accepted computer admission and releasing its capacity', async () => {
    const competition = await authority({ AI_ENABLED: 'false' });
    const refusedId = crypto.randomUUID();
    const ai = { modelId: STOCKFISH_BUILD, level: 'club' } as const;
    expect(await competition.createCasualGame(await player(), { id: refusedId, format: 'blitz', ai }))
      .toMatchObject({ ok: false, error: { code: 'AI_UNAVAILABLE' } });
    expect(await env.DB.prepare('SELECT 1 FROM casual_game_admissions WHERE game_id=?').bind(refusedId).first()).toBeNull();
    expect((await competition.health()).casuals.unfinished).toBe(0);

    const actor = await player(true);
    const id = crypto.randomUUID();
    await admitGameFixture({ id, format: 'blitz', rated: false, white: actor, ai });
    await env.DB.prepare('INSERT INTO active_game_seats(user_id,game_id,acquired_at) VALUES(?,?,?)').bind(actor.id, id, Date.now()).run();
    const before = await env.DB.prepare("SELECT legacy_live FROM game_admission_counts WHERE kind='casual'").first<number>('legacy_live');
    const game = env.GAME.get(env.GAME.idFromName(id));
    await quiet(game, { AI_ENABLED: 'false' }, false);
    await authority({ NEW_WORK_STOPPED: 'true', CASUAL_GAME_LIMIT: '0', CASUAL_GAME_ID_LIMIT: '0', ARENA_GAME_LIMIT: '0' }, competition);
    expect(await competition.createCasualGame(actor, { id, format: 'blitz', ai }))
      .toMatchObject({ ok: true, created: false, snapshot: { status: 'finished', outcome: { reason: 'ai-unavailable', score: null } } });
    expect((await competition.health()).casuals.unfinished).toBe(0);
    expect(await env.DB.prepare('SELECT reservation_id FROM casual_game_admissions WHERE game_id=?').bind(id).first('reservation_id')).toBeNull();
    await game.flush();
    expect(await env.DB.prepare('SELECT released_at FROM active_game_seats WHERE user_id=? AND game_id=?').bind(actor.id, id).first('released_at')).not.toBeNull();
    expect(await env.DB.prepare("SELECT legacy_live FROM game_admission_counts WHERE kind='casual'").first('legacy_live')).toBe(before! - 1);
  });

  it('rejects a forged creator, byte exhaustion and permanent-cap refusal before allocating an unknown Game', async () => {
    const actor = await player();
    const competition = await authority({ ARENA_AUTHORITY_BYTE_LIMIT: '1' });
    const id = crypto.randomUUID();
    expect(await competition.createCasualGame({ ...actor, id: crypto.randomUUID() }, { id, format: 'blitz' }))
      .toMatchObject({ ok: false, error: { code: 'SIGN_IN_REQUIRED' } });
    await runInDurableObject(competition, instance => {
      const internal = instance as unknown as { env: Env; unknownGameCalls: number };
      internal.unknownGameCalls = 0;
      internal.env = { ...internal.env, GAME: { idFromName: () => { internal.unknownGameCalls++; throw new Error('unknown_game_allocation'); } } as unknown as Env['GAME'] };
    });
    expect(await competition.createCasualGame(actor, { id, format: 'blitz' })).toMatchObject({ ok: false, error: { code: 'SEAT_UNAVAILABLE' } });
    await authority({ ARENA_AUTHORITY_BYTE_LIMIT: '268435456', CASUAL_GAME_ID_LIMIT: '0' }, competition);
    expect(await competition.createCasualGame(actor, { id, format: 'blitz' })).toMatchObject({ ok: false, error: { code: 'SEAT_UNAVAILABLE' } });
    expect(await runInDurableObject(competition, instance => (instance as unknown as { unknownGameCalls: number }).unknownGameCalls)).toBe(0);
    expect(await env.DB.prepare('SELECT 1 FROM casual_game_admissions WHERE game_id=?').bind(id).first()).toBeNull();
    expect((await competition.health()).casuals.unfinished).toBe(0);
  });

  it('keeps legacy games accessible at stops and counts their seats without counting an opponent twice', async () => {
    const [actor, other] = await Promise.all([player(true), player(true)]);
    const id = crypto.randomUUID();
    const input: InitGame = { id, format: 'blitz', rated: false, white: actor, black: other };
    await admitGameFixture(input);
    await env.DB.batch([actor, other].map(person => env.DB.prepare('INSERT INTO active_game_seats(user_id,game_id,acquired_at) VALUES(?,?,?)')
      .bind(person.id, id, Date.now())));
    const count = await env.DB.prepare("SELECT legacy_live FROM game_admission_counts WHERE kind='casual'").first<number>('legacy_live');
    expect(count).toBeGreaterThanOrEqual(1);
    const game = env.GAME.get(env.GAME.idFromName(id));
    await game.init(input);
    await quiet(game);
    const competition = await authority({ ARENA_GAME_LIMIT: String(count), NEW_WORK_STOPPED: 'true', CASUAL_GAME_LIMIT: '0' });
    expect(await competition.createCasualGame(actor, { id, format: 'rapid' })).toMatchObject({ ok: true, snapshot: { id, format: 'blitz' } });
    await authority({ NEW_WORK_STOPPED: 'false' }, competition);
    expect(await competition.createCasualGame(await player(), { id: crypto.randomUUID(), format: 'blitz' })).toMatchObject({ ok: false, error: { code: 'SEAT_UNAVAILABLE' } });
    await env.DB.prepare('UPDATE active_game_seats SET released_at=? WHERE user_id=? AND game_id=?').bind(Date.now(), actor.id, id).run();
    expect(await env.DB.prepare("SELECT legacy_live FROM game_admission_counts WHERE kind='casual'").first('legacy_live')).toBe(count);
    await env.DB.prepare('UPDATE active_game_seats SET released_at=? WHERE user_id=? AND game_id=?').bind(Date.now(), other.id, id).run();
    expect(await env.DB.prepare("SELECT legacy_live FROM game_admission_counts WHERE kind='casual'").first('legacy_live')).toBe(count! - 1);
  });

  it('requires the accepted D1 reservation and refuses archived IDs before creating casual state', async () => {
    const actor = await player();
    const id = crypto.randomUUID();
    const game = env.GAME.get(env.GAME.idFromName(id));
    const input: InitGame = { id, format: 'blitz', rated: false, white: actor, reservationId: crypto.randomUUID() };
    await quiet(game);
    await runInDurableObject(game, async instance => {
      await expect((instance as Game).init(input)).rejects.toThrow('casual_admission_required');
    });
    await admitGameFixture(input);
    await runInDurableObject(game, async instance => {
      await expect((instance as Game).init({ ...input, reservationId: crypto.randomUUID() })).rejects.toThrow('casual_admission_required');
    });
    await env.DB.prepare("UPDATE casual_game_admissions SET storage_state='archived' WHERE game_id=?").bind(id).run();
    await runInDurableObject(game, async instance => {
      await expect((instance as Game).init(input)).rejects.toThrow('casual_admission_required');
    });
    expect(await game.status()).toBeNull();
  });
});
