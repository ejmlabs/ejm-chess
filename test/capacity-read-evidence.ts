interface ReadRecord {
  sql: string;
  rowsRead: number;
  rowsWritten: number;
  explain(): Promise<unknown[]>;
}

/** Capture native D1 metadata and query plans, never bound values or row data. */
export function capacityReadEvidence(native: D1Database): { db: D1Database; reads: ReadRecord[] } {
  const reads: ReadRecord[] = [];
  const statement = (sql: string, prepared: D1PreparedStatement, values: unknown[] = []): D1PreparedStatement =>
    new Proxy(prepared, { get(target, member) {
      if (member === 'bind') return (...bindings: unknown[]) => statement(sql, target.bind(...bindings), bindings);
      if (member === 'all' || member === 'run') return async () => {
        const result = await target[member]();
        reads.push({ sql, rowsRead: result.meta.rows_read, rowsWritten: result.meta.rows_written,
          explain: async () => (await native.prepare('EXPLAIN QUERY PLAN ' + sql).bind(...values).all()).results });
        return result;
      };
      const value = Reflect.get(target, member, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  const db = new Proxy(native, { get(target, member) {
    if (member === 'prepare') return (sql: string) => statement(sql, target.prepare(sql));
    const value = Reflect.get(target, member, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { db, reads };
}

export async function explainCapacityReads(reads: ReadRecord[]): Promise<unknown[]> {
  return Promise.all(reads.map(async ({ sql, rowsRead, rowsWritten, explain }) =>
    ({ sql, rowsRead, rowsWritten, plan: await explain() })));
}
