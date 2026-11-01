import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Competition } from '../src/server/competition';
import type { Env } from '../src/server/env';
import { GAME_HOT_RETENTION_MS, type Game } from '../src/server/game';
import { maintainUnattendedGames } from '../src/server/maintenance';
import type { Actor, InitGame } from '../src/shared/protocol';
import { STOCKFISH_BUILD } from '../src/shared/engine';
import { activeGame, admitGameFixture, gamesAnswering, heldCompetition, holdAlarms, holdDelivery, intercept, patchBindings, player, privates } from './authority-helpers';

type Authority = DurableObjectStub<Competition>;
afterEach(() => vi.restoreAllMocks());

const authority = (settings: Partial<Env> = {}, existing?: Authority) =>
  heldCompetition({ ARENAS_ENABLED: 'false', TOURNAMENTS_ENABLED: 'false', RANKED_ENABLED: 'true', ...settings }, existing);

/** Parks every other ledger row so the four-per-minute recovery budget reaches only the rows under test. */
async function parkOtherAdmissions(keep: string[]) {
  const marks = keep.map(() => '?').join(',');
  for (const ledger of ['casual_game_admissions', 'tournament_game_admissions']) {
    await env.DB.prepare(`UPDATE ${ledger} SET archive_retry_at=? WHERE game_id NOT IN (${marks})`).bind(Date.now() + 86_400_000 * 30, ...keep).run();
  }
  await env.DB.prepare('DELETE FROM maintenance_budgets').run();
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
    await holdDelivery(game);
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
    await patchBindings(original, gamesAnswering(() => ({ init: async () => { throw new Error('lost_before_initialization'); } })));
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
    await holdDelivery(game);
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
    await holdAlarms(game, { AI_ENABLED: 'false' });
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
    let unknownGameCalls = 0;
    await patchBindings(competition, ({ GAME }) => ({ GAME: intercept(GAME, {
      idFromName: () => { unknownGameCalls++; throw new Error('unknown_game_allocation'); },
    }) }));
    expect(await competition.createCasualGame(actor, { id, format: 'blitz' })).toMatchObject({ ok: false, error: { code: 'SEAT_UNAVAILABLE' } });
    await authority({ ARENA_AUTHORITY_BYTE_LIMIT: '268435456', CASUAL_GAME_ID_LIMIT: '0' }, competition);
    expect(await competition.createCasualGame(actor, { id, format: 'blitz' })).toMatchObject({ ok: false, error: { code: 'SEAT_UNAVAILABLE' } });
    expect(unknownGameCalls).toBe(0);
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
    await holdDelivery(game);
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
    await holdDelivery(game);
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

  it('does not poll healthy games Competition already reconciles, and still recovers those that outlived every clock', async () => {
    const hour = 3_600_000;
    const now = Date.now();
    const rows = {
      legacyFresh: { ledger: 'casual_game_admissions', createdAt: now - 10_000, reservation: null },
      legacyHealthy: { ledger: 'casual_game_admissions', createdAt: now - 600_000, reservation: null },
      watchedHealthy: { ledger: 'casual_game_admissions', createdAt: now - 12 * hour, reservation: 'reservation' },
      watchedOverdue: { ledger: 'casual_game_admissions', createdAt: now - 25 * hour, reservation: 'reservation' },
      eventHealthy: { ledger: 'tournament_game_admissions', createdAt: now - 2 * hour, reservation: null },
      eventOverdue: { ledger: 'tournament_game_admissions', createdAt: now - 25 * hour, reservation: null },
    } as const;
    const ids = Object.fromEntries(Object.keys(rows).map(name => [name, crypto.randomUUID()]));
    for (const [name, row] of Object.entries(rows)) {
      if (row.ledger === 'casual_game_admissions') await env.DB.prepare('INSERT INTO casual_game_admissions(game_id,creator_id,created_at,reservation_id) VALUES(?,?,?,?)')
        .bind(ids[name], 'recovery-fixture', row.createdAt, row.reservation).run();
      else await env.DB.prepare('INSERT INTO tournament_game_admissions(game_id,tournament_id,created_at) VALUES(?,?,?)')
        .bind(ids[name], 'recovery-fixture', row.createdAt).run();
    }
    await parkOtherAdmissions(Object.values(ids));
    const polled = async () => {
      const found: string[] = [];
      for (const [name, row] of Object.entries(rows)) {
        const retry = await env.DB.prepare(`SELECT archive_retry_at FROM ${row.ledger} WHERE game_id=?`).bind(ids[name]).first<number>('archive_retry_at');
        if (retry! > 0) found.push(name);
      }
      return found.sort();
    };
    expect((await maintainUnattendedGames(env, now)).recovery).toMatchObject({ attempted: 3 });
    expect(await polled()).toEqual(['eventOverdue', 'legacyHealthy', 'watchedOverdue']);
    // Only the legacy game, once its adjudication wait has passed, joins them. Healthy admitted games never do.
    expect((await maintainUnattendedGames(env, now + 60_000)).recovery).toMatchObject({ attempted: 1 });
    expect(await polled()).toEqual(['eventOverdue', 'legacyFresh', 'legacyHealthy', 'watchedOverdue']);
  });

  it('settles a casual game whose alarm and Competition polling were lost once it is a day old', async () => {
    const competition = await authority();
    const actor = await player();
    const id = crypto.randomUUID();
    const created = await competition.createCasualGame(actor, { id, format: 'blitz' });
    expect(created).toMatchObject({ ok: true, created: true });
    const game = env.GAME.get(env.GAME.idFromName(id));
    await holdAlarms(game);
    await parkOtherAdmissions([id]);
    const admitted = await env.DB.prepare('SELECT created_at FROM casual_game_admissions WHERE game_id=?').bind(id).first<number>('created_at');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(admitted! + 2 * 60 * 60_000);
    // Past its readiness deadline, but Competition owns this game's recovery.
    expect((await maintainUnattendedGames(env)).recovery.attempted).toBe(0);
    expect(await env.DB.prepare('SELECT archive_retry_at FROM casual_game_admissions WHERE game_id=?').bind(id).first('archive_retry_at')).toBe(0);
    clock.mockReturnValue(admitted! + 25 * 60 * 60_000);
    expect((await maintainUnattendedGames(env)).recovery).toEqual({ attempted: 1, completed: 1, failed: 0 });
    expect(await game.status()).toMatchObject({ status: 'finished', result: { outcome: { reason: 'readiness-expired' } } });
  });

  it('abandons an admission whose Game never existed once it is older than any game, freeing its seats and keeping its ID', async () => {
    const now = Date.now();
    const [creator, opponent] = await Promise.all([player(), player()]);
    const rows = { casual: crypto.randomUUID(), event: crypto.randomUUID(), young: crypto.randomUUID() };
    await env.DB.batch([
      env.DB.prepare('INSERT INTO casual_game_admissions(game_id,creator_id,created_at) VALUES(?,?,?)').bind(rows.casual, creator.id, now - 25 * 3_600_000),
      env.DB.prepare('INSERT INTO casual_game_admissions(game_id,creator_id,created_at) VALUES(?,?,?)').bind(rows.young, creator.id, now - 2 * 3_600_000),
      env.DB.prepare('INSERT INTO tournament_game_admissions(game_id,tournament_id,created_at) VALUES(?,?,?)').bind(rows.event, 'abandon-fixture', now - 25 * 3_600_000),
      ...[[creator, rows.casual], [creator, rows.young], [creator, rows.event], [opponent, rows.event]].map(([actor, id]) =>
        env.DB.prepare('INSERT INTO active_game_seats(user_id,game_id,acquired_at) VALUES(?,?,?)').bind((actor as typeof creator).id, id, now - 25 * 3_600_000)),
    ]);
    await parkOtherAdmissions(Object.values(rows));
    const counts = () => env.DB.prepare("SELECT permanent_ids,retained_payloads FROM game_admission_counts WHERE kind='casual'").first<{ permanent_ids: number; retained_payloads: number }>();
    const before = await counts();
    expect((await maintainUnattendedGames(env, now)).recovery).toEqual({ attempted: 3, completed: 3, failed: 0 });
    const state = (ledger: string, id: string) => env.DB.prepare(`SELECT storage_state,archived_at,terminal_version FROM ${ledger} WHERE game_id=?`).bind(id).first();
    expect(await state('casual_game_admissions', rows.casual)).toEqual({ storage_state: 'archived', archived_at: now, terminal_version: null });
    expect(await state('tournament_game_admissions', rows.event)).toEqual({ storage_state: 'archived', archived_at: now, terminal_version: null });
    // A game that could still be young is only polled, never abandoned.
    expect(await state('casual_game_admissions', rows.young)).toEqual({ storage_state: 'retained', archived_at: null, terminal_version: null });
    const open = async (id: string) => await env.DB.prepare('SELECT COUNT(*) FROM active_game_seats WHERE game_id=? AND released_at IS NULL').bind(id).first('COUNT(*)');
    expect([await open(rows.casual), await open(rows.event), await open(rows.young)]).toEqual([0, 0, 1]);
    // Each permanent ID stays counted. Only the retained payload slots return.
    expect(await counts()).toEqual({ permanent_ids: before!.permanent_ids, retained_payloads: before!.retained_payloads - 1 });
    // The ID can never start a game, and only the still-young row is polled again.
    await runInDurableObject(env.GAME.get(env.GAME.idFromName(rows.casual)), async instance => {
      await expect((instance as Game).init({ id: rows.casual, format: 'blitz', rated: false, white: creator })).rejects.toThrow('casual_admission_required');
    });
    await env.DB.prepare('DELETE FROM maintenance_budgets').run();
    expect((await maintainUnattendedGames(env, now + 3_600_000)).recovery).toEqual({ attempted: 1, completed: 1, failed: 0 });
    expect(await state('casual_game_admissions', rows.casual)).toMatchObject({ archived_at: now });
  });

  it('keeps polling a Game that cannot be reached and abandons it only after an answered status call', async () => {
    const now = Date.now();
    const creator = await player();
    const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO casual_game_admissions(game_id,creator_id,created_at,reservation_id) VALUES(?,?,?,?)').bind(id, creator.id, now - 25 * 3_600_000, 'reservation').run();
    await env.DB.prepare('INSERT INTO active_game_seats(user_id,game_id,acquired_at) VALUES(?,?,?)').bind(creator.id, id, now - 25 * 3_600_000).run();
    await parkOtherAdmissions([id]);
    const unreachable = { ...env, GAME: { idFromName: (name: string) => env.GAME.idFromName(name),
      get: () => ({ status: async () => { throw new Error('unavailable'); } }) } } as unknown as Env;
    const held = async () => env.DB.prepare(`SELECT a.storage_state,s.released_at FROM casual_game_admissions a JOIN active_game_seats s ON s.game_id=a.game_id WHERE a.game_id=?`).bind(id).first();
    expect((await maintainUnattendedGames(unreachable, now)).recovery).toEqual({ attempted: 1, completed: 0, failed: 1 });
    expect(await held()).toEqual({ storage_state: 'retained', released_at: null });
    // The existing five-minute cooldown still applies, and no failure ever ends the row.
    expect((await maintainUnattendedGames(unreachable, now + 299_000)).recovery.attempted).toBe(0);
    expect((await maintainUnattendedGames(unreachable, now + 300_000)).recovery).toEqual({ attempted: 1, completed: 0, failed: 1 });
    expect(await held()).toEqual({ storage_state: 'retained', released_at: null });
    expect((await maintainUnattendedGames(env, now + 600_000)).recovery).toEqual({ attempted: 1, completed: 1, failed: 0 });
    expect(await held()).toEqual({ storage_state: 'archived', released_at: now + 600_000 });
  });

  it('leaves an old admission alone while its Game holds a started game', async () => {
    const { game, snapshot } = await activeGame();
    await env.DB.prepare('UPDATE casual_game_admissions SET created_at=? WHERE game_id=?').bind(Date.now() - 25 * 3_600_000, snapshot.id).run();
    await parkOtherAdmissions([snapshot.id]);
    const deadline = snapshot.clocks.deadline!;
    vi.spyOn(Date, 'now').mockReturnValue(deadline);
    expect((await maintainUnattendedGames(env, deadline)).recovery).toEqual({ attempted: 1, completed: 1, failed: 0 });
    expect(await env.DB.prepare('SELECT storage_state,terminal_version FROM casual_game_admissions WHERE game_id=?').bind(snapshot.id).first())
      .toEqual({ storage_state: 'retained', terminal_version: null });
    expect(await game.status()).toMatchObject({ status: 'finished', startedAt: snapshot.startedAt, result: { outcome: { reason: 'timeout-win' } } });
  });

  it('reads the legacy casual count for a new admission only, not when resuming a saved request', async () => {
    const competition = await authority();
    const actor = await player();
    const saved = crypto.randomUUID();
    const reservationId = crypto.randomUUID();
    await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec(`INSERT INTO casual_intents(game_id,creator_id,reservation_id,payload,state,created_at,next_at)
      VALUES(?,?,?,?,'admitting',?,?)`, saved, actor.id, reservationId, JSON.stringify({ id: saved, format: 'blitz', rated: false, white: actor, reservationId }), Date.now(), Date.now()));
    const reads = await runInDurableObject<Competition, { resumed: number; afterNew: number }>(competition, async instance => {
      const prepared = vi.spyOn(privates(instance).env.DB, 'prepare');
      const count = () => prepared.mock.calls.filter(([sql]) => sql.includes('legacy_live')).length;
      expect(await instance.createCasualGame(actor, { id: saved, format: 'blitz' })).toMatchObject({ ok: true, created: true });
      const resumed = count();
      expect(await instance.createCasualGame(actor, { id: crypto.randomUUID(), format: 'blitz' })).toMatchObject({ ok: true, created: true });
      return { resumed, afterNew: count() };
    });
    expect(reads).toEqual({ resumed: 0, afterNew: 1 });
  });
});
