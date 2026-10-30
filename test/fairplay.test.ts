import { env } from 'cloudflare:workers';
import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { authHandler, currentActor, expireRestrictions, hasRecoveryEmail, rankedEligibility, type Actor } from '../src/server/auth';
import { ACCOUNT_REQUEST_LIMITS, consumeAccountRequest, GAME_PROTOCOL_LIMITS } from '../src/server/abuse';
import type { Env } from '../src/server/env';
import { APPEAL_WINDOW_MS, EVIDENCE_RETENTION_MS, REPORT_REVIEW_WINDOW_MS, cleanupPrivateData, expireReports, fairPlayHandler, recordEvidence, reviewAvailable } from '../src/server/fairplay';
import handler from '../src/server/index';
import { activeGame } from './authority-helpers';

const origin = 'http://localhost:8787';
let address = 100;
function request(path: string, body?: unknown, accessToken?: string): Request {
  return new Request(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: {
    Origin: origin, 'Content-Type': 'application/json', 'X-Turnstile-Token': 'local-development',
    ...(accessToken ? { 'CF-Access-Jwt-Assertion': accessToken } : {}),
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

async function playerSession(options: { verifiedOwner?: boolean } = {}): Promise<{ actor: Actor; cookie: string }> {
  const username = `p${crypto.randomUUID().replaceAll('-', '').slice(0, 23)}`;
  const response = await authHandler(new Request(origin + '/api/auth/sign-up/email', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Turnstile-Token': 'local-development', 'CF-Connecting-IP': `192.0.2.${address++}` },
    body: JSON.stringify({ username, name: username, ...(options.verifiedOwner ? { email: `${username}@example.com` } : {}), password: 'test-only-password-12345' }) }), env);
  expect(response.status).toBe(200);
  const cookie = response.headers.get('Set-Cookie')!.split(';')[0];
  let actor = (await currentActor(new Request(origin, { headers: { Cookie: cookie } }), env))!;
  if (options.verifiedOwner) {
    // Only owner review needs a verified real email. Sessions still come from native D1 auth.
    await env.DB.prepare('UPDATE user SET emailVerified=1 WHERE id=?').bind(actor.id).run();
    actor = (await currentActor(new Request(origin, { headers: { Cookie: cookie } }), env))!;
  }
  expect(actor).toMatchObject({ accountReady: true, emailVerified: Boolean(options.verifiedOwner) });
  expect(hasRecoveryEmail(actor.email)).toBe(Boolean(options.verifiedOwner));
  return { actor, cookie };
}

async function player(): Promise<Actor> { return (await playerSession()).actor; }

async function completedGame(white: Actor, black: Actor): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO games(id,pool,rated,white_id,black_id,white_name,black_name,status,reason,winner,score,started_at,ended_at,created_at,pgn,plies,rules_version,result_version,projection_epoch,projection_version,projected_at,settlement)
    VALUES(?,'blitz',1,?,?,?,?,'finished','resignation','w',1,?,?,?,'1. e4 e5 1-0',2,'online-v1',1,0,1,?,'settled')`)
    .bind(id, white.id, black.id, white.name, black.name, now - 60_000, now, now, now).run();
  return id;
}

describe('private human review and appeals', () => {
  let privateKey: CryptoKey;
  let accessToken: string;
  let reviewer: Actor;
  let reviewerCookie: string;
  let reviewEnv: Env;
  beforeAll(async () => {
    ({ actor: reviewer, cookie: reviewerCookie } = await playerSession({ verifiedOwner: true }));
    const keys = await generateKeyPair('RS256');
    privateKey = keys.privateKey;
    const jwk = await exportJWK(keys.publicKey);
    reviewEnv = { ...env, OPERATION_MODE: 'reviewed', CF_ACCESS_TEAM_DOMAIN: 'chess-review-test.cloudflareaccess.com', CF_ACCESS_AUD: 'review-audience', OWNER_EMAILS: reviewer.email };
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url !== 'https://chess-review-test.cloudflareaccess.com/cdn-cgi/access/certs') throw new Error('Unexpected network request in a local review test.');
      return Response.json({ keys: [{ ...jwk, kid: 'review-key', alg: 'RS256' }] });
    });
    accessToken = await new SignJWT({ email: reviewer.email, type: 'app' }).setProtectedHeader({ alg: 'RS256', kid: 'review-key' })
      .setIssuer('https://chess-review-test.cloudflareaccess.com').setAudience('review-audience').setSubject('test-owner').setIssuedAt().setExpirationTime('1h').sign(privateKey);
  });
  afterAll(() => { vi.unstubAllGlobals(); });

  it('returns private aggregate security counters to the signed-in owner without account or connection data', async () => {
    const limited = await player();
    await env.DB.prepare('INSERT INTO request_limits(key,count,window_start) VALUES(?,?,?)')
      .bind(`account:write:${limited.id}`, ACCOUNT_REQUEST_LIMITS.write.maximum, Date.now()).run();
    await expect(consumeAccountRequest(env.DB, limited.id, 'write')).rejects.toMatchObject({ status: 429 });
    const { game, white, snapshot } = await activeGame();
    await runInDurableObject(game, (_instance, state) => {
      state.storage.sql.exec('UPDATE protocol_limits SET count=?,window_start=? WHERE scope=? AND user_id=?',
        GAME_PROTOCOL_LIMITS.command.maximum, Date.now(), 'command', white.id);
    });
    expect(await game.command(white, { type: 'move', id: crypto.randomUUID(), expectedVersion: snapshot.version, from: 'e2', to: 'e4' }))
      .toMatchObject({ ok: false, code: 'command_rate_limited' });
    const ip = '192.0.2.250';
    const read = async (path: string) => {
      const value = request(path, undefined, accessToken);
      value.headers.set('Cookie', reviewerCookie);
      value.headers.set('CF-Connecting-IP', ip);
      const context = createExecutionContext();
      const response = await handler.fetch(value, reviewEnv, context);
      await waitOnExecutionContext(context);
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      return response.json();
    };
    const operations = await read('/api/admin/operations') as { security: unknown };
    expect(operations.security).toEqual({ policy: ACCOUNT_REQUEST_LIMITS,
      exhaustedWindowsSince: Math.floor(Date.now() / 86_400_000) * 86_400_000,
      exhaustedWindows: { read: 0, write: 1, connect: 0, credential: 0 } });
    const protocol = await read(`/api/admin/games/${snapshot.id}/security`);
    expect(protocol).toEqual({ policy: GAME_PROTOCOL_LIMITS,
      counters: { commandWindows: 1, connectWindows: 0, invalidFrames: 0 } });
    const counters = JSON.stringify({ account: operations.security, protocol });
    for (const privateValue of [reviewer.id, reviewer.email, reviewer.sessionId, reviewerCookie, accessToken, limited.id, white.id, ip]) {
      expect(counters).not.toContain(privateValue);
    }
  });

  it('records one participant report without a penalty and denies private evidence to public users', async () => {
    const reporter = await player();
    const subject = await player();
    const id = await completedGame(reporter, subject);
    const body = { gameId: id, reason: 'engine-assistance', details: 'Please review the middle game decisions.' };
    const first = await fairPlayHandler(request('/api/reports', body), env, reporter);
    const report = await first!.json() as { report: { id: string; caseId: string } };
    expect(report).toMatchObject({ report: { status: 'recorded', reviewAvailable: false,
      message: expect.stringContaining('Human review is unavailable') } });
    const second = await fairPlayHandler(request('/api/reports', body), env, reporter);
    expect(await second!.json()).toEqual(report);
    const evidence = (await env.DB.prepare('SELECT game_id,kind,source_version,summary_json FROM fairplay_evidence WHERE case_id=?').bind(report.report.caseId).all<{ game_id: string; kind: string; source_version: string; summary_json: string }>()).results;
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ game_id: id, kind: 'server_game', source_version: '1' });
    expect(JSON.parse(evidence[0].summary_json)).toEqual({ moveCount: 2 });
    expect(await env.DB.prepare('SELECT analysis_requested_at FROM fairplay_reports WHERE id=?').bind(report.report.id).first()).toEqual({ analysis_requested_at: null });
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM restrictions WHERE user_id=?').bind(subject.id).first<{ count: number }>())?.count).toBe(0);
    await expect(fairPlayHandler(request(`/api/admin/cases/${report.report.caseId}`), reviewEnv, reporter)).rejects.toMatchObject({ status: 403 });
    await expect(fairPlayHandler(request('/api/reports', body), env, reviewer)).rejects.toMatchObject({ status: 404 });
  });

  it('keeps owner review closed when the real recovery email loses verification', async () => {
    await env.DB.prepare('UPDATE user SET emailVerified=0 WHERE id=?').bind(reviewer.id).run();
    try {
      const value = request('/api/admin/cases', undefined, accessToken);
      value.headers.set('Cookie', reviewerCookie);
      const context = createExecutionContext();
      const response = await handler.fetch(value, reviewEnv, context);
      await waitOnExecutionContext(context);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: 'ADMIN_REQUIRED' });
    } finally {
      await env.DB.prepare('UPDATE user SET emailVerified=1 WHERE id=?').bind(reviewer.id).run();
    }
  });

  it('closes unattended reports once without changing results or retention, and preserves expired duplicate receipts', async () => {
    const [reporter, subject] = await Promise.all([player(), player()]);
    const gameId = await completedGame(reporter, subject);
    const body = { gameId, reason: 'engine-assistance', details: 'Please review this completed human game.' };
    const first = await fairPlayHandler(request('/api/reports', body), env, reporter);
    const { report } = await first!.json() as { report: { id: string; caseId: string } };
    const now = Date.now();
    await env.DB.prepare('UPDATE fairplay_cases SET created_at=? WHERE id=?').bind(now - REPORT_REVIEW_WINDOW_MS, report.caseId).run();
    const retained = await env.DB.prepare('SELECT id,created_at,expires_at,hold_until FROM fairplay_evidence WHERE case_id=?').bind(report.caseId).first();
    const result = await env.DB.prepare('SELECT status,score,result_version,settlement FROM games WHERE id=?').bind(gameId).first();
    await expireReports(env, now - 1);
    await expireReports(reviewEnv, now);
    expect(await env.DB.prepare('SELECT status,version,automatic_closed_at FROM fairplay_cases WHERE id=?').bind(report.caseId).first())
      .toEqual({ status: 'open', version: 1, automatic_closed_at: null });
    await cleanupPrivateData(env, now);
    await cleanupPrivateData(env, now + 1);
    expect(await env.DB.prepare('SELECT status,version,automatic_closed_at,automatic_outcome FROM fairplay_cases WHERE id=?').bind(report.caseId).first())
      .toEqual({ status: 'closed', version: 2, automatic_closed_at: now, automatic_outcome: 'expired-unreviewed' });
    expect(await env.DB.prepare('SELECT id,created_at,expires_at,hold_until FROM fairplay_evidence WHERE case_id=?').bind(report.caseId).first()).toEqual(retained);
    expect(await env.DB.prepare('SELECT details FROM fairplay_reports WHERE id=?').bind(report.id).first('details')).toBe(body.details);
    const duplicate = await fairPlayHandler(request('/api/reports', body), env, reporter);
    const receipt = await duplicate!.json();
    expect(receipt).toMatchObject({ report: { id: report.id, caseId: report.caseId, status: 'expired-unreviewed', closedAt: now, reviewAvailable: false } });
    await expect(recordEvidence(env, { caseId: report.caseId, gameId, kind: 'engine_summary', sourceRef: `${gameId}:b`,
      sourceVersion: '1', analysisVersion: 'screen-v1', summary: { positions: 1, engineAgreement: 1 } }))
      .rejects.toMatchObject({ code: 'CASE_CLOSED' });
    await expect(fairPlayHandler(request('/api/admin/decisions', { commandId: crypto.randomUUID(), caseId: report.caseId,
      expectedVersion: 2, outcome: 'clear', reason: 'Do not reopen an automatically closed report.', evidenceIds: [] }, accessToken), reviewEnv, reviewer))
      .rejects.toMatchObject({ code: 'CASE_CLOSED' });
    // Normal evidence expiry may delete the original record. A duplicate cannot recreate it.
    await env.DB.batch([
      env.DB.prepare('UPDATE fairplay_evidence SET expires_at=? WHERE case_id=?').bind(now - 1, report.caseId),
      env.DB.prepare('UPDATE fairplay_reports SET created_at=? WHERE id=?').bind(now - EVIDENCE_RETENTION_MS - 1, report.id),
    ]);
    await cleanupPrivateData(env, now + 2);
    const afterRetention = await fairPlayHandler(request('/api/reports', body), env, reporter);
    expect(await afterRetention!.json()).toEqual(receipt);
    expect(await env.DB.prepare('SELECT 1 FROM fairplay_evidence WHERE case_id=?').bind(report.caseId).first()).toBeNull();
    expect(await env.DB.prepare('SELECT details FROM fairplay_reports WHERE id=?').bind(report.id).first('details')).toBe('');
    expect(await env.DB.prepare('SELECT 1 FROM fairplay_decisions WHERE case_id=?').bind(report.caseId).first()).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM restrictions WHERE user_id=?').bind(subject.id).first()).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM rating_correction_outbox WHERE subject_id=?').bind(subject.id).first()).toBeNull();
    expect(await env.DB.prepare('SELECT status,score,result_version,settlement FROM games WHERE id=?').bind(gameId).first()).toEqual(result);
  });

  it('preserves decided and held reports and bounds automatic closure to 500 cases per pass', async () => {
    const [reporter, subject] = await Promise.all([player(), player()]);
    const now = Date.now();
    const cases: string[] = [];
    for (let index = 0; index < 2; index++) {
      const gameId = await completedGame(reporter, subject);
      const response = await fairPlayHandler(request('/api/reports', { gameId, reason: 'other', details: 'Preserve this report while protected.' }), env, reporter);
      const value = await response!.json() as { report: { caseId: string } };
      cases.push(value.report.caseId);
      await env.DB.prepare('UPDATE fairplay_cases SET created_at=? WHERE id=?').bind(now - REPORT_REVIEW_WINDOW_MS, value.report.caseId).run();
    }
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO fairplay_decisions(id,case_id,subject_id,reviewer_id,outcome,reason,review_note,corroboration,evidence_ids,request_hash,created_at,appeal_until)
        VALUES(?,?,?,?,'clear','A real recorded human outcome.','','','[]','fixture',?,?)`)
        .bind(crypto.randomUUID(), cases[0], subject.id, reviewer.id, now, now + APPEAL_WINDOW_MS),
      env.DB.prepare('UPDATE fairplay_evidence SET hold_until=? WHERE case_id=?').bind(now + 1, cases[1]),
    ]);
    await expireReports(env, now);
    for (const id of cases) expect(await env.DB.prepare('SELECT status,version,automatic_closed_at FROM fairplay_cases WHERE id=?').bind(id).first())
      .toEqual({ status: 'open', version: 1, automatic_closed_at: null });
    const prefix = crypto.randomUUID();
    await env.DB.prepare(`WITH RECURSIVE sequence(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM sequence WHERE n<501)
      INSERT INTO fairplay_cases(id,subject_id,game_id,created_at,updated_at)
      SELECT ? || ':' || n,?,? || ':' || n,?,? FROM sequence`).bind(prefix, subject.id, prefix, now - REPORT_REVIEW_WINDOW_MS - 1, now).run();
    await expireReports(env, now);
    expect(await env.DB.prepare("SELECT COUNT(*) FROM fairplay_cases WHERE id LIKE ? AND automatic_outcome='expired-unreviewed'").bind(prefix + ':%').first('COUNT(*)')).toBe(500);
    expect(await env.DB.prepare("SELECT COUNT(*) FROM fairplay_cases WHERE id LIKE ? AND status='open'").bind(prefix + ':%').first('COUNT(*)')).toBe(1);
    await expireReports(env, now + 1);
    expect(await env.DB.prepare("SELECT COUNT(*) FROM fairplay_cases WHERE id LIKE ? AND automatic_outcome='expired-unreviewed' AND version=2").bind(prefix + ':%').first('COUNT(*)')).toBe(501);
    // The explicit hold ends independently of closure; the human decision remains protected.
    expect(await env.DB.prepare('SELECT automatic_outcome FROM fairplay_cases WHERE id=?').bind(cases[1]).first('automatic_outcome')).toBe('expired-unreviewed');
    expect(await env.DB.prepare('SELECT automatic_closed_at FROM fairplay_cases WHERE id=?').bind(cases[0]).first('automatic_closed_at')).toBeNull();
  });

  it.each(['restrict', 'clear', 'overturn', 'uphold'])('disables new %s decisions while unattended', async outcome => {
    const unattended = { ...reviewEnv, OPERATION_MODE: 'unattended' };
    expect(reviewAvailable(env)).toBe(false);
    expect(reviewAvailable({ ...env, OPERATION_MODE: 'REVIEWED' })).toBe(false);
    expect(reviewAvailable(reviewEnv)).toBe(true);
    await expect(fairPlayHandler(request('/api/admin/decisions', {
      commandId: crypto.randomUUID(), caseId: crypto.randomUUID(), expectedVersion: 1, outcome,
      reason: 'This unattended request must not create a decision.', evidenceIds: [],
    }, accessToken), unattended, reviewer)).rejects.toMatchObject({ code: 'REVIEW_UNAVAILABLE' });
  });

  it('expires unreviewed appeals without inventing a human decision or retaining evidence forever', async () => {
    const [reporter, subject] = await Promise.all([player(), player()]);
    const gameId = await completedGame(reporter, subject);
    const reportResponse = await fairPlayHandler(request('/api/reports', { gameId, reason: 'other', details: 'A private historical report for this game.' }), env, reporter);
    const { report } = await reportResponse!.json() as { report: { id: string; caseId: string } };
    const now = Date.now();
    const decisionId = crypto.randomUUID();
    const appealId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO fairplay_decisions(id,case_id,subject_id,reviewer_id,outcome,reason,review_note,corroboration,evidence_ids,request_hash,created_at,appeal_until)
        VALUES(?,?,?,?,'restrict','A historical reviewed temporary restriction.','','','[]','fixture',?,?)`)
        .bind(decisionId, report.caseId, subject.id, reviewer.id, now - 30 * 86_400_000, now - 15 * 86_400_000),
      env.DB.prepare(`INSERT INTO fairplay_appeals(id,decision_id,case_id,user_id,reason,status,created_at)
        VALUES(?,?,?,?,'Please reconsider the historical decision.','pending',?)`)
        .bind(appealId, decisionId, report.caseId, subject.id, now - APPEAL_WINDOW_MS),
      env.DB.prepare("UPDATE fairplay_cases SET status='appeal_open' WHERE id=?").bind(report.caseId),
      env.DB.prepare('UPDATE fairplay_evidence SET expires_at=?,hold_until=0 WHERE case_id=?').bind(now - 1, report.caseId),
      env.DB.prepare('UPDATE fairplay_reports SET created_at=? WHERE id=?').bind(now - 91 * 86_400_000, report.id),
    ]);
    await cleanupPrivateData(env, now);
    await cleanupPrivateData(env, now + 1);
    expect(await env.DB.prepare('SELECT automatic_closed_at,automatic_outcome,outcome_decision_id FROM fairplay_appeals WHERE id=?').bind(appealId).first())
      .toEqual({ automatic_closed_at: now, automatic_outcome: 'expired-unreviewed', outcome_decision_id: null });
    expect(await env.DB.prepare('SELECT COUNT(*) FROM fairplay_decisions WHERE case_id=?').bind(report.caseId).first('COUNT(*)')).toBe(1);
    expect(await env.DB.prepare('SELECT COUNT(*) FROM fairplay_evidence WHERE case_id=?').bind(report.caseId).first('COUNT(*)')).toBe(0);
    expect(await env.DB.prepare('SELECT details FROM fairplay_reports WHERE id=?').bind(report.id).first('details')).toBe('');
    const status = await fairPlayHandler(request('/api/me/fair-play'), env, subject);
    expect(await status!.json()).toMatchObject({ reviewAvailable: false,
      appeals: [{ id: appealId, status: 'expired-unreviewed', resolvedAt: now }] });
    expect(await env.DB.prepare('SELECT COUNT(*) FROM rating_correction_outbox WHERE decision_id=?').bind(decisionId).first('COUNT(*)')).toBe(0);
  });

  it('minimizes expired private case text while preserving appeal holds and permanent audit identities', async () => {
    const subject = await player();
    const now = Date.now();
    const old = now - EVIDENCE_RETENTION_MS - 1;
    const fixtures: Array<{ kind: string; caseId: string; decisionId: string; appealId: string }> = [];
    for (const kind of ['expired', 'recent', 'appeal-window', 'evidence-hold', 'pending-appeal']) {
      const caseId = crypto.randomUUID();
      const decisionId = crypto.randomUUID();
      const appealId = crypto.randomUUID();
      fixtures.push({ kind, caseId, decisionId, appealId });
      await env.DB.batch([
        env.DB.prepare("INSERT INTO fairplay_cases(id,subject_id,game_id,status,created_at,updated_at) VALUES(?,?,?,'decided',?,?)")
          .bind(caseId, subject.id, crypto.randomUUID(), old, kind === 'recent' ? now : old),
        env.DB.prepare(`INSERT INTO fairplay_decisions(id,case_id,subject_id,reviewer_id,outcome,reason,review_note,corroboration,evidence_ids,request_hash,created_at,appeal_until)
          VALUES(?,?,?,?,'clear','The retained public decision reason.','Private review detail.','Private supporting detail.','[]','retained-command-hash',?,?)`)
          .bind(decisionId, caseId, subject.id, reviewer.id, old, kind === 'appeal-window' ? now + 1 : now - 1),
        env.DB.prepare(`INSERT INTO fairplay_appeals(id,decision_id,case_id,user_id,reason,status,created_at,resolved_at)
          VALUES(?,?,?,?,'Private appeal detail.',?,?,?)`)
          .bind(appealId, decisionId, caseId, subject.id, kind === 'pending-appeal' ? 'pending' : 'upheld', kind === 'pending-appeal' ? now : old, kind === 'pending-appeal' ? null : old),
      ]);
      if (kind === 'evidence-hold') await env.DB.prepare(`INSERT INTO fairplay_evidence(id,case_id,game_id,kind,source_ref,source_version,summary_json,created_at,expires_at,hold_until)
        VALUES(?,?,?,'server_game','retention-fixture','v1','{}',?,?,?)`).bind(crypto.randomUUID(), caseId, crypto.randomUUID(), old, now - 1, now + 1).run();
    }
    await cleanupPrivateData(env, now);
    await cleanupPrivateData(env, now);
    for (const fixture of fixtures) {
      const decision = await env.DB.prepare('SELECT reason,review_note,corroboration,request_hash FROM fairplay_decisions WHERE id=?').bind(fixture.decisionId).first();
      const appeal = await env.DB.prepare('SELECT reason FROM fairplay_appeals WHERE id=?').bind(fixture.appealId).first('reason');
      expect(decision).toEqual({ reason: 'The retained public decision reason.', review_note: fixture.kind === 'expired' ? '' : 'Private review detail.', corroboration: fixture.kind === 'expired' ? '' : 'Private supporting detail.', request_hash: 'retained-command-hash' });
      expect(appeal).toBe(fixture.kind === 'expired' ? 'Private appeal text removed after retention.' : 'Private appeal detail.');
      expect(await env.DB.prepare('SELECT version FROM fairplay_cases WHERE id=?').bind(fixture.caseId).first('version')).toBe(1);
    }
  });

  it('requires corroboration, records concurrent decisions once, holds appeal evidence, and scopes reversals', async () => {
    const reporter = await player();
    const subject = await player();
    const firstGame = await completedGame(reporter, subject);
    const otherGame = await completedGame(reviewer, subject);
    const reportResponse = await fairPlayHandler(request('/api/reports', { gameId: firstGame, reason: 'rating-manipulation', details: 'Please review these repeated results.' }), env, reporter);
    const { report } = await reportResponse!.json() as { report: { caseId: string } };
    const serverEvidence = (await env.DB.prepare("SELECT id FROM fairplay_evidence WHERE case_id=? AND game_id=? AND kind='server_game'").bind(report.caseId, firstGame).first<{ id: string }>())!.id;
    const unrelatedGame = await completedGame(reviewer, reporter);
    await expect(fairPlayHandler(request(`/api/admin/cases/${report.caseId}/evidence`, { gameId: unrelatedGame }, accessToken), reviewEnv, reviewer)).rejects.toMatchObject({ code: 'GAME_UNAVAILABLE' });
    const relatedResponse = await fairPlayHandler(request(`/api/admin/cases/${report.caseId}/evidence`, { gameId: otherGame, summary: { engineAgreement: 1 } }, accessToken), reviewEnv, reviewer);
    const relatedEvidence = (await relatedResponse!.json() as { evidence: { id: string } }).evidence.id;
    const caseResponse = await fairPlayHandler(request(`/api/admin/cases/${report.caseId}`, undefined, accessToken), reviewEnv, reviewer);
    const review = await caseResponse!.json() as { games: { id: string; pgn: string }[]; evidence: { id: string; summary_json: string }[] };
    expect(review.games.map(game => game.id).sort()).toEqual([firstGame, otherGame].sort());
    expect(review.games.every(game => game.pgn === '1. e4 e5 1-0')).toBe(true);
    expect(JSON.parse(review.evidence.find(item => item.id === relatedEvidence)!.summary_json)).toEqual({ moveCount: 2 });
    const body = { commandId: crypto.randomUUID(), caseId: report.caseId, expectedVersion: 1, outcome: 'restrict', reason: 'The reviewed games show coordinated rating transfers.', reviewNote: 'Private review details are not published.', corroboration: 'Server move and result records across both games support this decision.', evidenceIds: [serverEvidence], affectedGameIds: [firstGame] };
    await expect(fairPlayHandler(request('/api/admin/decisions', body, accessToken), reviewEnv, reviewer)).rejects.toMatchObject({ code: 'CORROBORATION_REQUIRED' });
    body.evidenceIds = [serverEvidence, relatedEvidence];
    const concurrent = await Promise.all([fairPlayHandler(request('/api/admin/decisions', body, accessToken), reviewEnv, reviewer), fairPlayHandler(request('/api/admin/decisions', body, accessToken), reviewEnv, reviewer)]);
    expect(concurrent.map(response => response!.status).sort()).toEqual([200, 201]);
    const decisions = await Promise.all(concurrent.map(response => response!.json())) as { decision: { id: string }; correction: string | null }[];
    const decision = decisions[0];
    expect(decisions[1]).toEqual(decision);
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM restrictions WHERE decision_id=?').bind(decision.decision.id).first<{ count: number }>())?.count).toBe(1);
    expect(decision.correction).toBe('pending');
    await env.DB.prepare('UPDATE rating_correction_outbox SET completed_at=? WHERE decision_id=?').bind(Date.now(), decision.decision.id).run();
    const retry = await fairPlayHandler(request('/api/admin/decisions', body, accessToken), reviewEnv, reviewer);
    expect(await retry!.json()).toMatchObject({ decision: { id: decision.decision.id }, correction: null });
    await expect(fairPlayHandler(request('/api/admin/decisions', { ...body, reason: 'A different reason for the same request.' }, accessToken), reviewEnv, reviewer)).rejects.toMatchObject({ code: 'COMMAND_CONFLICT' });
    const later = await fairPlayHandler(request('/api/admin/decisions', { ...body, commandId: crypto.randomUUID(), expectedVersion: 2, affectedGameIds: [], reason: 'A later independent review supports another temporary restriction.' }, accessToken), reviewEnv, reviewer);
    expect(later!.status).toBe(201);
    expect(await rankedEligibility({ ...env, RANKED_ENABLED: 'true' }, subject.id)).toMatchObject({ eligible: false, reason: 'RANKED_RESTRICTED' });
    const publicStatus = await fairPlayHandler(request('/api/me/fair-play'), env, subject);
    const statusText = await publicStatus!.text();
    expect(statusText).toContain(body.reason);
    expect(statusText).not.toContain(body.reviewNote);
    expect(statusText).not.toContain('reporter_id');
    await env.DB.prepare('UPDATE fairplay_evidence SET expires_at=? WHERE case_id=?').bind(Date.now() - 1, report.caseId).run();
    await cleanupPrivateData(env);
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM fairplay_evidence WHERE case_id=?').bind(report.caseId).first<{ count: number }>())?.count).toBe(2);
    const appealResponse = await fairPlayHandler(request('/api/appeals', { decisionId: decision.decision.id, reason: 'These games were played independently. Please review the records again.' }), env, subject);
    const appeal = await appealResponse!.json() as { appeal: { id: string } };
    await env.DB.prepare('UPDATE fairplay_evidence SET hold_until=0 WHERE case_id=?').bind(report.caseId).run();
    await cleanupPrivateData(env);
    expect((await env.DB.prepare('SELECT COUNT(*) AS count FROM fairplay_evidence WHERE case_id=?').bind(report.caseId).first<{ count: number }>())?.count).toBe(2);
    // Pending appeals retain evidence even if ordinary timers lapse; restore current hold before review.
    await env.DB.prepare('UPDATE fairplay_evidence SET hold_until=? WHERE case_id=?').bind(Date.now() + 86_400_000, report.caseId).run();
    const reversal = await fairPlayHandler(request('/api/admin/decisions', { commandId: crypto.randomUUID(), caseId: report.caseId, expectedVersion: 4, outcome: 'overturn', reason: 'Further review found insufficient evidence for the restriction.', reviewNote: 'Reversed after reviewing the timely appeal.', corroboration: '', evidenceIds: [serverEvidence, relatedEvidence], appealId: appeal.appeal.id }, accessToken), reviewEnv, reviewer);
    expect(reversal!.status).toBe(201);
    expect(await rankedEligibility({ ...env, RANKED_ENABLED: 'true' }, subject.id)).toMatchObject({ eligible: false, reason: 'RANKED_RESTRICTED' });
    const clear = await fairPlayHandler(request('/api/admin/decisions', { commandId: crypto.randomUUID(), caseId: report.caseId, expectedVersion: 5, outcome: 'clear', reason: 'Further review clears the remaining case restriction.', reviewNote: '', corroboration: '', evidenceIds: [] }, accessToken), reviewEnv, reviewer);
    expect(clear!.status).toBe(201);
    expect(await rankedEligibility({ ...env, RANKED_ENABLED: 'true' }, subject.id)).toMatchObject({ eligible: true });
    const outbox = (await env.DB.prepare('SELECT action FROM rating_correction_outbox WHERE subject_id=? ORDER BY created_at').bind(subject.id).all<{ action: string }>()).results;
    expect(outbox.map(row => row.action)).toEqual(['review_replay', 'review_replay', 'reverse_replay', 'reverse_replay']);
  });

  it('records expiry and restores eligibility without a renewal', async () => {
    const reporter = await player();
    const subject = await player();
    const gameId = await completedGame(reporter, subject);
    const now = Date.now();
    const caseId = crypto.randomUUID();
    const decisionId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO fairplay_cases(id,subject_id,game_id,created_at,updated_at) VALUES(?,?,?,?,?)').bind(caseId, subject.id, gameId, now, now),
      env.DB.prepare(`INSERT INTO fairplay_decisions(id,case_id,subject_id,reviewer_id,outcome,reason,review_note,corroboration,evidence_ids,request_hash,created_at,appeal_until)
        VALUES(?,?,?,?,'restrict','A reviewed temporary restriction.','','','[]','fixture',?,?)`).bind(decisionId, caseId, subject.id, reviewer.id, now - 7200_000, now + 86_400_000),
      env.DB.prepare('INSERT INTO restrictions(id,user_id,case_id,decision_id,reason,starts_at,expires_at) VALUES(?,?,?,?,?,?,?)').bind(decisionId, subject.id, caseId, decisionId, 'A reviewed temporary restriction.', now - 7200_000, now - 1),
    ]);
    await expireRestrictions(env.DB, now, subject.id);
    expect(await rankedEligibility({ ...env, RANKED_ENABLED: 'true' }, subject.id)).toEqual({ eligible: true });
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM fairplay_events WHERE case_id=? AND kind='restriction_expired'").bind(caseId).first<{ count: number }>())?.count).toBe(1);
    await expireRestrictions(env.DB, now, subject.id);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM fairplay_events WHERE case_id=? AND kind='restriction_expired'").bind(caseId).first<{ count: number }>())?.count).toBe(1);
  });

  it('excludes private AI practice from reports, related evidence, and enforcement', async () => {
    const reporter = await player();
    const subject = await player();
    const humanGame = await completedGame(reporter, subject);
    const practice = await completedGame(subject, reviewer);
    await env.DB.prepare('UPDATE games SET rated=0,ai_model_id=?,ai_actual_model=? WHERE id=?')
      .bind('practice:free', 'practice-model', practice).run();
    await expect(fairPlayHandler(request('/api/reports', { gameId: practice, reason: 'engine-assistance', details: 'Please review this practice game.' }), env, subject)).rejects.toMatchObject({ code: 'GAME_UNAVAILABLE' });
    const response = await fairPlayHandler(request('/api/reports', { gameId: humanGame, reason: 'engine-assistance', details: 'Please review this human game.' }), env, reporter);
    const { report } = await response!.json() as { report: { caseId: string } };
    await expect(fairPlayHandler(request(`/api/admin/cases/${report.caseId}/evidence`, { gameId: practice }, accessToken), reviewEnv, reviewer)).rejects.toMatchObject({ code: 'GAME_UNAVAILABLE' });
    await expect(recordEvidence(env, { caseId: report.caseId, gameId: practice, kind: 'engine_summary', sourceRef: practice,
      sourceVersion: '1', analysisVersion: 'screen-v1', summary: { engineAgreement: 1 } })).rejects.toMatchObject({ code: 'EVIDENCE_CAPACITY' });
    expect(await env.DB.prepare('SELECT 1 FROM fairplay_reports WHERE game_id=?').bind(practice).first()).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM fairplay_evidence WHERE game_id=?').bind(practice).first()).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM restrictions WHERE user_id=?').bind(subject.id).first()).toBeNull();
    const review = await fairPlayHandler(request(`/api/admin/cases/${report.caseId}`, undefined, accessToken), reviewEnv, reviewer);
    expect((await review!.json() as { games: { id: string }[] }).games.map(game => game.id)).toEqual([humanGame]);
  });
});
