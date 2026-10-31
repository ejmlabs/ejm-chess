/** Private fixed-workflow permits. Production never imports this module. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { CapacityNativeMeter, type CapacityNativeUsage } from './capacity-meter';

export type AcceptanceAuthority = 'Game' | 'Competition' | 'Prover' | 'Control';
// These are prepaid ceilings, not provider qualification. Interrupted events
// retain the entire envelope. There are at most twelve Game workflows, one
// Competition, two fixed phase Provers, and one Control in the fixed run.
export const ACCEPTANCE_WORK = Object.freeze({
  Game: { events: 32, doRowsRead: 4096, doRowsWritten: 48, d1RowsRead: 128, d1RowsWritten: 8 },
  Competition: { events: 96, doRowsRead: 16384, doRowsWritten: 192, d1RowsRead: 16384, d1RowsWritten: 128 },
  Prover: { events: 192, doRowsRead: 4096, doRowsWritten: 48, d1RowsRead: 1024, d1RowsWritten: 4 },
  Control: { events: 768, doRowsRead: 4096, doRowsWritten: 48, d1RowsRead: 4096, d1RowsWritten: 128 },
});
export const ACCEPTANCE_PHYSICAL_BYTES = 4 * 1024 * 1024;
const D1_BYTES = 16 * 1024 * 1024;
const MAX_STATEMENT_READ = 1024;
const MAX_STATEMENT_WRITE = 16;
const GAME_SEAT_RELEASE = 'UPDATE active_game_seats SET released_at=? WHERE game_id=? AND released_at IS NULL';
type Event = { id: number; meter: CapacityNativeMeter; pending: Set<Promise<unknown>> };
type BudgetRow = { kind: AcceptanceAuthority; events: number; emergencies: number; closed: number };
export interface AcceptanceRecoveryBudget extends BudgetRow {
  entries: { id: number; operation: string; complete: number; usage: string | null }[];
}

/** A native reconstruction spends another permit. A backup never renews it. */
export function proofRecoveryBudgetPlan(before: AcceptanceRecoveryBudget, later: AcceptanceRecoveryBudget) {
  const kind = before.kind;
  const check = (value: AcceptanceRecoveryBudget) => {
    if (!Object.hasOwn(ACCEPTANCE_WORK, kind) || value.kind !== kind || !Number.isSafeInteger(value.events)
      || value.events < 1 || value.events > ACCEPTANCE_WORK[kind].events + (['Control', 'Prover'].includes(kind) ? 6 : 0)
      || !Array.isArray(value.entries) || value.entries.length !== value.events
      || !Number.isSafeInteger(value.emergencies) || value.emergencies < 0 || value.emergencies > 6
      || ![0, 1].includes(value.closed) || value.entries.some((entry, index) => entry.id !== index + 1
        || typeof entry.operation !== 'string' || entry.operation.length > 80 || entry.complete !== 1
        || entry.usage !== null && (typeof entry.usage !== 'string' || entry.usage.length > 4096))) {
      throw new Error('proof_recovery_budget_invalid');
    }
  };
  check(before); check(later);
  if (later.events < before.events || later.emergencies < before.emergencies || later.closed < before.closed
    || JSON.stringify(later.entries.slice(0, before.events)) !== JSON.stringify(before.entries)) {
    throw new Error('proof_recovery_budget_conflict');
  }
  const emergency = Number(Boolean(later.closed || later.events >= ACCEPTANCE_WORK[kind].events));
  if (emergency && (!['Control', 'Prover'].includes(kind) || later.emergencies >= 6)) {
    throw new Error('proof_recovery_reconstruction_exhausted');
  }
  return { events: later.events + 1, emergencies: later.emergencies + emergency, closed: later.closed };
}
const emergencyOperations = new Set(['bootstrap', 'inspect', 'stop', 'native-callback', 'alarm', 'acceptanceStop',
  'acceptanceEmergencyCleanup', 'onStop', 'onActivityExpired', 'expireProofAllocation']);

/**
 * Reserve before entering product code and before any Container operation.
 * Product transaction rollbacks cannot roll back this earlier synced permit.
 * Cursor measurements belong to the event even if its product transaction
 * rolls back. No refund depends on a reply, clock, caller, or restored result.
 */
export class ProofAcceptanceBudget {
  private scopes = new AsyncLocalStorage<Event>();
  private constructing: Event | null;
  private bootstrapDone: Promise<void> = Promise.resolve();
  readonly context: DurableObjectState;

  constructor(private readonly native: DurableObjectState, readonly kind: AcceptanceAuthority) {
    const sql = native.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS proof_acceptance_budget(id INTEGER PRIMARY KEY CHECK(id=1),
      kind TEXT NOT NULL,events INTEGER NOT NULL DEFAULT 0,emergencies INTEGER NOT NULL DEFAULT 0,closed INTEGER NOT NULL DEFAULT 0)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS proof_acceptance_usage(id INTEGER PRIMARY KEY,operation TEXT NOT NULL,
      complete INTEGER NOT NULL DEFAULT 0,usage TEXT)`);
    sql.exec('INSERT OR IGNORE INTO proof_acceptance_budget(id,kind) VALUES(1,?)', kind);
    this.constructing = this.reserve('bootstrap');
    const current = () => this.event();
    const track = <T>(promise: Promise<T>): Promise<T> => {
      const event = current(); event.pending.add(promise);
      void promise.then(() => event.pending.delete(promise), () => event.pending.delete(promise));
      return promise;
    };
    const measuredSql = new Proxy(sql, { get: (target, key) => {
      const event = current();
      if (key === 'exec') return (query: string, ...bindings: unknown[]) => {
        const used = event.meter.snapshot(); const limit = ACCEPTANCE_WORK[kind];
        const writes = !/^\s*(?:SELECT\b|PRAGMA\s+(?:table_info|page_count|page_size)\b)/i.test(query);
        if (used.doRowsRead + MAX_STATEMENT_READ > limit.doRowsRead
          || writes && used.doRowsWritten + MAX_STATEMENT_WRITE > limit.doRowsWritten) {
          throw new Error('proof_acceptance_statement_permit_exhausted');
        }
        // All SQL is fixed product source. No caller supplies SQL or bindings
        // other than the fixed synthetic authority and normal Game commands.
        return event.meter.sql(target).exec(query, ...bindings);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const storage = new Proxy(native.storage, { get: (target, key) => {
      if (key === 'sql') return measuredSql;
      if (key === 'transactionSync') return <T>(run: () => T): T => { current(); return target.transactionSync(run); };
      if (key === 'sync') return () => track(target.sync());
      if (key === 'setAlarm') return (at: number | Date) => track(current().meter.alarm('write', () => target.setAlarm(at)));
      if (key === 'getAlarm' || key === 'deleteAlarm') return () =>
        track(current().meter.alarm<unknown>(key === 'getAlarm' ? 'read' : 'write', () => target[key]()));
      // Native bookmarks have no authority writes. Destructive restore has a
      // separate reviewed drill and is never an acceptance command.
      if (key === 'getCurrentBookmark' || key === 'getBookmarkForTime') {
        return (...args: unknown[]) => { current(); return track((target[key] as (...values: unknown[]) => Promise<unknown>)(...args)); };
      }
      throw new Error('proof_acceptance_unmetered_storage');
    } });
    this.context = new Proxy(native, { get(target, key) {
      if (key === 'storage') return storage;
      if (key === 'waitUntil') return (promise: Promise<unknown>) => target.waitUntil(track(promise));
      if (key === 'blockConcurrencyWhile') return <T>(run: () => Promise<T>) => {
        const event = thisBudget.scopes.getStore() ?? thisBudget.constructing;
        if (!event) return thisBudget.run('native-callback', () => target.blockConcurrencyWhile(run));
        return track(target.blockConcurrencyWhile(async () => {
          await target.storage.sync();
          return thisBudget.scopes.run(event, run);
        }));
      };
      if (key === 'acceptWebSocket') return () => { throw new Error('proof_acceptance_no_sockets'); };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const thisBudget = this;
  }

  private event(): Event {
    const event = this.scopes.getStore() ?? this.constructing;
    if (!event) throw new Error('proof_acceptance_event_missing');
    return event;
  }
  private reserve(operation: string): Event {
    const id = this.native.storage.transactionSync(() => {
      const row = this.native.storage.sql.exec<BudgetRow>('SELECT kind,events,emergencies,closed FROM proof_acceptance_budget WHERE id=1').one();
      const exhausted = Boolean(row.closed || row.events >= ACCEPTANCE_WORK[this.kind].events);
      const emergency = exhausted && ['Control', 'Prover'].includes(this.kind) && emergencyOperations.has(operation) && row.emergencies < 6;
      if (row.kind !== this.kind || exhausted && !emergency) {
        // A failed measurement closes the budget with permits left. Name it so a readback can tell closure from spent permits.
        throw new Error(row.kind === this.kind && row.closed ? 'proof_acceptance_native_envelope_closed' : 'proof_acceptance_work_exhausted');
      }
      this.native.storage.sql.exec('UPDATE proof_acceptance_budget SET events=events+1,emergencies=emergencies+? WHERE id=1', Number(emergency));
      this.native.storage.sql.exec('INSERT INTO proof_acceptance_usage(id,operation) VALUES(?,?)', row.events + 1, operation);
      return row.events + 1;
    });
    return { id, meter: new CapacityNativeMeter(), pending: new Set() };
  }
  private async finish(event: Event): Promise<void> {
    while (event.pending.size) await Promise.allSettled([...event.pending]);
    const used = event.meter.snapshot(); const limit = ACCEPTANCE_WORK[this.kind];
    const closed = used.uncertain || used.unresolvedD1 || used.doStorageBytes > ACCEPTANCE_PHYSICAL_BYTES
      || used.d1StorageBytes > D1_BYTES || used.doRowsRead > limit.doRowsRead || used.doRowsWritten > limit.doRowsWritten
      || used.d1RowsRead > limit.d1RowsRead || used.d1RowsWritten > limit.d1RowsWritten;
    this.native.storage.sql.exec('UPDATE proof_acceptance_usage SET complete=1,usage=? WHERE id=?', JSON.stringify(used), event.id);
    if (closed) this.native.storage.sql.exec('UPDATE proof_acceptance_budget SET closed=1 WHERE id=1');
    await this.native.storage.sync();
    if (closed) throw new Error('proof_acceptance_native_envelope_failed');
  }
  /** Call once after the product constructor and its own schema have run. */
  sealBootstrap(deferred?: Promise<unknown>): void {
    const event = this.constructing!;
    this.bootstrapDone = Promise.resolve(deferred).then(() => this.finish(event)).finally(() => { this.constructing = null; });
    // Every explicit entry awaits bootstrapDone. Taking another native input
    // gate here can make sync wait on the gate that awaits that same sync.
  }
  async run<T>(operation: string, run: () => T | Promise<T>): Promise<T> {
    if (this.scopes.getStore()) return run();
    await this.bootstrapDone;
    const event = this.reserve(operation);
    await this.native.storage.sync();
    return this.scopes.run(event, async () => {
      try { return await run(); }
      finally { await this.finish(event); }
    });
  }
  d1(db: D1Database): D1Database {
    const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
    const check = (queries: string[]) => {
      const used = this.event().meter.snapshot(); const limit = ACCEPTANCE_WORK[this.kind];
      const read = this.kind === 'Game' ? 32 : 1024;
      const writeQueries = queries.filter(query => !/^\s*SELECT\b/i.test(query));
      // Finished Games release their two admitted seats after Competition's
      // acknowledgement. No other Game D1 write belongs to this fixed run.
      if (this.kind === 'Game' && writeQueries.some(query => query !== GAME_SEAT_RELEASE)) {
        throw new Error('proof_acceptance_d1_permit_exhausted');
      }
      if (used.d1RowsRead + read * queries.length > limit.d1RowsRead
        || used.d1RowsWritten + writeQueries.length * 8 > limit.d1RowsWritten) throw new Error('proof_acceptance_d1_permit_exhausted');
    };
    const queries = new WeakMap<D1PreparedStatement, string>();
    const statement = (original: D1PreparedStatement, query: string): D1PreparedStatement => {
      const wrapped = new Proxy(original, { get: (target, key) => {
        if (key === 'bind') return (...values: unknown[]) => statement(target.bind(...values), query);
        if (key === 'all' || key === 'run' || key === 'first') return (...values: unknown[]) => {
          check([query]); return (target[key] as (...args: unknown[]) => unknown)(...values);
        };
        throw new Error('proof_acceptance_d1_operation_invalid');
      } });
      originals.set(wrapped, original); queries.set(wrapped, query); return wrapped;
    };
    return new Proxy(db, { get: (target, key) => {
      const measured = this.event().meter.d1(target);
      if (key === 'prepare') return (query: string) => statement(measured.prepare(query), query);
      if (key === 'batch') return (values: D1PreparedStatement[]) => {
        check(values.map(value => { const query = queries.get(value); if (!query) throw new Error('proof_acceptance_d1_statement_invalid'); return query; }));
        return measured.batch(values.map(value => originals.get(value)!));
      };
      throw new Error('proof_acceptance_d1_operation_invalid');
    } });
  }
  inspect() {
    const budget = this.native.storage.sql.exec<BudgetRow>('SELECT kind,events,emergencies,closed FROM proof_acceptance_budget WHERE id=1').one();
    const events = this.native.storage.sql.exec<{ id: number; operation: string; complete: number; usage: string | null }>(
      'SELECT id,operation,complete,usage FROM proof_acceptance_usage ORDER BY id LIMIT ?', ACCEPTANCE_WORK[this.kind].events + 6).toArray();
    return { ...budget, envelope: ACCEPTANCE_WORK[this.kind], physicalBytes: this.native.storage.sql.databaseSize,
      events: events.map(event => ({ ...event, usage: event.usage ? JSON.parse(event.usage) as CapacityNativeUsage : null })) };
  }
  /** Private restore metadata. Save outside every rollback target. */
  async recoveryBudget(sql = this.native.storage.sql): Promise<AcceptanceRecoveryBudget> {
    await this.bootstrapDone;
    return { ...sql.exec<BudgetRow>(
      'SELECT kind,events,emergencies,closed FROM proof_acceptance_budget WHERE id=1').one(),
    entries: sql.exec<AcceptanceRecoveryBudget['entries'][number]>(
      'SELECT id,operation,complete,usage FROM proof_acceptance_usage ORDER BY id LIMIT ?',
      ACCEPTANCE_WORK[this.kind].events + 6).toArray() };
  }
  /** A restore may not refund later permits or the new reconstruction. */
  async reapplyRecoveryBudget(before: AcceptanceRecoveryBudget, later: AcceptanceRecoveryBudget,
    sql = this.native.storage.sql): Promise<void> {
    await this.bootstrapDone;
    const expected = proofRecoveryBudgetPlan(before, later);
    if (before.kind !== this.kind) throw new Error('proof_recovery_budget_invalid');
    const current = await this.recoveryBudget(sql);
    // A lost reapply reply can be read back without reconstructing or charging
    // a second time. The only later row is this session's completed bootstrap.
    if (current.events === expected.events && current.emergencies === expected.emergencies
      && current.closed === expected.closed && current.entries.at(-1)?.operation === 'bootstrap'
      && current.entries.at(-1)?.complete === 1
      && JSON.stringify(current.entries.slice(0, later.events)) === JSON.stringify(later.entries)) return;
    // The private runner blocks all product traffic. Only the constructor's
    // new bootstrap may occur after the native restore and before reapply.
    if (current.events !== before.events + 1 || current.entries.at(-1)?.operation !== 'bootstrap'
      || JSON.stringify(current.entries.slice(0, before.events)) !== JSON.stringify(before.entries)) {
      throw new Error('proof_recovery_budget_later_work');
    }
    const bootstrap = current.entries.at(-1)!;
    this.native.storage.transactionSync(() => {
      for (const entry of later.entries.slice(before.events)) {
        sql.exec(`INSERT INTO proof_acceptance_usage(id,operation,complete,usage) VALUES(?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET operation=excluded.operation,complete=excluded.complete,usage=excluded.usage`,
        entry.id, entry.operation, entry.complete, entry.usage);
      }
      sql.exec(`INSERT INTO proof_acceptance_usage(id,operation,complete,usage) VALUES(?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET operation=excluded.operation,complete=excluded.complete,usage=excluded.usage`,
      later.events + 1, bootstrap.operation, bootstrap.complete, bootstrap.usage);
      sql.exec(`UPDATE proof_acceptance_budget SET events=?,emergencies=?,closed=? WHERE id=1`,
        expected.events, expected.emergencies, Number(Boolean(expected.closed || current.closed)));
    });
    await this.native.storage.sync();
  }
}
