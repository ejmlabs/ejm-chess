import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface SecurityEnv {
  AUTH_BASE_URL: string;
  LOCAL_DEV?: string;
  TURNSTILE_SECRET_KEY?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  OWNER_EMAILS?: string;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public retryAfterSeconds?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

export function canonicalOrigin(env: SecurityEnv): string {
  let url: URL;
  try { url = new URL(env.AUTH_BASE_URL); }
  catch { throw new ApiError(503, 'CONFIGURATION_UNAVAILABLE', 'Service configuration is unavailable.'); }
  const local = env.LOCAL_DEV === 'true' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((!local && url.origin !== 'https://chess.ejmlabs.com') || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new ApiError(503, 'CONFIGURATION_UNAVAILABLE', 'Service configuration is unavailable.');
  }
  if (local && !['http:', 'https:'].includes(url.protocol)) {
    throw new ApiError(503, 'CONFIGURATION_UNAVAILABLE', 'Service configuration is unavailable.');
  }
  return url.origin;
}

export function isLocalRequest(request: Request, env: SecurityEnv): boolean {
  return env.LOCAL_DEV === 'true'
    && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(request.url).hostname)
    && new URL(request.url).origin === canonicalOrigin(env);
}

export function requireSameOrigin(request: Request, env: SecurityEnv): void {
  const origin = canonicalOrigin(env);
  if (new URL(request.url).origin !== origin || request.headers.get('Origin') !== origin) {
    throw new ApiError(403, 'INVALID_ORIGIN', 'This request must come from the chess site.');
  }
}

export async function readJson<T = Record<string, unknown>>(request: Pick<Request, 'headers' | 'body'>, maxBytes = 16_384): Promise<T> {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
    throw new ApiError(415, 'JSON_REQUIRED', 'Send a JSON request.');
  }
  const declared = request.headers.get('Content-Length');
  if (declared && Number(declared) > maxBytes) throw new ApiError(413, 'REQUEST_TOO_LARGE', 'The request is too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, 'INVALID_JSON', 'Send a JSON object.');
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      void reader.cancel().catch(() => {});
      throw new ApiError(413, 'REQUEST_TOO_LARGE', 'The request is too large.');
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as T;
  } catch { throw new ApiError(400, 'INVALID_JSON', 'Send a JSON object.'); }
}

/** Siteverify consumes each valid token. A local bypass requires both explicit mode and an exact loopback origin. */
export async function verifyTurnstile(request: Request, env: SecurityEnv, action: 'sign-up' | 'sign-in' | 'password-reset' | 'verify-email' | 'account-complete' | 'report', fetcher: typeof fetch = fetch): Promise<void> {
  if (isLocalRequest(request, env) && request.headers.get('X-Turnstile-Token') === 'local-development') return;
  const token = request.headers.get('X-Turnstile-Token');
  if (!env.TURNSTILE_SECRET_KEY) throw new ApiError(503, 'CHALLENGE_UNAVAILABLE', 'The security check is unavailable. Try again later.');
  if (!token || token.length > 2048) throw new ApiError(403, 'CHALLENGE_REQUIRED', 'Complete the security check again.');
  const body = new FormData();
  body.set('secret', env.TURNSTILE_SECRET_KEY);
  body.set('response', token);
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) body.set('remoteip', ip);
  let result: { success?: boolean; hostname?: string; action?: string; challenge_ts?: string };
  try {
    const response = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body, signal: AbortSignal.timeout(6_000) });
    if (!response.ok) throw new Error();
    result = await response.json();
  } catch { throw new ApiError(503, 'CHALLENGE_UNAVAILABLE', 'The security check is unavailable. Try again later.'); }
  const age = Date.now() - Date.parse(result.challenge_ts ?? '');
  if (!result.success || result.hostname !== new URL(canonicalOrigin(env)).hostname || result.action !== action || !Number.isFinite(age) || age < -30_000 || age > 300_000) {
    throw new ApiError(403, 'CHALLENGE_INVALID', 'Complete the security check again.');
  }
}

const accessKeys = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** The optional resolver is a test seam, never a request or environment option. */
export async function verifyAccessJwt(token: string, env: SecurityEnv, resolver?: JWTVerifyGetKey): Promise<string> {
  const team = env.CF_ACCESS_TEAM_DOMAIN;
  if (!team || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team) || !env.CF_ACCESS_AUD) {
    throw new ApiError(503, 'ADMIN_UNAVAILABLE', 'Private review is unavailable.');
  }
  const issuer = `https://${team}`;
  let keys = resolver ?? accessKeys.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), { timeoutDuration: 5_000 });
    accessKeys.clear();
    accessKeys.set(issuer, keys as ReturnType<typeof createRemoteJWKSet>);
  }
  try {
    const { payload } = await jwtVerify(token, keys, { issuer, audience: env.CF_ACCESS_AUD, algorithms: ['RS256'], requiredClaims: ['iss', 'aud', 'sub', 'email', 'iat', 'exp'], maxTokenAge: '24h' });
    if (typeof payload.email !== 'string' || payload.type !== 'app') throw new Error();
    return payload.email.trim().toLowerCase();
  } catch { throw new ApiError(403, 'ADMIN_REQUIRED', 'Private review requires owner access.'); }
}

export interface AdminActor {
  id: string;
  email: string;
  emailVerified: boolean;
  isAnonymous: boolean;
}

export async function requireAdmin(request: Request, env: SecurityEnv, actor: AdminActor | null): Promise<AdminActor> {
  if (!actor || !actor.emailVerified || actor.isAnonymous) throw new ApiError(403, 'ADMIN_REQUIRED', 'Private review requires owner access.');
  const allowed = (env.OWNER_EMAILS ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  const token = request.headers.get('CF-Access-Jwt-Assertion');
  if (!token || !allowed.includes(actor.email.toLowerCase())) throw new ApiError(403, 'ADMIN_REQUIRED', 'Private review requires owner access.');
  const accessEmail = await verifyAccessJwt(token, env);
  if (accessEmail !== actor.email.toLowerCase()) throw new ApiError(403, 'ADMIN_REQUIRED', 'Private review requires owner access.');
  return actor;
}

export function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

/** An ApiError thrown inside a Durable Object reaches the Worker as a plain Error that keeps its fields. Restore it so the caller sees the real status and code. */
function restoreApiError(error: unknown): unknown {
  if (!(error instanceof Error) || error.name !== 'ApiError') return error;
  const { status, code, retryAfterSeconds } = error as Error & Partial<ApiError>;
  return Number.isInteger(status) && typeof code === 'string' ? new ApiError(status!, code, error.message, retryAfterSeconds) : error;
}

export function errorResponse(thrown: unknown): Response {
  const error = restoreApiError(thrown);
  if (error instanceof ApiError) {
    const response = jsonResponse({ error: error.code, message: error.message }, error.status);
    if (error.retryAfterSeconds !== undefined) response.headers.set('Retry-After', String(error.retryAfterSeconds));
    return response;
  }
  return jsonResponse({ error: 'SERVICE_UNAVAILABLE', message: 'The service is unavailable. Try again later.' }, 503);
}
