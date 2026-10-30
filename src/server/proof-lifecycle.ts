/** Durable application limits, not provider billing guarantees. */
export const PROOF_ALLOCATION_MS = 22_500;
export const PROOF_STOP_ATTEMPTS = 3;
export const PROOF_STOP_WAIT_MS = 1_000;
export const PROOF_STOP_CALLBACK = 'expireProofAllocation';

export type ProofLifecycle = {
  generation: number;
  phase: 'idle' | 'reserved' | 'active' | 'stopping';
  reserved_at: number;
  deadline: number;
  reserved_ms: number;
  observed_ms: number;
  observed_at: number;
  stop_attempts: number;
  stop_pending: number;
  start_issued: number;
  destroy_confirmed: number;
  stop_debt: number;
  schedule_failed: number;
  diagnostic_emitted: number;
};

export function initializeProofLifecycle(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS proof_lifecycle
    (id INTEGER PRIMARY KEY CHECK(id=1),generation INTEGER NOT NULL,phase TEXT NOT NULL,
     reserved_at INTEGER NOT NULL,deadline INTEGER NOT NULL,reserved_ms INTEGER NOT NULL,
     observed_ms INTEGER NOT NULL,observed_at INTEGER NOT NULL,stop_attempts INTEGER NOT NULL,stop_pending INTEGER NOT NULL DEFAULT 0,
     start_issued INTEGER NOT NULL,destroy_confirmed INTEGER NOT NULL DEFAULT 0,stop_debt INTEGER NOT NULL,schedule_failed INTEGER NOT NULL,
     diagnostic_emitted INTEGER NOT NULL)`);
  if (!sql.exec<{ name: string }>('PRAGMA table_info(proof_lifecycle)').toArray().some(column => column.name === 'destroy_confirmed')) {
    sql.exec('ALTER TABLE proof_lifecycle ADD COLUMN destroy_confirmed INTEGER NOT NULL DEFAULT 0');
  }
  if (!sql.exec<{ name: string }>('PRAGMA table_info(proof_lifecycle)').toArray().some(column => column.name === 'stop_pending')) {
    sql.exec('ALTER TABLE proof_lifecycle ADD COLUMN stop_pending INTEGER NOT NULL DEFAULT 0');
    sql.exec("UPDATE proof_lifecycle SET destroy_confirmed=0 WHERE phase<>'idle'");
  }
  const fresh = sql.exec(`INSERT OR IGNORE INTO proof_lifecycle
    (id,generation,phase,reserved_at,deadline,reserved_ms,observed_ms,observed_at,stop_attempts,stop_pending,start_issued,destroy_confirmed,stop_debt,schedule_failed,diagnostic_emitted)
    VALUES(1,0,'idle',0,0,0,0,0,0,0,0,0,0,0,0) RETURNING id`).toArray().length;
  // Pre-lifecycle receipts can have a native start whose reply was lost.
  if (fresh && sql.exec('SELECT 1 FROM proof_attempts LIMIT 1').toArray().length) {
    sql.exec("UPDATE proof_lifecycle SET phase='stopping',start_issued=1,stop_debt=1,observed_at=? WHERE id=1", Date.now());
  }
}

export function proofLifecycle(sql: SqlStorage): ProofLifecycle {
  return sql.exec<ProofLifecycle>('SELECT * FROM proof_lifecycle WHERE id=1').one();
}

export function observedProofMilliseconds(state: ProofLifecycle, now = Date.now()): number {
  return state.observed_ms + (state.phase === 'idle' ? 0 : Math.max(0, now - state.observed_at));
}

export function saveProofLifecycle(sql: SqlStorage, state: ProofLifecycle, now = Date.now()): void {
  sql.exec(`UPDATE proof_lifecycle SET generation=?,phase=?,reserved_at=?,deadline=?,reserved_ms=?,
    observed_ms=?,observed_at=?,stop_attempts=?,stop_pending=?,start_issued=?,destroy_confirmed=?,stop_debt=?,schedule_failed=?,diagnostic_emitted=? WHERE id=1`,
  state.generation, state.phase, state.reserved_at, state.deadline, state.reserved_ms,
  state.observed_ms, now, state.stop_attempts, state.stop_pending, state.start_issued, state.destroy_confirmed, state.stop_debt, state.schedule_failed, state.diagnostic_emitted);
}

/** A timed-out platform call remains observed by its caller and cannot rearm work. */
export async function withinProofStop<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('proof_stop_unconfirmed')), PROOF_STOP_WAIT_MS);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
