import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GAME_HOT_RETENTION_MS } from '../src/server/game';
import { nextRetirementAt, retireGamePayloads, retirementMode, runScaledRetirementPass } from '../src/server/maintenance';
import { activeGame, gamesAnswering, holdAlarms, patchBindings, player } from './authority-helpers';

const authority = () => env.COMPETITION.get(env.COMPETITION.idFromName('global'));
const scaled = () => ({ ...env, GAME_RETIREMENT_MODE: 'scaled' });

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM game_retirement_work').run();
  await env.DB.prepare('UPDATE game_retirement_budget SET tokens_milli=32000,refilled_at=0').run();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await runInDurableObject(authority(), async (_instance, state) => { await state.storage.deleteAlarm(); });
  await evictDurableObject(authority());
});

async function fixtures(count: number, now: number) {
  const creator = await player();
  const prefix = crypto.randomUUID();
  const ids = Array.from({ length: count }, (_, index) => `${prefix}-${String(index).padStart(4, '0')}`);
  for (const id of ids) {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO casual_game_admissions(game_id,creator_id,created_at) VALUES(?,?,?)').bind(id, creator.id, now - GAME_HOT_RETENTION_MS - 100),
      env.DB.prepare(`INSERT INTO games(id,pool,rated,white_id,white_name,status,reason,score,ended_at,created_at,pgn,plies,
        rules_version,result_version,projection_epoch,projection_version,projected_at,settlement,terminal_digest)
        VALUES(?,'blitz',0,?,'Fixture','finished','resignation',1,?,?,'',1,'test-only',3,1,1,?,'unrated',?)`)
        .bind(id, creator.id, now - GAME_HOT_RETENTION_MS - 1, now - GAME_HOT_RETENTION_MS - 100, now, id),
    ]);
  }
  return { ids, creator };
}

const archives = { calls: [] as string[], active: 0, peak: 0 };

async function fakeArchives(failures: string[] = []) {
  Object.assign(archives, { calls: [], active: 0, peak: 0 });
  await holdAlarms(authority(), { GAME_RETIREMENT_MODE: 'scaled' });
  await patchBindings(authority(), gamesAnswering(() => ({
    archive: async (proof: { gameId: string; expectedVersion: number; terminalDigest: string }) => {
      archives.calls.push(proof.gameId); archives.active++; archives.peak = Math.max(archives.peak, archives.active);
      await env.DB.prepare('SELECT 1').first();
      archives.active--;
      if (failures.includes(proof.gameId)) throw new Error('injected_unavailability');
      return { gameId: proof.gameId, terminalVersion: proof.expectedVersion, terminalDigest: proof.terminalDigest, archivedAt: Date.now() };
    },
  })));
}

it('routes concurrent scaled callers through one pass and preserves a real tombstone and replay across restart', async () => {
  const setup = await activeGame();
  await setup.game.command(setup.white, { type: 'resign', id: crypto.randomUUID(), expectedVersion: setup.snapshot.version });
  await setup.game.flush(); await authority().flush();
  const result = (await setup.game.status())!.result!;
  const now = result.endedAt + GAME_HOT_RETENTION_MS;
  vi.spyOn(Date, 'now').mockReturnValue(now);
  await holdAlarms(authority(), scaled());
  const replies = await Promise.all(Array.from({ length: 4 }, () => retireGamePayloads(scaled())));
  expect(replies.reduce((sum, row) => sum + row.attempted, 0)).toBe(1);
  expect(replies.reduce((sum, row) => sum + row.completed, 0)).toBe(1);
  expect(await env.DB.prepare('SELECT pgn FROM games WHERE id=?').bind(result.id).first('pgn')).toBe(result.pgn);
  expect(await env.DB.prepare('SELECT storage_state FROM casual_game_admissions WHERE game_id=?').bind(result.id).first('storage_state')).toBe('archived');
  expect(await env.DB.prepare('SELECT game_id FROM game_retirement_work WHERE game_id=?').bind(result.id).first()).toBeNull();
  await evictDurableObject(setup.game);
  expect(await setup.game.archive({ gameId: result.id, expectedVersion: result.version, terminalDigest: result.terminalDigest }))
    .toMatchObject({ gameId: result.id, terminalVersion: result.version, terminalDigest: result.terminalDigest, archivedAt: now });
  expect(await setup.game.status()).toBeNull();
});

it('keeps a shared persisted token bucket, four in-flight calls, and progress beyond held or failed oldest rows', async () => {
  const now = Date.now() + GAME_HOT_RETENTION_MS;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  const { ids, creator } = await fixtures(72, now);
  await env.DB.prepare('INSERT INTO active_game_seats(user_id,game_id,acquired_at) VALUES(?,?,?)').bind(creator.id, ids[0], now).run();
  const cases = Array.from({ length: 3 }, () => crypto.randomUUID());
  for (const [index, caseId] of cases.entries()) {
    await env.DB.prepare('INSERT INTO fairplay_cases(id,subject_id,game_id,created_at,updated_at) VALUES(?,?,?,?,?)')
      .bind(caseId, creator.id, index === 2 ? crypto.randomUUID() : ids[index + 1], now, now).run();
    if (index !== 1) await env.DB.prepare(`INSERT INTO fairplay_evidence(id,case_id,game_id,kind,source_ref,source_version,summary_json,created_at,expires_at)
      VALUES(?,?,?,'server_game',?,'3','{}',?,?)`).bind(crypto.randomUUID(), caseId, ids[index + 1], ids[index + 1], now,
      index === 0 ? now + 300_000 : now - 1).run();
    if (index !== 0) {
      const decisionId = crypto.randomUUID();
      // Persisted reviewed-case fixtures exercise both a case's main game and
      // expired related evidence. They do not invoke a new case decision.
      await env.DB.prepare(`INSERT INTO fairplay_decisions(id,case_id,subject_id,reviewer_id,outcome,reason,review_note,corroboration,
        evidence_ids,request_hash,created_at,appeal_until) VALUES(?,?,?,?,'clear','Fixture decision','','','[]','fixture',?,?)`)
        .bind(decisionId, caseId, creator.id, creator.id, now, now + 300_000).run();
      await env.DB.prepare(`INSERT INTO fairplay_appeals(id,decision_id,case_id,user_id,reason,created_at)
        VALUES(?,?,?,?,'Fixture pending appeal',?)`).bind(crypto.randomUUID(), decisionId, caseId, creator.id, now).run();
    }
  }
  await fakeArchives(ids.slice(4, 6));
  const first = await retireGamePayloads(scaled());
  expect(first).toEqual({ attempted: 28, completed: 26, failed: 2 });
  expect(await retireGamePayloads(scaled())).toEqual({ attempted: 4, completed: 4, failed: 0 });
  expect(await retireGamePayloads(scaled())).toEqual({ attempted: 0, completed: 0, failed: 0 });
  expect(archives.calls).toHaveLength(32); expect(new Set(archives.calls).size).toBe(32); expect(archives.peak).toBe(4);
  expect(await nextRetirementAt(scaled(), now + 15)).toBe(now + 32);
  await evictDurableObject(authority()); await fakeArchives(ids.slice(4, 6));
  expect(await retireGamePayloads(scaled())).toEqual({ attempted: 0, completed: 0, failed: 0 });
  clock.mockReturnValue(now + 1_000);
  expect(await retireGamePayloads(scaled())).toEqual({ attempted: 32, completed: 32, failed: 0 });
  clock.mockReturnValue(now + 2_000);
  expect(await retireGamePayloads(scaled())).toEqual({ attempted: 4, completed: 4, failed: 0 });
  expect((await env.DB.prepare('SELECT game_id FROM game_retirement_work').all()).results).toHaveLength(6);
  await env.DB.prepare('UPDATE active_game_seats SET released_at=? WHERE game_id IN (?,?,?,?)').bind(now, ...ids.slice(0, 4)).run();
  await env.DB.prepare('UPDATE fairplay_appeals SET automatic_closed_at=? WHERE case_id IN (?,?,?)').bind(now, ...cases).run();
  clock.mockReturnValue(now + 300_000); await fakeArchives();
  expect(await retireGamePayloads(scaled())).toEqual({ attempted: 6, completed: 6, failed: 0 });
  expect(await nextRetirementAt(scaled())).toBeNull();
});

it('recovers a lost D1 acknowledgement from the same native archive receipt and rejects changed terminal proof', async () => {
  const setup = await activeGame();
  await setup.game.command(setup.white, { type: 'resign', id: crypto.randomUUID(), expectedVersion: setup.snapshot.version });
  await setup.game.flush(); await authority().flush();
  const result = (await setup.game.status())!.result!;
  const now = result.endedAt + GAME_HOT_RETENTION_MS;
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const receipt = await setup.game.archive({ gameId: result.id, expectedVersion: result.version, terminalDigest: result.terminalDigest });
  await env.DB.prepare('UPDATE casual_game_admissions SET archive_error=?,archive_retry_at=? WHERE game_id=?')
    .bind('archive_receipt_pending', now, result.id).run();
  await env.DB.prepare('UPDATE game_retirement_work SET ready_at=? WHERE game_id=?').bind(now, result.id).run();
  await env.DB.prepare('UPDATE games SET terminal_digest=? WHERE id=?').bind('changed', result.id).run();
  expect(await runScaledRetirementPass(scaled())).toEqual({ attempted: 1, completed: 0, failed: 1 });
  expect(await env.DB.prepare('SELECT storage_state FROM casual_game_admissions WHERE game_id=?').bind(result.id).first('storage_state')).toBe('retained');
  expect(await env.DB.prepare('SELECT archive_error FROM casual_game_admissions WHERE game_id=?').bind(result.id).first('archive_error')).toBe('archive_receipt_pending');
  await env.DB.prepare('UPDATE games SET terminal_digest=? WHERE id=?').bind(result.terminalDigest, result.id).run();
  vi.mocked(Date.now).mockReturnValue(now + 300_000);
  expect(await runScaledRetirementPass(scaled())).toEqual({ attempted: 1, completed: 1, failed: 0 });
  expect(await env.DB.prepare('SELECT archived_at FROM casual_game_admissions WHERE game_id=?').bind(result.id).first('archived_at')).toBe(receipt.archivedAt);
});

it('keeps preview as default and closes malformed modes without consuming scaled work', async () => {
  expect(retirementMode(env)).toBe('preview');
  expect(retirementMode({ GAME_RETIREMENT_MODE: 'preview' })).toBe('preview');
  for (const mode of ['', 'SCALED', 'true', 'qualification']) {
    const invalid = { ...env, GAME_RETIREMENT_MODE: mode };
    expect(retirementMode(invalid)).toBe('closed');
    expect(await retireGamePayloads(invalid)).toEqual({ attempted: 0, completed: 0, failed: 0 });
  }
});
