import { csp, directives } from '@ejm/site/headers';
import { chessHeaders } from '../policy';
import { FORMATS, type Actor as GameActor, type Pool } from '../shared/protocol';
import { isGameId } from '../shared/gamePath';
import { getEngineLevel, STOCKFISH_BUILD, type EngineLevel } from '../shared/engine';
import { acquireSeatGuard, authHandler, casualGameLimit, completeAccount, currentActor, hasRecoveryEmail, knownGame, PASSWORD_ACCOUNT_SQL, rankedEligibility, type Actor } from './auth';
import { accountRequestStatus, consumeAccountRequest } from './abuse';
import { budgetStatus } from './budget';
import { setBudgetStops } from './operations';
import { budgetStopWebhook } from './budget-webhook';
import { admittedRecoveryGame, recoveryInventory } from './recovery';
import { readArenaList, readArenaStandings, readArenaSummary } from './arena-projection';
import { publicArenaJson } from './public-arena-cache';
import { arenaRegistrationAdmission } from './arena-registration-admission';
import { cleanupPrivateData, fairPlayHandler, reviewAvailable } from './fairplay';
import { maintainUnattendedGames } from './maintenance';
import { cleanupAnalysis, consumeAnalysis, drainAnalysis, reconcileReportedAnalysis } from './analysis';
import { aiEnabled } from './env';
import type { JournalKind } from './competition';
import { publicProfile } from './profile';
import { closeAccount, exportAccount } from './privacy';
import { ApiError, canonicalOrigin, errorResponse, isLocalRequest, jsonResponse, readJson, requireAdmin, requireSameOrigin } from './security';
import type { Env } from './env';

export { Game } from './game';
export { Competition } from './competition';
export { StockfishAnalyzer } from './analysis';

/** Game authorities need a seat/session reference, never an email address. */
function gameActor(actor: Actor): GameActor {
  const { id, name, isAnonymous, sessionId, sessionExpiresAt } = actor;
  return { id, name, isAnonymous, sessionId, sessionExpiresAt };
}

function pool(value: unknown): Pool {
  if (typeof value !== 'string' || !Object.hasOwn(FORMATS, value)) throw new ApiError(400, 'INVALID_FORMAT', 'Choose 5 + 3 or 10 + 5.');
  return value as Pool;
}

function game(env: Env, id: string) {
  if (!isGameId(id)) throw new ApiError(404, 'GAME_NOT_FOUND', 'This game was not found.');
  return env.GAME.get(env.GAME.idFromName(id));
}

/** Static _headers do not cover Worker replies. Apply the public owner policy here too. */
function secure(response: Response, request: Request, env: Env, privateResponse = true): Response {
  // Binding replies have immutable headers. Preserve the socket explicitly
  // while creating a mutable response for the shared security policy.
  const result = response.status === 101
    ? new Response(null, { status: 101, headers: response.headers, webSocket: response.webSocket })
    : new Response(response.body, response);
  let policy = csp(chessHeaders);
  if (isLocalRequest(request, env)) {
    const local = directives(chessHeaders);
    delete local['upgrade-insecure-requests'];
    local['connect-src'].push(canonicalOrigin(env).replace(/^http/, 'ws'));
    policy = Object.entries(local).map(([name, sources]) => [name, ...sources].join(' ')).join('; ');
  }
  result.headers.set('Content-Security-Policy', policy);
  result.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  result.headers.set('Referrer-Policy', 'no-referrer');
  result.headers.set('X-Content-Type-Options', 'nosniff');
  result.headers.set('X-Frame-Options', 'DENY');
  if (!isLocalRequest(request, env)) result.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (privateResponse) result.headers.set('Cache-Control', 'no-store');
  if (/^\/account(?:\/|$)/.test(new URL(request.url).pathname)) result.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return result;
}

async function releaseRejectedSeat(env: Env, userId: string, gameId: string) {
  await env.DB.prepare('UPDATE active_game_seats SET released_at=? WHERE user_id=? AND game_id=? AND released_at IS NULL').bind(Date.now(), userId, gameId).run();
}

function archivedGame(id: string): Response {
  return jsonResponse({ error: 'GAME_ARCHIVED', message: 'This completed game is available in Replay.', replayUrl: `/replay/?game=${encodeURIComponent(id)}` }, 410);
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const origin = canonicalOrigin(env);
  if (url.origin !== origin) {
    if ((request.method === 'GET' || request.method === 'HEAD') && !url.pathname.startsWith('/api/')) {
      return Response.redirect(new URL(url.pathname + url.search, origin).href, 308);
    }
    throw new ApiError(403, 'INVALID_ORIGIN', 'Use the canonical chess site.');
  }
  if (url.pathname === '/api/operations/budget-stop') return budgetStopWebhook(request, env);
  if (url.pathname.startsWith('/api/auth/')) return authHandler(request, env);
  if (url.pathname === '/api/config' && request.method === 'GET') {
    return jsonResponse({ ranked: env.RANKED_ENABLED === 'true', ai: aiEnabled(env), tournaments: env.TOURNAMENTS_ENABLED === 'true', reviewAvailable: reviewAvailable(env), local: isLocalRequest(request, env), turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? null });
  }
  if (url.pathname === '/api/arenas' && request.method === 'GET') return publicArenaJson(request, ctx, () => readArenaList(env));
  const arenaRoute = /^\/api\/arenas\/([a-z0-9-]{1,80})(?:\/(standings|me|register|withdraw|queue|pause|resume))?$/.exec(url.pathname);
  if (arenaRoute && request.method === 'GET' && (!arenaRoute[2] || arenaRoute[2] === 'standings')) {
    return publicArenaJson(request, ctx, async () => {
      const value = arenaRoute[2] === 'standings'
        ? await readArenaStandings(env.DB, arenaRoute[1], url.searchParams.get('cursor'))
        : await readArenaSummary(env.DB, arenaRoute[1]);
      if (!value) throw new ApiError(404, 'ARENA_NOT_FOUND', 'This arena was not found.');
      return value;
    });
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') requireSameOrigin(request, env);
  if (request.method === 'POST' && arenaRoute?.[2] === 'register') {
    const body = await readJson(request, 1024);
    if (Object.keys(body).length) throw new ApiError(400, 'INVALID_ARENA_REQUEST', 'Send an empty object for this arena action.');
    return arenaRegistrationAdmission.run(async () => {
      const competition = env.COMPETITION.get(env.COMPETITION.idFromName('global'));
      // One native entry owns authentication across all Worker isolates.
      const result = await competition.registerArenaRequest(new Request(request.url, { headers: request.headers }), arenaRoute[1]);
      if (!result.ok) throw new ApiError(result.error.status, result.error.code, result.error.message);
      return jsonResponse(result.value);
    });
  }
  return authenticatedRoute(request, env, ctx, url, arenaRoute);
}

async function authenticatedRoute(request: Request, env: Env, ctx: ExecutionContext,
  url: URL, arenaRoute: RegExpExecArray | null): Promise<Response> {
  const requestActor = url.pathname.startsWith('/api/') || url.pathname === '/admin' || url.pathname.startsWith('/admin/')
    ? await currentActor(request, env) : null;
  if (requestActor && url.pathname.startsWith('/api/')) {
    const kind = request.method === 'GET' && /^\/api\/games\/[^/]+\/connect$/.test(url.pathname)
      ? 'connect' : ['GET', 'HEAD'].includes(request.method) ? 'read' : 'write';
    await consumeAccountRequest(env.DB, requestActor.id, kind);
  }
  const signedIn = (): Actor => {
    if (!requestActor) throw new ApiError(401, 'SIGN_IN_REQUIRED', 'Sign in to your chess account.');
    return requestActor;
  };
  if (arenaRoute) {
    const [, id, action] = arenaRoute;
    const actor = signedIn();
    const competition = env.COMPETITION.get(env.COMPETITION.idFromName('global'));
    if (action === 'me' && request.method === 'GET') {
      const value = await competition.getArenaMe(gameActor(actor), id);
      if (!value) throw new ApiError(404, 'ARENA_NOT_FOUND', 'This arena was not found.');
      return jsonResponse(value);
    }
    const actions = { register: 'registerArena', withdraw: 'withdrawArena', queue: 'queueArena', pause: 'pauseArena', resume: 'resumeArena' } as const;
    if (action && Object.hasOwn(actions, action) && request.method === 'POST') {
      const body = await readJson(request, 1024);
      if (Object.keys(body).length) throw new ApiError(400, 'INVALID_ARENA_REQUEST', 'Send an empty object for this arena action.');
      const result = await competition[actions[action as keyof typeof actions]](gameActor(actor), id);
      if (!result.ok) throw new ApiError(result.error.status, result.error.code, result.error.message);
      return jsonResponse(result.value);
    }
    throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use the arena action shown on the page.');
  }
  if (url.pathname === '/api/me' && request.method === 'GET') {
    const actor = requestActor;
    return jsonResponse(actor ? { id: actor.id, name: actor.name, isAnonymous: actor.isAnonymous, emailVerified: actor.emailVerified, hasRecoveryEmail: hasRecoveryEmail(actor.email), username: actor.username, accountReady: actor.accountReady } : null);
  }
  if (url.pathname === '/api/account/complete' && request.method === 'POST') return completeAccount(request, env);
  if (url.pathname === '/api/account/export' && request.method === 'POST') return exportAccount(request, env, signedIn());
  if (url.pathname === '/api/account/close' && request.method === 'POST') return closeAccount(request, env, signedIn());

  if (url.pathname === '/api/tournaments' && request.method === 'GET') {
    const actor = requestActor;
    return jsonResponse(await env.COMPETITION.get(env.COMPETITION.idFromName('global')).listTournaments(actor ? gameActor(actor) : undefined));
  }
  const tournamentRoute = /^\/api\/tournaments\/([a-z0-9-]{1,80})(?:\/(register|withdraw))?$/.exec(url.pathname);
  if (tournamentRoute) {
    const [, id, action] = tournamentRoute;
    const competition = env.COMPETITION.get(env.COMPETITION.idFromName('global'));
    if (!action && request.method === 'GET') {
      const actor = requestActor;
      const event = await competition.getTournament(id, actor ? gameActor(actor) : undefined);
      if (!event) throw new ApiError(404, 'TOURNAMENT_NOT_FOUND', 'This tournament was not found.');
      return jsonResponse(event);
    }
    if (action && request.method === 'POST') {
      const actor = signedIn();
      await readJson(request, 1024);
      const result = await (action === 'register' ? competition.registerTournament(gameActor(actor), id) : competition.withdrawTournament(gameActor(actor), id));
      if (!result.ok) throw new ApiError(result.error.status, result.error.code, result.error.message);
      return jsonResponse(result.value);
    }
    throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use the tournament action shown on the page.');
  }

  const fairplayRoute = /^\/api\/(reports$|appeals$|me\/fair-play$|admin\/(cases|decisions))/.test(url.pathname);
  if (fairplayRoute) {
    const actor = signedIn();
    const response = await fairPlayHandler(request, env, actor);
    if (response) {
      if (response.ok && request.method === 'POST' && url.pathname === '/api/admin/decisions') {
        ctx.waitUntil(env.COMPETITION.get(env.COMPETITION.idFromName('global')).processCorrections());
      }
      if (response.ok && request.method === 'POST' && url.pathname === '/api/reports') {
        ctx.waitUntil(reconcileReportedAnalysis(env));
      }
      return response;
    }
  }
  if (url.pathname === '/api/games' && request.method === 'POST') {
    const actor = signedIn();
    const body = await readJson<{ id?: unknown; format?: unknown; ai?: { modelId?: unknown; level?: unknown } }>(request, 1024);
    if (body.ai !== undefined && Object.keys(body).some(key => !['id', 'format', 'ai'].includes(key))) throw new ApiError(400, 'INVALID_GAME_REQUEST', 'Choose a format and game mode from the create-game form.');
    if (!isGameId(body.id)) throw new ApiError(400, 'INVALID_GAME_ID', 'Reopen the create-game form.');
    const format = pool(body.format);
    const admission = await env.DB.prepare('SELECT creator_id,storage_state FROM casual_game_admissions WHERE game_id=?').bind(body.id).first<{ creator_id: string; storage_state: string }>();
    if ((admission && admission.creator_id !== actor.id) || (!admission && await knownGame(env, body.id))) {
      throw new ApiError(404, 'GAME_NOT_FOUND', 'This game was not found for your session.');
    }
    if (admission?.storage_state === 'archived') return archivedGame(body.id);
    let ai: { modelId: string; level: EngineLevel } | undefined;
    if (body.ai !== undefined) {
      const level = getEngineLevel(body.ai?.level);
      if (!body.ai || typeof body.ai !== 'object' || Array.isArray(body.ai)
        || Object.keys(body.ai).some(key => !['modelId', 'level'].includes(key))
        || body.ai.modelId !== STOCKFISH_BUILD || !level) {
        throw new ApiError(400, 'INVALID_ENGINE', 'Choose an available computer difficulty.');
      }
      if (!admission && !aiEnabled(env)) throw new ApiError(503, 'AI_UNAVAILABLE', 'Computer practice is unavailable. Try a casual invitation.');
      ai = { modelId: STOCKFISH_BUILD, level: level.id };
    }
    const result = await env.COMPETITION.get(env.COMPETITION.idFromName('global')).createCasualGame(gameActor(actor), { id: body.id, format, ...(ai ? { ai } : {}) });
    if (!result.ok) throw new ApiError(result.error.status, result.error.code, result.error.message);
    return jsonResponse(result.snapshot, result.created ? 201 : 200);
  }
  const gameRoute = /^\/api\/games\/([^/]+)(?:\/(join|connect|pgn))?$/.exec(url.pathname);
  if (gameRoute) {
    const actor = signedIn();
    const [, id, action] = gameRoute;
    if (!isGameId(id) || !await knownGame(env, id)) throw new ApiError(404, 'GAME_NOT_FOUND', 'This game was not found.');
    if (action === 'pgn' && request.method === 'GET') {
      const row = await env.DB.prepare('SELECT pgn,status FROM games WHERE id=? AND (white_id=? OR black_id=?)').bind(id, actor.id, actor.id).first<{ pgn: string; status: string }>();
      if (!row || row.status !== 'finished') throw new ApiError(404, 'PGN_UNAVAILABLE', 'The completed game is not ready to export yet.');
      return new Response(row.pgn, { headers: { 'Content-Type': 'application/x-chess-pgn; charset=utf-8', 'Content-Disposition': `attachment; filename="${id}.pgn"`, 'Cache-Control': 'no-store' } });
    }
    const retired = await env.DB.prepare("SELECT 1 FROM casual_game_admissions WHERE game_id=? AND storage_state='archived' UNION ALL SELECT 1 FROM tournament_game_admissions WHERE game_id=? AND storage_state='archived' LIMIT 1").bind(id, id).first();
    if (retired) {
      const participant = await env.DB.prepare('SELECT reason FROM games WHERE id=? AND (white_id=? OR black_id=?)').bind(id, actor.id, actor.id).first<{ reason: string }>();
      if (!participant) {
        if (action === 'join' && request.method === 'POST') throw new ApiError(404, 'INVITATION_UNAVAILABLE', 'This invitation is no longer available. Ask your friend for a new link.');
        throw new ApiError(404, 'GAME_NOT_FOUND', 'This game was not found for your session.');
      }
      if (participant.reason === 'readiness-expired' && action === 'join' && request.method === 'POST') {
        throw new ApiError(404, 'INVITATION_UNAVAILABLE', 'This invitation is no longer available. Ask your friend for a new link.');
      }
      return archivedGame(id);
    }
    const stub = game(env, id);
    if (action === 'connect' && request.method === 'GET') {
      requireSameOrigin(request, env);
      const headers = new Headers(request.headers);
      // Overwrite any untrusted browser identity before crossing the private binding.
      headers.set('x-chess-actor', JSON.stringify(gameActor(actor)));
      return stub.fetch(new Request('https://game.internal/connect', { method: 'GET', headers }));
    }
    if (action === 'join' && request.method === 'POST') {
      await readJson(request, 1024);
      // An existing player can reopen even after the terminal outbox released the guard.
      const found = await stub.lookup(gameActor(actor));
      if (found) return jsonResponse(found);
      if (!actor.accountReady) throw new ApiError(403, 'ACCOUNT_REQUIRED', 'Create or complete your account to join a new game.');
      const casual = await env.DB.prepare('SELECT 1 FROM casual_game_admissions WHERE game_id=?').bind(id).first();
      if (!casual) throw new ApiError(409, 'SEAT_UNAVAILABLE', 'This ranked game already has its assigned players.');
      if (!await stub.status()) throw new ApiError(404, 'GAME_NOT_FOUND', 'This invitation was not found.');
      if (!await acquireSeatGuard(env, actor, id)) throw new ApiError(409, 'SEAT_UNAVAILABLE', 'Finish an active game or sign in again.');
      const result = await stub.claimSeat(gameActor(actor));
      if (result.ok) return jsonResponse(result.snapshot);
      await releaseRejectedSeat(env, actor.id, id);
      if (result.code === 'session_invalid') throw new ApiError(401, 'SIGN_IN_REQUIRED', 'Sign in again to take this seat.');
      throw new ApiError(result.code === 'game_not_found' ? 404 : 409, 'INVITATION_UNAVAILABLE', 'This invitation is no longer available. Ask your friend for a new link.');
    }
    if (!action && request.method === 'GET') {
      const found = await stub.lookup(gameActor(actor));
      if (!found) throw new ApiError(404, 'GAME_NOT_FOUND', 'This game was not found for your session.');
      return jsonResponse(found);
    }
  }
  if (url.pathname === '/api/history' && request.method === 'GET') {
    const actor = signedIn();
    const rows = await env.DB.prepare(`SELECT id,pool AS format,rated,ai_model_id AS aiModel,ai_actual_model AS actualModel,score,reason,status,ended_at AS endedAt,pgn FROM games
      WHERE (white_id=? OR black_id=?) ORDER BY ended_at DESC,id LIMIT 50`).bind(actor.id, actor.id).all<{ id: string; format: Pool; rated: number; aiModel: string | null; actualModel: string | null; score: number | null; reason: string; status: string; endedAt: number; pgn: string }>();
    return jsonResponse({ games: rows.results.map(({ score, status, pgn, ...row }) => ({ ...row, result: status === 'pending-adjudication' ? 'Pending adjudication' : score === 1 ? '1-0' : score === 0 ? '0-1' : score === 0.5 ? '½-½' : 'Void', ...(status === 'finished' ? { pgn } : {}) })) });
  }
  if (url.pathname === '/api/leaderboard' && request.method === 'GET') {
    const format = pool(url.searchParams.get('pool') ?? 'blitz');
    let cursor: { rating: number; id: string } | null = null;
    const token = url.searchParams.get('cursor');
    if (token) {
      try {
        if (token.length > 200) throw new Error();
        cursor = JSON.parse(atob(token));
        if (!cursor || !Number.isInteger(cursor.rating) || typeof cursor.id !== 'string' || cursor.id.length > 100) throw new Error();
      } catch { throw new ApiError(400, 'INVALID_CURSOR', 'Reload the leaderboard to start again.'); }
    }
    const now = Date.now();
    const rows = await env.DB.prepare(`SELECT l.user_id AS id,l.display_name AS name,l.rating_display AS rating,l.games,l.projected_at AS updatedAt
      FROM leaderboard_entries l JOIN user u ON u.id=l.user_id WHERE l.pool=? AND l.eligible=1
        AND (${PASSWORD_ACCOUNT_SQL})
        AND l.account_created_at<=? AND l.last_played_at>=?
        AND NOT EXISTS(SELECT 1 FROM restrictions r WHERE r.user_id=l.user_id AND r.revoked_at IS NULL AND r.expires_at>?)
        AND (? IS NULL OR l.rating_display<? OR (l.rating_display=? AND l.user_id>?))
      ORDER BY l.rating_display DESC,l.user_id ASC LIMIT 51`).bind(format, now - 7 * 86400_000, now - 30 * 86400_000, now,
        cursor?.rating ?? null, cursor?.rating ?? null, cursor?.rating ?? null, cursor?.id ?? '').all<{ id: string; name: string; rating: number; games: number; updatedAt: number }>();
    const page = rows.results.slice(0, 50);
    const last = page.at(-1);
    return jsonResponse({ pool: format, entries: page.map(({ updatedAt: _, ...row }) => row), updatedAt: page.length ? Math.max(...page.map(row => row.updatedAt)) : null,
      nextCursor: rows.results.length > 50 && last ? btoa(JSON.stringify({ rating: last.rating, id: last.id })) : null });
  }
  const profileRoute = /^\/api\/players\/([^/]+)$/.exec(url.pathname);
  if (profileRoute && request.method === 'GET') {
    const profile = await publicProfile(env, profileRoute[1]);
    if (!profile) throw new ApiError(404, 'PLAYER_NOT_FOUND', 'This player profile was not found.');
    return jsonResponse(profile);
  }
  if (url.pathname === '/api/queue' || url.pathname === '/api/queue/cancel') {
    const joining = request.method === 'POST' && url.pathname === '/api/queue';
    const actor = signedIn();
    if (joining) {
      const eligibility = await rankedEligibility(env, actor.id);
      if (!eligibility.eligible) throw new ApiError(403, eligibility.reason ?? 'RANKED_UNAVAILABLE', eligibility.reason === 'RANKED_CLOSED'
        ? 'Ranked play is closed.' : 'Ranked play requires an eligible account.');
    }
    const competition = env.COMPETITION.get(env.COMPETITION.idFromName('global'));
    if (request.method === 'GET' && url.pathname === '/api/queue') return jsonResponse(await competition.queueStatus(gameActor(actor)));
    if (request.method === 'POST') {
      const body = await readJson<{ pool?: unknown }>(request, 1024);
      if (url.pathname.endsWith('/cancel')) return jsonResponse(await competition.cancelQueue(gameActor(actor)));
      const region = String(request.cf?.continent ?? 'unknown').slice(0, 20);
      return jsonResponse(await competition.joinQueue(gameActor(actor), pool(body.pool), region));
    }
  }
  if (url.pathname.startsWith('/api/admin/operations')) {
    const actor = signedIn();
    await requireAdmin(request, env, actor);
    const competition = env.COMPETITION.get(env.COMPETITION.idFromName('global'));
    if (url.pathname === '/api/admin/operations' && request.method === 'GET') {
      const [authority, casual, analysis, budget, security] = await Promise.all([
        competition.health(),
        env.DB.prepare("SELECT COUNT(*) AS retained FROM casual_game_admissions WHERE storage_state='retained'").first(),
        env.DB.prepare('SELECT status,COUNT(*) AS jobs,MIN(created_at) AS oldest FROM analysis_jobs GROUP BY status').all(),
        budgetStatus(env),
        accountRequestStatus(env.DB),
      ]);
      return jsonResponse({ authority, budget, security, casual: { ...casual, limit: casualGameLimit(env) }, analysis: { enabled: env.ANALYSIS_ENABLED === 'true', states: analysis.results }, ai: { enabled: aiEnabled(env), build: STOCKFISH_BUILD, execution: 'browser' } });
    }
    if (url.pathname === '/api/admin/operations/budget' && request.method === 'POST') {
      return jsonResponse(await setBudgetStops(env, actor.id, await readJson(request, 1024)));
    }
    if (url.pathname === '/api/admin/operations/maintenance' && request.method === 'POST') {
      await readJson(request, 1024);
      const authority = await competition.maintenance();
      const [games, analysis] = await Promise.allSettled([
        maintainUnattendedGames(env),
        reconcileReportedAnalysis(env).then(() => drainAnalysis(env)),
      ]);
      return jsonResponse({ authority, games: games.status === 'fulfilled' ? games.value : 'retry-needed',
        analysis: analysis.status === 'fulfilled' ? 'complete' : 'retry-needed' });
    }
    if (url.pathname === '/api/admin/operations/export/manifest' && request.method === 'GET') return jsonResponse(await competition.beginExport());
    if (url.pathname === '/api/admin/operations/recovery/inventory' && request.method === 'GET') {
      const limit = url.searchParams.get('limit') ?? '50';
      if (!/^[0-9]{1,2}$/.test(limit)) throw new ApiError(400, 'INVALID_RECOVERY_CURSOR', 'Use a recovery page limit from 1 to 50.');
      return jsonResponse(await recoveryInventory(env, url.searchParams.get('after') ?? '', Number(limit)));
    }
    if (url.pathname === '/api/admin/operations/recovery/competition' && request.method === 'POST') {
      await readJson(request, 1024);
      return jsonResponse(await competition.captureRecoveryPoint());
    }
    const captureGame = /^\/api\/admin\/operations\/recovery\/games\/([^/]+)$/.exec(url.pathname);
    if (captureGame && request.method === 'POST') {
      await readJson(request, 1024);
      if (!await admittedRecoveryGame(env, captureGame[1])) throw new ApiError(404, 'GAME_NOT_FOUND', 'This admitted game was not found.');
      return jsonResponse(await game(env, captureGame[1]).captureRecoveryPoint(captureGame[1]));
    }
    if (url.pathname === '/api/admin/operations/export' && request.method === 'GET') {
      const kind = url.searchParams.get('kind');
      const after = url.searchParams.get('after') ?? '0';
      const watermark = url.searchParams.get('watermark');
      const kinds: JournalKind[] = ['results', 'ratings', 'correctedRatings', 'corrections', 'voids', 'restorations', 'checkpoints', 'arenaScores'];
      if (!kinds.includes(kind as JournalKind) || !/^\d{1,16}$/.test(after) || !watermark || !/^\d{1,16}$/.test(watermark)
        || !Number.isSafeInteger(Number(after)) || !Number.isSafeInteger(Number(watermark)) || Number(after) > Number(watermark)) {
        throw new ApiError(400, 'INVALID_EXPORT_CURSOR', 'Use a journal kind and watermark from the export manifest.');
      }
      return jsonResponse(await competition.exportEvents({ kind: kind as JournalKind, after: Number(after), watermark: Number(watermark) }));
    }
  }
  const voidRoute = /^\/api\/admin\/games\/([^/]+)\/void$/.exec(url.pathname);
  if (voidRoute && request.method === 'POST') {
    const actor = signedIn();
    await requireAdmin(request, env, actor);
    const body = await readJson<{ decisionId?: unknown }>(request, 1024);
    if (typeof body.decisionId !== 'string') throw new ApiError(400, 'INVALID_DECISION', 'Supply a stable decision ID.');
    if (!isGameId(voidRoute[1]) || !await knownGame(env, voidRoute[1])) throw new ApiError(404, 'GAME_NOT_FOUND', 'This game was not found.');
    return jsonResponse(await game(env, voidRoute[1]).technicalVoid(body.decisionId));
  }
  const securityRoute = /^\/api\/admin\/games\/([^/]+)\/security$/.exec(url.pathname);
  if (securityRoute && request.method === 'GET') {
    await requireAdmin(request, env, signedIn());
    if (!isGameId(securityRoute[1]) || !await knownGame(env, securityRoute[1])) throw new ApiError(404, 'GAME_NOT_FOUND', 'This game was not found.');
    return jsonResponse(await game(env, securityRoute[1]).securityStatus());
  }
  if (url.pathname.startsWith('/api/')) throw new ApiError(404, 'NOT_FOUND', 'This endpoint was not found.');
  if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) await requireAdmin(request, env, requestActor);
  if (!['GET', 'HEAD'].includes(request.method)) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Use GET for this page.');
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const response = await route(request, env, ctx);
      const path = new URL(request.url).pathname;
      const publicArenaRead = response.ok && request.method === 'GET' && /^\/api\/arenas(?:\/[a-z0-9-]{1,80}(?:\/standings)?)?$/.test(path);
      return secure(response, request, env, !publicArenaRead && (path.startsWith('/api/') || path.startsWith('/admin') || /^\/account(?:\/|$)/.test(path)));
    } catch (error) {
      let safeError: unknown = error;
      if (error instanceof Error) {
        if (error.message.includes('engine_unavailable')) safeError = new ApiError(503, 'AI_UNAVAILABLE', 'Computer practice is unavailable. Try a casual invitation.');
        if (['game_not_found', 'not_a_player'].some(code => error.message.includes(code))) safeError = new ApiError(404, 'GAME_NOT_FOUND', 'This game was not found for your session.');
        if (error.message.includes('seat_unavailable')) safeError = new ApiError(409, 'SEAT_UNAVAILABLE', 'This invitation has already been claimed or has expired.');
      }
      try { return secure(errorResponse(safeError), request, env); }
      catch { return errorResponse(safeError); }
    }
  },
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    await consumeAnalysis(batch, env);
  },
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const work: [string, () => Promise<unknown>][] = [
      ['competition', () => env.COMPETITION.get(env.COMPETITION.idFromName('global')).maintenance()],
      ['unattended_games', () => maintainUnattendedGames(env)],
      ['analysis', async () => { await reconcileReportedAnalysis(env); await drainAnalysis(env); }],
    ];
    if (event.cron === '15 3 * * *') work.push(['private_cleanup', () => cleanupPrivateData(env)], ['analysis_cleanup', () => cleanupAnalysis(env)]);
    ctx.waitUntil((async () => {
      const results = await Promise.allSettled(work.map(([, run]) => run()));
      results.forEach((result, index) => { if (result.status === 'rejected') console.error('maintenance_failed', work[index][0]); });
    })());
  },
} satisfies ExportedHandler<Env>;
