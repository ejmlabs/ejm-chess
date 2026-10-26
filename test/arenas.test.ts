import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireSeatGuard, hasActiveSeat } from '../src/server/auth';
import { ARENA_POLICY, arenaLimits } from '../src/server/arena-policy';
import { bindIsolatedGameBudget } from '../src/server/capacity-policy';
import { readArenaStandings, readArenaSummary } from '../src/server/arena-projection';
import type { Competition } from '../src/server/competition';
import type { Env } from '../src/server/env';
import type { Actor, GameResult, GameSnapshot } from '../src/shared/protocol';
import type { ArenaActionResult, ArenaMe, ArenaStanding } from '../src/shared/arenas';
import { player } from './authority-helpers';

type Authority = DurableObjectStub<Competition>;
const HOUR = 3_600_000;
let index = 0;
afterEach(() => vi.restoreAllMocks());

async function authority(settings: Partial<Env> = {}, existing?: Authority): Promise<Authority> {
  const stub = existing ?? env.COMPETITION.get(env.COMPETITION.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, async (instance, state) => {
    const internal = instance as unknown as { env: Env; schedule(): Promise<void> };
    internal.env = { ...internal.env, ARENAS_ENABLED: 'true', TOURNAMENTS_ENABLED: 'false', RANKED_ENABLED: 'true', ...settings };
    internal.schedule = async () => {};
    await state.storage.deleteAlarm();
  });
  return stub;
}

function value(result: ArenaActionResult): ArenaMe {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

async function prepare(count = 4, settings: Partial<Env> = {}) {
  const startsAt = Math.ceil(Date.now() / HOUR) * HOUR + ++index * 4 * HOUR;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(startsAt - 10 * 60_000);
  const competition = await authority(settings);
  const actors = await Promise.all(Array.from({ length: count }, () => player(false, { recoveryEmail: false })));
  const id = `arena-hourly-${startsAt}`;
  for (const [index, actor] of actors.entries()) {
    if (index >= ARENA_POLICY.registrationBurst) {
      clock.mockReturnValue(startsAt - 10 * 60_000 + (index - ARENA_POLICY.registrationBurst + 1) * 67);
    }
    value(await competition.registerArena(actor, id));
  }
  return { competition, actors, id, startsAt, clock };
}

async function games(competition: Authority, actors: Actor[], id: string) {
  const states = await Promise.all(actors.map(actor => competition.getArenaMe(actor, id)));
  return [...new Set(states.flatMap(state => state?.gameId ? [state.gameId] : []))];
}

async function game(gameId: string, actors: Actor[]) {
  const stub = env.GAME.get(env.GAME.idFromName(gameId));
  await runInDurableObject(stub, async (instance, state) => {
    const internal = instance as unknown as { schedule(): Promise<void>; flush(): Promise<void> };
    // The test explicitly delivers each authority result and can inject retries.
    internal.schedule = async () => {};
    internal.flush = async () => {};
    await state.storage.deleteAlarm();
  });
  const first = await stub.snapshot(actors[0]);
  const white = actors.find(actor => actor.id === first.white.id)!;
  const black = actors.find(actor => actor.id === first.black!.id)!;
  return { stub, white, black, snapshot: first };
}

async function ready(gameId: string, actors: Actor[]) {
  // snapshot requires a participant, found from the private authority's seats.
  const stub = env.GAME.get(env.GAME.idFromName(gameId));
  let participant: Actor | undefined;
  await runInDurableObject(stub, (instance) => {
    const state = (instance as unknown as { load(): { white: { id: string } } }).load();
    participant = actors.find(actor => actor.id === state.white.id);
  });
  const context = await game(gameId, [participant!, ...actors.filter(actor => actor.id !== participant!.id)]);
  let snapshot: GameSnapshot = context.snapshot;
  for (const actor of [context.white, context.black]) {
    const reply = await context.stub.command(actor, { type: 'ready', id: crypto.randomUUID(), expectedVersion: snapshot.version });
    if (!reply.ok) throw new Error(reply.code);
    snapshot = reply.snapshot;
  }
  return { ...context, snapshot };
}

async function draw(gameId: string, actors: Actor[], competition: Authority, deliver = true): Promise<GameResult> {
  const context = await ready(gameId, actors);
  let snapshot = context.snapshot;
  for (const [actor, type] of [[context.white, 'offer-draw'], [context.black, 'accept-draw']] as const) {
    const reply = await context.stub.command(actor, { type, id: crypto.randomUUID(), expectedVersion: snapshot.version });
    if (!reply.ok) throw new Error(reply.code);
    snapshot = reply.snapshot;
  }
  const result = (await context.stub.status())!.result!;
  if (deliver) {
    expect(await competition.settle(result)).toEqual({ accepted: true, pending: false });
    await competition.flush();
  }
  return result;
}

async function publish(competition: Authority, clock: ReturnType<typeof vi.spyOn>, advance = true) {
  if (advance) clock.mockReturnValue(Date.now() + 11_000);
  for (let pass = 0; pass < 32; pass++) await competition.maintenance();
}

async function standings(id: string) {
  const rows: ArenaStanding[] = [];
  let cursor: string | null = null;
  let generation = 0;
  do {
    const page = await readArenaStandings(env.DB, id, cursor);
    if (!page) throw new Error('Expected a complete standings generation.');
    if (generation) expect(page.generation).toBe(generation);
    generation = page.generation;
    expect(page.standings.length).toBeLessThanOrEqual(50);
    expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(32 * 1024);
    rows.push(...page.standings);
    cursor = page.nextCursor;
  } while (cursor);
  return { rows, generation };
}

describe('timed arena authority', () => {
  it('skips maintenance for unchanged arena registrations and retries while preserving newly created work', async () => {
    const startsAt = Math.ceil(Date.now() / HOUR) * HOUR + ++index * 4 * HOUR;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(startsAt - 600_000);
    const competition = await authority();
    const [actor, retrying, waiting] = await Promise.all(Array.from({ length: 3 }, () => player(false, { recoveryEmail: false })));
    const id = `arena-hourly-${startsAt}`;
    await runInDurableObject<Competition, void>(competition, async (instance, state) => {
      const internal = instance as unknown as { env: Env; schedule(): Promise<void> };
      const schedule = vi.spyOn(internal, 'schedule').mockResolvedValue();
      const sync = vi.spyOn(state.storage, 'sync');
      const prepare = vi.spyOn(internal.env.DB, 'prepare');
      try {
        expect(value(await instance.registerArena(actor, id)).registered).toBe(true);
        expect(schedule).toHaveBeenCalledOnce();
        schedule.mockClear(); sync.mockClear();
        const changes = state.storage.sql.exec<{ value: number }>('SELECT total_changes() AS value').one().value;
        expect(value(await instance.registerArena(actor, id)).registered).toBe(true);
        expect(state.storage.sql.exec<{ value: number }>('SELECT total_changes() AS value').one().value).toBe(changes);
        expect(sync).not.toHaveBeenCalled();
        expect(schedule).not.toHaveBeenCalled();

        const refreshed = { ...actor, sessionExpiresAt: actor.sessionExpiresAt + 1_000 };
        expect(value(await instance.registerArena(refreshed, id)).registered).toBe(true);
        expect(state.storage.sql.exec<{ actor: string }>('SELECT actor FROM arena_entries WHERE event_id=? AND user_id=?', id, actor.id).one().actor).toBe(JSON.stringify(refreshed));
        expect(sync).toHaveBeenCalledOnce();
        expect(schedule).not.toHaveBeenCalled();
        sync.mockClear();
        const renamed = { ...refreshed, name: 'Renamed player' };
        expect(value(await instance.registerArena(renamed, id)).registered).toBe(true);
        expect(sync).toHaveBeenCalledOnce();
        expect(schedule).toHaveBeenCalledOnce();
        schedule.mockClear(); sync.mockClear(); prepare.mockClear();

        const lastAcceptedAt = Date.now();
        state.storage.sql.exec("UPDATE arena_tokens SET tokens=0,updated_at=? WHERE kind='registration'", lastAcceptedAt);
        const beforeRetry = state.storage.sql.exec<{ value: number }>('SELECT total_changes() AS value').one().value;
        expect(await instance.registerArena(retrying, id)).toMatchObject({ ok: false, error: { status: 429, code: 'ARENA_RETRY' } });
        expect(state.storage.sql.exec<{ value: number }>('SELECT total_changes() AS value').one().value).toBe(beforeRetry);
        expect(sync).not.toHaveBeenCalled();
        expect(schedule).not.toHaveBeenCalled();
        expect(prepare).not.toHaveBeenCalled();
        expect(state.storage.sql.exec('SELECT 1 FROM arena_entries WHERE event_id=? AND user_id=?', id, retrying.id).toArray()).toEqual([]);
        expect(value(await instance.registerArena(renamed, id)).registered).toBe(true);
        expect(sync).not.toHaveBeenCalled();
        expect(schedule).not.toHaveBeenCalled();
        prepare.mockClear();
        const unused = state.storage.sql.exec<{ id: string }>('SELECT id FROM arena_events WHERE id<>? LIMIT 1', id).one().id;
        state.storage.sql.exec('DELETE FROM arena_events WHERE id=?', unused);
        expect(await instance.registerArena(retrying, id)).toMatchObject({ ok: false, error: { status: 429, code: 'ARENA_RETRY' } });
        expect(schedule).not.toHaveBeenCalled();
        expect(prepare).not.toHaveBeenCalled();
        expect(state.storage.sql.exec('SELECT 1 FROM arena_events WHERE id=?', unused).toArray()).toHaveLength(0);
        const beforeRefill = state.storage.sql.exec<{ value: number }>('SELECT total_changes() AS value').one().value;
        clock.mockReturnValue(lastAcceptedAt + 19);
        expect(await instance.registerArena(retrying, id)).toMatchObject({ ok: false, error: { status: 429, code: 'ARENA_RETRY' } });
        expect(state.storage.sql.exec<{ value: number }>('SELECT total_changes() AS value').one().value).toBe(beforeRefill);
        expect(state.storage.sql.exec("SELECT tokens,updated_at FROM arena_tokens WHERE kind='registration'").one()).toEqual({ tokens: 0, updated_at: lastAcceptedAt });
        clock.mockReturnValue(lastAcceptedAt + 20);
        expect(value(await instance.registerArena(retrying, id)).registered).toBe(true);
        expect(schedule).toHaveBeenCalledOnce();
        expect(state.storage.sql.exec('SELECT 1 FROM arena_events WHERE id=?', unused).toArray()).toHaveLength(1);
        expect(state.storage.sql.exec<{ tokens: number }>("SELECT tokens FROM arena_tokens WHERE kind='registration'").one().tokens).toBe(0);
        const afterRefill = state.storage.sql.exec<{ value: number }>('SELECT total_changes() AS value').one().value;
        expect(await instance.registerArena(waiting, id)).toMatchObject({ ok: false, error: { status: 429, code: 'ARENA_RETRY' } });
        clock.mockReturnValue(lastAcceptedAt + 10);
        expect(await instance.registerArena(waiting, id)).toMatchObject({ ok: false, error: { status: 429, code: 'ARENA_RETRY' } });
        expect(state.storage.sql.exec<{ value: number }>('SELECT total_changes() AS value').one().value).toBe(afterRefill);
      } finally {
        schedule.mockRestore(); sync.mockRestore(); prepare.mockRestore();
      }
    });
  });

  it('rechecks session ownership, credentials, restrictions and expiry before registering or queuing', async () => {
    const { competition, id, clock } = await prepare(0);
    const actors = await Promise.all(Array.from({ length: 5 }, () => player(false, { recoveryEmail: false })));
    const now = Date.now(), caseId = crypto.randomUUID(), decisionId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM session WHERE id=?').bind(actors[0].sessionId),
      env.DB.prepare('DELETE FROM account WHERE userId=?').bind(actors[1].id),
      env.DB.prepare('INSERT INTO fairplay_cases(id,subject_id,game_id,created_at,updated_at) VALUES(?,?,?,?,?)')
        .bind(caseId, actors[3].id, crypto.randomUUID(), now, now),
      env.DB.prepare(`INSERT INTO fairplay_decisions(id,case_id,subject_id,reviewer_id,outcome,reason,review_note,corroboration,evidence_ids,request_hash,created_at,appeal_until)
        VALUES(?,?,?,?,'restrict','A reviewed temporary restriction.','','','[]','fixture',?,?)`)
        .bind(decisionId, caseId, actors[3].id, actors[4].id, now, now + 86_400_000),
      env.DB.prepare('INSERT INTO restrictions(id,user_id,case_id,decision_id,reason,starts_at,expires_at) VALUES(?,?,?,?,?,?,?)')
        .bind(decisionId, actors[3].id, caseId, decisionId, 'A reviewed temporary restriction.', now, now + 60_000),
    ]);
    await runInDurableObject<Competition, void>(competition, async (instance, state) => {
      const wrongOwner = { ...actors[4], sessionId: actors[3].sessionId };
      for (const actor of [actors[0], actors[1], actors[3], wrongOwner]) {
        expect(await instance.registerArena(actor, id)).toMatchObject({ ok: false, error: { code: 'ARENA_INELIGIBLE' } });
        expect(await instance.queueArena(actor, id)).toMatchObject({ ok: false, error: { code: 'ARENA_INELIGIBLE' } });
      }
      const pending = instance.registerArena({ ...actors[2], sessionExpiresAt: now + 1 }, id);
      clock.mockReturnValue(now + 2);
      expect(await pending).toMatchObject({ ok: false, error: { code: 'ARENA_INELIGIBLE' } });
      expect(state.storage.sql.exec('SELECT 1 FROM arena_entries').toArray()).toEqual([]);
      expect(state.storage.sql.exec<{ tokens: number }>("SELECT tokens FROM arena_tokens WHERE kind='registration'").one().tokens).toBe(95_000);
      await expect(instance.getArenaMe(actors[0], id)).rejects.toMatchObject({ status: 401, code: 'SIGN_IN_REQUIRED' });
      await env.DB.prepare('UPDATE restrictions SET revoked_at=? WHERE id=?').bind(Date.now(), decisionId).run();
      expect(value(await instance.registerArena(actors[3], id)).registered).toBe(true);
      expect(value(await instance.queueArena(actors[3], id)).state).toBe('reserving');
    });
  });

  it('starts budget preflight before eligibility returns and keeps account errors first', async () => {
    const { competition, id } = await prepare(0);
    const actor = await player(false, { recoveryEmail: false });
    const databaseError = new Error('eligibility read unavailable');
    await runInDurableObject<Competition, void>(competition, async (instance, state) => {
      const internal = instance as unknown as { env: Env };
      const database = internal.env.DB;
      const originalPrepare = database.prepare.bind(database);
      for (const [eligible, available, code] of [
        [false, new Error('controller unavailable'), 'ARENA_INELIGIBLE'],
        [true, new Error('controller unavailable'), 'BUDGET_UNAVAILABLE'],
        [databaseError, false, null],
      ] as const) {
        let release!: () => void;
        const paused = new Promise<void>(resolve => { release = resolve; });
        const readEligibility = vi.fn(async () => {
          await paused;
          if (eligible instanceof Error) throw eligible;
          return eligible ? { expiresAt: new Date(actor.sessionExpiresAt).toISOString(), accountReady: 1, restricted: 0 } : null;
        });
        const prepare = vi.spyOn(database, 'prepare').mockImplementation(query => query.startsWith('SELECT s.expiresAt,')
          ? { bind: () => ({ first: readEligibility }) } as unknown as D1PreparedStatement : originalPrepare(query));
        const readAvailability = vi.fn(async () => {
          await paused;
          if (available instanceof Error) throw available;
          return available;
        });
        internal.env = { ...internal.env };
        bindIsolatedGameBudget(internal.env, { manifestDigest: 'a'.repeat(64), maximum: 20_000,
          available: readAvailability, reserve: async () => true });
        const pending = instance.registerArena(actor, id).then(value => ({ value }), error => ({ error }));
        let result: Awaited<typeof pending>;
        try {
          await vi.waitFor(() => {
            expect(readEligibility).toHaveBeenCalledOnce();
            expect(readAvailability).toHaveBeenCalledOnce();
          }, { timeout: 500, interval: 1 });
        } finally { release(); result = await pending; prepare.mockRestore(); }
        if (code) expect(result).toMatchObject({ value: { ok: false, error: { code } } });
        else expect(result).toEqual({ error: databaseError });
      }
      expect(state.storage.sql.exec('SELECT 1 FROM arena_entries').toArray()).toEqual([]);
      expect(state.storage.sql.exec<{ tokens: number }>("SELECT tokens FROM arena_tokens WHERE kind='registration'").one().tokens)
        .toBe((ARENA_POLICY.registrationBurst - 3) * 1_000);
    });
  });

  it('sheds excess new registrations without queuing, preserves confirmations and releases failed slots', async () => {
    const { competition, id, startsAt, clock } = await prepare(0, { ARENA_ENTRANT_LIMIT: '2000' });
    const [existing, waiting, ...actors] = await Promise.all(Array.from({ length: 5 }, () => player(false, { recoveryEmail: false })));
    value(await competition.registerArena(existing, id));
    const databaseError = new Error('registration check unavailable');
    await runInDurableObject<Competition, void>(competition, async (instance, state) => {
      const internal = instance as unknown as { env: Env; schedule(): Promise<void> };
      const database = internal.env.DB, originalPrepare = database.prepare.bind(database);
      for (const [offset, mode] of ['eligibility-failure', 'sync-failure', 'success'].entries()) {
        const firstAt = startsAt - 10 * 60_000 + offset * 10_000;
        clock.mockReturnValue(firstAt);
        const actor = actors[offset];
        let release!: () => void;
        const paused = new Promise<void>(resolve => { release = resolve; });
        const readEligibility = vi.fn(async (userId: string) => {
          if (userId !== existing.id) {
            await paused;
            if (mode === 'eligibility-failure') throw databaseError;
          }
          return { expiresAt: new Date(actor.sessionExpiresAt).toISOString(), accountReady: 1, restricted: 0 };
        });
        const prepare = vi.spyOn(database, 'prepare').mockImplementation(query => query.startsWith('SELECT s.expiresAt,')
          ? { bind: (...args: unknown[]) => ({ first: () => readEligibility(args[2] as string) }) } as unknown as D1PreparedStatement
          : originalPrepare(query));
        const sync = vi.spyOn(state.storage, 'sync');
        if (mode === 'sync-failure') sync.mockRejectedValueOnce(databaseError);
        const schedule = vi.spyOn(internal, 'schedule').mockResolvedValue();
        const pending = Array.from({ length: ARENA_POLICY.registrationConcurrency }, (_, index) => {
          clock.mockReturnValue(firstAt + index * 67);
          return instance.registerArena(actor, id).then(value => ({ value }), error => ({ error }));
        });
        let results: Awaited<typeof pending[number]>[];
        try {
          await vi.waitFor(() => expect(readEligibility).toHaveBeenCalledTimes(ARENA_POLICY.registrationConcurrency),
            { timeout: 500, interval: 1 });
          const reads = prepare.mock.calls.length;
          const changes = state.storage.sql.exec<{ value: number }>('SELECT total_changes() AS value').one().value;
          const tokens = state.storage.sql.exec<{ tokens: number }>("SELECT tokens FROM arena_tokens WHERE kind='registration'").one().tokens;
          expect(await instance.registerArena(waiting, `${id}-other`)).toMatchObject({ ok: false, error: { code: 'ARENA_RETRY', status: 429 } });
          expect(prepare).toHaveBeenCalledTimes(reads);
          expect(schedule).not.toHaveBeenCalled();
          expect(state.storage.sql.exec<{ value: number }>('SELECT total_changes() AS value').one().value).toBe(changes);
          expect(state.storage.sql.exec<{ tokens: number }>("SELECT tokens FROM arena_tokens WHERE kind='registration'").one().tokens).toBe(tokens);
          expect(value(await instance.registerArena(existing, id)).registered).toBe(true);
          expect(readEligibility).toHaveBeenLastCalledWith(existing.id);
        } finally {
          release();
          results = await Promise.all(pending);
          prepare.mockRestore(); sync.mockRestore(); schedule.mockRestore();
        }
        const failures = results.filter(result => 'error' in result);
        expect(failures).toHaveLength(mode === 'eligibility-failure' ? ARENA_POLICY.registrationConcurrency : mode === 'sync-failure' ? 1 : 0);
        for (const result of failures) expect(result).toEqual({ error: databaseError });
        for (const result of results) if ('value' in result) expect(result.value.ok).toBe(true);
      }
      expect(value(await instance.registerArena(waiting, id)).registered).toBe(true);
    });
  });

  it('sheds a registration burst and admits fixed 67 ms confirmations through a 3200 ms eligibility stall', async () => {
    const { competition, id, startsAt, clock } = await prepare(0, { ARENA_ENTRANT_LIMIT: '2000' });
    const actors = await Promise.all(Array.from({ length: 96 }, () => player(false, { recoveryEmail: false })));
    clock.mockRestore();
    await runInDurableObject<Competition, void>(competition, async (instance, state) => {
      const internal = instance as unknown as { env: Env };
      const database = internal.env.DB, originalPrepare = database.prepare.bind(database);
      let active = 0, maximum = 0;
      vi.useFakeTimers({ now: startsAt - 10 * 60_000, loopLimit: 1_000 });
      const prepare = vi.spyOn(database, 'prepare').mockImplementation(query => {
        if (query.startsWith('SELECT s.expiresAt,')) return {
          bind: () => ({ first: async () => {
            active++; maximum = Math.max(maximum, active);
            await new Promise<void>(resolve => setTimeout(resolve, 3_200));
            active--;
            return { expiresAt: new Date(actors[0].sessionExpiresAt).toISOString(), accountReady: 1, restricted: 0 };
          } }),
        } as unknown as D1PreparedStatement;
        if (query.startsWith('SELECT 1 FROM operations_control')) return {
          bind: () => ({ first: async () => ({ allowed: 1 }) }),
        } as unknown as D1PreparedStatement;
        return originalPrepare(query);
      });
      const sync = vi.spyOn(state.storage, 'sync').mockResolvedValue();
      try {
        const burst = actors.map(actor => instance.registerArena(actor, id));
        await vi.runAllTimersAsync();
        const burstReplies = await Promise.all(burst);
        expect(burstReplies.filter(reply => reply.ok)).toHaveLength(16);
        expect(burstReplies.filter(reply => !reply.ok))
          .toEqual(Array.from({ length: 80 }, () => expect.objectContaining({ error: expect.objectContaining({ code: 'ARENA_RETRY' }) })));
        expect(maximum).toBe(16);
        maximum = 0;
        await vi.advanceTimersByTimeAsync(35_000 - 3_200);
        const elapsed: number[] = [];
        const replies = actors.map((actor, index) => new Promise<ArenaActionResult>(resolve => {
          setTimeout(() => {
            const offeredAt = Date.now();
            void instance.registerArena(actor, id).then(reply => { elapsed.push(Date.now() - offeredAt); resolve(reply); });
          }, index * 67);
        }));
        await vi.runAllTimersAsync();
        expect((await Promise.all(replies)).every(reply => reply.ok)).toBe(true);
        expect(Math.max(...elapsed)).toBeLessThan(5_000);
        expect(maximum).toBe(48);
        expect(state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM arena_entries').one().count).toBe(96);
      } finally {
        prepare.mockRestore(); sync.mockRestore(); vi.useRealTimers();
      }
    });
  });

  it('keeps the entrant cap and duplicate registration count under concurrent admissions', async () => {
    const { competition, id } = await prepare(0, { ARENA_ENTRANT_LIMIT: '1' });
    const actors = await Promise.all(Array.from({ length: 2 }, () => player(false, { recoveryEmail: false })));
    await runInDurableObject<Competition, void>(competition, async (instance, state) => {
      const replies = await Promise.all(actors.map(actor => instance.registerArena(actor, id)));
      expect(replies.filter(reply => reply.ok)).toHaveLength(1);
      expect(replies.filter(reply => !reply.ok)).toMatchObject([{ error: { code: 'ARENA_FULL' } }]);
      const accepted = actors[replies[0].ok ? 0 : 1];
      const tokens = state.storage.sql.exec<{ tokens: number }>("SELECT tokens FROM arena_tokens WHERE kind='registration'").one().tokens;
      expect((await Promise.all([instance.registerArena(accepted, id), instance.registerArena(accepted, id)])).every(reply => reply.ok)).toBe(true);
      expect(state.storage.sql.exec<{ entrants: number }>('SELECT entrants FROM arena_events WHERE id=?', id).one().entrants).toBe(1);
      expect(state.storage.sql.exec('SELECT 1 FROM arena_entries WHERE event_id=?', id).toArray()).toHaveLength(1);
      expect(state.storage.sql.exec<{ tokens: number }>("SELECT tokens FROM arena_tokens WHERE kind='registration'").one().tokens).toBe(tokens);
    });
  });

  it('charges a new join when an existing entry is withdrawn during its external checks', async () => {
    const { competition, actors, id } = await prepare(1);
    await runInDurableObject<Competition, void>(competition, async (instance, state) => {
      const pending = instance.registerArena(actors[0], id);
      state.storage.sql.exec("UPDATE arena_entries SET state='withdrawn' WHERE event_id=? AND user_id=?", id, actors[0].id);
      state.storage.sql.exec('UPDATE arena_events SET entrants=0 WHERE id=?', id);
      state.storage.sql.exec("UPDATE arena_tokens SET tokens=0,updated_at=? WHERE kind='registration'", Date.now());
      expect(await pending).toMatchObject({ ok: false, error: { code: 'ARENA_RETRY' } });
      expect(state.storage.sql.exec<{ state: string }>('SELECT state FROM arena_entries WHERE event_id=? AND user_id=?', id, actors[0].id).one().state).toBe('withdrawn');
      expect(state.storage.sql.exec<{ entrants: number }>('SELECT entrants FROM arena_events WHERE id=?', id).one().entrants).toBe(0);
    });
  });

  it('creates fixed isolated events through native scheduling without changing the clock or production calendar', async () => {
    const competition = await authority();
    const anchor = Math.ceil(Date.now() / 60_000) * 60_000;
    const starts = { weekly: anchor - 110 * 60_000, daily: anchor + 10 * 60_000, hourly: anchor + 10 * 60_000 };
    const events = await runInDurableObject(competition, (instance, state) => {
      const internal = instance as unknown as { env: Env; arenas: { ensure(now?: number): void } };
      bindIsolatedGameBudget(internal.env, { manifestDigest: 'a'.repeat(64), maximum: 20_000,
        arenaStarts: starts, available: async () => true, reserve: async () => true });
      internal.arenas.ensure();
      return state.storage.sql.exec<{ cadence: string; starts_at: number; closes_at: number }>(
        'SELECT cadence,starts_at,closes_at FROM arena_events ORDER BY cadence').toArray();
    });
    expect(events).toHaveLength(3);
    for (const event of events) {
      expect(event.starts_at).toBe(starts[event.cadence as keyof typeof starts]);
      expect(event.closes_at - event.starts_at).toBe(event.cadence === 'hourly' ? HOUR : 2 * HOUR);
    }
  });

  it('finishes the old hourly event before admitting simultaneous daily and hourly starts while weekly games drain', async () => {
    const boundary = Date.UTC(2026, 9, 25, 18);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(boundary - 600_000);
    const competition = await authority();
    const actors = await Promise.all(Array.from({ length: 6 }, () => player(false, { recoveryEmail: false })));
    const weekly = `arena-weekly-${boundary - 2 * HOUR}`;
    const daily = `arena-daily-${boundary}`;
    const hourly = `arena-hourly-${boundary}`;
    const oldHourly = `arena-hourly-${boundary - HOUR}`;
    for (const [event, entrants] of [[weekly, actors.slice(0, 2)], [daily, actors.slice(2, 4)], [hourly, actors.slice(4)]] as const)
      for (const actor of entrants) value(await competition.registerArena(actor, event));
    for (const actor of actors.slice(0, 2)) value(await competition.queueArena(actor, weekly));
    clock.mockReturnValue(boundary - 60_000);
    await competition.maintenance();
    const [weeklyGame] = await games(competition, actors.slice(0, 2), weekly);
    expect(weeklyGame).toBeTruthy();
    await ready(weeklyGame, actors.slice(0, 2));
    clock.mockReturnValue(boundary - 59_500);
    for (const actor of actors.slice(2, 4)) value(await competition.queueArena(actor, daily));
    for (const actor of actors.slice(4)) value(await competition.queueArena(actor, hourly));
    clock.mockReturnValue(boundary);
    await competition.maintenance();
    const events = await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec<{
      id: string; status: string; unresolved: number;
    }>('SELECT id,status,unresolved FROM arena_events WHERE id IN (?,?,?,?)', weekly, daily, hourly, oldHourly).toArray());
    expect(events.find(event => event.id === weekly)).toMatchObject({ status: 'draining', unresolved: 1 });
    expect(events.find(event => event.id === oldHourly)).toMatchObject({ status: 'finished', unresolved: 0 });
    for (const id of [daily, hourly]) expect(events.find(event => event.id === id)).toMatchObject({ status: 'running', unresolved: 1 });
    expect(events.filter(event => ['running', 'draining'].includes(event.status))).toHaveLength(3);
  });

  it('shares accepted game capacity with casual work and resumes arena pairing after its terminal settlement', async () => {
    const { competition, actors, id, startsAt, clock } = await prepare(2, { ARENA_GAME_LIMIT: '1' });
    for (const actor of actors) value(await competition.queueArena(actor, id));
    clock.mockReturnValue(startsAt);
    const casualPlayer = await player();
    const casualId = crypto.randomUUID();
    expect(await competition.createCasualGame(casualPlayer, { id: casualId, format: 'blitz' })).toMatchObject({ ok: true });
    const casual = env.GAME.get(env.GAME.idFromName(casualId));
    await runInDurableObject(casual, async (instance, state) => {
      const internal = instance as unknown as { schedule(): Promise<void>; flush(): Promise<void> };
      internal.schedule = async () => {};
      internal.flush = async () => {};
      await state.storage.deleteAlarm();
    });
    await competition.maintenance();
    expect(await games(competition, actors, id)).toEqual([]);
    clock.mockReturnValue(startsAt + 600_000);
    await competition.maintenance();
    expect((await casual.status())?.status).toBe('finished');
    expect(await games(competition, actors, id)).toHaveLength(1);
  });

  it('continues pairing a busy event after visiting an empty running event', async () => {
    const { competition, actors, id, startsAt, clock } = await prepare();
    for (const actor of actors) value(await competition.queueArena(actor, id));
    await runInDurableObject(competition, (instance, state) => {
      (instance as unknown as { arenas: { ensure(): void } }).arenas.ensure = () => {};
      state.storage.sql.exec('DELETE FROM arena_events WHERE id<>?', id);
      state.storage.sql.exec(`INSERT INTO arena_events(id,cadence,pool,starts_at,closes_at,status,next_at)
        VALUES('000-empty-running','hourly','blitz',?,?,'running',?)`, startsAt, startsAt + HOUR, startsAt);
    });
    clock.mockReturnValue(startsAt);
    await competition.maintenance();
    const created = await games(competition, actors, id);
    expect(created).toHaveLength(2);
    for (const gameId of created) expect(await env.DB.prepare(`SELECT COUNT(*) AS count FROM active_game_seats
      WHERE game_id=? AND released_at IS NULL`).bind(gameId).first('count')).toBe(2);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM tournament_game_admissions WHERE tournament_id=?')
      .bind(id).first('count')).toBe(2);
    const emptyIntents = await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM arena_intents WHERE event_id='000-empty-running'").one().count);
    expect(emptyIntents).toBe(0);
  });

  it('keeps registration free of account locks and serializes explicit queue claims across game modes', async () => {
    const { competition, actors, id, startsAt, clock } = await prepare();
    expect(await hasActiveSeat(env.DB, actors[0].id)).toBe(false);
    const duplicate = await Promise.all([competition.queueArena(actors[0], id), competition.queueArena(actors[0], id)]);
    expect(duplicate.map(result => value(result).state)).toEqual(['reserving', 'reserving']);
    await competition.maintenance();
    expect((await competition.getArenaMe(actors[0], id))?.state).toBe('queued');
    expect(await acquireSeatGuard(env, actors[0], crypto.randomUUID())).toBe(false);
    expect(await competition.joinQueue(actors[0], 'rapid')).toEqual({ status: 'tournament', pool: 'blitz', tournamentId: id });
    value(await competition.pauseArena(actors[0], id));
    expect(await competition.resumeArena(actors[0], id)).toMatchObject({ ok: false, error: { code: 'ARENA_RELEASE_PENDING' } });
    await competition.maintenance();
    expect(await hasActiveSeat(env.DB, actors[0].id)).toBe(false);
    expect((await competition.getArenaMe(actors[0], id))?.state).toBe('paused');
    value(await competition.resumeArena(actors[0], id));
    await competition.maintenance();
    clock.mockReturnValue(startsAt);
    await competition.maintenance();
    expect(await games(competition, actors, id)).toEqual([]);
    expect((await competition.getArenaMe(actors[0], id))?.state).toBe('queued');
    expect((await competition.getArenaMe(actors[0], id))?.points).toBe(0);
  });

  it('commits terminal points once, requires requeue, and enforces a different opponent between repeats', async () => {
    const { competition, actors, id, startsAt, clock } = await prepare();
    for (const actor of actors) value(await competition.queueArena(actor, id));
    clock.mockReturnValue(startsAt);
    await competition.maintenance();
    const first = await games(competition, actors, id);
    expect(first).toHaveLength(2);
    const results = [];
    for (const gameId of first) results.push(await draw(gameId, actors, competition));
    for (const result of results) expect(await competition.settle(result)).toEqual({ accepted: true, pending: false });
    await competition.maintenance();
    for (const actor of actors) expect(await competition.getArenaMe(actor, id)).toMatchObject({ points: 0.5, games: 1, state: 'registered', gameId: null });
    expect(await games(competition, actors, id)).toEqual([]);
    for (const actor of actors) value(await competition.queueArena(actor, id));
    await competition.maintenance();
    const second = await games(competition, actors, id);
    expect(second).toHaveLength(2);
    for (const gameId of second) {
      const result = await draw(gameId, actors, competition);
      const previous = results.find(prior => prior.white.id === result.white.id || prior.black!.id === result.white.id)!;
      expect(new Set([previous.white.id, previous.black!.id])).not.toEqual(new Set([result.white.id, result.black!.id]));
    }
    await competition.maintenance();
    await publish(competition, clock);
    const published = await standings(id);
    expect(published.rows).toHaveLength(4);
    expect(published.rows.every(row => row.points === 1 && row.games === 2 && row.rank === 1)).toBe(true);
    const encoded = JSON.stringify(await readArenaSummary(env.DB, id)) + JSON.stringify(published);
    for (const actor of actors) expect(encoded).not.toContain(actor.sessionId);
    expect(encoded).not.toContain('placeholder.invalid');
    expect(await env.DB.prepare('SELECT emailVerified FROM user WHERE id=?').bind(actors[0].id).first('emailVerified')).toBe(0);
    const receipts = await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM arena_receipts').one().count);
    expect(receipts).toBe(4);
  });

  it('drains accepted games after closure and pauses only the no-show without granting points', async () => {
    const { competition, actors, id, startsAt, clock } = await prepare(2);
    clock.mockReturnValue(startsAt + HOUR - 30_000);
    for (const actor of actors) value(await competition.queueArena(actor, id));
    await competition.maintenance();
    const [gameId] = await games(competition, actors, id);
    expect(gameId).toBeTruthy();
    const context = await game(gameId, actors);
    expect(await context.stub.command(context.white, {
      type: 'ready', id: crypto.randomUUID(), expectedVersion: context.snapshot.version,
    })).toMatchObject({ ok: true });
    clock.mockReturnValue(startsAt + HOUR);
    await competition.maintenance();
    expect((await competition.getArenaMe(actors[0], id))?.status).toBe('draining');
    expect(await competition.queueArena(actors[0], id)).toMatchObject({ ok: false, error: { code: 'ARENA_ENTRY_CLOSED' } });
    clock.mockReturnValue(startsAt + HOUR + 120_000);
    await competition.maintenance();
    await competition.flush();
    await competition.maintenance();
    expect(await competition.getArenaMe(context.white, id)).toMatchObject({ status: 'finished', state: 'registered', points: 0, games: 1, gameId: null });
    expect(await competition.getArenaMe(context.black, id)).toMatchObject({ status: 'finished', state: 'paused', points: 0, games: 1, gameId: null });
    await publish(competition, clock);
    expect(await readArenaSummary(env.DB, id)).toMatchObject({ status: 'finished', provisional: false, unresolvedGames: 0 });
  });

  it('recovers uncertain game creation with the same ID and held account reservations', async () => {
    const { competition: original, actors, id, startsAt, clock } = await prepare(2);
    for (const actor of actors) value(await original.queueArena(actor, id));
    expect(await original.observeArenaReservation(actors[0], id)).toBeNull();
    await runInDurableObject(original, instance => {
      const internal = instance as unknown as { env: Env };
      const namespace = internal.env.GAME;
      let loseReply = true;
      internal.env = { ...internal.env, GAME: {
        idFromName: (name: string) => namespace.idFromName(name),
        get: (gameId: DurableObjectId) => {
          const actual = namespace.get(gameId);
          return new Proxy(actual, { get(target, property) {
            if (property === 'init') return async (...args: Parameters<typeof actual.init>) => {
              const result = await actual.init(...args);
              if (loseReply) { loseReply = false; throw new Error('lost_init_reply'); }
              return result;
            };
            const value = Reflect.get(target, property);
            return typeof value === 'function' ? (...args: unknown[]) => Reflect.apply(value, target, args) : value;
          } });
        },
      } as unknown as Env['GAME'] };
    });
    clock.mockReturnValue(startsAt);
    await original.maintenance();
    const created = await runInDurableObject(original, (_instance, state) => state.storage.sql.exec<{ game_id: string }>('SELECT game_id FROM arena_intents').one().game_id);
    // The ordinary UI read hides uncertain creation. The binding-only read
    // must preserve that same native intent and both actual seat identities.
    expect((await original.getArenaMe(actors[0], id))?.gameId).toBeNull();
    const pending = await original.observeArenaReservation(actors[0], id);
    expect(pending).toMatchObject({ gameId: created, eventId: id, status: 'creating' });
    expect(new Set([pending!.whiteId, pending!.blackId])).toEqual(new Set(actors.map(actor => actor.id)));
    expect(await original.observeArenaReservation(actors[1], id)).toEqual(pending);
    const staleActor = await runInDurableObject(original, async instance => {
      try { await (instance as Competition).observeArenaReservation({ ...actors[0], sessionId: crypto.randomUUID() }, id); }
      catch (error) { return (error as { code?: string }).code; }
      return null;
    });
    expect(staleActor).toBe('SIGN_IN_REQUIRED');
    await evictDurableObject(original);
    const competition = await authority({}, original);
    clock.mockReturnValue(startsAt + 2_000);
    await competition.maintenance();
    expect(await games(competition, actors, id)).toEqual([created]);
    expect(await competition.observeArenaReservation(actors[0], id)).toMatchObject({
      gameId: created, eventId: id, reservationId: pending!.reservationId,
      whiteId: pending!.whiteId, blackId: pending!.blackId, status: 'live' });
    for (const actor of actors) expect(await hasActiveSeat(env.DB, actor.id)).toBe(true);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM tournament_game_admissions WHERE tournament_id=?').bind(id).first('count')).toBe(1);
  });

  it('keeps visible and withdrawn standings anchors through updates and restart', async () => {
    const { competition, actors, id, clock } = await prepare(34, { ARENA_ENTRANT_LIMIT: '2000' });
    actors.sort((a, b) => a.id < b.id ? -1 : 1);
    await runInDurableObject(competition, (instance, state) => {
      (instance as unknown as { arenas: { ensure(): void } }).arenas.ensure = () => {};
      state.storage.sql.exec('DELETE FROM arena_events WHERE id<>?', id);
    });
    value(await competition.withdrawArena(actors[33], id));
    const frozen = await runInDurableObject(competition, async (instance, state) => {
      await (instance as unknown as { arenas: { projection: { advance(now: number): Promise<void> } } }).arenas.projection.advance(Date.now());
      return {
        build: state.storage.sql.exec<{ revision: number; scan_state: string }>('SELECT revision,scan_state FROM arena_projection_builds WHERE event_id=?', id).one(),
        anchors: state.storage.sql.exec(`SELECT user_id,revision,name,points_half,games,visible FROM arena_entry_versions
          WHERE event_id=? AND user_id IN (?,?) ORDER BY user_id,revision`, id, actors[32].id, actors[33].id).toArray(),
      };
    });
    for (let update = 0; update < 4; update++) {
      value(await competition.registerArena({ ...actors[32], name: `Later name ${update}` }, id));
      value(await competition.registerArena({ ...actors[33], name: `Rejoined ${update}` }, id));
    }
    const retained = await runInDurableObject(competition, (_instance, state) => ({
      cursor: state.storage.sql.exec<{ scan_state: string }>('SELECT scan_state FROM arena_projection_builds WHERE event_id=?', id).one().scan_state,
      anchors: state.storage.sql.exec(`SELECT user_id,revision,name,points_half,games,visible FROM arena_entry_versions
        WHERE event_id=? AND user_id IN (?,?) AND revision<=? ORDER BY user_id,revision`,
      id, actors[32].id, actors[33].id, frozen.build.revision).toArray(),
      excess: state.storage.sql.exec('SELECT user_id FROM arena_entry_versions WHERE event_id=? GROUP BY user_id HAVING COUNT(*)>2', id).toArray(),
    }));
    expect(retained.cursor).toBe(frozen.build.scan_state);
    expect(retained.anchors).toEqual(frozen.anchors);
    expect(retained.excess).toEqual([]);
    expect(retained.anchors.some(row => row.user_id === actors[33].id && row.visible === 0)).toBe(true);
    await evictDurableObject(competition);
    const resumed = await authority({ ARENA_ENTRANT_LIMIT: '2000' }, competition);
    await runInDurableObject(resumed, instance => {
      (instance as unknown as { arenas: { ensure(): void } }).arenas.ensure = () => {};
    });
    const advance = () => runInDurableObject(resumed, async instance => {
      for (let pass = 0; pass < 6; pass++) await (instance as unknown as {
        arenas: { projection: { advance(now: number): Promise<void> } };
      }).arenas.projection.advance(Date.now());
    });
    await advance();
    const first = await standings(id);
    expect(first.rows).toHaveLength(33);
    expect(first.rows.find(row => row.id === actors[32].id)?.name).toBe(actors[32].name.slice(0, 40));
    expect(first.rows.some(row => row.id === actors[33].id)).toBe(false);
    value(await resumed.registerArena({ ...actors[32], name: 'After publication' }, id));
    const newest = await runInDurableObject(resumed, (_instance, state) => state.storage.sql.exec(
      'SELECT name FROM arena_entry_versions WHERE event_id=? AND user_id=?', id, actors[32].id).toArray());
    expect(newest).toEqual([{ name: 'After publication' }]);
    clock.mockReturnValue(Date.now() + 11_000);
    await advance();
    const next = await standings(id);
    expect(next.rows).toHaveLength(34);
    expect(next.rows.find(row => row.id === actors[32].id)?.name).toBe('After publication');
    expect(next.rows.find(row => row.id === actors[33].id)?.name).toBe('Rejoined 3');
  });

  it('keeps the frozen anchor behind a legacy version backlog while pruning at most two obsolete keys', async () => {
    const { competition, actors, id } = await prepare(1);
    const actor = actors[0];
    const anchor = await runInDurableObject(competition, (instance, state) => {
      (instance as unknown as { arenas: { ensure(): void } }).arenas.ensure = () => {};
      const sql = state.storage.sql;
      const revision = sql.exec<{ revision: number }>('SELECT revision FROM arena_events WHERE id=?', id).one().revision;
      sql.exec(`INSERT INTO arena_projection_builds(event_id,generation,revision,watermark,generated_at,summary,phase)
        VALUES(?,1,?,0,?,'{}','capture')`, id, revision, Date.now());
      for (let offset = 1; offset <= 6; offset++) sql.exec(`INSERT INTO arena_entry_versions
        (event_id,user_id,revision,name,points_half,games,visible) VALUES(?,?,?, ?,0,0,1)`, id, actor.id, revision + offset, `Legacy ${offset}`);
      sql.exec('UPDATE arena_events SET revision=? WHERE id=?', revision + 6, id);
      return sql.exec('SELECT revision,name,visible FROM arena_entry_versions WHERE event_id=? AND user_id=? AND revision=?', id, actor.id, revision).one();
    });
    value(await competition.registerArena({ ...actor, name: 'Current name' }, id));
    const rows = await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec(
      'SELECT revision,name,visible FROM arena_entry_versions WHERE event_id=? AND user_id=? ORDER BY revision', id, actor.id).toArray());
    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual(anchor);
    expect(rows.at(-1)).toMatchObject({ name: 'Current name', visible: 1 });
    expect(rows.some(row => row.name === 'Legacy 5' || row.name === 'Legacy 6')).toBe(false);
    expect(rows.some(row => row.name === 'Legacy 1')).toBe(true);
  });

  it('holds one standings watermark across bounded capture while a later result commits', async () => {
    const { competition, actors, id, startsAt, clock } = await prepare(66, { ARENA_ENTRANT_LIMIT: '2000' });
    actors.sort((a, b) => a.id < b.id ? -1 : 1);
    const playing = actors.slice(-2);
    for (const actor of playing) value(await competition.queueArena(actor, id));
    await runInDurableObject(competition, (instance, state) => {
      (instance as unknown as { arenas: { ensure(): void } }).arenas.ensure = () => {};
      state.storage.sql.exec('DELETE FROM arena_events WHERE id<>?', id);
    });
    clock.mockReturnValue(startsAt);
    await competition.maintenance();
    const [gameId] = await games(competition, playing, id);
    expect(gameId).toBeTruthy();
    await draw(gameId, actors, competition);
    // The first generation captured its revision before this terminal result.
    for (let pass = 0; pass < 8; pass++) await competition.maintenance();
    const first = await standings(id);
    expect(first.rows).toHaveLength(66);
    expect(first.rows.every(row => row.points === 0 && row.rank === 1)).toBe(true);
    await publish(competition, clock);
    const second = await standings(id);
    expect(second.generation).toBeGreaterThan(first.generation);
    expect(second.rows.filter(row => row.points === 0.5).map(row => row.id).sort()).toEqual(playing.map(actor => actor.id).sort());
    expect(second.rows.filter(row => row.points === 0).every(row => row.rank === 3)).toBe(true);
    const old = await readArenaStandings(env.DB, id, `${first.generation}:1`);
    expect(old?.generation).toBe(first.generation);
  });

  it('fails closed on unqualified configuration and byte exhaustion without losing registrations', async () => {
    expect(arenaLimits({ ARENA_ENTRANT_LIMIT: '2001', ARENA_GAME_LIMIT: '-1', ARENA_AUTHORITY_BYTE_LIMIT: 'nan' }))
      .toMatchObject({ maxEntrants: 0, liveGames: 0, authorityBytes: 0 });
    const { competition, actors, id, startsAt, clock } = await prepare(2);
    await authority({ ARENA_AUTHORITY_BYTE_LIMIT: '1' }, competition);
    const additional = await player();
    expect(await competition.registerArena(additional, id)).toMatchObject({ ok: false, error: { code: 'ARENA_STORAGE_FULL' } });
    for (const actor of actors) value(await competition.queueArena(actor, id));
    clock.mockReturnValue(startsAt);
    await competition.maintenance();
    expect(await games(competition, actors, id)).toEqual([]);
    for (const actor of actors) expect(await competition.getArenaMe(actor, id)).toMatchObject({ registered: true, state: 'queued', points: 0 });
  });

  it('keeps retained-entry headroom atomic through cleanup and eviction and closes on a missing counter', async () => {
    const { competition, actors, id } = await prepare(2);
    await runInDurableObject(competition, (_instance, state) => {
      const sql = state.storage.sql;
      const count = () => sql.exec<{ retained: number }>('SELECT retained FROM arena_entry_counts WHERE singleton=1').one().retained;
      expect(count()).toBe(2);
      expect(() => state.storage.transactionSync(() => {
        sql.exec('DELETE FROM arena_entries WHERE event_id=? AND user_id=?', id, actors[1].id);
        expect(count()).toBe(1);
        throw new Error('rollback_entry_cleanup');
      })).toThrow('rollback_entry_cleanup');
      expect(count()).toBe(2);
      sql.exec('DELETE FROM arena_entries WHERE event_id=? AND user_id=?', id, actors[1].id);
      expect(count()).toBe(1);
    });
    await evictDurableObject(competition);
    await authority({}, competition);
    const additional = await player(false, { recoveryEmail: false });
    expect(await competition.registerArena(additional, id)).toMatchObject({ ok: true });
    await runInDurableObject(competition, (_instance, state) => {
      const rows = state.storage.sql.exec<{ retained: number }>('SELECT retained FROM arena_entry_counts WHERE singleton=1');
      expect(rows.one().retained).toBe(2);
      expect(rows.rowsRead).toBe(1);
      state.storage.sql.exec('DELETE FROM arena_entry_counts WHERE singleton=1');
    });
    await evictDurableObject(competition);
    await authority({}, competition);
    expect(await competition.registerArena(await player(), id)).toMatchObject({ ok: false, error: { code: 'ARENA_STORAGE_FULL' } });
    expect(await competition.getArenaMe(actors[0], id)).toMatchObject({ registered: true });
  });

  it('rolls a conflicting arena receipt back with the terminal event and records the conflict', async () => {
    const { competition, actors, id, startsAt, clock } = await prepare(2);
    for (const actor of actors) value(await competition.queueArena(actor, id));
    clock.mockReturnValue(startsAt);
    await competition.maintenance();
    const [gameId] = await games(competition, actors, id);
    const result = await draw(gameId, actors, competition, false);
    const originalReservation = result.reservationId!;
    await runInDurableObject(competition, (_instance, state) => {
      state.storage.sql.exec('UPDATE arena_intents SET reservation_id=? WHERE game_id=?', crypto.randomUUID(), gameId);
    });
    await runInDurableObject(competition, async instance => {
      await expect((instance as Competition).settle(result)).rejects.toThrow('conflicting_arena_result');
    });
    const failed = await runInDurableObject(competition, (_instance, state) => ({
      events: state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM result_events WHERE game_id=?', gameId).one().count,
      receipts: state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM arena_receipts WHERE game_id=?', gameId).one().count,
      incidents: state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM incidents WHERE game_id=? AND kind='conflicting_arena_result'", gameId).one().count,
    }));
    expect(failed).toEqual({ events: 0, receipts: 0, incidents: 1 });
    for (const actor of actors) expect(await competition.getArenaMe(actor, id)).toMatchObject({ points: 0, games: 0, state: 'playing' });
    await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec('UPDATE arena_intents SET reservation_id=? WHERE game_id=?', originalReservation, gameId).toArray());
    for (let attempt = 0; attempt < 5; attempt++) expect(await competition.settle(result)).toEqual({ accepted: true, pending: false });
    for (const actor of actors) expect(await competition.getArenaMe(actor, id)).toMatchObject({ points: 0.5, games: 1 });
  });

  it('rolls back both entrants and the event when the second settlement reservation conflicts', async () => {
    const { competition, actors, id, startsAt, clock } = await prepare(2);
    for (const actor of actors) value(await competition.queueArena(actor, id));
    clock.mockReturnValue(startsAt);
    await competition.maintenance();
    const [gameId] = await games(competition, actors, id);
    const result = await draw(gameId, actors, competition, false);
    await runInDurableObject(competition, (_instance, state) => {
      state.storage.sql.exec('UPDATE arena_entries SET game_id=? WHERE event_id=? AND user_id=?', crypto.randomUUID(), id, result.black!.id);
    });
    const capture = () => runInDurableObject(competition, (_instance, state) => ({
      event: state.storage.sql.exec('SELECT unresolved,watermark,revision,next_at FROM arena_events WHERE id=?', id).one(),
      entries: state.storage.sql.exec(`SELECT user_id,game_id,points_half,score_band,games,state,release_to,next_at,reason
        FROM arena_entries WHERE event_id=? ORDER BY user_id`, id).toArray(),
      intent: state.storage.sql.exec('SELECT status,next_at,reason FROM arena_intents WHERE game_id=?', gameId).one(),
      versions: state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM arena_entry_versions WHERE event_id=?', id).one().count,
      events: state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM result_events WHERE game_id=?', gameId).one().count,
      receipts: state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM arena_receipts WHERE game_id=?', gameId).one().count,
    }));
    const before = await capture();
    await runInDurableObject(competition, async instance => {
      await expect((instance as Competition).settle(result)).rejects.toThrow('arena_reservation_conflict');
    });
    expect(await capture()).toEqual(before);
    await runInDurableObject(competition, (_instance, state) => {
      state.storage.sql.exec('UPDATE arena_entries SET game_id=? WHERE event_id=? AND user_id=?', gameId, id, result.black!.id);
    });
    for (let attempt = 0; attempt < 5; attempt++) expect(await competition.settle(result)).toEqual({ accepted: true, pending: false });
    const after = await capture();
    expect(after.event).toMatchObject({ unresolved: 0, watermark: 1, revision: Number(before.event.revision) + 1 });
    expect(after.intent).toMatchObject({ status: 'finished', next_at: null });
    expect(after.versions).toBe(2);
    expect(after.events).toBe(1);
    expect(after.receipts).toBe(1);
    for (const entry of after.entries) expect(entry).toMatchObject({
      game_id: gameId, points_half: 1, score_band: 1, games: 1, state: 'releasing', release_to: 'registered', reason: null,
    });
    const versionRows = await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec(
      'SELECT revision,points_half,games,visible FROM arena_entry_versions WHERE event_id=? AND revision=?', id, after.event.revision!).toArray());
    expect(versionRows).toHaveLength(2);
    for (const version of versionRows) expect(version).toEqual({ revision: after.event.revision, points_half: 1, games: 1, visible: 1 });
  });

  it('drains obsolete public pages after finalization while keeping both published generations', async () => {
    const competition = await authority();
    await runInDurableObject(competition, instance => {
      (instance as unknown as { arenas: { ensure(): void } }).arenas.ensure = () => {};
    });
    const id = `arena-history-${crypto.randomUUID()}`;
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const summary = { id, format: 'arena-v1', cadence: 'hourly', pool: 'blitz', rated: false, startsAt: now - HOUR,
      registrationOpensAt: now - HOUR - 900_000, closesAt: now, finishedAt: now, status: 'finished', reason: null,
      entrants: 0, unresolvedGames: 0, maxEntrants: 4, provisional: false, generation: 3, watermark: 0, generatedAt: now };
    await env.DB.prepare(`INSERT INTO arena_public_events(event_id,starts_at,finished_at,status,generation,previous_generation,watermark,generated_at,page_count,summary)
      VALUES(?,?,?,'finished',3,2,0,?,1,?)`).bind(id, now - HOUR, now, now, JSON.stringify(summary)).run();
    await env.DB.batch(Array.from({ length: 65 }, (_unused, page) => env.DB.prepare('INSERT INTO arena_public_pages(event_id,generation,page_number,payload) VALUES(?,1,?,?)')
      .bind(id, page, '{}')));
    for (const generation of [2, 3]) await env.DB.prepare('INSERT INTO arena_public_pages(event_id,generation,page_number,payload) VALUES(?,?,0,?)')
      .bind(id, generation, JSON.stringify({ id, format: 'arena-v1', generation, watermark: 0, generatedAt: now, provisional: false, standings: [], nextCursor: null })).run();
    // The shared D1 fixture can contain protected pages from earlier cases.
    // One indexed sweep visits at most 32 candidates per maintenance pass.
    const candidates = await env.DB.prepare('SELECT COUNT(*) AS count FROM arena_public_pages').first<number>('count');
    const maxPasses = Math.ceil(candidates! / 32) + 1;
    for (let pass = 0; pass < maxPasses; pass++) {
      clock.mockReturnValue(now + pass * 1_000);
      await competition.maintenance();
      if (!await env.DB.prepare('SELECT 1 FROM arena_public_pages WHERE event_id=? AND generation=1 LIMIT 1').bind(id).first()) break;
    }
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM arena_public_pages WHERE event_id=?').bind(id).first('count')).toBe(2);
    expect((await readArenaStandings(env.DB, id))?.generation).toBe(3);
    expect((await readArenaStandings(env.DB, id, '2:0'))?.generation).toBe(2);
    await expect(readArenaStandings(env.DB, id, '1:0')).rejects.toMatchObject({ code: 'ARENA_CURSOR_EXPIRED' });
  });
});
