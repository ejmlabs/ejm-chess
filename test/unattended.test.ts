import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADJUDICATION_WAIT_MS, GAME_HOT_RETENTION_MS } from '../src/server/game';
import { maintainUnattendedGames, retireGamePayloads } from '../src/server/maintenance';
import { recordEvidence } from '../src/server/fairplay';
import { activeGame, player } from './authority-helpers';
import type { Env } from '../src/server/env';
import type { GameResult } from '../src/shared/protocol';

afterEach(() => { vi.restoreAllMocks(); });
beforeEach(async () => { await env.DB.prepare('DELETE FROM maintenance_budgets').run(); });

async function completedGame() {
  const setup = await activeGame();
  await setup.game.command(setup.white, { type: 'resign', id: crypto.randomUUID(), expectedVersion: setup.snapshot.version });
  await setup.game.flush();
  await env.COMPETITION.get(env.COMPETITION.idFromName('global')).flush();
  const result = (await setup.game.status())!.result!;
  return { ...setup, result, proof: { gameId: result.id, expectedVersion: result.version, terminalDigest: result.terminalDigest } };
}

async function archiveError(game: Awaited<ReturnType<typeof completedGame>>['game'], proof: { gameId: string; expectedVersion: number; terminalDigest: string }) {
  return runInDurableObject(game, async instance => {
    try { await instance.archive(proof); return null; }
    catch (error) { return (error as Error).message; }
  });
}

async function stopFixtureAlarms(game: Awaited<ReturnType<typeof activeGame>>['game']) {
  // These fixtures isolate the Game cutoff contract; tournament authority integration owns registration and delivery tests.
  await runInDurableObject(game, async (instance, state) => {
    (instance as unknown as { schedule(): Promise<void> }).schedule = async () => {};
    await state.storage.deleteAlarm();
  });
}

describe('unattended recovery and payload retirement', () => {
  it('voids one uncertain timeout at 30 seconds after restart and repairs a lost alarm through the admission ledger', async () => {
    const { game, white, black, snapshot } = await activeGame();
    await env.DB.batch([white, black].map(actor => env.DB.prepare('INSERT INTO active_game_seats(user_id,game_id,acquired_at) VALUES(?,?,?)')
      .bind(actor.id, snapshot.id, Date.now())));
    const deadline = snapshot.clocks.deadline!;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(deadline);
    expect((await game.status())?.status).toBe('pending-adjudication');
    clock.mockReturnValue(deadline + ADJUDICATION_WAIT_MS - 1);
    expect((await game.status())?.status).toBe('pending-adjudication');
    await evictDurableObject(game);
    clock.mockReturnValue(deadline + ADJUDICATION_WAIT_MS);
    const maintained = await maintainUnattendedGames(env);
    expect(maintained.recovery).toEqual({ attempted: 1, completed: 1, failed: 0 });
    const terminal = await game.status();
    expect(terminal).toMatchObject({ status: 'finished', version: snapshot.version + 2,
      result: { endedAt: deadline + ADJUDICATION_WAIT_MS, outcome: { reason: 'technical-void', score: null, winner: null } } });
    await game.flush();
    await env.COMPETITION.get(env.COMPETITION.idFromName('global')).flush();
    await evictDurableObject(game);
    expect(await game.status()).toEqual(terminal);
    expect(await env.DB.prepare('SELECT COUNT(*) FROM active_game_seats WHERE game_id=? AND released_at IS NULL').bind(snapshot.id).first('COUNT(*)')).toBe(0);
    expect(await env.DB.prepare('SELECT reason,score,settlement FROM games WHERE id=?').bind(snapshot.id).first()).toEqual({ reason: 'technical-void', score: null, settlement: 'unrated' });
    const competition = env.COMPETITION.get(env.COMPETITION.idFromName('global'));
    const events = await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec<{ payload: string }>('SELECT payload FROM result_events WHERE game_id=?', snapshot.id).toArray());
    expect(events.filter(row => (JSON.parse(row.payload) as GameResult).status === 'finished')).toHaveLength(1);
  });

  it('preserves legacy game rules and cached receipts while v2 recovery closes an old pending timeout', async () => {
    const { game, white, black, snapshot } = await activeGame();
    expect(snapshot.rulesVersion).toBe('online-2026-10-v2-unattended');
    await env.DB.batch([white, black].map(actor => env.DB.prepare('INSERT INTO active_game_seats(user_id,game_id,acquired_at) VALUES(?,?,?)')
      .bind(actor.id, snapshot.id, Date.now())));
    await runInDurableObject(game, (_instance, state) => {
      const stored = JSON.parse(state.storage.sql.exec<{ value: string }>('SELECT value FROM game_state').one().value);
      stored.rulesVersion = 'online-2026-10-v1';
      state.storage.sql.exec('UPDATE game_state SET value=?', JSON.stringify(stored));
    });
    const deadline = snapshot.clocks.deadline!;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(deadline);
    const pending = (await game.status())!.result!;
    expect(pending.rulesVersion).toBe('online-2026-10-v1');
    expect(pending.pgn).not.toContain('[Termination ');
    expect(JSON.parse(pending.terminalDigest)).toHaveLength(12);
    await evictDurableObject(game);
    await game.flush();
    const competition = env.COMPETITION.get(env.COMPETITION.idFromName('global'));
    await competition.flush();
    expect(await env.DB.prepare('SELECT status,rules_version FROM games WHERE id=?').bind(snapshot.id).first())
      .toEqual({ status: 'pending-adjudication', rules_version: 'online-2026-10-v1' });
    clock.mockReturnValue(deadline + ADJUDICATION_WAIT_MS);
    await maintainUnattendedGames(env);
    await competition.flush();
    const result = (await game.status())!.result!;
    expect(result).toMatchObject({ rulesVersion: 'online-2026-10-v1', status: 'finished',
      outcome: { score: null, reason: 'technical-void', decisionId: expect.stringContaining('online-2026-10-v2-unattended') } });
    expect(await env.DB.prepare('SELECT status,rules_version,settlement FROM games WHERE id=?').bind(snapshot.id).first())
      .toEqual({ status: 'finished', rules_version: 'online-2026-10-v1', settlement: 'unrated' });
    expect(await env.DB.prepare('SELECT COUNT(*) FROM active_game_seats WHERE game_id=? AND released_at IS NULL').bind(snapshot.id).first('COUNT(*)')).toBe(0);
    const unknown = await runInDurableObject(competition, async instance => {
      try { await instance.settle({ ...result, rulesVersion: 'unknown-policy' }); return null; }
      catch (error) { return (error as Error).message; }
    });
    expect(unknown).toBe('invalid_result');
  });

  it('records revoked tournament eligibility before a new ready state can escape', async () => {
    const [white, black] = await Promise.all([player(), player()]);
    await env.DB.prepare("UPDATE account SET password=NULL WHERE userId=? AND providerId='credential'").bind(black.id).run();
    const id = crypto.randomUUID();
    const game = env.GAME.get(env.GAME.idFromName(id));
    await stopFixtureAlarms(game);
    const result = await game.init({ id, white, black, format: 'blitz', rated: false, reservationId: `event:${id}`,
      tournament: { id: 'hourly:blitz:revoked', round: 2, deadlineAt: Date.now() + 1_080_000 } });
    expect(result).toMatchObject({ status: 'finished', version: 1, startedAt: null,
      outcome: { reason: 'eligibility-revoked', score: null, winner: null } });
    await evictDurableObject(game);
    await stopFixtureAlarms(game);
    expect(await game.snapshot(white)).toMatchObject({ status: 'finished', version: 1, outcome: result.outcome });
  });

  it('uses the stored tournament cutoff, preserves a prior readiness expiry, and ignores late duplicates', async () => {
    const [white, black] = await Promise.all([player(), player()]);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const id = crypto.randomUUID();
    const game = env.GAME.get(env.GAME.idFromName(id));
    await stopFixtureAlarms(game);
    const tournament = { id: 'hourly:blitz:fixture', round: 1, deadlineAt: now + 60_000 };
    await game.init({ id, white, black, rated: false, format: 'blitz', reservationId: `event:${id}`, tournament });
    await game.command(white, { type: 'ready', id: crypto.randomUUID(), expectedVersion: 0 });
    await game.command(black, { type: 'ready', id: crypto.randomUUID(), expectedVersion: 1 });
    expect((await game.enforceTournamentDeadline(tournament.id, 1))?.status).toBe('active');
    clock.mockReturnValue(tournament.deadlineAt);
    const ended = await game.enforceTournamentDeadline(tournament.id, 1);
    expect(ended).toMatchObject({ status: 'finished', endedAt: tournament.deadlineAt,
      outcome: { reason: 'technical-void', score: null, decisionId: `tournament:${tournament.id}:round:1:deadline` } });
    await evictDurableObject(game);
    await stopFixtureAlarms(game);
    expect(await game.enforceTournamentDeadline(tournament.id, 1)).toMatchObject({ version: ended!.version, outcome: ended!.outcome });
    const otherId = crypto.randomUUID();
    const other = env.GAME.get(env.GAME.idFromName(otherId));
    await stopFixtureAlarms(other);
    const waiting = await other.init({ id: otherId, white, black, rated: false, format: 'blitz', reservationId: `event:${otherId}`,
      tournament: { ...tournament, round: 2, deadlineAt: Date.now() + 600_000 } });
    clock.mockReturnValue(Date.now() + 600_000);
    expect(await other.enforceTournamentDeadline(tournament.id, 2)).toMatchObject({ status: 'finished', endedAt: waiting.readinessDeadline,
      outcome: { reason: 'readiness-expired', score: null } });
    const mismatch = await runInDurableObject(game, async instance => {
      try { await instance.enforceTournamentDeadline('another-event', 1); return null; }
      catch (error) { return (error as Error).message; }
    });
    expect(mismatch).toBe('tournament_context_mismatch');
  });

  it('requires the exact persisted result, elapsed retention, released seats, and no evidence hold', async () => {
    const setup = await completedGame();
    expect(await archiveError(setup.game, setup.proof)).toBe('archive_not_ready');
    const now = setup.result.endedAt + GAME_HOT_RETENTION_MS;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    expect(await archiveError(setup.game, { ...setup.proof, terminalDigest: 'untrusted' })).toBe('archive_conflict');
    await env.DB.prepare('UPDATE games SET terminal_digest=? WHERE id=?').bind('wrong', setup.result.id).run();
    expect(await archiveError(setup.game, setup.proof)).toBe('archive_not_proved');
    await env.DB.prepare('UPDATE games SET terminal_digest=? WHERE id=?').bind(setup.result.terminalDigest, setup.result.id).run();
    await env.DB.prepare('UPDATE games SET rules_version=? WHERE id=?').bind('another-policy', setup.result.id).run();
    expect(await archiveError(setup.game, setup.proof)).toBe('archive_not_proved');
    await env.DB.prepare('UPDATE games SET rules_version=? WHERE id=?').bind(setup.result.rulesVersion, setup.result.id).run();
    await env.DB.prepare('INSERT INTO active_game_seats(user_id,game_id,acquired_at) VALUES(?,?,?)').bind(setup.white.id, setup.result.id, now).run();
    expect(await archiveError(setup.game, setup.proof)).toBe('archive_not_proved');
    await env.DB.prepare('UPDATE active_game_seats SET released_at=? WHERE game_id=?').bind(now, setup.result.id).run();
    const caseId = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO fairplay_cases(id,subject_id,game_id,created_at,updated_at) VALUES(?,?,?,?,?)')
      .bind(caseId, setup.black.id, setup.result.id, now, now).run();
    const evidence = { caseId, gameId: setup.result.id, kind: 'server_game' as const, sourceRef: setup.result.id,
      sourceVersion: String(setup.result.version), summary: { moveCount: setup.result.plies } };
    await env.DB.prepare('UPDATE casual_game_admissions SET archive_error=?,archive_retry_at=? WHERE game_id=?')
      .bind(`retiring:${crypto.randomUUID()}`, now + 300_000, setup.result.id).run();
    await expect(recordEvidence(env, evidence)).rejects.toMatchObject({ code: 'EVIDENCE_CAPACITY' });
    await env.DB.prepare('UPDATE casual_game_admissions SET archive_error=NULL,archive_retry_at=0 WHERE game_id=?').bind(setup.result.id).run();
    await recordEvidence(env, evidence);
    expect(await archiveError(setup.game, setup.proof)).toBe('archive_not_proved');
    expect((await setup.game.status())?.status).toBe('finished');
  });

  it('keeps a stable tombstone across partial failure and retains replay history without allowing ID reuse', async () => {
    const setup = await completedGame();
    const now = setup.result.endedAt + GAME_HOT_RETENTION_MS;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const receipt = await setup.game.archive(setup.proof);
    expect(await env.DB.prepare('SELECT storage_state FROM casual_game_admissions WHERE game_id=?').bind(setup.result.id).first('storage_state')).toBe('retained');
    await evictDurableObject(setup.game);
    expect(await setup.game.archive(setup.proof)).toEqual(receipt);
    const reused = await runInDurableObject(setup.game, async instance => {
      try { await instance.init({ id: setup.result.id, white: setup.white, black: setup.black, format: 'blitz', rated: false }); return null; }
      catch (error) { return (error as Error).message; }
    });
    expect(reused).toBe('game_archived');
    vi.mocked(Date.now).mockReturnValue(now + 300_000);
    const caseId = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO fairplay_cases(id,subject_id,game_id,created_at,updated_at) VALUES(?,?,?,?,?)')
      .bind(caseId, setup.black.id, setup.result.id, Date.now(), Date.now()).run();
    await recordEvidence(env, { caseId, gameId: setup.result.id, kind: 'server_game', sourceRef: setup.result.id,
      sourceVersion: String(setup.result.version), summary: { moveCount: setup.result.plies } });
    expect(await retireGamePayloads(env)).toEqual({ attempted: 1, completed: 1, failed: 0 });
    expect(await env.DB.prepare('SELECT storage_state,terminal_version,terminal_digest FROM casual_game_admissions WHERE game_id=?').bind(setup.result.id).first())
      .toEqual({ storage_state: 'archived', terminal_version: setup.result.version, terminal_digest: setup.result.terminalDigest });
    expect(await env.DB.prepare('SELECT pgn,result_version,rules_version FROM games WHERE id=?').bind(setup.result.id).first())
      .toEqual({ pgn: setup.result.pgn, result_version: setup.result.version, rules_version: setup.result.rulesVersion });
    const sizes = await runInDurableObject(setup.game, (_instance, state) => ({
      payload: state.storage.sql.exec('SELECT * FROM game_state').toArray().length,
      commands: state.storage.sql.exec('SELECT * FROM command_receipts').toArray().length,
      tombstones: state.storage.sql.exec('SELECT * FROM archived_game').toArray().length,
    }));
    expect(sizes).toEqual({ payload: 0, commands: 0, tombstones: 1 });
    expect(await setup.game.status()).toBeNull();
  });

  it('limits all retries to four retirements per minute and cools failures so later games can proceed', async () => {
    const games = [];
    for (let i = 0; i < 6; i++) games.push(await completedGame());
    const now = Math.ceil((Date.now() + GAME_HOT_RETENTION_MS) / 60_000) * 60_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const failing = { ...env, GAME: { idFromName: env.GAME.idFromName.bind(env.GAME), get: () => ({ archive: async () => { throw new Error('unavailable'); } }) } } as unknown as Env;
    expect(await retireGamePayloads(failing)).toEqual({ attempted: 4, completed: 0, failed: 4 });
    expect(await retireGamePayloads(env)).toEqual({ attempted: 0, completed: 0, failed: 0 });
    clock.mockReturnValue(now + 60_000);
    expect(await retireGamePayloads(env)).toEqual({ attempted: 2, completed: 2, failed: 0 });
    clock.mockReturnValue(now + 300_000);
    expect(await retireGamePayloads(env)).toEqual({ attempted: 4, completed: 4, failed: 0 });
    expect((await env.DB.prepare(`SELECT game_id FROM casual_game_admissions WHERE storage_state='archived'
      AND game_id IN (${games.map(() => '?').join(',')})`).bind(...games.map(game => game.result.id)).all()).results).toHaveLength(6);
  });
});
