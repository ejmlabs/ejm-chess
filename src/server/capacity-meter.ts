import { CAPACITY_D1_READ_ATTEMPTS } from '../shared/capacity-corpus';
export { CAPACITY_D1_READ_ATTEMPTS, CAPACITY_WARM_D1_READ_ROWS } from '../shared/capacity-corpus';

/** Native measurements for the private capacity candidate. Never used by production. */
export interface CapacityNativeUsage {
  doRowsRead: number;
  doRowsWritten: number;
  doStorageBytes: number;
  d1RowsRead: number;
  d1RowsWritten: number;
  d1StorageBytes: number;
  d1Statements: number;
  d1Retries: number;
  /** Charged bound for earlier read attempts whose row metrics are absent. */
  d1RetryReadSurcharge: number;
  unresolvedD1: number;
  uncertain: boolean;
}

const zero = (): CapacityNativeUsage => ({ doRowsRead: 0, doRowsWritten: 0, doStorageBytes: 0,
  d1RowsRead: 0, d1RowsWritten: 0, d1StorageBytes: 0, d1Statements: 0, d1Retries: 0, d1RetryReadSurcharge: 0,
  unresolvedD1: 0, uncertain: false });

function count(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('capacity_native_metrics_unavailable');
  return value;
}

/**
 * SQL cursors report rows visited, including index work. Charge their deltas
 * while consumed. D1 first() uses the same native all() request so its metadata
 * is retained. No returned-row count is used as a billing measurement.
 *
 * This measures completed calls. A failed D1 response has unknown native work
 * and permanently marks this meter uncertain. A caller must retain its entire
 * predispatch reservation and permit in that case.
 */
export class CapacityNativeMeter {
  private usage = zero();
  private nativeStatements = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  private retryReadBound: number | null = null;

  snapshot(): CapacityNativeUsage { return { ...this.usage }; }
  readBound(): number | null { return this.retryReadBound; }

  /** The caller must reserve three complete read passes before native work. */
  allowD1ReadRetries(singleAttemptReadBound: number): void {
    if (!Number.isSafeInteger(singleAttemptReadBound) || singleAttemptReadBound < 1
      || this.retryReadBound !== null || this.usage.d1Statements || this.usage.unresolvedD1) {
      throw new Error('capacity_native_retry_bound_invalid');
    }
    this.retryReadBound = singleAttemptReadBound;
  }

  /** Alarm storage is billed outside SQL cursors. Keep its row work visible. */
  async alarm<R>(kind: 'read' | 'write', run: () => Promise<R>): Promise<R> {
    if (kind === 'read') this.usage.doRowsRead++;
    else this.usage.doRowsWritten++;
    try { return await run(); }
    catch (error) { this.usage.uncertain = true; throw error; }
  }

  sql(native: SqlStorage): SqlStorage {
    const meter = this;
    return new Proxy(native, { get(target, key) {
      if (key !== 'exec') {
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (query: string, ...bindings: unknown[]) => {
        let cursor: ReturnType<SqlStorage['exec']>;
        try { cursor = target.exec(query, ...bindings); }
        catch (error) { meter.usage.uncertain = true; throw error; }
        let read = 0;
        let written = 0;
        const record = () => {
          try {
            const nextRead = count(cursor.rowsRead);
            const nextWritten = count(cursor.rowsWritten);
            if (nextRead < read || nextWritten < written) throw new Error('capacity_native_metrics_regressed');
            meter.usage.doRowsRead += nextRead - read;
            meter.usage.doRowsWritten += nextWritten - written;
            meter.usage.doStorageBytes = Math.max(meter.usage.doStorageBytes, count(target.databaseSize));
            read = nextRead; written = nextWritten;
          } catch (error) { meter.usage.uncertain = true; throw error; }
        };
        const iterator = <T>(source: IterableIterator<T>): IterableIterator<T> => ({
          next() { try { return source.next(); } finally { record(); } },
          return(value?: unknown) { try { return source.return?.(value) ?? { done: true, value: value as T }; } finally { record(); } },
          [Symbol.iterator]() { return this; },
        });
        record();
        return new Proxy(cursor, { get(source, member) {
          if (member === Symbol.iterator) return () => iterator(source[Symbol.iterator]());
          if (member === 'raw') return () => iterator(source.raw());
          const value = Reflect.get(source, member, source);
          return typeof value === 'function' ? (...args: unknown[]) => {
            try { return value.apply(source, args); } finally { record(); }
          } : value;
        } });
      };
    } });
  }

  private metadata(result: D1Result): void {
    try {
      this.usage.d1RowsRead += count(result.meta.rows_read);
      this.usage.d1RowsWritten += count(result.meta.rows_written);
      this.usage.d1StorageBytes = Math.max(this.usage.d1StorageBytes, count(result.meta.size_after));
      this.usage.d1Statements++;
      if (this.retryReadBound !== null && this.usage.d1RowsRead > this.retryReadBound) {
        throw new Error('capacity_native_retry_bound_exceeded');
      }
      if (result.meta.total_attempts !== undefined) {
        const attempts = count(result.meta.total_attempts);
        if (attempts < 1 || attempts > CAPACITY_D1_READ_ATTEMPTS) throw new Error('capacity_native_metrics_unavailable');
        this.usage.d1Retries += attempts - 1;
        if (attempts > 1) {
          // D1 retries read-only queries at most twice. Its row metrics cover
          // only the final attempt. Charge complete bounded read passes for
          // the missing attempts, separately from the returned measurements.
          if (this.retryReadBound === null || result.meta.rows_written !== 0
            || result.meta.changed_db !== false || result.meta.changes !== 0) this.usage.uncertain = true;
          else this.usage.d1RetryReadSurcharge = Math.max(this.usage.d1RetryReadSurcharge,
            this.retryReadBound * (attempts - 1));
        }
      }
    } catch (error) { this.usage.uncertain = true; throw error; }
  }

  private async request<T>(run: () => Promise<D1Result<T>[]>): Promise<D1Result<T>[]> {
    this.usage.unresolvedD1++;
    try {
      const results = await run();
      for (const result of results) this.metadata(result);
      this.usage.unresolvedD1--;
      return results;
    } catch (error) {
      // An error does not prove that the provider performed no native work.
      this.usage.uncertain = true;
      throw error;
    }
  }

  private statement(native: D1PreparedStatement): D1PreparedStatement {
    const meter = this;
    let wrapped: D1PreparedStatement;
    wrapped = new Proxy(native, { get(target, member) {
      if (member === 'bind') return (...values: unknown[]) => meter.statement(target.bind(...values));
      if (member === 'all' || member === 'run') return async () =>
        (await meter.request(async () => [await target[member]()]))[0];
      if (member === 'first') return async (column?: string) => {
        const row = (await meter.request(async () => [await target.all()]))[0].results[0] ?? null;
        if (row === null || column === undefined) return row;
        if (!(column in row)) throw new Error('D1_COLUMN_NOTFOUND');
        return row[column];
      };
      if (member === 'raw') return () => { throw new Error('capacity_unmetered_d1_raw'); };
      throw new Error('capacity_unmetered_d1_statement');
    } });
    this.nativeStatements.set(wrapped, native);
    return wrapped;
  }

  /** Unknown D1 operations close qualification instead of hiding their cost. */
  d1<T extends D1Database | D1DatabaseSession>(native: T): T {
    const meter = this;
    return new Proxy(native, { get(target, member) {
      if (member === 'prepare') return (query: string) => meter.statement(target.prepare(query));
      if (member === 'batch') return (statements: D1PreparedStatement[]) => meter.request(() => target.batch(statements.map(statement => {
        const original = meter.nativeStatements.get(statement);
        if (!original) throw new Error('capacity_unmetered_d1_batch');
        return original;
      })));
      if (member === 'withSession' && 'withSession' in target) return (bookmark?: D1SessionBookmark | D1SessionConstraint) =>
        meter.d1(target.withSession(bookmark));
      if (member === 'getBookmark' && 'getBookmark' in target) return target.getBookmark.bind(target);
      throw new Error('capacity_unmetered_d1_operation');
    } });
  }
}
