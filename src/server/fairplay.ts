import { expireRestrictions, type Actor, type AuthEnv } from './auth';
import { ApiError, jsonResponse, readJson, requireAdmin, verifyTurnstile } from './security';

export const APPEAL_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
export const EVIDENCE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const REPORT_REVIEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_RESTRICTION_SECONDS = 7 * 24 * 60 * 60;
const MAX_OPEN_CASES = 1000;

type CaseRow = { id: string; subject_id: string; game_id: string; status: string; version: number; created_at: number; updated_at: number; automatic_closed_at: number | null; automatic_outcome: string | null };
type ReportRow = { id: string; case_id: string; automatic_closed_at: number | null; automatic_outcome: string | null };
type DecisionRow = { id: string; case_id: string; subject_id: string; reviewer_id: string; outcome: string; reason: string; created_at: number; appeal_until: number; request_hash: string };
type EvidenceRow = { id: string; case_id: string; game_id: string; kind: string; expires_at: number; hold_until: number };
type RestrictionRow = { id: string; reason: string; expires_at: number };
type AppealRow = { id: string; decision_id: string; status: string; created_at: number; resolved_at: number | null; automatic_closed_at: number | null; automatic_outcome: string | null };

export function reviewAvailable(env: AuthEnv): boolean { return env.OPERATION_MODE === 'reviewed'; }

function reportReceipt(env: AuthEnv, report: ReportRow, status = 200): Response {
  const available = reviewAvailable(env);
  return jsonResponse({ report: { id: report.id, caseId: report.case_id, status: report.automatic_outcome ?? 'recorded',
    closedAt: report.automatic_closed_at, reviewAvailable: available,
    message: report.automatic_closed_at !== null
      ? 'Closed automatically without human review. No cheating finding, restriction, or rating removal was made.'
      : available ? 'Recorded for optional human review. No action is promised.'
      : 'Recorded privately. Human review is unavailable. This report will not cause a cheating finding, restriction, or rating removal.' } }, status);
}

function publicAppeal(row: AppealRow) {
  return { id: row.id, decisionId: row.decision_id,
    status: row.automatic_closed_at === null ? row.status : row.automatic_outcome,
    createdAt: row.created_at, resolvedAt: row.resolved_at ?? row.automatic_closed_at,
    expiresAt: row.created_at + APPEAL_WINDOW_MS };
}

function caseNotRetiring(caseId: 'fairplay_decisions.case_id' | 'fairplay_cases.id'): string {
  return ['casual_game_admissions', 'tournament_game_admissions'].map(table => `AND NOT EXISTS(
    SELECT 1 FROM ${table} a WHERE a.game_id IN (SELECT game_id FROM fairplay_cases WHERE id=${caseId}
      UNION SELECT game_id FROM fairplay_evidence WHERE case_id=${caseId})
      AND COALESCE(a.archive_error,'') LIKE 'retiring:%' AND a.archive_retry_at>?)`).join(' ');
}

function string(value: unknown, name: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) throw new ApiError(400, 'INVALID_REQUEST', `Check ${name}.`);
  return value.trim();
}

function identifier(value: unknown, name: string): string {
  const result = string(value, name, 1, 128);
  if (!/^[a-zA-Z0-9_.:-]+$/.test(result)) throw new ApiError(400, 'INVALID_REQUEST', `Check ${name}.`);
  return result;
}

async function consumeLimit(db: D1Database, key: string, max: number, windowMs: number, now: number): Promise<void> {
  const row = await db.prepare(`INSERT INTO request_limits(key,count,window_start) VALUES(?,1,?)
    ON CONFLICT(key) DO UPDATE SET
      count=CASE WHEN window_start<=? THEN 1 ELSE MIN(count+1,?) END,
      window_start=CASE WHEN window_start<=? THEN excluded.window_start ELSE window_start END
    RETURNING count`).bind(key, now, now - windowMs, max + 1, now - windowMs).first<{ count: number }>();
  if (!row || row.count > max) throw new ApiError(429, 'TOO_MANY_REQUESTS', 'Please wait before trying again.');
}

function publicDecision(row: DecisionRow) {
  return { id: row.id, caseId: row.case_id, outcome: row.outcome, reason: row.reason, createdAt: row.created_at, appealUntil: row.appeal_until };
}

async function decisionResponse(env: AuthEnv, row: DecisionRow, status = 200): Promise<Response> {
  const pending = await env.DB.prepare('SELECT 1 FROM rating_correction_outbox WHERE decision_id=? AND completed_at IS NULL').bind(row.id).first();
  return jsonResponse({ decision: publicDecision(row), correction: pending ? 'pending' : null }, status);
}

async function submitReport(request: Request, env: AuthEnv, actor: Actor): Promise<Response> {
  const body = await readJson(request);
  const gameId = identifier(body.gameId, 'game');
  const reason = string(body.reason, 'report reason', 1, 40);
  if (!['engine-assistance', 'rating-manipulation', 'account-abuse', 'other'].includes(reason)) throw new ApiError(400, 'INVALID_REQUEST', 'Choose a report reason.');
  const details = string(body.details, 'report details', 10, 1000);
  const game = await env.DB.prepare('SELECT id,white_id,black_id,status,plies,result_version FROM games WHERE id=? AND ai_model_id IS NULL').bind(gameId).first<{ id: string; white_id: string; black_id: string | null; status: string; plies: number; result_version: number }>();
  if (!game || !game.black_id || ![game.white_id, game.black_id].includes(actor.id) || game.status !== 'finished') throw new ApiError(404, 'GAME_UNAVAILABLE', 'A completed game you played is required.');
  const retainGame = (caseId: string) => recordEvidence(env, { caseId, gameId, kind: 'server_game', sourceRef: gameId, sourceVersion: String(game.result_version), summary: { moveCount: game.plies } });
  const receipt = () => env.DB.prepare(`SELECT r.id,r.case_id,c.automatic_closed_at,c.automatic_outcome
    FROM fairplay_reports r JOIN fairplay_cases c ON c.id=r.case_id WHERE r.game_id=? AND r.reporter_id=?`)
    .bind(gameId, actor.id).first<ReportRow>();
  const existing = await receipt();
  if (existing) {
    if (existing.automatic_closed_at === null) await retainGame(existing.case_id);
    return reportReceipt(env, existing);
  }
  await verifyTurnstile(request, env, 'report');
  const now = Date.now();
  await consumeLimit(env.DB, `report:${actor.id}`, 5, 86_400_000, now);
  const subjectId = game.white_id === actor.id ? game.black_id : game.white_id;
  if (subjectId === actor.id) throw new ApiError(400, 'INVALID_REPORT', 'Self-play is not reportable.');
  const caseId = crypto.randomUUID();
  const reportId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO fairplay_cases(id,subject_id,game_id,status,created_at,updated_at)
      SELECT ?,?,?,'open',?,? WHERE (SELECT COUNT(*) FROM fairplay_cases WHERE status IN ('open','appeal_open'))<?`)
      .bind(caseId, subjectId, gameId, now, now, MAX_OPEN_CASES),
    env.DB.prepare(`INSERT OR IGNORE INTO fairplay_reports(id,case_id,game_id,reporter_id,reason,details,created_at)
      SELECT ?,id,?,?,?,?,? FROM fairplay_cases WHERE subject_id=? AND game_id=?`)
      .bind(reportId, gameId, actor.id, reason, details, now, subjectId, gameId),
  ]);
  const report = await receipt();
  if (!report) throw new ApiError(503, 'REPORT_CAPACITY', 'Private report storage is full. New reports are paused.');
  if (report.automatic_closed_at === null) await retainGame(report.case_id);
  return reportReceipt(env, report, 201);
}

/** Trusted background callers supply references and bounded numeric summaries, never browser evaluations or raw telemetry. */
export async function recordEvidence(env: AuthEnv, input: {
  caseId: string; gameId: string; kind: 'server_game' | 'engine_summary' | 'related_game' | 'farming';
  sourceRef: string; sourceVersion: string; analysisVersion?: string;
  summary: { moveCount?: number; positions?: number; forcedPositions?: number; meanLoss?: number; engineAgreement?: number; pattern?: 'repeated-pairs' | 'reciprocal-results' | 'early-resignations'; gameIds?: string[] };
}): Promise<string> {
  identifier(input.caseId, 'case');
  identifier(input.gameId, 'game');
  identifier(input.sourceRef, 'source reference');
  string(input.sourceVersion, 'source version', 1, 128);
  if (input.kind === 'engine_summary' && !input.analysisVersion) throw new ApiError(400, 'ANALYSIS_VERSION_REQUIRED', 'Engine evidence needs an analysis version.');
  const summary = {
    moveCount: input.summary.moveCount, positions: input.summary.positions, forcedPositions: input.summary.forcedPositions,
    meanLoss: input.summary.meanLoss, engineAgreement: input.summary.engineAgreement, pattern: input.summary.pattern,
    gameIds: input.summary.gameIds?.slice(0, 20).map(id => identifier(id, 'related game')),
  };
  for (const value of [summary.moveCount, summary.positions, summary.forcedPositions, summary.meanLoss, summary.engineAgreement]) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1_000_000_000)) throw new ApiError(400, 'INVALID_EVIDENCE', 'Check evidence values.');
  }
  const now = Date.now();
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT OR IGNORE INTO fairplay_evidence(id,case_id,game_id,kind,source_ref,source_version,analysis_version,summary_json,created_at,expires_at,hold_until)
    SELECT ?,?,?,?,?,?,?,?,?,?,COALESCE((SELECT MAX(appeal_until) FROM fairplay_decisions WHERE case_id=?),0)
    WHERE EXISTS(SELECT 1 FROM fairplay_cases c JOIN games g ON g.id=?
      WHERE c.id=? AND c.automatic_closed_at IS NULL AND g.status='finished' AND g.ai_model_id IS NULL AND (g.white_id=c.subject_id OR g.black_id=c.subject_id))
      AND NOT EXISTS(SELECT 1 FROM casual_game_admissions a WHERE a.game_id=? AND COALESCE(a.archive_error,'') LIKE 'retiring:%' AND a.archive_retry_at>?)
      AND NOT EXISTS(SELECT 1 FROM tournament_game_admissions a WHERE a.game_id=? AND COALESCE(a.archive_error,'') LIKE 'retiring:%' AND a.archive_retry_at>?)
      AND (SELECT COUNT(*) FROM fairplay_evidence WHERE case_id=?)<20`)
    .bind(id, input.caseId, input.gameId, input.kind, input.sourceRef, input.sourceVersion, input.analysisVersion ?? null, JSON.stringify(summary), now, now + EVIDENCE_RETENTION_MS, input.caseId, input.gameId, input.caseId, input.gameId, now, input.gameId, now, input.caseId).run();
  const existing = await env.DB.prepare(`SELECT e.id FROM fairplay_evidence e JOIN games g ON g.id=e.game_id
    WHERE e.case_id=? AND e.source_ref=? AND e.source_version=? AND e.kind=? AND g.ai_model_id IS NULL`)
    .bind(input.caseId, input.sourceRef, input.sourceVersion, input.kind).first<{ id: string }>();
  if (!existing) {
    const expired = await env.DB.prepare('SELECT 1 FROM fairplay_cases WHERE id=? AND automatic_closed_at IS NOT NULL').bind(input.caseId).first();
    if (expired) throw new ApiError(409, 'CASE_CLOSED', 'This report closed without human review.');
    throw new ApiError(503, 'EVIDENCE_CAPACITY', 'Evidence could not be recorded within the case limit.');
  }
  return existing.id;
}

async function playerStatus(env: AuthEnv, actor: Actor): Promise<Response> {
  const now = Date.now();
  await expireRestrictions(env.DB, now, actor.id);
  await expireAppeals(env, now);
  const results = await env.DB.batch([
    env.DB.prepare('SELECT id,case_id,outcome,reason,created_at,appeal_until FROM fairplay_decisions WHERE subject_id=? ORDER BY created_at DESC,id DESC LIMIT 50').bind(actor.id),
    env.DB.prepare('SELECT id,reason,expires_at FROM restrictions WHERE user_id=? AND revoked_at IS NULL AND expires_at>? ORDER BY expires_at').bind(actor.id, now),
    env.DB.prepare('SELECT id,decision_id,status,created_at,resolved_at,automatic_closed_at,automatic_outcome FROM fairplay_appeals WHERE user_id=? ORDER BY created_at DESC LIMIT 50').bind(actor.id),
  ]);
  return jsonResponse({
    reviewAvailable: reviewAvailable(env),
    notices: (results[0].results as DecisionRow[]).map(publicDecision),
    restrictions: (results[1].results as RestrictionRow[]).map(row => ({ id: row.id, reason: row.reason, expiresAt: row.expires_at })),
    appeals: (results[2].results as AppealRow[]).map(publicAppeal),
  });
}

async function submitAppeal(request: Request, env: AuthEnv, actor: Actor): Promise<Response> {
  const body = await readJson(request);
  const decisionId = identifier(body.decisionId, 'decision');
  const reason = string(body.reason, 'appeal reason', 10, 2000);
  const decision = await env.DB.prepare('SELECT id,case_id,subject_id,outcome,appeal_until FROM fairplay_decisions WHERE id=? AND subject_id=?')
    .bind(decisionId, actor.id).first<DecisionRow>();
  if (!decision || decision.outcome !== 'restrict') throw new ApiError(404, 'DECISION_UNAVAILABLE', 'This decision is unavailable.');
  await expireAppeals(env);
  const existing = await env.DB.prepare('SELECT * FROM fairplay_appeals WHERE decision_id=? AND user_id=?').bind(decisionId, actor.id).first<AppealRow>();
  if (existing) return jsonResponse({ appeal: publicAppeal(existing), reviewAvailable: reviewAvailable(env) });
  const now = Date.now();
  if (decision.appeal_until < now) throw new ApiError(409, 'APPEAL_WINDOW_CLOSED', 'The appeal window has closed.');
  await consumeLimit(env.DB, `appeal:${actor.id}`, 5, 86_400_000, now);
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO fairplay_appeals(id,decision_id,case_id,user_id,reason,status,created_at)
      SELECT ?,id,case_id,subject_id,?,'pending',? FROM fairplay_decisions WHERE id=? AND subject_id=? AND appeal_until>=?
        ${caseNotRetiring('fairplay_decisions.case_id')}`)
      .bind(id, reason, now, decisionId, actor.id, now, now, now),
    env.DB.prepare(`UPDATE fairplay_cases SET status='appeal_open',version=version+1,updated_at=?
      WHERE id=? AND EXISTS(SELECT 1 FROM fairplay_appeals WHERE id=?)`).bind(now, decision.case_id, id),
    env.DB.prepare(`UPDATE fairplay_evidence SET hold_until=MAX(hold_until,?) WHERE case_id=?
      AND EXISTS(SELECT 1 FROM fairplay_appeals WHERE id=?)`).bind(now + APPEAL_WINDOW_MS, decision.case_id, id),
    env.DB.prepare(`INSERT OR IGNORE INTO fairplay_events(id,case_id,actor_id,kind,reference_id,created_at)
      SELECT id || ':opened',case_id,user_id,'appeal_opened',id,created_at FROM fairplay_appeals WHERE id=?`).bind(id),
  ]);
  const appeal = await env.DB.prepare('SELECT * FROM fairplay_appeals WHERE decision_id=? AND user_id=?').bind(decisionId, actor.id).first<AppealRow>();
  if (!appeal) throw new ApiError(409, 'APPEAL_UNAVAILABLE', 'The appeal could not be recorded.');
  return jsonResponse({ appeal: publicAppeal(appeal), reviewAvailable: reviewAvailable(env) }, 201);
}

async function digest(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function decide(request: Request, env: AuthEnv, reviewer: Actor): Promise<Response> {
  const body = await readJson(request);
  const id = identifier(body.commandId, 'command ID');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new ApiError(400, 'INVALID_REQUEST', 'Use a fresh UUID command ID.');
  const caseId = identifier(body.caseId, 'case');
  const outcome = string(body.outcome, 'decision', 1, 16);
  if (!['restrict', 'clear', 'overturn', 'uphold'].includes(outcome)) throw new ApiError(400, 'INVALID_REQUEST', 'Choose a supported decision.');
  const expectedVersion = body.expectedVersion;
  if (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 1) throw new ApiError(400, 'INVALID_REQUEST', 'Reload the case before deciding.');
  const reason = string(body.reason, 'player-visible reason', 10, 500);
  const reviewNote = string(body.reviewNote ?? '', 'review note', 0, 4000);
  const corroboration = string(body.corroboration ?? '', 'corroboration', 0, 4000);
  if (!Array.isArray(body.evidenceIds) || body.evidenceIds.length > 20) throw new ApiError(400, 'INVALID_REQUEST', 'Select at most 20 evidence records.');
  const evidenceIds = [...new Set(body.evidenceIds.map(value => identifier(value, 'evidence')))];
  if (body.affectedGameIds !== undefined && (!Array.isArray(body.affectedGameIds) || body.affectedGameIds.length > 20)) throw new ApiError(400, 'INVALID_REQUEST', 'Select at most 20 affected games.');
  const affectedGameIds = [...new Set(((body.affectedGameIds ?? []) as unknown[]).map(value => identifier(value, 'affected game')))];
  if (outcome !== 'restrict' && affectedGameIds.length) throw new ApiError(400, 'INVALID_REQUEST', 'Appeal reversals use the original decision scope.');
  const appealId = body.appealId ? identifier(body.appealId, 'appeal') : null;
  const restrictionSeconds = body.restrictionSeconds ?? MAX_RESTRICTION_SECONDS;
  if (!Number.isSafeInteger(restrictionSeconds) || Number(restrictionSeconds) < 3600 || Number(restrictionSeconds) > MAX_RESTRICTION_SECONDS) throw new ApiError(400, 'INVALID_REQUEST', 'Restrictions must last from one hour to seven days.');
  const hash = await digest({ caseId, outcome, expectedVersion, reason, reviewNote, corroboration, evidenceIds, affectedGameIds, appealId, restrictionSeconds });
  const prior = await env.DB.prepare('SELECT * FROM fairplay_decisions WHERE id=?').bind(id).first<DecisionRow>();
  if (prior) {
    if (prior.request_hash !== hash || prior.reviewer_id !== reviewer.id) throw new ApiError(409, 'COMMAND_CONFLICT', 'This command ID was already used for a different decision.');
    return decisionResponse(env, prior);
  }
  if (!reviewAvailable(env)) throw new ApiError(503, 'REVIEW_UNAVAILABLE', 'Human review is unavailable. New case decisions and appeal decisions are disabled.');
  await expireAppeals(env);
  const caseRow = await env.DB.prepare('SELECT * FROM fairplay_cases WHERE id=?').bind(caseId).first<CaseRow>();
  if (!caseRow) throw new ApiError(404, 'CASE_UNAVAILABLE', 'This case is unavailable.');
  if (caseRow.automatic_closed_at !== null) throw new ApiError(409, 'CASE_CLOSED', 'This report closed without human review.');
  if (caseRow.version !== expectedVersion) {
    const concurrent = await env.DB.prepare('SELECT * FROM fairplay_decisions WHERE id=?').bind(id).first<DecisionRow>();
    if (concurrent) {
      if (concurrent.request_hash !== hash || concurrent.reviewer_id !== reviewer.id) throw new ApiError(409, 'COMMAND_CONFLICT', 'This command ID was already used for a different decision.');
      return decisionResponse(env, concurrent);
    }
    throw new ApiError(409, 'CASE_CHANGED', 'Reload the case before deciding.');
  }
  const appealDecision = outcome === 'overturn' || outcome === 'uphold';
  if (caseRow.status === 'appeal_open' && !appealDecision) throw new ApiError(409, 'APPEAL_REVIEW_REQUIRED', 'Resolve the pending appeal before another case decision.');
  if (appealDecision) {
    const appeal = appealId && await env.DB.prepare('SELECT id FROM fairplay_appeals WHERE id=? AND case_id=? AND status=\'pending\' AND automatic_closed_at IS NULL').bind(appealId, caseId).first();
    if (!appeal) throw new ApiError(409, 'APPEAL_UNAVAILABLE', 'Select a pending appeal for this case.');
  } else if (appealId) throw new ApiError(400, 'INVALID_REQUEST', 'Use an appeal outcome for an appeal.');
  const now = Date.now();
  const evidence = evidenceIds.length ? (await env.DB.prepare(`SELECT e.* FROM fairplay_evidence e JOIN games g ON g.id=e.game_id
    WHERE e.case_id=? AND e.id IN (${evidenceIds.map(() => '?').join(',')}) AND g.ai_model_id IS NULL`)
    .bind(caseId, ...evidenceIds).all<EvidenceRow>()).results : [];
  if (evidence.length !== evidenceIds.length || evidence.some(row => row.expires_at <= now && row.hold_until <= now)) throw new ApiError(409, 'EVIDENCE_UNAVAILABLE', 'Select retained evidence from this case.');
  if (outcome === 'restrict' || outcome === 'uphold') {
    const games = new Set(evidence.map(row => row.game_id));
    const serverEvidence = evidence.some(row => ['server_game', 'related_game', 'farming'].includes(row.kind));
    if (corroboration.length < 30 || evidence.length < 2 || games.size < 2 || !serverEvidence) {
      throw new ApiError(400, 'CORROBORATION_REQUIRED', 'A human review must explain corroborated server evidence across multiple games. Accuracy, IP, focus, and report count alone are insufficient.');
    }
  }
  if (affectedGameIds.length) {
    const supported = new Set(evidence.map(row => row.game_id));
    const games = (await env.DB.prepare(`SELECT id FROM games WHERE id IN (${affectedGameIds.map(() => '?').join(',')})
      AND status='finished' AND rated=1 AND ai_model_id IS NULL AND (white_id=? OR black_id=?)`).bind(...affectedGameIds, caseRow.subject_id, caseRow.subject_id).all<{ id: string }>()).results;
    if (games.length !== affectedGameIds.length || affectedGameIds.some(id => !supported.has(id))) throw new ApiError(400, 'UNSUPPORTED_CORRECTION', 'Each selected rated game needs retained evidence and the subject as a participant.');
  }
  const appealUntil = now + APPEAL_WINDOW_MS;
  const evidenceCondition = evidenceIds.length
    ? `AND (SELECT COUNT(*) FROM fairplay_evidence e JOIN games g ON g.id=e.game_id WHERE e.case_id=fairplay_cases.id AND e.id IN (${evidenceIds.map(() => '?').join(',')}) AND g.ai_model_id IS NULL AND (e.expires_at>? OR e.hold_until>?))=?`
    : '';
  const acceptedCommand = 'EXISTS(SELECT 1 FROM fairplay_decisions WHERE id=? AND request_hash=? AND reviewer_id=?)';
  const commandArgs = [id, hash, reviewer.id];
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`INSERT OR IGNORE INTO fairplay_decisions(id,case_id,subject_id,reviewer_id,outcome,reason,review_note,corroboration,evidence_ids,affected_game_ids,request_hash,created_at,appeal_until,appeal_id)
      SELECT ?,id,subject_id,?,?,?,?,?,?,?,?,?,?,? FROM fairplay_cases WHERE id=? AND version=? AND automatic_closed_at IS NULL ${evidenceCondition}
        ${caseNotRetiring('fairplay_cases.id')}
        ${appealDecision ? "AND EXISTS(SELECT 1 FROM fairplay_appeals WHERE id=? AND status='pending' AND automatic_closed_at IS NULL)" : ''}`)
      .bind(id, reviewer.id, outcome, reason, reviewNote, corroboration, JSON.stringify(evidenceIds), JSON.stringify(affectedGameIds), hash, now, appealUntil, appealId, caseId, Number(expectedVersion), ...(evidenceIds.length ? [...evidenceIds, now, now, evidenceIds.length] : []), now, now, ...(appealDecision ? [appealId] : [])),
    env.DB.prepare(`UPDATE fairplay_cases SET status=?,version=version+1,updated_at=? WHERE id=? AND version=?
      AND ${acceptedCommand}`)
      .bind(appealDecision || outcome === 'clear' ? 'closed' : 'decided', now, caseId, Number(expectedVersion), ...commandArgs),
    env.DB.prepare(`UPDATE fairplay_evidence SET hold_until=MAX(hold_until,?) WHERE case_id=?
      AND ${acceptedCommand}`).bind(appealUntil, caseId, ...commandArgs),
    env.DB.prepare(`INSERT OR IGNORE INTO fairplay_events(id,case_id,actor_id,kind,reference_id,created_at)
      SELECT id || ':issued',case_id,reviewer_id,'human_decision',id,created_at FROM fairplay_decisions WHERE id=? AND request_hash=? AND reviewer_id=?`).bind(...commandArgs),
  ];
  if (outcome === 'restrict') {
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO restrictions(id,user_id,case_id,decision_id,reason,starts_at,expires_at)
      SELECT id,subject_id,case_id,id,reason,created_at,? FROM fairplay_decisions WHERE id=? AND request_hash=? AND reviewer_id=?`).bind(now + Number(restrictionSeconds) * 1000, ...commandArgs));
  }
  if (outcome === 'overturn' || outcome === 'clear') {
    const scope = outcome === 'overturn' ? ' AND decision_id=(SELECT decision_id FROM fairplay_appeals WHERE id=?)' : '';
    statements.push(env.DB.prepare(`UPDATE restrictions SET revoked_at=?,revoke_reason=? WHERE case_id=? AND revoked_at IS NULL
      AND ${acceptedCommand}${scope}`).bind(now, outcome, caseId, ...commandArgs, ...(outcome === 'overturn' ? [appealId] : [])));
  }
  if (appealDecision) {
    statements.push(env.DB.prepare(`UPDATE fairplay_appeals SET status=?,resolved_at=?,outcome_decision_id=? WHERE id=? AND status='pending' AND automatic_closed_at IS NULL
      AND ${acceptedCommand}`).bind(outcome === 'overturn' ? 'overturned' : 'upheld', now, id, appealId, ...commandArgs));
  }
  if (outcome !== 'uphold') {
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO rating_correction_outbox(decision_id,subject_id,action,created_at)
      SELECT id,subject_id,?,created_at FROM fairplay_decisions WHERE id=? AND request_hash=? AND reviewer_id=?`).bind(outcome === 'restrict' ? 'review_replay' : 'reverse_replay', ...commandArgs));
  }
  const result = await env.DB.batch(statements);
  const saved = await env.DB.prepare('SELECT * FROM fairplay_decisions WHERE id=?').bind(id).first<DecisionRow>();
  if (!saved) throw new ApiError(409, 'CASE_CHANGED', 'Reload the case before deciding.');
  if (saved.request_hash !== hash || saved.reviewer_id !== reviewer.id) throw new ApiError(409, 'COMMAND_CONFLICT', 'This command ID was already used for a different decision.');
  return decisionResponse(env, saved, result[0].meta.changes ? 201 : 200);
}

async function adminCases(request: Request, env: AuthEnv): Promise<Response> {
  const url = new URL(request.url);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
  const beforeAt = Number(url.searchParams.get('beforeAt')) || Number.MAX_SAFE_INTEGER;
  const beforeId = url.searchParams.get('beforeId') ?? '\uffff';
  const rows = (await env.DB.prepare(`SELECT id,subject_id,game_id,status,version,updated_at,automatic_closed_at,automatic_outcome FROM fairplay_cases
    WHERE updated_at<? OR (updated_at=? AND id<?) ORDER BY updated_at DESC,id DESC LIMIT ?`)
    .bind(beforeAt, beforeAt, beforeId, limit).all<CaseRow>()).results;
  return jsonResponse({ cases: rows.map(row => ({ id: row.id, subjectId: row.subject_id, gameId: row.game_id,
    status: row.automatic_outcome ?? row.status, closedAt: row.automatic_closed_at, version: row.version, updatedAt: row.updated_at })) });
}

async function adminCase(env: AuthEnv, caseId: string): Promise<Response> {
  const found = await env.DB.prepare('SELECT * FROM fairplay_cases WHERE id=?').bind(caseId).first<CaseRow>();
  if (!found) throw new ApiError(404, 'CASE_UNAVAILABLE', 'This case is unavailable.');
  const [reports, evidence, decisions, appeals, games] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM fairplay_reports WHERE case_id=? ORDER BY created_at LIMIT 50').bind(caseId),
    env.DB.prepare('SELECT e.* FROM fairplay_evidence e JOIN games g ON g.id=e.game_id WHERE e.case_id=? AND g.ai_model_id IS NULL ORDER BY e.created_at LIMIT 20').bind(caseId),
    env.DB.prepare('SELECT * FROM fairplay_decisions WHERE case_id=? ORDER BY created_at DESC LIMIT 50').bind(caseId),
    env.DB.prepare('SELECT * FROM fairplay_appeals WHERE case_id=? ORDER BY created_at DESC LIMIT 50').bind(caseId),
    env.DB.prepare(`SELECT id,white_id AS whiteId,black_id AS blackId,white_name AS whiteName,black_name AS blackName,
      pgn,plies,result_version AS resultVersion,rules_version AS rulesVersion,reason,ended_at AS endedAt FROM games
      WHERE ai_model_id IS NULL AND id IN (SELECT DISTINCT game_id FROM fairplay_evidence WHERE case_id=? LIMIT 20) ORDER BY ended_at,id`).bind(caseId),
  ]);
  const publicAppeals = (appeals.results as AppealRow[]).map(row => ({ ...row, status: row.automatic_closed_at === null ? row.status : row.automatic_outcome }));
  return jsonResponse({ reviewAvailable: reviewAvailable(env), case: { id: found.id, subjectId: found.subject_id, gameId: found.game_id,
    status: found.automatic_outcome ?? found.status, closedAt: found.automatic_closed_at, version: found.version, updatedAt: found.updated_at },
    reports: reports.results, evidence: evidence.results, decisions: decisions.results, appeals: publicAppeals, games: games.results });
}

async function attachRelatedGame(request: Request, env: AuthEnv, reviewer: Actor, caseId: string): Promise<Response> {
  const body = await readJson(request, 1024);
  const gameId = identifier(body.gameId, 'related game');
  const found = await env.DB.prepare('SELECT * FROM fairplay_cases WHERE id=?').bind(caseId).first<CaseRow>();
  if (!found) throw new ApiError(404, 'CASE_UNAVAILABLE', 'This case is unavailable.');
  const game = await env.DB.prepare(`SELECT plies,result_version FROM games WHERE id=? AND status='finished' AND ai_model_id IS NULL
    AND (white_id=? OR black_id=?)`).bind(gameId, found.subject_id, found.subject_id).first<{ plies: number; result_version: number }>();
  if (!game) throw new ApiError(404, 'GAME_UNAVAILABLE', 'Choose a completed game involving this case subject.');
  const now = Date.now();
  await consumeLimit(env.DB, `review-evidence:${reviewer.id}`, 30, 60_000, now);
  const id = await recordEvidence(env, { caseId, gameId, kind: gameId === found.game_id ? 'server_game' : 'related_game',
    sourceRef: gameId, sourceVersion: String(game.result_version), summary: { moveCount: game.plies } });
  await env.DB.prepare(`INSERT OR IGNORE INTO fairplay_events(id,case_id,actor_id,kind,reference_id,created_at)
    VALUES(?,?,?,'related_game_attached',?,?)`).bind(`evidence:${id}`, caseId, reviewer.id, id, now).run();
  return jsonResponse({ evidence: { id } }, 201);
}

export async function expireAppeals(env: AuthEnv, now = Date.now()): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`UPDATE fairplay_appeals SET automatic_closed_at=?,automatic_outcome='expired-unreviewed'
      WHERE id IN (SELECT id FROM fairplay_appeals WHERE status='pending' AND automatic_closed_at IS NULL AND created_at<=? LIMIT 500)`)
      .bind(now, now - APPEAL_WINDOW_MS),
    env.DB.prepare(`UPDATE fairplay_cases SET status='closed',version=version+1,updated_at=?
      WHERE id IN (SELECT c.id FROM fairplay_cases c WHERE c.status='appeal_open'
        AND EXISTS(SELECT 1 FROM fairplay_appeals a WHERE a.case_id=c.id AND a.automatic_closed_at IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM fairplay_appeals a WHERE a.case_id=c.id AND a.status='pending' AND a.automatic_closed_at IS NULL) LIMIT 500)`)
      .bind(now),
  ]);
}

export async function expireReports(env: AuthEnv, now = Date.now()): Promise<void> {
  if (reviewAvailable(env)) return;
  await env.DB.prepare(`UPDATE fairplay_cases SET status='closed',automatic_closed_at=?,automatic_outcome='expired-unreviewed',
      version=version+1,updated_at=? WHERE id IN (
    SELECT c.id FROM fairplay_cases c WHERE c.status='open' AND c.automatic_closed_at IS NULL AND c.created_at<=?
      AND NOT EXISTS(SELECT 1 FROM fairplay_decisions d WHERE d.case_id=c.id)
      AND NOT EXISTS(SELECT 1 FROM fairplay_appeals a WHERE a.case_id=c.id AND a.status='pending' AND a.automatic_closed_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM fairplay_evidence e WHERE e.case_id=c.id AND e.hold_until>?)
    ORDER BY c.created_at,c.id LIMIT 500)`).bind(now, now, now - REPORT_REVIEW_WINDOW_MS, now).run();
}

export async function cleanupPrivateData(env: AuthEnv, now = Date.now()): Promise<void> {
  await expireRestrictions(env.DB, now);
  await expireAppeals(env, now);
  await expireReports(env, now);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM fairplay_evidence WHERE id IN (SELECT id FROM fairplay_evidence WHERE expires_at<=? AND hold_until<=?
      AND NOT EXISTS(SELECT 1 FROM fairplay_appeals a WHERE a.case_id=fairplay_evidence.case_id AND a.status='pending' AND a.automatic_closed_at IS NULL) LIMIT 500)`).bind(now, now),
    env.DB.prepare(`UPDATE fairplay_reports SET details='' WHERE id IN (SELECT id FROM fairplay_reports WHERE created_at<? AND details<>''
      AND NOT EXISTS(SELECT 1 FROM fairplay_appeals a WHERE a.case_id=fairplay_reports.case_id AND a.status='pending' AND a.automatic_closed_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM fairplay_decisions d WHERE d.case_id=fairplay_reports.case_id AND d.appeal_until>?) LIMIT 500)`).bind(now - EVIDENCE_RETENTION_MS, now),
    env.DB.prepare(`UPDATE fairplay_decisions SET review_note='',corroboration='' WHERE id IN (
      SELECT d.id FROM fairplay_cases c JOIN fairplay_decisions d ON d.case_id=c.id
      WHERE c.status IN ('closed','decided') AND c.updated_at<=? AND (d.review_note<>'' OR d.corroboration<>'')
        AND NOT EXISTS(SELECT 1 FROM fairplay_decisions pending WHERE pending.case_id=c.id AND pending.appeal_until>?)
        AND NOT EXISTS(SELECT 1 FROM fairplay_appeals a WHERE a.case_id=c.id AND a.status='pending' AND a.automatic_closed_at IS NULL)
        AND NOT EXISTS(SELECT 1 FROM fairplay_evidence e WHERE e.case_id=c.id AND e.hold_until>?)
      ORDER BY c.updated_at,c.id,d.id LIMIT 500)`).bind(now - EVIDENCE_RETENTION_MS, now, now),
    env.DB.prepare(`UPDATE fairplay_appeals SET reason='Private appeal text removed after retention.' WHERE id IN (
      SELECT a.id FROM fairplay_cases c JOIN fairplay_appeals a ON a.case_id=c.id
      WHERE c.status IN ('closed','decided') AND c.updated_at<=? AND a.reason<>'Private appeal text removed after retention.'
        AND (a.status<>'pending' OR a.automatic_closed_at IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM fairplay_decisions d WHERE d.case_id=c.id AND d.appeal_until>?)
        AND NOT EXISTS(SELECT 1 FROM fairplay_appeals pending WHERE pending.case_id=c.id AND pending.status='pending' AND pending.automatic_closed_at IS NULL)
        AND NOT EXISTS(SELECT 1 FROM fairplay_evidence e WHERE e.case_id=c.id AND e.hold_until>?)
      ORDER BY c.updated_at,c.id,a.id LIMIT 500)`).bind(now - EVIDENCE_RETENTION_MS, now, now),
    env.DB.prepare('DELETE FROM request_limits WHERE key IN (SELECT key FROM request_limits WHERE window_start<? LIMIT 500)').bind(now - 86_400_000),
    env.DB.prepare('DELETE FROM identity_change_leases WHERE user_id IN (SELECT user_id FROM identity_change_leases WHERE expires_at<=? LIMIT 500)').bind(now),
    env.DB.prepare('DELETE FROM verification WHERE id IN (SELECT id FROM verification WHERE expiresAt<? LIMIT 500)').bind(new Date(now - 86_400_000).toISOString()),
    env.DB.prepare('DELETE FROM session WHERE id IN (SELECT id FROM session WHERE expiresAt<? LIMIT 500)').bind(new Date(now).toISOString()),
    env.DB.prepare('DELETE FROM rateLimit WHERE id IN (SELECT id FROM rateLimit WHERE lastRequest<? LIMIT 500)').bind(now - 86_400_000),
    env.DB.prepare('DELETE FROM active_game_seats WHERE (user_id,game_id) IN (SELECT user_id,game_id FROM active_game_seats WHERE released_at<? LIMIT 500)').bind(now - 30 * 86_400_000),
    env.DB.prepare(`DELETE FROM user WHERE id IN (SELECT id FROM user WHERE isAnonymous=1 AND createdAt<?
      AND NOT EXISTS(SELECT 1 FROM active_game_seats a WHERE a.user_id=user.id)
      AND NOT EXISTS(SELECT 1 FROM games g WHERE g.white_id=user.id OR g.black_id=user.id)
      AND NOT EXISTS(SELECT 1 FROM fairplay_cases c WHERE c.subject_id=user.id)
      AND NOT EXISTS(SELECT 1 FROM fairplay_reports r WHERE r.reporter_id=user.id)
      AND NOT EXISTS(SELECT 1 FROM fairplay_decisions d WHERE d.reviewer_id=user.id) LIMIT 100)`)
      .bind(new Date(now - 30 * 86_400_000).toISOString()),
  ]);
}

export async function fairPlayHandler(request: Request, env: AuthEnv, actor: Actor | null): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith('/api/admin/') && !['/api/reports', '/api/appeals', '/api/me/fair-play'].includes(path)) return null;
  if (!actor) throw new ApiError(401, 'SIGN_IN_REQUIRED', 'Sign in to continue.');
  if (path.startsWith('/api/admin/')) {
    await requireAdmin(request, env, actor);
    if (path === '/api/admin/cases' && request.method === 'GET') return adminCases(request, env);
    const match = path.match(/^\/api\/admin\/cases\/([a-zA-Z0-9_.:-]+)$/);
    if (match && request.method === 'GET') return adminCase(env, identifier(match[1], 'case'));
    const evidence = path.match(/^\/api\/admin\/cases\/([a-zA-Z0-9_.:-]+)\/evidence$/);
    if (evidence && request.method === 'POST') return attachRelatedGame(request, env, actor, identifier(evidence[1], 'case'));
    if (path === '/api/admin/decisions' && request.method === 'POST') return decide(request, env, actor);
  }
  if (path === '/api/reports' && request.method === 'POST') return submitReport(request, env, actor);
  if (path === '/api/appeals' && request.method === 'POST') return submitAppeal(request, env, actor);
  if (path === '/api/me/fair-play' && request.method === 'GET') return playerStatus(env, actor);
  throw new ApiError(404, 'NOT_FOUND', 'This review endpoint is unavailable.');
}
