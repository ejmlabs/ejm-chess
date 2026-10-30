import { ApiError } from './security';

const MINUTE = 60_000;
const DAY = 86_400_000;
const MAX_COUNTER = 1_000_000_000;

export const ACCOUNT_REQUEST_LIMITS = {
  read: { maximum: 120, windowMs: MINUTE },
  write: { maximum: 30, windowMs: MINUTE },
  connect: { maximum: 12, windowMs: MINUTE },
  credential: { maximum: 3, windowMs: MINUTE },
} as const;
type RequestKind = keyof typeof ACCOUNT_REQUEST_LIMITS;

/** Each exhausted account/window contributes once to a fixed, private daily counter. */
export async function consumeAccountRequest(db: D1Database, userId: string, kind: RequestKind, now = Date.now()): Promise<void> {
  const policy = ACCOUNT_REQUEST_LIMITS[kind];
  const key = `account:${kind}:${userId}`;
  const day = Math.floor(now / DAY) * DAY;
  const results = await db.batch<{ count: number; window_start: number }>([
    db.prepare(`INSERT INTO request_limits(key,count,window_start) VALUES(?,1,?)
      ON CONFLICT(key) DO UPDATE SET
        count=CASE WHEN window_start<=? THEN 1 ELSE MIN(count+1,?) END,
        window_start=CASE WHEN window_start<=? THEN excluded.window_start ELSE window_start END
      RETURNING count,window_start`)
      .bind(key, now, now - policy.windowMs, policy.maximum + 2, now - policy.windowMs),
    db.prepare(`INSERT INTO request_limits(key,count,window_start)
      SELECT ?,1,? WHERE EXISTS(SELECT 1 FROM request_limits WHERE key=? AND count=?)
      ON CONFLICT(key) DO UPDATE SET
        count=CASE WHEN window_start<excluded.window_start THEN 1 ELSE MIN(count+1,?) END,
        window_start=MAX(window_start,excluded.window_start)
      WHERE window_start<=excluded.window_start`)
      .bind(`security:exhausted:${kind}`, day, key, policy.maximum + 1, MAX_COUNTER),
  ]);
  const row = results[0].results[0];
  if (!row) throw new Error('request_limit_unavailable');
  if (row.count <= policy.maximum) return;
  throw new ApiError(429, 'REQUEST_RATE_LIMITED', 'Too many requests. Try again shortly.',
    Math.max(1, Math.ceil((row.window_start + policy.windowMs - now) / 1_000)));
}

export async function accountRequestStatus(db: D1Database, now = Date.now()) {
  const day = Math.floor(now / DAY) * DAY;
  const rows = await db.prepare('SELECT key,count FROM request_limits WHERE key IN (?,?,?,?) AND window_start=?')
    .bind('security:exhausted:read', 'security:exhausted:write', 'security:exhausted:connect', 'security:exhausted:credential', day)
    .all<{ key: string; count: number }>();
  return {
    policy: ACCOUNT_REQUEST_LIMITS,
    exhaustedWindowsSince: day,
    exhaustedWindows: Object.fromEntries((Object.keys(ACCOUNT_REQUEST_LIMITS) as RequestKind[])
      .map(kind => [kind, rows.results.find(row => row.key === `security:exhausted:${kind}`)?.count ?? 0])),
  };
}

export const GAME_PROTOCOL_LIMITS = {
  command: { maximum: 30, windowMs: 10_000 },
  connect: { maximum: 10, windowMs: MINUTE },
} as const;
type ProtocolKind = keyof typeof GAME_PROTOCOL_LIMITS;
type ProtocolCounter = 'commandWindows' | 'connectWindows' | 'invalidFrames';

export function initializeProtocolLimits(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS protocol_limits
    (scope TEXT NOT NULL,user_id TEXT NOT NULL,window_start INTEGER NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(scope,user_id))`);
  sql.exec('CREATE TABLE IF NOT EXISTS protocol_counters (kind TEXT PRIMARY KEY,count INTEGER NOT NULL)');
}

export function countProtocolEvent(sql: SqlStorage, kind: ProtocolCounter): void {
  sql.exec(`INSERT INTO protocol_counters(kind,count) VALUES(?,1)
    ON CONFLICT(kind) DO UPDATE SET count=MIN(count+1,?)`, kind, MAX_COUNTER);
}

/** Call only after checking the assigned seat, bounding each game to four buckets. */
export function consumeGameProtocol(sql: SqlStorage, userId: string, kind: ProtocolKind, now: number): { allowed: boolean; retryAfterSeconds: number } {
  const policy = GAME_PROTOCOL_LIMITS[kind];
  const row = sql.exec<{ count: number; window_start: number }>(`INSERT INTO protocol_limits(scope,user_id,window_start,count) VALUES(?,?,?,1)
    ON CONFLICT(scope,user_id) DO UPDATE SET
      count=CASE WHEN window_start<=? THEN 1 ELSE MIN(count+1,?) END,
      window_start=CASE WHEN window_start<=? THEN excluded.window_start ELSE window_start END
    RETURNING count,window_start`, kind, userId, now, now - policy.windowMs, policy.maximum + 2, now - policy.windowMs).one();
  if (row.count === policy.maximum + 1) countProtocolEvent(sql, kind === 'command' ? 'commandWindows' : 'connectWindows');
  return { allowed: row.count <= policy.maximum, retryAfterSeconds: Math.max(1, Math.ceil((row.window_start + policy.windowMs - now) / 1_000)) };
}

export function gameProtocolStatus(sql: SqlStorage) {
  const rows = sql.exec<{ kind: string; count: number }>('SELECT kind,count FROM protocol_counters').toArray();
  return { policy: GAME_PROTOCOL_LIMITS, counters: Object.fromEntries((['commandWindows', 'connectWindows', 'invalidFrames'] as const)
    .map(kind => [kind, rows.find(row => row.kind === kind)?.count ?? 0])) };
}
