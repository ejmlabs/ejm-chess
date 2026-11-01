import { env } from 'cloudflare:workers';
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/server/env';
import { cleanupExpiredRows, EXPIRY_BATCH } from '../src/server/fairplay';
import handler from '../src/server/index';
import { CRON, cronStatus, runScheduled } from '../src/server/operations';
import { player } from './authority-helpers';
import { ownerFixture } from './owner-fixture';

const DAY = 86_400_000;

interface Heartbeat { started_at: number; finished_at: number | null; last_error: string | null; last_error_at: number | null }
const heartbeat = (schedule: string) => env.DB.prepare('SELECT started_at,finished_at,last_error,last_error_at FROM cron_heartbeats WHERE schedule=?').bind(schedule).first<Heartbeat>();
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

async function scheduled(cron: string, bindings: Env = env) {
  const ctx = createExecutionContext();
  await handler.scheduled(createScheduledController({ cron, scheduledTime: Date.now() }), bindings, ctx);
  await waitOnExecutionContext(ctx);
}

/** Inserts `count` request windows that ended `age` ago. */
const expiredWindows = (count: number, age: number) => env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
  INSERT INTO request_limits(key,count,window_start) SELECT 'expired:'||?||':'||i,1,? FROM n`).bind(count, crypto.randomUUID(), Date.now() - age).run();
const windows = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM request_limits WHERE key LIKE 'expired:%'").first<{ n: number }>())!.n;

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare('DELETE FROM cron_heartbeats'), env.DB.prepare("DELETE FROM request_limits WHERE key LIKE 'expired:%'")]);
});

describe('cron heartbeat', () => {
  it('records the start and finish of each schedule that ran, and nothing for one that has not', async () => {
    const before = Date.now();
    await scheduled(CRON.minute);
    const row = await heartbeat(CRON.minute);
    expect(row).toMatchObject({ last_error: null, last_error_at: null });
    expect(row!.started_at).toBeGreaterThanOrEqual(before);
    expect(row!.finished_at).toBeGreaterThanOrEqual(row!.started_at);
    expect(await cronStatus(env.DB)).toEqual({
      minute: { schedule: CRON.minute, startedAt: row!.started_at, finishedAt: row!.finished_at, lastError: null, lastErrorAt: null },
      daily: { schedule: CRON.daily, startedAt: null, finishedAt: null, lastError: null, lastErrorAt: null },
    });
    await scheduled(CRON.daily);
    expect((await heartbeat(CRON.daily))?.finished_at).toBeGreaterThan(0);
  });

  it('records a failing stage without hiding it, running the others, or losing it to the next clean run', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ran = vi.fn(async () => {});
    try {
      await runScheduled(env, CRON.minute, [['competition', async () => { throw new Error('down'); }], ['expired_rows', ran]]);
      const failed = (await heartbeat(CRON.minute))!;
      expect(ran).toHaveBeenCalledOnce();
      expect(failed).toMatchObject({ last_error: 'competition' });
      expect(failed.finished_at).toBeGreaterThanOrEqual(failed.started_at);
      expect(failed.last_error_at).toBe(failed.finished_at);
      expect(log).toHaveBeenCalledWith('maintenance_failed', 'competition');

      await tick();
      await runScheduled(env, CRON.minute, [['expired_rows', ran]]);
      const clean = (await heartbeat(CRON.minute))!;
      expect(clean.started_at).toBeGreaterThan(failed.started_at);
      expect(clean.finished_at).toBeGreaterThanOrEqual(clean.started_at);
      expect(clean.last_error).toBe('competition');
      expect(clean.last_error_at).toBe(failed.last_error_at);
      expect(clean.last_error_at!).toBeLessThan(clean.started_at);
    } finally { log.mockRestore(); }
  });

  it('names the failed stages when the real scheduled handler cannot reach its authority', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await scheduled(CRON.minute, { ...env, COMPETITION: { idFromName: () => { throw new Error('down'); } } as unknown as Env['COMPETITION'] });
      expect((await heartbeat(CRON.minute))!.last_error).toContain('competition');
    } finally { log.mockRestore(); }
  });

  it('keeps maintenance running when the heartbeat cannot be written', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ran = vi.fn(async () => {});
    try {
      const broken = { DB: { prepare: () => { throw new Error('migration 0016 is not applied'); } } as unknown as D1Database };
      await runScheduled(broken, CRON.minute, [['expired_rows', ran]]);
      expect(ran).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledWith('heartbeat_failed');
    } finally { log.mockRestore(); }
  });
});

describe('growth-path cleanup', () => {
  it('drains a backlog larger than one batch over successive runs and keeps live rows', async () => {
    const backlog = EXPIRY_BATCH * 2 + 100;
    await expiredWindows(backlog, 2 * DAY);
    await expiredWindows(3, 0);
    const removed = [];
    for (let run = 0; run < 3; run++) removed.push(await cleanupExpiredRows(env));
    expect(removed).toEqual([EXPIRY_BATCH, EXPIRY_BATCH, 100]);
    expect(await windows()).toBe(3);
    expect(await cleanupExpiredRows(env)).toBe(0);
  });

  it('removes released seats, expired sessions and stale limits in the same bounded pass', async () => {
    const actor = await player();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO active_game_seats(user_id,game_id,acquired_at,released_at) VALUES(?,?,?,?)').bind(actor.id, 'old-seat', now - 40 * DAY, now - 31 * DAY),
      env.DB.prepare('INSERT INTO active_game_seats(user_id,game_id,acquired_at,released_at) VALUES(?,?,?,?)').bind(actor.id, 'recent-seat', now - DAY, now - 1_000),
      env.DB.prepare('INSERT INTO active_game_seats(user_id,game_id,acquired_at,released_at) VALUES(?,?,?,NULL)').bind(actor.id, 'open-seat', now - DAY),
      env.DB.prepare('INSERT INTO rateLimit(id,key,count,lastRequest) VALUES(?,?,?,?)').bind('old-rate', 'old-rate-key', 1, now - 2 * DAY),
      env.DB.prepare('INSERT INTO rateLimit(id,key,count,lastRequest) VALUES(?,?,?,?)').bind('new-rate', 'new-rate-key', 1, now),
    ]);
    await env.DB.prepare('UPDATE session SET expiresAt=? WHERE id=?').bind(new Date(now - 1_000).toISOString(), actor.sessionId).run();
    await cleanupExpiredRows(env, now);
    const seats = (await env.DB.prepare('SELECT game_id FROM active_game_seats WHERE user_id=? ORDER BY game_id').bind(actor.id).all<{ game_id: string }>()).results.map(row => row.game_id);
    expect(seats).toEqual(['open-seat', 'recent-seat']);
    expect((await env.DB.prepare("SELECT id FROM rateLimit WHERE id IN ('old-rate','new-rate')").all<{ id: string }>()).results.map(row => row.id)).toEqual(['new-rate']);
    expect(await env.DB.prepare('SELECT 1 FROM session WHERE id=?').bind(actor.sessionId).first()).toBeNull();
  });

  it('runs one batch on every minute schedule, not only the daily one', async () => {
    await expiredWindows(EXPIRY_BATCH + 50, 2 * DAY);
    await scheduled(CRON.minute);
    expect(await windows()).toBe(50);
    await scheduled(CRON.minute);
    expect(await windows()).toBe(0);
  });
});

describe('owner operations status', () => {
  let admin: Awaited<ReturnType<typeof ownerFixture>>;
  beforeAll(async () => { admin = await ownerFixture(); });

  it('shows each schedule heartbeat to the verified owner behind Access', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try { await runScheduled(env, CRON.minute, [['expired_rows', async () => { throw new Error('down'); }]]); }
    finally { log.mockRestore(); }
    const response = await admin('/api/admin/operations');
    expect(response.status).toBe(200);
    const status = await response.json() as { cron: Record<'minute' | 'daily', { schedule: string; startedAt: number | null; finishedAt: number | null; lastError: string | null }> };
    expect(status.cron.minute).toMatchObject({ schedule: CRON.minute, lastError: 'expired_rows' });
    expect(status.cron.minute.finishedAt).toBeGreaterThanOrEqual(status.cron.minute.startedAt!);
    expect(status.cron.daily).toMatchObject({ schedule: CRON.daily, startedAt: null });
  });
});
