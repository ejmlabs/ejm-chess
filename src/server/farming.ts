import type { GameResult } from '../shared/protocol';

export const FARMING_POLICY = 'informational-2026-10-v2';
const DAY = 86_400_000;
const RETAINED = 1_000;
const QUERY_LIMIT = RETAINED + 1;
const CANDIDATE_LIMIT = 4 * RETAINED;
const CATCHUP_LIMIT = 8;
export const FARMING_PATTERNS = ['repeated-pair', 'reciprocal-wins', 'early-resignation', 'account-cluster', 'rating-transfer-candidate'] as const;
type Pattern = typeof FARMING_PATTERNS[number];
type Check = {
  game_id: string; event_id: string; terminal_digest: string; policy: string; pair_key: string;
  winner_id: string | null; score: number | null; reason: string; plies: number; ended_at: number;
  patterns_json: string; coverage: 'pending' | 'complete' | 'incomplete'; coverage_reason: string | null;
};
type CoverageReason = 'candidate-limit' | 'update-limit' | 'source-unavailable';
export interface FarmingWork {
  duplicate: boolean;
  complete: boolean;
  candidateRows: number;
  rowsRead: number;
  updatedChecks: number;
  reason?: CoverageReason;
}
const COLUMNS = 'game_id,event_id,terminal_digest,policy,pair_key,winner_id,score,reason,plies,ended_at,patterns_json,coverage,coverage_reason';

export function initializeFarmingChecks(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS rated_result_checks
    (game_id TEXT PRIMARY KEY,event_id TEXT NOT NULL,terminal_digest TEXT NOT NULL,policy TEXT NOT NULL,
      pair_key TEXT NOT NULL,winner_id TEXT,reason TEXT NOT NULL,plies INTEGER NOT NULL,ended_at INTEGER NOT NULL,
      patterns_json TEXT NOT NULL,checked_at INTEGER NOT NULL,score REAL,
      coverage TEXT NOT NULL DEFAULT 'pending',coverage_reason TEXT)`);
  const columns = new Set(sql.exec<{ name: string }>('PRAGMA table_info(rated_result_checks)').toArray().map(column => column.name));
  if (!columns.has('score')) sql.exec('ALTER TABLE rated_result_checks ADD COLUMN score REAL');
  if (!columns.has('coverage')) sql.exec("ALTER TABLE rated_result_checks ADD COLUMN coverage TEXT NOT NULL DEFAULT 'pending'");
  if (!columns.has('coverage_reason')) sql.exec('ALTER TABLE rated_result_checks ADD COLUMN coverage_reason TEXT');
  sql.exec('CREATE INDEX IF NOT EXISTS rated_check_pair ON rated_result_checks(pair_key,ended_at)');
  sql.exec("CREATE INDEX IF NOT EXISTS rated_check_account_0 ON rated_result_checks(json_extract(pair_key,'$[0]'),ended_at,game_id)");
  sql.exec("CREATE INDEX IF NOT EXISTS rated_check_account_1 ON rated_result_checks(json_extract(pair_key,'$[1]'),ended_at,game_id)");
  sql.exec('CREATE INDEX IF NOT EXISTS rated_check_winner ON rated_result_checks(winner_id,ended_at,game_id)');
  sql.exec('CREATE INDEX IF NOT EXISTS rated_check_coverage ON rated_result_checks(coverage,game_id)');
  sql.exec('CREATE TABLE IF NOT EXISTS rated_farming_upgrade (policy TEXT PRIMARY KEY,cursor TEXT NOT NULL)');
  sql.exec("INSERT OR IGNORE INTO rated_farming_upgrade(policy,cursor) VALUES(?,'')", FARMING_POLICY);
}

function pair(check: Check): [string, string] { return JSON.parse(check.pair_key) as [string, string]; }
function early(check: Check): boolean { return check.winner_id !== null && check.reason === 'resignation' && check.plies < 10; }
function order(a: Check, b: Check): number { return a.ended_at - b.ended_at || a.game_id.localeCompare(b.game_id); }

function incomplete(sql: SqlStorage, check: Check, work: FarmingWork, reason: CoverageReason): FarmingWork {
  sql.exec("UPDATE rated_result_checks SET policy=?,coverage='incomplete',coverage_reason=? WHERE game_id=?", FARMING_POLICY, reason, check.game_id);
  return { ...work, complete: false, reason };
}

function analyze(sql: SqlStorage, current: Check, now: number): FarmingWork {
  const work: FarmingWork = { duplicate: false, complete: false, candidateRows: 0, rowsRead: 0, updatedChecks: 0 };
  const checks = new Map<string, Check>([[current.game_id, current]]);
  const flags = new Map<string, Set<Pattern>>();
  function mark(check: Check, pattern: Pattern) {
    const values = flags.get(check.game_id) ?? new Set<Pattern>(JSON.parse(check.patterns_json) as Pattern[]);
    values.add(pattern);
    flags.set(check.game_id, values);
  }
  // Each lookup seeks an indexed local time window. The extra row is a guard,
  // not permission to analyze more than the retained-ranked admission ceiling.
  function read(where: string, bindings: Array<string | number>, ordering = 'ended_at,game_id'): Check[] | null {
    const cursor = sql.exec<Check>(`SELECT ${COLUMNS} FROM rated_result_checks WHERE ${where} ORDER BY ${ordering} LIMIT ${QUERY_LIMIT}`, ...bindings);
    const rows = cursor.toArray();
    work.rowsRead += cursor.rowsRead;
    work.candidateRows += rows.length;
    if (rows.length > RETAINED || work.candidateRows > CANDIDATE_LIMIT) return null;
    for (const check of rows) checks.set(check.game_id, check);
    return rows;
  }
  const from = current.ended_at - DAY;
  const until = current.ended_at + DAY;
  const peers = read('pair_key=? AND ended_at>=? AND ended_at<=?', [current.pair_key, from, until], 'ended_at');
  if (!peers) return incomplete(sql, current, work, 'candidate-limit');
  for (const peer of peers) {
    if (peer.game_id === current.game_id) continue;
    mark(current, 'repeated-pair'); mark(peer, 'repeated-pair');
    if (current.winner_id !== null && peer.winner_id !== null && peer.winner_id !== current.winner_id) {
      mark(current, 'reciprocal-wins'); mark(peer, 'reciprocal-wins');
    }
  }

  if (current.score !== null) {
    const [a, b] = pair(current);
    const incident = new Map<string, Check>();
    for (const account of [a, b]) {
      for (const index of [0, 1]) {
        const rows = read(`json_extract(pair_key,'$[${index}]')=? AND ended_at>=? AND ended_at<=?`, [account, from, until]);
        if (!rows) return incomplete(sql, current, work, 'candidate-limit');
        for (const check of rows) incident.set(check.game_id, check);
      }
    }
    const neighbors = new Map<string, { a: Check[]; b: Check[] }>();
    for (const check of incident.values()) {
      if (check.score === null || check.pair_key === current.pair_key) continue;
      const accounts = pair(check);
      const side = accounts.includes(a) ? 'a' : accounts.includes(b) ? 'b' : null;
      if (!side) continue;
      const other = accounts[0] === (side === 'a' ? a : b) ? accounts[1] : accounts[0];
      const neighbor = neighbors.get(other) ?? { a: [], b: [] };
      neighbor[side].push(check); neighbors.set(other, neighbor);
    }
    for (const neighbor of neighbors.values()) {
      if (!neighbor.a.length || !neighbor.b.length) continue;
      neighbor.a.sort(order); neighbor.b.sort(order);
      for (const [left, right] of [[neighbor.a, neighbor.b], [neighbor.b, neighbor.a]]) {
        for (const check of left) {
          const lower = Math.max(current.ended_at, check.ended_at) - DAY;
          const upper = Math.min(current.ended_at, check.ended_at) + DAY;
          let lo = 0; let hi = right.length;
          while (lo < hi) {
            const middle = (lo + hi) >>> 1;
            if (right[middle].ended_at < lower) lo = middle + 1;
            else hi = middle;
          }
          if (lo < right.length && right[lo].ended_at <= upper) {
            mark(check, 'account-cluster'); mark(current, 'account-cluster');
          }
        }
      }
    }
  }

  if (current.winner_id !== null) {
    const wins = read('winner_id=? AND ended_at>=? AND ended_at<=?', [current.winner_id, from, until]);
    if (!wins) return incomplete(sql, current, work, 'candidate-limit');
    let right = 0; let earlyWins = 0; let markedUntil = 0;
    const donors = new Map<string, number>();
    function donor(check: Check): string {
      const accounts = pair(check);
      return accounts[0] === current.winner_id ? accounts[1] : accounts[0];
    }
    for (let left = 0; left < wins.length; left++) {
      while (right < wins.length && wins[right].ended_at - wins[left].ended_at <= DAY) {
        const account = donor(wins[right]);
        donors.set(account, (donors.get(account) ?? 0) + 1);
        if (early(wins[right])) earlyWins++;
        right++;
      }
      if (right - left >= 3 && donors.size >= 2 && earlyWins >= 2) {
        for (let index = Math.max(left, markedUntil); index < right; index++) mark(wins[index], 'rating-transfer-candidate');
        markedUntil = Math.max(markedUntil, right);
      }
      const account = donor(wins[left]);
      const count = donors.get(account)! - 1;
      if (count) donors.set(account, count); else donors.delete(account);
      if (early(wins[left])) earlyWins--;
    }
  }

  // Apply nothing from an incomplete neighborhood. The basic durable record
  // and its original facts remain, and settlement is never denied by a guard.
  if (checks.size > RETAINED || new Set([...flags.keys(), current.game_id]).size > RETAINED) {
    return incomplete(sql, current, work, 'update-limit');
  }
  for (const id of new Set([...flags.keys(), current.game_id])) {
    const check = checks.get(id)!;
    const values = flags.get(id) ?? new Set<Pattern>(JSON.parse(check.patterns_json) as Pattern[]);
    const patterns = JSON.stringify(FARMING_PATTERNS.filter(pattern => values.has(pattern)));
    if (id === current.game_id) {
      sql.exec("UPDATE rated_result_checks SET patterns_json=?,policy=?,coverage='complete',coverage_reason=NULL,checked_at=? WHERE game_id=?",
        patterns, FARMING_POLICY, now, id);
      work.updatedChecks++;
    } else if (patterns !== check.patterns_json) {
      sql.exec('UPDATE rated_result_checks SET patterns_json=? WHERE game_id=?', patterns, id);
      work.updatedChecks++;
    }
  }
  return { ...work, complete: true };
}

/** These server facts never change ratings, results, account eligibility, or restrictions. */
export function recordFarmingCheck(sql: SqlStorage, result: GameResult, now: number): FarmingWork | null {
  if (!result.rated || result.ai || result.status !== 'finished' || !result.black) return null;
  if (result.white.id === result.black.id) throw new Error('self_play_result');
  const winner = result.outcome.score === 1 ? result.white.id : result.outcome.score === 0 ? result.black.id : null;
  const patterns: Pattern[] = result.outcome.reason === 'resignation' && winner !== null && result.plies < 10 ? ['early-resignation'] : [];
  const inserted = sql.exec<Check>(`INSERT OR IGNORE INTO rated_result_checks
    (game_id,event_id,terminal_digest,policy,pair_key,winner_id,reason,plies,ended_at,patterns_json,checked_at,score)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?) RETURNING ${COLUMNS}`, result.id, result.eventId, result.terminalDigest,
    FARMING_POLICY, JSON.stringify([result.white.id, result.black.id].sort()), winner, result.outcome.reason,
    result.plies, result.endedAt, JSON.stringify(patterns), now, result.outcome.score).toArray();
  return inserted.length ? analyze(sql, inserted[0], now)
    : { duplicate: true, complete: true, candidateRows: 0, rowsRead: 0, updatedChecks: 0 };
}

export function farmingWorkPending(sql: SqlStorage): boolean {
  return Boolean(sql.exec("SELECT 1 FROM rated_result_checks WHERE coverage='pending' LIMIT 1").toArray().length);
}

/** One indexed keyset page of at most eight legacy checks. */
export function advanceFarmingChecks(sql: SqlStorage, now: number, limit = CATCHUP_LIMIT): { processed: number; pending: boolean; cursor: string } {
  const batch = Number.isSafeInteger(limit) ? Math.max(1, Math.min(CATCHUP_LIMIT, limit)) : CATCHUP_LIMIT;
  let cursor = sql.exec<{ cursor: string }>('SELECT cursor FROM rated_farming_upgrade WHERE policy=?', FARMING_POLICY).one().cursor;
  const page = () => sql.exec<Check>(`SELECT ${COLUMNS} FROM rated_result_checks WHERE coverage='pending' AND game_id>? ORDER BY game_id LIMIT ?`, cursor, batch).toArray();
  let rows = page();
  if (!rows.length && cursor) { cursor = ''; rows = page(); }
  for (const check of rows) {
    const source = sql.exec<{ payload: string }>('SELECT payload FROM result_events WHERE event_id=? LIMIT 1', check.event_id).toArray()[0];
    let result: GameResult | null = null;
    try { if (source) result = JSON.parse(source.payload) as GameResult; } catch { /* Keep an explicit incomplete record. */ }
    if (!result || result.id !== check.game_id || result.eventId !== check.event_id || result.terminalDigest !== check.terminal_digest
      || !result.rated || result.ai || result.status !== 'finished' || !result.black
      || ![null, 0, 0.5, 1].includes(result.outcome?.score)) {
      incomplete(sql, check, { duplicate: false, complete: false, candidateRows: 0, rowsRead: 0, updatedChecks: 0 }, 'source-unavailable');
    } else {
      sql.exec('UPDATE rated_result_checks SET score=? WHERE game_id=?', result.outcome.score, check.game_id);
      analyze(sql, { ...check, score: result.outcome.score }, now);
    }
    cursor = check.game_id;
  }
  sql.exec('UPDATE rated_farming_upgrade SET cursor=? WHERE policy=?', cursor, FARMING_POLICY);
  return { processed: rows.length, pending: farmingWorkPending(sql), cursor };
}

export function farmingStatus(sql: SqlStorage) {
  const totals = sql.exec<{ checked: number; flagged: number; pending: number; incomplete: number; candidateLimit: number; updateLimit: number; sourceUnavailable: number }>(`SELECT COUNT(*) AS checked,
    COALESCE(SUM(json_array_length(patterns_json)>0),0) AS flagged,
    COALESCE(SUM(coverage='pending'),0) AS pending,COALESCE(SUM(coverage='incomplete'),0) AS incomplete,
    COALESCE(SUM(coverage_reason='candidate-limit'),0) AS candidateLimit,
    COALESCE(SUM(coverage_reason='update-limit'),0) AS updateLimit,
    COALESCE(SUM(coverage_reason='source-unavailable'),0) AS sourceUnavailable FROM rated_result_checks`).one();
  const recent = sql.exec<{ game_id: string; ended_at: number; checked_at: number; patterns_json: string }>(`SELECT game_id,ended_at,checked_at,patterns_json
    FROM rated_result_checks WHERE json_array_length(patterns_json)>0 ORDER BY checked_at DESC,game_id LIMIT 20`).toArray();
  return {
    policy: FARMING_POLICY, informational: true, checked: totals.checked, flagged: totals.flagged,
    coverage: { complete: !totals.pending && !totals.incomplete, pending: Boolean(totals.pending), incomplete: totals.incomplete,
      reasons: { 'candidate-limit': totals.candidateLimit, 'update-limit': totals.updateLimit, 'source-unavailable': totals.sourceUnavailable } },
    limits: { retainedRankedGames: RETAINED, candidateRowsPerCheck: CANDIDATE_LIMIT, rowsPerQuery: QUERY_LIMIT, updatedChecks: RETAINED, catchupPerAlarm: CATCHUP_LIMIT },
    patterns: Object.fromEntries(FARMING_PATTERNS.map(pattern => [pattern, sql.exec<{ count: number }>(`SELECT COUNT(*) AS count
      FROM rated_result_checks WHERE EXISTS(SELECT 1 FROM json_each(patterns_json) WHERE value=?)`, pattern).one().count])),
    recent: recent.map(row => ({ gameId: row.game_id, endedAt: row.ended_at, checkedAt: row.checked_at, patterns: JSON.parse(row.patterns_json) as Pattern[] })),
  };
}
