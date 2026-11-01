import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { BUDGET_CLEANUP_BATCH, budgetStatus, cleanupBudgetReceipts, newWorkAllowed, reserveMonthlyWork, reserveSignupAttempt, type BudgetEnv } from '../src/server/budget';
import { setBudgetStops } from '../src/server/operations';

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM budget_receipts'),
    env.DB.prepare('UPDATE budget_receipt_counts SET count=0'),
    env.DB.prepare('DELETE FROM budget_months'),
    env.DB.prepare('DELETE FROM operations_changes'),
    env.DB.prepare("INSERT INTO signup_budget(id) VALUES('product') ON CONFLICT(id) DO UPDATE SET period=0,monthly_attempts=0,lifetime_attempts=0"),
    env.DB.prepare("UPDATE operations_control SET version=0,games_stopped=0,email_stopped=0,changed_at=NULL,changed_by=NULL,reason=NULL WHERE id='product'"),
  ]);
});

describe('signup usage', () => {
  it('records every attempt, rolls the month, and does not cap', async () => {
    const first = Date.UTC(2026, 9, 31, 23, 59, 59);
    const next = Date.UTC(2026, 10, 1);
    expect((await Promise.all(Array.from({ length: 8 }, () => reserveSignupAttempt(env, first)))).filter(Boolean)).toHaveLength(8);
    expect((await budgetStatus(env, first)).signup).toMatchObject({ used: 8, lifetimeUsed: 8, accepting: true });
    expect(await reserveSignupAttempt(env, next)).toBe(true);
    expect((await budgetStatus(env, next)).signup).toMatchObject({ used: 1, lifetimeUsed: 9, accepting: true });
  });

  it('shares the existing game stop and handles missing state and unavailable D1', async () => {
    for (const value of ['true', 'invalid']) expect(await reserveSignupAttempt({ ...env, NEW_WORK_STOPPED: value })).toBe(false);
    await setBudgetStops(env, 'owner-fixture', controls(0, true));
    expect(await reserveSignupAttempt(env)).toBe(false);
    await setBudgetStops(env, 'owner-fixture', controls(1, false));
    expect(await reserveSignupAttempt(env)).toBe(true);
    const unavailable = { DB: { prepare: () => { throw new Error('database unavailable'); } } } as unknown as BudgetEnv;
    await expect(reserveSignupAttempt(unavailable)).rejects.toMatchObject({ status: 503, code: 'BUDGET_UNAVAILABLE' });
    await env.DB.prepare("DELETE FROM signup_budget WHERE id='product'").run();
    expect(await reserveSignupAttempt(env)).toBe(false);
  });
});

function controls(expectedVersion: number, stopped: boolean) {
  return { expectedVersion, gamesStopped: stopped, emailStopped: stopped, reason: 'Investigating the monthly allowance.' };
}

describe('work usage', () => {
  it('records every game reservation and never charges a stable game ID twice', async () => {
    const ids = Array.from({ length: 12 }, () => `casual:${crypto.randomUUID()}`);
    const accepted = await Promise.all(ids.map(id => reserveMonthlyWork(env, 'games', id)));
    expect(accepted.filter(Boolean)).toHaveLength(12);
    const first = ids[0];
    expect(await Promise.all(Array.from({ length: 12 }, () => reserveMonthlyWork(env, 'games', first)))).toEqual(Array(12).fill(true));
    expect((await budgetStatus(env)).allowances.find(row => row.kind === 'games'))
      .toMatchObject({ used: 12, retainedReceipts: 12, accepting: true });
    expect(await newWorkAllowed(env, 'games')).toBe(true);
  });

  it('reserves all preview tournament games together and rejects changed reservation sizes', async () => {
    const id = `tournament:hourly-${Date.now()}`;
    expect(await reserveMonthlyWork(env, 'games', id, Date.now(), 6)).toBe(true);
    expect(await reserveMonthlyWork(env, 'games', id, Date.now(), 6)).toBe(true);
    expect(await reserveMonthlyWork(env, 'games', id, Date.now(), 3)).toBe(false);
    expect((await budgetStatus(env)).allowances.find(row => row.kind === 'games'))
      .toMatchObject({ used: 6, retainedReceipts: 1, accepting: true });
  });

  it('keeps accepted work through stops and UTC rollover without refunding permanent receipts', async () => {
    const first = Date.UTC(2026, 9, 31, 23, 59, 59);
    const next = Date.UTC(2026, 10, 1);
    const id = `casual:${crypto.randomUUID()}`;
    expect(await reserveMonthlyWork(env, 'games', id, first)).toBe(true);
    await setBudgetStops(env, 'owner-fixture', controls(0, true), first);
    expect(await newWorkAllowed(env, 'games')).toBe(false);
    expect(await reserveMonthlyWork(env, 'games', id, next)).toBe(true);
    expect(await reserveMonthlyWork(env, 'games', `casual:${crypto.randomUUID()}`, next)).toBe(false);
    await setBudgetStops(env, 'owner-fixture', controls(1, false), next);
    expect(await reserveMonthlyWork(env, 'games', `casual:${crypto.randomUUID()}`, next)).toBe(true);
    const status = await budgetStatus(env, next);
    expect(status.month).toBe('2026-11');
    expect(status.allowances.find(row => row.kind === 'games')).toMatchObject({ used: 1, retainedReceipts: 2, accepting: true });
    expect(status.history.find(row => row.kind === 'games' && row.month === '2026-10')?.used).toBe(1);
  });

  it('handles a stop and unavailable D1 without promising new work', async () => {
    expect(await reserveMonthlyWork({ ...env, NEW_WORK_STOPPED: 'invalid' }, 'games', `casual:${crypto.randomUUID()}`)).toBe(false);
    const unavailable = { DB: { prepare: () => { throw new Error('database unavailable'); } } } as unknown as BudgetEnv;
    await expect(reserveMonthlyWork(unavailable, 'games', `casual:${crypto.randomUUID()}`)).rejects.toMatchObject({ status: 503, code: 'BUDGET_UNAVAILABLE' });
    await expect(newWorkAllowed(unavailable, 'games')).rejects.toMatchObject({ status: 503, code: 'BUDGET_UNAVAILABLE' });
  });

  it('bounds stale receipt cleanup while retaining permanent game receipts and monthly audit totals', async () => {
    const now = Date.now();
    const old = now - 63 * 86_400_000;
    const gameId = `casual:${crypto.randomUUID()}`;
    expect(await reserveMonthlyWork(env, 'games', gameId, old)).toBe(true);
    expect(await reserveMonthlyWork(env, 'email', crypto.randomUUID(), old)).toBe(true);
    await env.DB.prepare(`INSERT INTO budget_receipts(kind,id,period,units,created_at)
      SELECT 'email',value,period,1,? FROM json_each(?) CROSS JOIN budget_months WHERE kind='email'`)
      .bind(old, JSON.stringify(Array.from({ length: BUDGET_CLEANUP_BATCH }, () => crypto.randomUUID()))).run();
    expect(await cleanupBudgetReceipts(env, now)).toBe(BUDGET_CLEANUP_BATCH);
    expect(await env.DB.prepare("SELECT count FROM budget_receipt_counts WHERE kind='email'").first('count')).toBe(1);
    expect(await env.DB.prepare("SELECT count FROM budget_receipt_counts WHERE kind='games'").first('count')).toBe(1);
    expect(await reserveMonthlyWork({ ...env, NEW_WORK_STOPPED: 'true' }, 'games', gameId, now)).toBe(true);
    expect((await budgetStatus(env, old)).allowances.find(row => row.kind === 'email')?.used).toBe(BUDGET_CLEANUP_BATCH + 1);
  });

  it('rejects stale operator changes and retains the actual actor and stop decision', async () => {
    const results = await Promise.allSettled([
      setBudgetStops(env, 'owner-one', controls(0, true)),
      setBudgetStops(env, 'owner-two', controls(0, false)),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409, code: 'BUDGET_CONTROL_CHANGED' } });
    const status = await budgetStatus(env);
    expect(status.control.version).toBe(1);
    expect(status.recentChanges).toHaveLength(1);
    expect(status.recentChanges[0]).toMatchObject(status.control);
    await expect(setBudgetStops(env, 'owner-one', { ...controls(1, false), reason: 'short' })).rejects.toMatchObject({ status: 400 });
  });
});
