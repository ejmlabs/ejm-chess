import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANALYSIS_PROFILE, ENGINE_VERSION, StockfishAnalyzer, analysisJobId, cleanupAnalysis, consumeAnalysis, drainAnalysis,
  enqueueReportedGame, parseAnalysisJob, reconcileReportedAnalysis, safeAnalysisPgn, validateAnalysisSummary,
  type AnalysisEnv, type AnalysisJob,
} from '../src/server/analysis';
import { RULES_VERSION } from '../src/shared/protocol';
import { rankedEligibility } from '../src/server/auth';
import { expireReports, REPORT_REVIEW_WINDOW_MS } from '../src/server/fairplay';
import { player } from './authority-helpers';

const PGN = '[White "Private name"]\n\n1. e4 {private comment} e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 1-0';
const summary = () => ({ engineVersion: ENGINE_VERSION, profileVersion: ANALYSIS_PROFILE,
  sides: { w: { moveCount: 5, positions: 1, forcedPositions: 0, meanLoss: 12, engineAgreement: 1 },
    b: { moveCount: 5, positions: 1, forcedPositions: 0, meanLoss: 80, engineAgreement: 0 } },
  positions: 2, nodes: 40_000, elapsedMs: 150 });

function job(gameId = crypto.randomUUID(), priority: 'report' | 'sample' = 'sample'): AnalysisJob {
  return { gameId, resultVersion: 1, rulesVersion: RULES_VERSION, priority,
    engineVersion: ENGINE_VERSION, profileVersion: ANALYSIS_PROFILE };
}
function analysisEnv(fetcher = vi.fn(async (_: Request) => Response.json(summary()))): AnalysisEnv {
  return { ...env, ANALYSIS_ENABLED: 'true', ANALYSIS_DAILY_LIMIT: '20', ANALYZER: {
    idFromName: () => 'private-singleton', get: () => ({ fetch: fetcher }),
  } as unknown as AnalysisEnv['ANALYZER'] };
}
async function accept(jobs: unknown[], config: AnalysisEnv = { ...env, ANALYSIS_ENABLED: 'false' }): Promise<void> {
  const messages = jobs.map(body => ({ id: crypto.randomUUID(), body, ack: vi.fn(), retry: vi.fn() }));
  await consumeAnalysis({ messages } as unknown as MessageBatch<unknown>, config);
  for (const message of messages) { expect(message.ack).toHaveBeenCalledOnce(); expect(message.retry).not.toHaveBeenCalled(); }
}
async function game(status = 'finished', resultVersion = 1) {
  const [white, black] = await Promise.all([player(), player()]);
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO games(id,pool,rated,white_id,black_id,white_name,black_name,status,reason,winner,score,started_at,ended_at,created_at,pgn,plies,rules_version,result_version,projection_epoch,projection_version,projected_at,settlement)
    VALUES(?,'blitz',0,?,?,?, ?,?,'resignation','w',1,?,?,?, ?,10,?,?,0,1,?,'unrated')`)
    .bind(id, white.id, black.id, white.name, black.name, status, now - 60_000, now, now, PGN, RULES_VERSION, resultVersion, now).run();
  return { id, white, black };
}
async function report(source: Awaited<ReturnType<typeof game>>, subject = source.black.id) {
  const caseId = crypto.randomUUID();
  const reportId = crypto.randomUUID();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO fairplay_cases(id,subject_id,game_id,created_at,updated_at) VALUES(?,?,?,?,?)')
      .bind(caseId, subject, source.id, now, now),
    env.DB.prepare("INSERT INTO fairplay_reports(id,case_id,game_id,reporter_id,reason,details,created_at) VALUES(?,?,?,?,'engine-assistance','Please review.',?)")
      .bind(reportId, caseId, source.id, subject === source.black.id ? source.white.id : source.black.id, now),
  ]);
  return { caseId, reportId };
}
async function row(id: string) { return env.DB.prepare('SELECT * FROM analysis_jobs WHERE id=?').bind(analysisJobId(job(id))).first<Record<string, unknown>>(); }

describe('bounded postgame analysis', () => {
  beforeEach(async () => { await env.DB.batch(['analysis_jobs', 'analysis_daily', 'analysis_lease', 'analysis_dead_letters'].map(table => env.DB.prepare(`DELETE FROM ${table}`))); });

  it('accepts only pinned metadata and strips private PGN fields before the engine boundary', () => {
    const value = job();
    expect(parseAnalysisJob(value)).toEqual(value);
    for (const change of [{ enginePath: '/bin/sh' }, { nodes: 1e9 }, { engineVersion: 'latest' },
      { gameId: '../game' }, { resultVersion: 0 }, { resultVersion: Number.MAX_SAFE_INTEGER }, { rulesVersion: 'old' }]) {
      expect(parseAnalysisJob({ ...value, ...change })).toBeNull();
    }
    const pgn = safeAnalysisPgn(PGN, 10);
    expect(pgn).toContain('1. e4 e5');
    expect(pgn).not.toContain('Private name');
    expect(pgn).not.toContain('private comment');
    expect(() => safeAnalysisPgn(PGN, 12)).toThrow('INVALID_GAME_INPUT');
    expect(() => safeAnalysisPgn('x'.repeat(16_385), 10)).toThrow('INVALID_GAME_INPUT');
    expect(() => safeAnalysisPgn('[SetUp "1"]\n[FEN "8/8/8/8/8/8/K6k/8 w - - 0 1"]\n\n*', 2)).toThrow('INVALID_GAME_INPUT');
    expect(validateAnalysisSummary({ ...summary(), pv: 'private variations' })).toEqual(summary());
    expect(() => validateAnalysisSummary({ ...summary(), nodes: 1_500_001 })).toThrow('INVALID_ENGINE_SUMMARY');
    expect(() => validateAnalysisSummary({ ...summary(), sides: { ...summary().sides,
      w: { ...summary().sides.w, forcedPositions: 5 } } })).toThrow('INVALID_ENGINE_SUMMARY');
  });

  it('denies public Container URLs and prevents overlapping private requests', async () => {
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    const start = vi.fn(async () => ready);
    const forward = vi.fn(async () => Response.json(summary()));
    const instance = { busy: false, startAndWaitForPorts: start, containerFetch: forward } as unknown as StockfishAnalyzer;
    const fetch = (request: Request) => StockfishAnalyzer.prototype.fetch.call(instance, request);
    for (const request of [new Request('https://chess.ejmlabs.com/analyze', { method: 'POST' }),
      new Request('http://analysis.internal/analyze'), new Request('http://analysis.internal/other', { method: 'POST' })]) {
      expect((await fetch(request)).status).toBe(404);
    }
    expect(start).not.toHaveBeenCalled();
    const first = fetch(new Request('http://analysis.internal/analyze', { method: 'POST' }));
    expect((await fetch(new Request('http://analysis.internal/analyze', { method: 'POST' }))).status).toBe(429);
    release();
    expect((await first).status).toBe(200);
    expect(forward).toHaveBeenCalledOnce();
  });

  it('durably deduplicates and raises report priority while engine work is disabled', async () => {
    const value = job();
    const fetcher = vi.fn(async (_: Request) => Response.json(summary()));
    await accept([value, { ...value, priority: 'report' }, { ...value, nodes: 1e9 }], { ...analysisEnv(fetcher), ANALYSIS_ENABLED: 'false' });
    expect(await row(value.gameId)).toMatchObject({ status: 'pending', priority: 'report', attempts: 0 });
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM analysis_jobs').first<{ n: number }>())?.n).toBe(1);
    expect((await env.DB.prepare('SELECT reason FROM analysis_dead_letters').first())?.reason).toBe('INVALID_QUEUE_MESSAGE');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('repairs report intent without Queue delivery, analyzes reports first, and attaches only each subject side', async () => {
    const sampled = await game();
    const reported = await game();
    const blackCase = await report(reported);
    const whiteCase = await report(reported, reported.white.id);
    await accept([job(sampled.id)]);
    await reconcileReportedAnalysis(env);
    expect((await env.DB.prepare('SELECT analysis_requested_at FROM fairplay_reports WHERE id=?').bind(blackCase.reportId).first())?.analysis_requested_at).toEqual(expect.any(Number));
    const fetcher = vi.fn(async (_: Request) => Response.json(summary()));
    await drainAnalysis(analysisEnv(fetcher));
    const input = await fetcher.mock.calls[0][0].json() as { gameId: string; pgn: string };
    expect(input.gameId).toBe(reported.id);
    expect(input.pgn).not.toContain('Private name');
    expect(await row(reported.id)).toMatchObject({ status: 'done', attempts: 1 });
    expect(await row(sampled.id)).toMatchObject({ status: 'pending', attempts: 0 });
    for (const [caseId, side] of [[blackCase.caseId, 'b'], [whiteCase.caseId, 'w']] as const) {
      const evidence = await env.DB.prepare("SELECT source_ref,source_version,analysis_version,summary_json FROM fairplay_evidence WHERE case_id=? AND kind='engine_summary'").bind(caseId).all<{ source_ref: string; source_version: string; analysis_version: string; summary_json: string }>();
      expect(evidence.results).toHaveLength(1);
      expect(evidence.results[0]).toMatchObject({ source_ref: `${reported.id}:${side}`, source_version: '1', analysis_version: `${ENGINE_VERSION}/${ANALYSIS_PROFILE}` });
      expect(JSON.parse(evidence.results[0].summary_json)).toEqual(summary().sides[side]);
    }
    await enqueueReportedGame(env, reported.id);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM fairplay_evidence WHERE game_id=? AND kind='engine_summary'").bind(reported.id).first<{ n: number }>())?.n).toBe(2);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM restrictions').first<{ n: number }>())?.n).toBe(0);
  });

  it('rejects unfinished, missing, and stale game versions before consuming engine budget', async () => {
    const unfinished = await game('pending-adjudication');
    const changed = await game('finished', 2);
    const absent = job();
    await accept([job(unfinished.id), job(changed.id), absent]);
    const fetcher = vi.fn(async (_: Request) => Response.json(summary()));
    for (let i = 0; i < 3; i++) await drainAnalysis(analysisEnv(fetcher));
    expect(fetcher).not.toHaveBeenCalled();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM analysis_jobs WHERE status='dead' AND last_error='INVALID_GAME_INPUT'").first<{ n: number }>())?.n).toBe(3);
    expect(await env.DB.prepare('SELECT * FROM analysis_daily').first()).toBeNull();
  });

  it('finishes late saved summaries without reopening expired reports or spending another engine attempt', async () => {
    const source = await game();
    const reported = await report(source);
    await enqueueReportedGame(env, source.id);
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare('UPDATE fairplay_cases SET created_at=? WHERE id=?').bind(now - REPORT_REVIEW_WINDOW_MS, reported.caseId),
      env.DB.prepare('UPDATE analysis_jobs SET attempts=3,summary_json=? WHERE game_id=?').bind(JSON.stringify(summary()), source.id),
    ]);
    await expireReports(env, now);
    const closed = await env.DB.prepare('SELECT status,version,automatic_closed_at,automatic_outcome FROM fairplay_cases WHERE id=?').bind(reported.caseId).first();
    const fetcher = vi.fn(async (_: Request) => Response.json(summary()));
    const config = analysisEnv(fetcher);
    await drainAnalysis(config);
    await enqueueReportedGame(config, source.id);
    await reconcileReportedAnalysis(config);
    expect(await row(source.id)).toMatchObject({ status: 'done', attempts: 3, last_error: null, summary_json: JSON.stringify(summary()) });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT * FROM analysis_daily').first()).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM fairplay_evidence WHERE case_id=?').bind(reported.caseId).first()).toBeNull();
    expect(await env.DB.prepare('SELECT status,version,automatic_closed_at,automatic_outcome FROM fairplay_cases WHERE id=?').bind(reported.caseId).first()).toEqual(closed);
    await env.DB.prepare('DELETE FROM analysis_jobs WHERE game_id=?').bind(source.id).run();
    await enqueueReportedGame(config, source.id);
    expect(await row(source.id)).toBeNull();
  });

  it('keeps extreme agreement and injected report, network and focus claims informational through retries', async () => {
    const source = await game();
    const reported = await report(source);
    const eligibility = await rankedEligibility({ ...env, RANKED_ENABLED: 'true' }, source.black.id);
    expect(eligibility).toEqual({ eligible: true });
    const before = await env.DB.prepare('SELECT status,score,result_version,settlement FROM games WHERE id=?').bind(source.id).first();
    const extreme = summary();
    extreme.sides.w = { ...extreme.sides.w, meanLoss: 0, engineAgreement: 1 };
    extreme.sides.b = { ...extreme.sides.b, meanLoss: 0, engineAgreement: 1 };
    const fetcher = vi.fn(async (_: Request) => Response.json({ ...extreme,
      reportCount: 1000, sharedIp: true, focusChanges: 1000 }));
    const config = { ...analysisEnv(fetcher), OPERATION_MODE: 'unattended' };
    await accept([job(source.id), job(source.id, 'report')]);
    await drainAnalysis(config);
    await enqueueReportedGame(config, source.id);
    await drainAnalysis(config);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(await row(source.id)).toMatchObject({ status: 'done', attempts: 1 });
    const evidence = await env.DB.prepare("SELECT summary_json FROM fairplay_evidence WHERE case_id=? AND kind='engine_summary'")
      .bind(reported.caseId).first<{ summary_json: string }>();
    expect(JSON.parse(evidence!.summary_json)).toEqual(extreme.sides.b);
    expect(await env.DB.prepare('SELECT status,version FROM fairplay_cases WHERE id=?').bind(reported.caseId).first())
      .toEqual({ status: 'open', version: 1 });
    expect(await env.DB.prepare('SELECT 1 FROM fairplay_decisions WHERE case_id=?').bind(reported.caseId).first()).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM restrictions WHERE user_id=?').bind(source.black.id).first()).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM rating_correction_outbox WHERE subject_id=?').bind(source.black.id).first()).toBeNull();
    expect(await rankedEligibility({ ...env, RANKED_ENABLED: 'true' }, source.black.id)).toEqual(eligibility);
    expect(await env.DB.prepare('SELECT status,score,result_version,settlement FROM games WHERE id=?').bind(source.id).first()).toEqual(before);
  });

  it('excludes AI games from Queue admission, report recovery, engine work, and cached evidence', async () => {
    const source = await game();
    await report(source);
    await accept([job(source.id)]);
    await env.DB.prepare("UPDATE games SET ai_model_id='test-model' WHERE id=?").bind(source.id).run();
    await enqueueReportedGame(env, source.id);
    await reconcileReportedAnalysis(env);
    expect((await env.DB.prepare('SELECT analysis_requested_at FROM fairplay_reports WHERE game_id=?').bind(source.id).first())?.analysis_requested_at).toBeNull();
    const fetcher = vi.fn(async (_: Request) => Response.json(summary()));
    const config = analysisEnv(fetcher);
    await drainAnalysis(config);
    expect(await row(source.id)).toMatchObject({ status: 'dead', attempts: 0, summary_json: null });
    await env.DB.prepare("UPDATE analysis_jobs SET status='pending',summary_json=? WHERE game_id=?").bind(JSON.stringify(summary()), source.id).run();
    await drainAnalysis(config);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM fairplay_evidence WHERE game_id=? AND kind='engine_summary'").bind(source.id).first<{ n: number }>())?.n).toBe(0);
    const queued = await game();
    await env.DB.prepare("UPDATE games SET ai_model_id='test-model' WHERE id=?").bind(queued.id).run();
    await accept([job(queued.id)], config);
    expect(await row(queued.id)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT * FROM analysis_daily').first()).toBeNull();
  });

  it('enforces the atomic daily cap and leaves waiting work durable for the next day', async () => {
    const first = await game();
    const second = await game();
    await accept([job(first.id), job(second.id)]);
    const fetcher = vi.fn(async (_: Request) => Response.json(summary()));
    const config = { ...analysisEnv(fetcher), ANALYSIS_DAILY_LIMIT: '1' };
    await Promise.all([drainAnalysis(config), drainAnalysis(config)]);
    await drainAnalysis(config);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await env.DB.prepare('SELECT attempts FROM analysis_daily').first())?.attempts).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM analysis_jobs WHERE status='pending'").first<{ n: number }>())?.n).toBe(1);
    await drainAnalysis(config, Date.now() + 86_400_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('reclaims crashed work, bounds engine retries, and durably delivers dead letters', async () => {
    const source = await game();
    await accept([job(source.id)]);
    await env.DB.prepare("UPDATE analysis_jobs SET status='running',attempts=1,lease_until=? WHERE game_id=?").bind(Date.now() - 1, source.id).run();
    await env.DB.prepare("INSERT INTO analysis_lease(id,token,expires_at) VALUES('worker','crashed',?)").bind(Date.now() - 1).run();
    const fetcher = vi.fn(async (_: Request) => new Response('Unavailable', { status: 503 }));
    const config = analysisEnv(fetcher);
    await drainAnalysis(config);
    expect(await row(source.id)).toMatchObject({ status: 'pending', attempts: 2 });
    await drainAnalysis(config, Date.now() + 120_000);
    expect(await row(source.id)).toMatchObject({ status: 'dead', attempts: 3 });
    await accept([job(source.id)]);
    await drainAnalysis(config, Date.now() + 240_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((await env.DB.prepare('SELECT reason FROM analysis_dead_letters WHERE game_id=?').bind(source.id).first())?.reason).toBe('ATTEMPTS_EXHAUSTED');
    const send = vi.fn(async (_: unknown) => {});
    await cleanupAnalysis({ ...config, ANALYSIS_DEAD_LETTER_QUEUE: { send } as unknown as Queue });
    await cleanupAnalysis({ ...config, ANALYSIS_DEAD_LETTER_QUEUE: { send } as unknown as Queue });
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toMatchObject({ gameId: source.id, reason: 'ATTEMPTS_EXHAUSTED' });
    expect(JSON.stringify(send.mock.calls)).not.toContain('pgn');
  });

  it('retries saved evidence even after the last engine attempt without another charge', async () => {
    const source = await game();
    await report(source);
    await enqueueReportedGame(env, source.id);
    await env.DB.prepare("UPDATE analysis_jobs SET attempts=3,summary_json=?,last_error='EVIDENCE_FAILURE' WHERE game_id=?")
      .bind(JSON.stringify(summary()), source.id).run();
    await env.DB.prepare("UPDATE operations_control SET analysis_stopped=1 WHERE id='product'").run();
    const fetcher = vi.fn(async (_: Request) => Response.json(summary()));
    await drainAnalysis({ ...analysisEnv(fetcher), MONTHLY_ANALYSIS_LIMIT: '0' });
    expect(await row(source.id)).toMatchObject({ status: 'done', attempts: 3, last_error: null });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT * FROM analysis_daily').first()).toBeNull();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM fairplay_evidence WHERE game_id=? AND kind='engine_summary'").bind(source.id).first<{ n: number }>())?.n).toBe(1);
  });
});
