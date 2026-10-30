import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { CapacityNativeMeter } from '../src/server/capacity-meter';
import { capacityUsageWork } from '../src/server/capacity-workflow';

describe('capacity native measurements', () => {
  it('charges missing read attempts separately and keeps a finite event read bound', async () => {
    const native = await env.DB.prepare('SELECT 1 AS value').all();
    const reply = (attempts: number, reads: number, writes = 0) => ({ ...native,
      meta: { ...native.meta, rows_read: reads, rows_written: writes, changes: writes,
        changed_db: writes !== 0, total_attempts: attempts } });
    const responses = [reply(3, 5), reply(2, 7), reply(1, 629)];
    const db = { prepare: () => ({ all: async () => responses.shift()! }) } as unknown as D1Database;
    const meter = new CapacityNativeMeter();
    meter.allowD1ReadRetries(640);
    await meter.d1(db).prepare('SELECT value').all();
    await meter.d1(db).prepare('SELECT value').all();
    expect(meter.snapshot()).toMatchObject({ d1RowsRead: 12, d1Retries: 3,
      d1RetryReadSurcharge: 1_280, unresolvedD1: 0, uncertain: false });
    expect(capacityUsageWork(meter.snapshot()).d1RowsRead).toBe(1_292);
    await expect(meter.d1(db).prepare('SELECT value').all()).rejects.toThrow('capacity_native_retry_bound_exceeded');
    expect(meter.snapshot()).toMatchObject({ unresolvedD1: 1, uncertain: true, d1RetryReadSurcharge: 1_280 });

    for (const metadata of [reply(2, 5), reply(2, 5, 1), reply(4, 5)]) {
      const strict = new CapacityNativeMeter();
      if (metadata.meta.rows_written || metadata.meta.total_attempts === 4) strict.allowD1ReadRetries(640);
      const boundary = { prepare: () => ({ all: async () => metadata }) } as unknown as D1Database;
      await strict.d1(boundary).prepare('SELECT value').all().catch(() => {});
      expect(strict.snapshot().uncertain).toBe(true);
      expect(strict.snapshot().d1RetryReadSurcharge).toBe(0);
    }
  });

  it('charges native SQLite index and scan work while consuming each cursor once', async () => {
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    const measured = await runInDurableObject(game, (_instance, state) => {
      const meter = new CapacityNativeMeter();
      const sql = meter.sql(state.storage.sql);
      sql.exec('CREATE TABLE capacity_probe(id INTEGER PRIMARY KEY,value TEXT)');
      sql.exec('CREATE INDEX capacity_probe_value ON capacity_probe(value)');
      for (let id = 1; id <= 8; id++) sql.exec('INSERT INTO capacity_probe VALUES(?,?)', id, `v${id}`);
      const before = meter.snapshot();
      const cursor = sql.exec<{ id: number }>('SELECT id FROM capacity_probe WHERE length(value)>0');
      const ids = cursor.toArray().map(row => row.id);
      const after = meter.snapshot();
      const once = meter.snapshot();
      cursor.toArray();
      return { ids, before, after, once, repeated: meter.snapshot(), nativeBytes: state.storage.sql.databaseSize };
    });
    expect(measured.ids).toHaveLength(8);
    expect(measured.before.doRowsWritten).toBeGreaterThan(8);
    expect(measured.after.doRowsRead - measured.before.doRowsRead).toBeGreaterThanOrEqual(8);
    expect(measured.after.doStorageBytes).toBe(measured.nativeBytes);
    expect(measured.repeated).toEqual(measured.once);
  });

  it('retains D1 metadata for first, all, batch and primary sessions', async () => {
    const meter = new CapacityNativeMeter();
    const db = meter.d1(env.DB);
    const id = `capacity-probe-${crypto.randomUUID()}`;
    await db.prepare('INSERT INTO verification(id,identifier,value,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
      .bind(id, id, 'probe', new Date(Date.now() + 60_000).toISOString(), new Date().toISOString(), new Date().toISOString()).run();
    expect(await db.withSession('first-primary').prepare('SELECT value FROM verification WHERE id=?').bind(id).first('value')).toBe('probe');
    const batch = await db.batch([
      db.prepare('SELECT value FROM verification WHERE id=?').bind(id),
      db.prepare('DELETE FROM verification WHERE id=?').bind(id),
    ]);
    expect(batch[0].results).toEqual([{ value: 'probe' }]);
    expect(meter.snapshot()).toMatchObject({ d1Statements: 4, unresolvedD1: 0, uncertain: false });
    expect(meter.snapshot().d1RowsWritten).toBeGreaterThanOrEqual(2);
    expect(meter.snapshot().d1RowsRead).toBeGreaterThanOrEqual(1);
    expect(meter.snapshot().d1StorageBytes).toBeGreaterThan(0);
  });

  it('keeps uncertain native work unresolved and rejects calls with no row metrics', async () => {
    const meter = new CapacityNativeMeter();
    await expect(meter.d1(env.DB).prepare('SELECT * FROM missing_capacity_probe').all()).rejects.toThrow();
    expect(meter.snapshot()).toMatchObject({ unresolvedD1: 1, uncertain: true });
    expect(() => meter.d1(env.DB).exec('SELECT 1')).toThrow('capacity_unmetered_d1_operation');
    expect(() => meter.d1(env.DB).prepare('SELECT 1').raw()).toThrow('capacity_unmetered_d1_raw');
  });

  it('retains uncertainty when native product code catches a broken SQL metric', async () => {
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    const usage = await runInDurableObject(game, (_instance, state) => {
      const meter = new CapacityNativeMeter();
      const unavailable = new Proxy(state.storage.sql, { get(target, key) {
        if (key === 'exec') return (query: string, ...bindings: unknown[]) => new Proxy(target.exec(query, ...bindings), {
          get(cursor, member) {
            if (member === 'rowsRead') return NaN;
            const value = Reflect.get(cursor, member, cursor);
            return typeof value === 'function' ? value.bind(cursor) : value;
          },
        });
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      try { meter.sql(unavailable).exec('SELECT 1').toArray(); }
      catch { /* Native maintenance can catch a stage error and keep going. */ }
      return meter.snapshot();
    });
    expect(usage.uncertain).toBe(true);
  });
});
