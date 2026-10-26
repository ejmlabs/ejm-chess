import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireSeatGuard, acquireTournamentAccount, hasActiveSeat } from '../src/server/auth';
import type { Competition } from '../src/server/competition';
import type { Env } from '../src/server/env';
import type { Actor, GameSnapshot, InitGame } from '../src/shared/protocol';
import type { TournamentView } from '../src/shared/tournaments';
import { TOURNAMENT_LIMITS } from '../src/server/tournaments';
import { player } from './authority-helpers';

const HOUR = 3_600_000;
type Authority = DurableObjectStub<Competition>;
afterEach(() => { vi.restoreAllMocks(); });

async function authority(existing?: Authority): Promise<Authority> {
  const stub = existing ?? env.COMPETITION.get(env.COMPETITION.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, async (instance, state) => {
    const internal = instance as unknown as { env: Env; schedule(): Promise<void> };
    internal.env = { ...internal.env, TOURNAMENTS_ENABLED: 'true', RANKED_ENABLED: 'true' };
    internal.schedule = async () => {};
    await state.storage.deleteAlarm();
  });
  return stub;
}

let clockIndex = 0;
function startClock() {
  const startsAt = Math.ceil(Date.now() / HOUR) * HOUR + ++clockIndex * HOUR;
  return { startsAt, clock: vi.spyOn(Date, 'now').mockReturnValue(startsAt - 10 * 60_000) };
}

async function enter(competition: Authority, count: 3 | 4, startsAt: number) {
  const actors = await Promise.all(Array.from({ length: count }, () => player()));
  const id = `hourly-${startsAt}`;
  expect((await competition.listTournaments()).events.some(event => event.id === id)).toBe(true);
  for (const actor of actors) await register(competition, actor, id);
  return { id, actors };
}

async function event(competition: Authority, id: string, actor?: Actor): Promise<TournamentView> {
  const value = await competition.getTournament(id, actor);
  if (!value) throw new Error('Expected the retained tournament.');
  return value;
}

async function gameFor(pairing: TournamentView['games'][number], competition: Authority) {
  const game = env.GAME.get(env.GAME.idFromName(pairing.id));
  const authorityId = competition.id.toString();
  await runInDurableObject(game, async (instance, state) => {
    const internal = instance as unknown as { env: Env; schedule(): Promise<void> };
    const original = internal.env.COMPETITION;
    internal.env = { ...internal.env, COMPETITION: {
      idFromName: (name: string) => original.idFromName(name),
      get: () => original.get(original.idFromString(authorityId)),
    } as unknown as Env['COMPETITION'] };
    internal.schedule = async () => {};
    await state.storage.deleteAlarm();
  });
  return game;
}

async function playDraw(competition: Authority, pairing: TournamentView['games'][number], actors: Actor[]) {
  const white = actors.find(actor => actor.id === pairing.whiteId)!;
  const black = actors.find(actor => actor.id === pairing.blackId)!;
  const game = await gameFor(pairing, competition);
  let snapshot: GameSnapshot = await game.snapshot(white);
  for (const [actor, type] of [[white, 'ready'], [black, 'ready'], [white, 'offer-draw'], [black, 'accept-draw']] as const) {
    const reply = await game.command(actor, { type, id: crypto.randomUUID(), expectedVersion: snapshot.version });
    if (!reply.ok) throw new Error(reply.code);
    snapshot = reply.snapshot;
  }
  const result = (await game.status())!.result!;
  expect(await competition.settle(result)).toEqual({ accepted: true, pending: false });
  await game.flush();
  await competition.flush();
  return result;
}

async function register(competition: Authority, actor: Actor, id: string): Promise<TournamentView> {
  const result = await competition.registerTournament(actor, id);
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

async function registrationError(competition: Authority, actor: Actor, id: string): Promise<string | null> {
  const result = await competition.registerTournament(actor, id);
  return result.ok ? null : result.error.code;
}

describe('scheduled tournament authority', () => {
  it('keeps fixed UTC occurrences idempotent through eviction and skips missed periods after an outage', async () => {
    const { startsAt, clock } = startClock();
    let competition = await authority();
    const first = await competition.listTournaments();
    expect(first.enabled).toBe(true);
    for (const value of first.events) {
      const date = new Date(value.startsAt);
      expect(date.getUTCMinutes()).toBe(0);
      if (value.cadence === 'daily') expect(date.getUTCHours()).toBe(18);
      if (value.cadence === 'weekly') { expect(date.getUTCDay()).toBe(0); expect(date.getUTCHours()).toBe(16); }
    }
    const ids = first.events.map(value => value.id);
    await evictDurableObject(competition);
    competition = await authority(competition);
    expect((await competition.listTournaments()).events.map(value => value.id)).toEqual(ids);
    const later = startsAt + 40 * 24 * HOUR;
    clock.mockReturnValue(later);
    await competition.maintenance();
    const recovered = await competition.listTournaments();
    const created = recovered.events.filter(value => !ids.includes(value.id));
    expect(created.length).toBeLessThanOrEqual(6);
    expect(created.length).toBeGreaterThan(0);
    expect(created.every(value => value.startsAt >= later - TOURNAMENT_LIMITS.startGraceMs)).toBe(true);
    expect(recovered.events.filter(value => ids.includes(value.id)).every(value => value.status === 'cancelled')).toBe(true);
  });

  it('admits accounts without recovery email while enforcing registration windows, guest rejection and entrant limits', async () => {
    const { startsAt, clock } = startClock();
    const competition = await authority();
    const eligible = await player(false, { recoveryEmail: false });
    const guest = await player(true);
    const id = `hourly-${startsAt}`;
    clock.mockReturnValue(startsAt - 16 * 60_000);
    expect(await registrationError(competition, eligible, id)).toBe('REGISTRATION_CLOSED');
    clock.mockReturnValue(startsAt - 10 * 60_000);
    expect(await registrationError(competition, guest, id)).toBe('TOURNAMENT_INELIGIBLE');
    const entrants = [eligible, ...await Promise.all([player(), player(), player()])];
    for (const actor of entrants) await register(competition, actor, id);
    expect((await register(competition, eligible, id)).players).toHaveLength(4);
    expect(await registrationError(competition, await player(), id)).toBe('TOURNAMENT_FULL');
    expect(await hasActiveSeat(env.DB, eligible.id)).toBe(false);
    expect(await competition.queueStatus(eligible)).toEqual({ status: 'idle' });
    const publicView = await event(competition, id);
    expect(publicView.myStatus).toBeNull();
    for (const member of publicView.players) expect(Object.keys(member).sort()).toEqual(['id', 'name', 'status']);
    expect(JSON.stringify(publicView)).not.toContain(eligible.sessionId);
    expect(JSON.stringify(publicView)).not.toContain('placeholder.invalid');
    expect(await env.DB.prepare('SELECT emailVerified FROM user WHERE id=?').bind(eligible.id).first('emailVerified')).toBe(0);
    const withdrawn = await competition.withdrawTournament(eligible, id);
    expect(withdrawn.ok && withdrawn.value.players.length).toBe(3);
    clock.mockReturnValue(startsAt);
    expect(await registrationError(competition, eligible, id)).toBe('REGISTRATION_CLOSED');
  });

  it('skips busy and newly ineligible entrants, then releases an underfilled event without creating games', async () => {
    const { startsAt, clock } = startClock();
    const competition = await authority();
    const { id, actors } = await enter(competition, 4, startsAt);
    const [busy, changed] = actors;
    expect(await acquireSeatGuard(env, busy, crypto.randomUUID())).toBe(true);
    await env.DB.prepare("UPDATE account SET password=NULL WHERE userId=? AND providerId='credential'").bind(changed.id).run();
    clock.mockReturnValue(startsAt);
    await competition.maintenance();
    const value = await event(competition, id);
    expect(value.status).toBe('cancelled');
    expect(value.players.find(actor => actor.id === busy.id)?.status).toBe('not-admitted');
    expect(value.players.find(actor => actor.id === changed.id)?.status).toBe('not-admitted');
    expect((await event(competition, id, busy)).myStatus).toBe('skipped-busy');
    expect((await event(competition, id, changed)).myStatus).toBe('skipped-ineligible');
    expect(JSON.stringify(value)).not.toMatch(/skipped-ineligible|skipped-busy|sessionId/);
    expect(value.games).toHaveLength(0);
    expect(await env.DB.prepare('SELECT COUNT(*) FROM tournament_account_locks WHERE tournament_id=?').bind(id).first('COUNT(*)')).toBe(0);
    for (const actor of actors.slice(2)) expect(await competition.queueStatus(actor)).toEqual({ status: 'idle' });
  });

  it('recovers an account claim committed before a crash without treating its own reservation as busy', async () => {
    const { startsAt, clock } = startClock();
    let competition = await authority();
    const { id, actors } = await enter(competition, 3, startsAt);
    await runInDurableObject(competition, instance => {
      const internal = instance as unknown as { env: Env };
      const original = internal.env.DB;
      let fail = true;
      internal.env = { ...internal.env, DB: new Proxy(original, { get(target, property) {
        if (property !== 'prepare') { const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value; }
        return (sql: string) => {
          const statement = original.prepare(sql);
          if (!fail || !sql.includes('INSERT INTO tournament_account_locks')) return statement;
          return { bind: (...args: unknown[]) => ({ first: async () => {
            const value = await statement.bind(...args).first();
            fail = false;
            throw new Error(`Simulated crash after D1 account claim ${Boolean(value)}`);
          } }) } as unknown as D1PreparedStatement;
        };
      } }) };
    });
    clock.mockReturnValue(startsAt);
    await competition.maintenance();
    expect((await event(competition, id)).status).toBe('starting');
    expect(await env.DB.prepare('SELECT COUNT(*) FROM tournament_account_locks WHERE tournament_id=?').bind(id).first('COUNT(*)')).toBe(1);
    await evictDurableObject(competition);
    competition = await authority(competition);
    clock.mockReturnValue(startsAt + 30_000);
    await competition.maintenance();
    const recovered = await event(competition, id);
    expect(recovered.status).toBe('running');
    expect(recovered.players.every(member => member.status === 'admitted')).toBe(true);
    expect(recovered.games).toHaveLength(1);
    for (const actor of actors) expect(await competition.queueStatus(actor)).toEqual({ status: 'tournament', pool: 'blitz', tournamentId: id });
    expect(await env.DB.prepare('SELECT COUNT(*) FROM tournament_game_admissions WHERE tournament_id=?').bind(id).first('COUNT(*)')).toBe(3);
  });

  it('resumes the same persisted game after an uncertain init and never resets its wall deadline', async () => {
    const { startsAt, clock } = startClock();
    let competition = await authority();
    const { id } = await enter(competition, 3, startsAt);
    await runInDurableObject(competition, instance => {
      const internal = instance as unknown as { env: Env };
      const original = internal.env.GAME;
      let fail = true;
      internal.env = { ...internal.env, GAME: {
        idFromName: (name: string) => original.idFromName(name),
        get: (gameId: DurableObjectId) => {
          const game = original.get(gameId);
          return { status: () => game.status(), init: async (input: InitGame) => {
            const value = await game.init(input);
            if (fail) { fail = false; throw new Error('Simulated lost init response.'); }
            return value;
          } };
        },
      } as unknown as Env['GAME'] };
    });
    clock.mockReturnValue(startsAt);
    await competition.maintenance();
    const uncertain = await event(competition, id);
    expect(uncertain.games).toHaveLength(1);
    expect(uncertain.games[0].status).toBe('creating');
    const white = uncertain.games[0].whiteId;
    const participant = await runInDurableObject(competition, (_instance, state) => {
      const row = state.storage.sql.exec<{ value: string }>('SELECT value FROM tournaments WHERE id=?', id).one();
      return (JSON.parse(row.value) as { members: { actor: Actor }[] }).members.find(member => member.actor.id === white)!.actor;
    });
    expect((await event(competition, id, participant)).myGameId).toBeNull();
    await evictDurableObject(competition);
    competition = await authority(competition);
    clock.mockReturnValue(startsAt + 30_000);
    await competition.maintenance();
    const recovered = await event(competition, id);
    expect(recovered.games[0].id).toBe(uncertain.games[0].id);
    expect(recovered.games[0].status).toBe('ready');
    expect(recovered.roundDeadlineAt).toBe(uncertain.roundDeadlineAt);
    expect(recovered.reason).toBeNull();
    expect((await event(competition, id, participant)).myGameId).toBe(recovered.games[0].id);
  });

  it('keeps overlapping events from booking the same accounts', async () => {
    const current = new Date(Date.now());
    let startsAt = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate(), 18);
    if (startsAt <= Date.now() + 15 * 60_000) startsAt += 86_400_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(startsAt - 10 * 60_000);
    const competition = await authority();
    const actors = await Promise.all([player(), player(), player()]);
    await competition.listTournaments();
    for (const actor of actors) {
      await register(competition, actor, `daily-${startsAt}`);
      await register(competition, actor, `hourly-${startsAt}`);
    }
    clock.mockReturnValue(startsAt);
    await competition.maintenance();
    const daily = await event(competition, `daily-${startsAt}`);
    const hourly = await event(competition, `hourly-${startsAt}`);
    expect([daily.status, hourly.status].sort()).toEqual(['cancelled', 'running']);
    const running = daily.status === 'running' ? daily : hourly;
    const cancelled = daily.status === 'cancelled' ? daily : hourly;
    expect(cancelled.games).toHaveLength(0);
    for (const actor of actors) {
      expect(await env.DB.prepare('SELECT tournament_id FROM tournament_account_locks WHERE user_id=?').bind(actor.id).first('tournament_id')).toBe(running.id);
      expect(await acquireSeatGuard(env, actor, crypto.randomUUID())).toBe(false);
      expect((await competition.joinQueue(actor, 'rapid')).status).toBe('tournament');
    }
  });

  it('drains a start accepted in D1 before a lost response without abandoning IDs or extending its first cutoff', async () => {
    const { startsAt, clock } = startClock();
    let competition = await authority();
    const { id } = await enter(competition, 3, startsAt);
    await runInDurableObject(competition, instance => {
      const internal = instance as unknown as { env: Env };
      const original = internal.env.DB;
      internal.env = { ...internal.env, DB: new Proxy(original, { get(target, property) {
        if (property !== 'prepare') { const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value; }
        return (sql: string) => {
          const statement = original.prepare(sql);
          if (!sql.includes('INSERT INTO tournament_game_admissions')) return statement;
          return { bind: (...args: unknown[]) => ({ run: async () => {
            await statement.bind(...args).run();
            throw new Error('Simulated lost D1 admission response.');
          } }) } as unknown as D1PreparedStatement;
        };
      } }) };
    });
    clock.mockReturnValue(startsAt);
    await competition.maintenance();
    expect((await event(competition, id)).status).toBe('starting');
    expect(await env.DB.prepare('SELECT COUNT(*) FROM tournament_game_admissions WHERE tournament_id=?').bind(id).first('COUNT(*)')).toBe(3);
    await evictDurableObject(competition);
    competition = await authority(competition);
    clock.mockReturnValue(startsAt + 30 * 60_000);
    await competition.maintenance();
    const drained = await event(competition, id);
    expect(drained.status).toBe('intermission');
    expect(drained.round).toBe(1);
    expect(drained.roundDeadlineAt).toBe(startsAt + 18 * 60_000);
    expect(drained.games).toHaveLength(1);
    expect(drained.games[0]).toMatchObject({ status: 'finished', whitePoints: 0, blackPoints: 0 });
    expect(await env.DB.prepare('SELECT COUNT(*) FROM tournament_game_admissions WHERE tournament_id=?').bind(id).first('COUNT(*)')).toBe(3);
  });

  it('voids a later round before readiness when a credential is removed during intermission and hides that reason publicly', async () => {
    const { startsAt, clock } = startClock();
    const competition = await authority();
    const { id, actors } = await enter(competition, 4, startsAt);
    clock.mockReturnValue(startsAt);
    await competition.maintenance();
    for (const pairing of (await event(competition, id)).games) await playDraw(competition, pairing, actors);
    const intermission = await event(competition, id);
    await env.DB.prepare("UPDATE account SET password=NULL WHERE userId=? AND providerId='credential'").bind(actors[0].id).run();
    clock.mockReturnValue(intermission.nextRoundAt!);
    await competition.maintenance();
    const publicView = await event(competition, id);
    const pairing = publicView.games.find(value => value.round === 2 && [value.whiteId, value.blackId].includes(actors[0].id))!;
    expect(pairing).toMatchObject({ status: 'finished', whitePoints: 0, blackPoints: 0, reason: 'technical-void' });
    expect(JSON.stringify(publicView)).not.toContain('eligibility-revoked');
    const game = await gameFor(pairing, competition);
    const terminal = (await game.status())!.result!;
    expect(terminal).toMatchObject({ startedAt: null, outcome: { reason: 'eligibility-revoked', score: null, winner: null } });
    expect(await env.DB.prepare('SELECT 1 FROM active_game_seats WHERE user_id=? AND game_id=? AND released_at IS NULL').bind(actors[0].id, pairing.id).first()).toBeNull();
    expect(publicView.standings.find(row => row.id === actors[0].id)?.points).toBe(0.5);
  });

  it('runs all three rounds, publishes exact shared ranks, and releases accounts after idempotent settlement', async () => {
    const { startsAt, clock } = startClock();
    let competition = await authority();
    const { id, actors } = await enter(competition, 4, startsAt);
    clock.mockReturnValue(startsAt);
    await competition.maintenance();
    const results = [];
    for (let round = 1; round <= 3; round++) {
      const current = await event(competition, id);
      expect(current.round).toBe(round);
      expect(current.games.filter(pairing => pairing.round === round)).toHaveLength(2);
      for (const pairing of current.games.filter(pairing => pairing.round === round)) results.push(await playDraw(competition, pairing, actors));
      const settled = await event(competition, id);
      if (round < 3) {
        expect(settled.status).toBe('intermission');
        expect(await acquireSeatGuard(env, actors[0], crypto.randomUUID())).toBe(false);
        expect((await competition.joinQueue(actors[0], 'rapid')).status).toBe('tournament');
        await evictDurableObject(competition);
        competition = await authority(competition);
        clock.mockReturnValue(settled.nextRoundAt!);
        await competition.maintenance();
      }
    }
    const before = await event(competition, id);
    expect(before.status).toBe('finished');
    expect(before.games).toHaveLength(6);
    expect(new Set(before.games.map(pairing => [pairing.whiteId, pairing.blackId].sort().join(':'))).size).toBe(6);
    expect(before.standings.map(row => [row.rank, row.points])).toEqual([[1, 1.5], [1, 1.5], [1, 1.5], [1, 1.5]]);
    expect(before.standings.map(row => row.id)).toEqual(actors.map(actor => actor.id).sort());
    for (const result of results) expect(await competition.settle(result)).toEqual({ accepted: true, pending: false });
    expect((await event(competition, id)).standings).toEqual(before.standings);
    clock.mockReturnValue(Date.now() + 1);
    await competition.maintenance();
    expect(await env.DB.prepare('SELECT COUNT(*) FROM tournament_account_locks WHERE tournament_id=?').bind(id).first('COUNT(*)')).toBe(0);
    for (const actor of actors) { expect(await competition.queueStatus(actor)).toEqual({ status: 'idle' }); expect(await hasActiveSeat(env.DB, actor.id)).toBe(false); }
    expect(await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec('SELECT game_id FROM rating_events').toArray())).toHaveLength(0);
    expect(await env.DB.prepare('SELECT COUNT(*) FROM games WHERE rated=0 AND score=0.5 AND terminal_digest IS NOT NULL AND id IN (SELECT game_id FROM tournament_game_admissions WHERE tournament_id=?)').bind(id).first('COUNT(*)')).toBe(6);
  });

  it('keeps no-show points separate from chess outcomes and counts one bye per entrant', async () => {
    const { startsAt, clock } = startClock();
    const competition = await authority();
    const { id, actors } = await enter(competition, 3, startsAt);
    clock.mockReturnValue(startsAt);
    await competition.maintenance();
    const awards = new Map(actors.map(actor => [actor.id, 0]));
    for (let round = 1; round <= 3; round++) {
      const current = await event(competition, id);
      const pairing = current.games.find(value => value.round === round)!;
      const bye = actors.find(actor => ![pairing.whiteId, pairing.blackId].includes(actor.id))!;
      awards.set(bye.id, awards.get(bye.id)! + 1);
      const game = await gameFor(pairing, competition);
      const white = actors.find(actor => actor.id === pairing.whiteId)!;
      const snapshot = await game.snapshot(white);
      if (round === 1) {
        const ready = await game.command(white, { type: 'ready', id: crypto.randomUUID(), expectedVersion: snapshot.version });
        expect(ready.ok).toBe(true);
        awards.set(white.id, awards.get(white.id)! + 1);
      }
      clock.mockReturnValue(snapshot.readinessDeadline!);
      await game.status();
      await game.flush();
      await competition.flush();
      const ended = (await game.status())!.result!;
      expect(ended.outcome).toMatchObject({ score: null, winner: null, reason: 'readiness-expired' });
      expect(await env.DB.prepare('SELECT score,settlement FROM games WHERE id=?').bind(pairing.id).first()).toEqual({ score: null, settlement: 'unrated' });
      const settled = await event(competition, id);
      const score = settled.games.find(value => value.id === pairing.id)!;
      expect([score.whitePoints, score.blackPoints]).toEqual(round === 1 ? [1, 0] : [0, 0]);
      if (round < 3) { clock.mockReturnValue(settled.nextRoundAt!); await competition.maintenance(); }
    }
    const completed = await event(competition, id);
    expect(completed.status).toBe('finished');
    for (const standing of completed.standings) expect(standing.points).toBe(awards.get(standing.id));
    expect([...awards.values()].reduce((sum, points) => sum + points, 0)).toBe(4);
  });

  it('serializes casual and tournament account claims and rejects casual reuse of a reserved tournament ID', async () => {
    const competition = await authority();
    const actor = await player();
    const casualId = crypto.randomUUID();
    const [tournament, casual] = await Promise.all([
      acquireTournamentAccount(env, actor, 'concurrent-event'), acquireSeatGuard(env, actor, casualId),
    ]);
    expect([tournament, casual].filter(Boolean)).toHaveLength(1);
    const other = await player();
    const tournamentId = 'claimed-event';
    const gameId = crypto.randomUUID();
    expect(await acquireTournamentAccount(env, other, tournamentId)).toBe(true);
    await env.DB.batch([
      env.DB.prepare('INSERT INTO tournament_game_admissions(game_id,tournament_id,created_at) VALUES(?,?,?)').bind(gameId, tournamentId, Date.now()),
      env.DB.prepare('INSERT INTO active_game_seats(user_id,game_id,acquired_at) VALUES(?,?,?)').bind(other.id, gameId, Date.now()),
    ]);
    expect(await acquireSeatGuard(env, other, gameId)).toBe(false);
    expect(await env.DB.prepare('SELECT 1 FROM casual_game_admissions WHERE game_id=?').bind(gameId).first()).toBeNull();
    expect((await competition.listTournaments()).events.length).toBeGreaterThan(0);
  });

  it('closes admission at retained and permanent storage ceilings without booking accounts', async () => {
    const { startsAt, clock } = startClock();
    const competition = await authority();
    const { id } = await enter(competition, 3, startsAt);
    const alreadyRetained = await env.DB.prepare("SELECT COUNT(*) FROM tournament_game_admissions WHERE storage_state='retained'").first<number>('COUNT(*)');
    await env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
      INSERT INTO tournament_game_admissions(game_id,tournament_id,created_at) SELECT 'cap-'||i,'fixture',? FROM n`)
      .bind(TOURNAMENT_LIMITS.retainedGames - (alreadyRetained ?? 0), Date.now()).run();
    clock.mockReturnValue(startsAt);
    await competition.maintenance();
    expect((await event(competition, id)).status).toBe('cancelled');
    expect(await env.DB.prepare('SELECT COUNT(*) FROM tournament_account_locks WHERE tournament_id=?').bind(id).first('COUNT(*)')).toBe(0);
    expect(await env.DB.prepare('SELECT COUNT(*) FROM tournament_game_admissions WHERE tournament_id=?').bind(id).first('COUNT(*)')).toBe(0);
    await env.DB.prepare("UPDATE tournament_game_admissions SET storage_state='archived',archived_at=?").bind(Date.now()).run();
    clock.mockReturnValue(startsAt + HOUR - 10 * 60_000);
    const next = await enter(competition, 3, startsAt + HOUR);
    const total = await env.DB.prepare('SELECT COUNT(*) FROM tournament_game_admissions').first<number>('COUNT(*)');
    await env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT ?+1 UNION ALL SELECT i+1 FROM n WHERE i<?)
      INSERT INTO tournament_game_admissions(game_id,tournament_id,created_at,storage_state,archived_at)
      SELECT 'cap-'||i,'fixture',?,'archived',? FROM n`)
      .bind(total ?? 0, TOURNAMENT_LIMITS.permanentGameIds, Date.now(), Date.now()).run();
    clock.mockReturnValue(startsAt + HOUR);
    await competition.maintenance();
    expect((await event(competition, next.id)).status).toBe('cancelled');
    expect(await env.DB.prepare('SELECT COUNT(*) FROM tournament_game_admissions').first('COUNT(*)')).toBe(TOURNAMENT_LIMITS.permanentGameIds);
  });
});

it('reuses retired casual payload capacity while retaining a separate permanent game ID ceiling', async () => {
  const actor = await player();
  const counts = await env.DB.prepare(`SELECT COUNT(*) AS total,SUM(CASE WHEN storage_state='retained' THEN 1 ELSE 0 END) AS retained
    FROM casual_game_admissions`).first<{ total: number; retained: number | null }>();
  const limited = { ...env, CASUAL_GAME_LIMIT: String((counts?.retained ?? 0) + 1), CASUAL_GAME_ID_LIMIT: String((counts?.total ?? 0) + 2) };
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  expect(await acquireSeatGuard(limited, actor, first)).toBe(true);
  expect(await acquireSeatGuard(limited, actor, second)).toBe(false);
  await env.DB.prepare("UPDATE casual_game_admissions SET storage_state='archived',archived_at=? WHERE game_id=?").bind(Date.now(), first).run();
  expect(await acquireSeatGuard(limited, actor, second)).toBe(true);
  await env.DB.prepare("UPDATE casual_game_admissions SET storage_state='archived',archived_at=? WHERE game_id=?").bind(Date.now(), second).run();
  expect(await acquireSeatGuard(limited, actor, crypto.randomUUID())).toBe(false);
  expect(await acquireSeatGuard({ ...limited, CASUAL_GAME_ID_LIMIT: '100001' }, actor, crypto.randomUUID())).toBe(false);
});
