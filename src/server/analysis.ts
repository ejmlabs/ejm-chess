import { Container } from '@cloudflare/containers';
import { Chess, DEFAULT_POSITION } from 'chess.js';
import { recordEvidence } from './fairplay';
import type { AuthEnv } from './auth';
import { PRIOR_RULES_VERSIONS, RULES_VERSION } from '../shared/protocol';
import { ApiError, readJson } from './security';
import { reserveMonthlyWork, workStopped } from './budget';

export const ENGINE_VERSION = 'stockfish-17.1';
export const ANALYSIS_PROFILE = 'screen-v1';
const MAX_PGN_BYTES = 16_384;
const MAX_PLIES = 512;
const MAX_ATTEMPTS = 3;
const MAX_STORED_JOBS = 5_000;
const MAX_AGE_MS = 7 * 86_400_000;
const LOCK_MS = 90_000;

export interface AnalysisJob {
  gameId: string;
  resultVersion: number;
  rulesVersion: string;
  priority: 'report' | 'sample';
  engineVersion: typeof ENGINE_VERSION;
  profileVersion: typeof ANALYSIS_PROFILE;
}

export interface AnalysisEnv extends AuthEnv {
  ANALYZER?: DurableObjectNamespace<StockfishAnalyzer>;
  ANALYSIS_ENABLED?: string;
  ANALYSIS_DAILY_LIMIT?: string;
  ANALYSIS_DEAD_LETTER_QUEUE?: Queue;
}

interface SideSummary {
  moveCount: number;
  positions: number;
  forcedPositions: number;
  meanLoss: number;
  engineAgreement: number;
}
interface AnalysisSummary {
  engineVersion: typeof ENGINE_VERSION;
  profileVersion: typeof ANALYSIS_PROFILE;
  sides: { w: SideSummary; b: SideSummary };
  positions: number;
  nodes: number;
  elapsedMs: number;
}
interface JobRow {
  id: string; game_id: string; result_version: number; rules_version: string;
  engine_version: typeof ENGINE_VERSION; profile_version: typeof ANALYSIS_PROFILE;
  priority: 'report' | 'sample'; status: string; attempts: number; created_at: number;
  summary_json: string | null;
}
interface GameRow {
  id: string; status: string; result_version: number; rules_version: string;
  pgn: string; plies: number; white_id: string; black_id: string | null; ai_model_id: string | null;
}

/** A private binding only. The public Worker must never forward a browser route here. */
export class StockfishAnalyzer extends Container {
  defaultPort = 8080;
  sleepAfter = '10s';
  enableInternet = false;
  private busy = false;

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.hostname !== 'analysis.internal' || url.pathname !== '/analyze') {
      return new Response('Unavailable', { status: 404 });
    }
    if (this.busy) return new Response('Busy', { status: 429 });
    this.busy = true;
    try {
      await this.startAndWaitForPorts({ ports: 8080, cancellationOptions: {
        abort: request.signal, instanceGetTimeoutMS: 10_000, portReadyTimeoutMS: 10_000,
      } });
      return await this.containerFetch(request, 8080);
    } finally { this.busy = false; }
  }
}

export function parseAnalysisJob(value: unknown): AnalysisJob | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(key => !['gameId', 'resultVersion', 'rulesVersion', 'priority', 'engineVersion', 'profileVersion'].includes(key))
    || typeof item.gameId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(item.gameId)
    || !Number.isSafeInteger(item.resultVersion) || Number(item.resultVersion) < 1 || Number(item.resultVersion) > 1_000_000
    || ![RULES_VERSION, PRIOR_RULES_VERSIONS[1]].includes(String(item.rulesVersion)) || !['report', 'sample'].includes(String(item.priority))
    || item.engineVersion !== ENGINE_VERSION || item.profileVersion !== ANALYSIS_PROFILE) return null;
  return item as unknown as AnalysisJob;
}

export function analysisJobId(job: AnalysisJob): string {
  return [job.gameId, job.resultVersion, job.rulesVersion, job.engineVersion, job.profileVersion].join(':');
}

/** Canonicalize stored server PGN with the maintained rules package. No custom positions or comments reach the engine. */
export function safeAnalysisPgn(pgn: string, plies: number): string {
  if (typeof pgn !== 'string' || new TextEncoder().encode(pgn).byteLength > MAX_PGN_BYTES
    || !Number.isInteger(plies) || plies < 2 || plies > MAX_PLIES) throw new Error('INVALID_GAME_INPUT');
  const parsed = new Chess();
  try { parsed.loadPgn(pgn, { strict: true }); } catch { throw new Error('INVALID_GAME_INPUT'); }
  const headers = parsed.getHeaders();
  if ((headers.FEN && headers.FEN !== DEFAULT_POSITION) || (headers.SetUp && headers.SetUp !== '0')) throw new Error('INVALID_GAME_INPUT');
  const moves = parsed.history({ verbose: true });
  if (moves.length !== plies) throw new Error('INVALID_GAME_INPUT');
  const canonical = new Chess();
  for (const move of moves) canonical.move({ from: move.from, to: move.to, ...(move.promotion ? { promotion: move.promotion } : {}) });
  return canonical.pgn();
}

export function validateAnalysisSummary(value: unknown): AnalysisSummary {
  if (!value || typeof value !== 'object') throw new Error('INVALID_ENGINE_SUMMARY');
  const item = value as AnalysisSummary;
  if (item.engineVersion !== ENGINE_VERSION || item.profileVersion !== ANALYSIS_PROFILE
    || !Number.isInteger(item.positions) || item.positions < 0 || item.positions > 24
    || !Number.isInteger(item.nodes) || item.nodes < 0 || item.nodes > 1_500_000
    || !Number.isFinite(item.elapsedMs) || item.elapsedMs < 0 || item.elapsedMs > 25_000) throw new Error('INVALID_ENGINE_SUMMARY');
  for (const color of ['w', 'b'] as const) {
    const side = item.sides?.[color];
    if (!side || !Number.isInteger(side.moveCount) || side.moveCount < 0 || side.moveCount > 256
      || !Number.isInteger(side.positions) || side.positions < 0 || side.positions > Math.min(24, side.moveCount)
      || !Number.isInteger(side.forcedPositions) || side.forcedPositions < 0 || side.forcedPositions > side.moveCount
      || side.positions + side.forcedPositions > side.moveCount
      || !Number.isFinite(side.meanLoss) || side.meanLoss < 0 || side.meanLoss > 1000
      || !Number.isFinite(side.engineAgreement) || side.engineAgreement < 0 || side.engineAgreement > 1) throw new Error('INVALID_ENGINE_SUMMARY');
  }
  if (item.sides.w.positions + item.sides.b.positions !== item.positions
    || JSON.stringify(item).length > 4096) throw new Error('INVALID_ENGINE_SUMMARY');
  // Persist only the bounded contract. Raw PVs, arbitrary fields, and account data are discarded.
  const side = (s: SideSummary): SideSummary => ({ moveCount: s.moveCount, positions: s.positions,
    forcedPositions: s.forcedPositions, meanLoss: s.meanLoss, engineAgreement: s.engineAgreement });
  return { engineVersion: ENGINE_VERSION, profileVersion: ANALYSIS_PROFILE, sides: { w: side(item.sides.w), b: side(item.sides.b) },
    positions: item.positions, nodes: item.nodes, elapsedMs: item.elapsedMs };
}

async function attachSummary(env: AnalysisEnv, row: JobRow, game?: GameRow): Promise<void> {
  if (!row.summary_json) return;
  const source = game ?? await env.DB.prepare('SELECT id,status,result_version,rules_version,pgn,plies,white_id,black_id,ai_model_id FROM games WHERE id=?').bind(row.game_id).first<GameRow>();
  if (!source || source.ai_model_id || source.status !== 'finished' || source.result_version !== row.result_version || source.rules_version !== row.rules_version) return;
  const summary = validateAnalysisSummary(JSON.parse(row.summary_json));
  const cases = await env.DB.prepare("SELECT id,subject_id FROM fairplay_cases WHERE game_id=? AND status IN ('open','appeal_open') AND automatic_closed_at IS NULL LIMIT 2")
    .bind(row.game_id).all<{ id: string; subject_id: string }>();
  for (const item of cases.results) {
    const color = item.subject_id === source.white_id ? 'w' : item.subject_id === source.black_id ? 'b' : null;
    if (!color || summary.sides[color].positions === 0) continue;
    try {
      await recordEvidence(env, { caseId: item.id, gameId: row.game_id, kind: 'engine_summary', sourceRef: `${row.game_id}:${color}`,
        sourceVersion: String(row.result_version), analysisVersion: `${ENGINE_VERSION}/${ANALYSIS_PROFILE}`, summary: summary.sides[color] });
    } catch (error) {
      // Expiry can win after the case lookup. Its terminal receipt needs no retry.
      if (!(error instanceof ApiError) || error.code !== 'CASE_CLOSED') throw error;
    }
  }
}

async function finishEvidence(env: AnalysisEnv, row: JobRow, now: number, game?: GameRow): Promise<void> {
  try {
    await attachSummary(env, row, game);
    await env.DB.prepare("UPDATE analysis_jobs SET status='done',last_error=NULL,lease_until=0,updated_at=? WHERE id=?").bind(now, row.id).run();
  } catch {
    // The bounded summary is already durable. Retry evidence delivery without another engine attempt.
    await env.DB.prepare("UPDATE analysis_jobs SET status='pending',lease_until=0,next_attempt_at=?,updated_at=?,last_error='EVIDENCE_FAILURE' WHERE id=?")
      .bind(now + 60_000, now, row.id).run();
  }
}

async function deadLetter(env: AnalysisEnv, id: string, gameId: string | null, reason: string, now: number): Promise<void> {
  await env.DB.prepare(`INSERT OR IGNORE INTO analysis_dead_letters(id,game_id,reason,created_at)
    SELECT ?,?,?,? WHERE (SELECT COUNT(*) FROM analysis_dead_letters)<5000`).bind(id, gameId, reason, now).run();
}

async function persistJob(env: AnalysisEnv, job: AnalysisJob, now: number): Promise<JobRow | null> {
  const id = analysisJobId(job);
  await env.DB.prepare(`INSERT OR IGNORE INTO analysis_jobs
    (id,game_id,result_version,rules_version,engine_version,profile_version,priority,created_at,updated_at,next_attempt_at)
    SELECT ?,?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM analysis_jobs)<?`)
    .bind(id, job.gameId, job.resultVersion, job.rulesVersion, job.engineVersion, job.profileVersion, job.priority, now, now, now, MAX_STORED_JOBS).run();
  const row = await env.DB.prepare('SELECT * FROM analysis_jobs WHERE id=?').bind(id).first<JobRow>();
  if (!row) return null;
  if (job.priority === 'report') {
    await env.DB.prepare("UPDATE analysis_jobs SET priority='report',updated_at=? WHERE id=?").bind(now, id).run();
  }
  if (row.status === 'done') await finishEvidence(env, row, now);
  return row;
}

/** Reports need no working Queue to leave a durable analysis intent. Input is a stored completed game ID only. */
export async function enqueueReportedGame(env: AnalysisEnv, gameId: string, now = Date.now()): Promise<void> {
  const game = await env.DB.prepare(`SELECT result_version,rules_version FROM games WHERE id=? AND status='finished' AND ai_model_id IS NULL
    AND EXISTS(SELECT 1 FROM fairplay_cases c WHERE c.game_id=games.id AND c.status IN ('open','appeal_open') AND c.automatic_closed_at IS NULL)`)
    .bind(gameId).first<{ result_version: number; rules_version: string }>();
  if (!game) return;
  const job = parseAnalysisJob({ gameId, resultVersion: game.result_version, rulesVersion: game.rules_version,
    priority: 'report', engineVersion: ENGINE_VERSION, profileVersion: ANALYSIS_PROFILE });
  if (!job || !await persistJob(env, job, now)) throw new Error('ANALYSIS_CAPACITY');
  await env.DB.prepare('UPDATE fairplay_reports SET analysis_requested_at=? WHERE game_id=? AND analysis_requested_at IS NULL').bind(now, gameId).run();
}

/** Repair the crash window after a report commits but before its analysis intent is accepted. */
export async function reconcileReportedAnalysis(env: AnalysisEnv, now = Date.now()): Promise<void> {
  const rows = await env.DB.prepare(`SELECT g.id FROM games g JOIN fairplay_reports r ON r.game_id=g.id
    JOIN fairplay_cases c ON c.id=r.case_id
    WHERE g.status='finished' AND g.ai_model_id IS NULL AND g.rules_version IN (?,?) AND r.analysis_requested_at IS NULL AND c.status IN ('open','appeal_open')
    GROUP BY g.id ORDER BY MIN(r.created_at) LIMIT 20`).bind(RULES_VERSION, PRIOR_RULES_VERSIONS[1]).all<{ id: string }>();
  for (const row of rows.results) await enqueueReportedGame(env, row.id, now);
}

export const requestReportAnalysis = enqueueReportedGame;
export const recoverReportAnalysis = reconcileReportedAnalysis;

/** Queue acceptance is durable in D1 before ack. Engine work and retries are independent of Queue redelivery. */
export async function consumeAnalysis(batch: MessageBatch<unknown>, env: AnalysisEnv): Promise<void> {
  for (const message of batch.messages) {
    try {
      const job = parseAnalysisJob(message.body);
      const now = Date.now();
      if (!job) {
        await deadLetter(env, `message:${message.id.slice(0, 128)}`, null, 'INVALID_QUEUE_MESSAGE', now);
        message.ack();
        continue;
      }
      const source = await env.DB.prepare('SELECT ai_model_id FROM games WHERE id=?').bind(job.gameId).first<{ ai_model_id: string | null }>();
      if (source?.ai_model_id) {
        await deadLetter(env, analysisJobId(job), job.gameId, 'AI_GAME_EXCLUDED', now);
        message.ack();
        continue;
      }
      const row = await persistJob(env, job, now);
      if (!row) { message.retry({ delaySeconds: 600 }); continue; }
      message.ack();
    } catch { message.retry({ delaySeconds: 60 }); }
  }
  await drainAnalysis(env);
}

function dailyLimit(value?: string): number {
  const limit = Number(value ?? '20');
  return Number.isInteger(limit) && limit >= 0 && limit <= 100 ? limit : 0;
}

/** One job per call, one global lease, one named instance. Schedule this once a minute for recovery. */
export async function drainAnalysis(env: AnalysisEnv, now = Date.now()): Promise<void> {
  if (env.ANALYSIS_ENABLED !== 'true' || !env.ANALYZER || dailyLimit(env.ANALYSIS_DAILY_LIMIT) === 0) return;
  const token = crypto.randomUUID();
  const acquired = await env.DB.prepare(`INSERT INTO analysis_lease(id,token,expires_at) VALUES('worker',?,?)
    ON CONFLICT(id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at WHERE analysis_lease.expires_at<=? RETURNING token`)
    .bind(token, now + LOCK_MS, now).first();
  if (!acquired) return;
  try {
    const row = await env.DB.prepare(`SELECT * FROM analysis_jobs WHERE
      (status='pending' AND next_attempt_at<=?) OR (status='running' AND lease_until<=?)
      ORDER BY CASE priority WHEN 'report' THEN 0 ELSE 1 END,created_at,id LIMIT 1`).bind(now, now).first<JobRow>();
    if (!row) return;
    if (row.created_at < now - MAX_AGE_MS) {
      const reason = 'STALE_JOB';
      await env.DB.prepare("UPDATE analysis_jobs SET status='dead',last_error=?,updated_at=? WHERE id=?").bind(reason, now, row.id).run();
      await deadLetter(env, row.id, row.game_id, reason, now);
      return;
    }
    if (row.summary_json) {
      await finishEvidence(env, row, now);
      return;
    }
    if (row.attempts >= MAX_ATTEMPTS) {
      await env.DB.prepare("UPDATE analysis_jobs SET status='dead',last_error='ATTEMPTS_EXHAUSTED',updated_at=? WHERE id=?").bind(now, row.id).run();
      await deadLetter(env, row.id, row.game_id, 'ATTEMPTS_EXHAUSTED', now);
      return;
    }
    const game = await env.DB.prepare('SELECT id,status,result_version,rules_version,pgn,plies,white_id,black_id,ai_model_id FROM games WHERE id=?').bind(row.game_id).first<GameRow>();
    let pgn: string;
    let completed: JobRow | undefined;
    try {
      if (!game || game.ai_model_id || game.status !== 'finished' || game.result_version !== row.result_version || game.rules_version !== row.rules_version) throw new Error('GAME_VERSION_UNAVAILABLE');
      pgn = safeAnalysisPgn(game.pgn, game.plies);
    } catch {
      await env.DB.prepare("UPDATE analysis_jobs SET status='dead',last_error='INVALID_GAME_INPUT',updated_at=? WHERE id=?").bind(now, row.id).run();
      await deadLetter(env, row.id, row.game_id, 'INVALID_GAME_INPUT', now);
      return;
    }
    if (await workStopped(env, 'analysis') || !await reserveMonthlyWork(env, 'analysis', `${row.id}:attempt:${row.attempts + 1}`, now)) return;
    const day = new Date(now).toISOString().slice(0, 10);
    const charged = await env.DB.prepare(`INSERT INTO analysis_daily(day,attempts) VALUES(?,1)
      ON CONFLICT(day) DO UPDATE SET attempts=attempts+1 WHERE attempts<? RETURNING attempts`)
      .bind(day, dailyLimit(env.ANALYSIS_DAILY_LIMIT)).first();
    if (!charged) return;
    await env.DB.prepare("UPDATE analysis_jobs SET status='running',attempts=attempts+1,lease_until=?,updated_at=? WHERE id=?")
      .bind(now + LOCK_MS, now, row.id).run();
    try {
      const analyzer = env.ANALYZER.get(env.ANALYZER.idFromName('screen-v1-singleton'));
      const response = await analyzer.fetch(new Request('http://analysis.internal/analyze', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(45_000),
        body: JSON.stringify({ gameId: row.game_id, resultVersion: row.result_version, rulesVersion: row.rules_version,
          engineVersion: ENGINE_VERSION, profileVersion: ANALYSIS_PROFILE, pgn }) }));
      if (!response.ok) throw new Error('ENGINE_UNAVAILABLE');
      const summary = validateAnalysisSummary(await readJson<unknown>(response, 4096));
      if (summary.sides.w.moveCount !== Math.ceil(game.plies / 2) || summary.sides.b.moveCount !== Math.floor(game.plies / 2)) {
        throw new Error('INVALID_ENGINE_SUMMARY');
      }
      const summaryJson = JSON.stringify(summary);
      await env.DB.prepare("UPDATE analysis_jobs SET status='pending',summary_json=?,last_error=NULL,lease_until=0,updated_at=? WHERE id=?")
        .bind(summaryJson, Date.now(), row.id).run();
      completed = { ...row, summary_json: summaryJson };
    } catch {
      const attempts = row.attempts + 1;
      const status = attempts >= MAX_ATTEMPTS ? 'dead' : 'pending';
      await env.DB.prepare('UPDATE analysis_jobs SET status=?,last_error=?,lease_until=0,next_attempt_at=?,updated_at=? WHERE id=?')
        .bind(status, 'ENGINE_FAILURE', Date.now() + Math.min(3600, 30 * 2 ** (attempts - 1)) * 1000, Date.now(), row.id).run();
      if (status === 'dead') await deadLetter(env, row.id, row.game_id, 'ATTEMPTS_EXHAUSTED', Date.now());
    }
    if (completed) await finishEvidence(env, completed, Date.now(), game);
  } finally {
    await env.DB.prepare("DELETE FROM analysis_lease WHERE id='worker' AND token=?").bind(token).run();
  }
}

export async function cleanupAnalysis(env: AnalysisEnv, now = Date.now()): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM analysis_jobs WHERE status IN ('done','dead') AND updated_at<?").bind(now - 30 * 86_400_000),
    env.DB.prepare('DELETE FROM analysis_daily WHERE day<?').bind(new Date(now - 31 * 86_400_000).toISOString().slice(0, 10)),
    env.DB.prepare('DELETE FROM analysis_dead_letters WHERE created_at<?').bind(now - 30 * 86_400_000),
  ]);
  if (!env.ANALYSIS_DEAD_LETTER_QUEUE) return;
  const letters = await env.DB.prepare('SELECT id,game_id,reason,created_at FROM analysis_dead_letters WHERE notified_at IS NULL ORDER BY created_at LIMIT 10')
    .all<{ id: string; game_id: string | null; reason: string; created_at: number }>();
  for (const letter of letters.results) {
    await env.ANALYSIS_DEAD_LETTER_QUEUE.send({ jobId: letter.id, gameId: letter.game_id, reason: letter.reason, createdAt: letter.created_at });
    await env.DB.prepare('UPDATE analysis_dead_letters SET notified_at=? WHERE id=?').bind(now, letter.id).run();
  }
}
