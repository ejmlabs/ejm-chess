import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BUDGET_CLEANUP_BATCH, budgetStatus, cleanupBudgetReceipts, monthlyLimit, newWorkAllowed, reserveMonthlyWork, reserveSignupAttempt, workStopped, type BudgetEnv } from '../src/server/budget';
import { bindIsolatedGameBudget } from '../src/server/capacity-policy';
import { setBudgetStops } from '../src/server/operations';

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM budget_receipts'),
    env.DB.prepare('UPDATE budget_receipt_counts SET count=0'),
    env.DB.prepare('DELETE FROM budget_months'),
    env.DB.prepare('DELETE FROM operations_changes'),
    env.DB.prepare("INSERT INTO signup_budget(id) VALUES('product') ON CONFLICT(id) DO UPDATE SET period=0,monthly_attempts=0,lifetime_attempts=0"),
    env.DB.prepare("UPDATE operations_control SET version=0,games_stopped=0,email_stopped=0,analysis_stopped=0,changed_at=NULL,changed_by=NULL,reason=NULL WHERE id='product'"),
  ]);
});

describe('signup work admission', () => {
  it('serializes the final monthly attempt and preserves the lifetime charge through rollover', async () => {
    const first = Date.UTC(2026, 9, 31, 23, 59, 59);
    const next = Date.UTC(2026, 10, 1);
    const limited = { ...env, MONTHLY_SIGNUP_LIMIT: '1', SIGNUP_ATTEMPT_LIMIT: '2' };
    expect((await Promise.all(Array.from({ length: 8 }, () => reserveSignupAttempt(limited, first)))).filter(Boolean)).toHaveLength(1);
    expect((await budgetStatus(limited, first)).signup).toMatchObject({ used: 1, remaining: 0, lifetimeUsed: 1, lifetimeRemaining: 1, accepting: false });
    expect(await reserveSignupAttempt(limited, next)).toBe(true);
    expect(await reserveSignupAttempt(limited, first)).toBe(false);
    expect(await reserveSignupAttempt(limited, Date.UTC(2026, 11, 1))).toBe(false);
    expect((await budgetStatus(limited, next)).signup).toMatchObject({ used: 1, lifetimeUsed: 2, lifetimeRemaining: 0, accepting: false });
  });

  it('shares the existing game stop and denies invalid limits, missing state and unavailable D1', async () => {
    for (const key of ['MONTHLY_SIGNUP_LIMIT', 'SIGNUP_ATTEMPT_LIMIT'] as const) {
      for (const value of ['0', '-1', '100001', '1.5', 'invalid', '']) {
        expect(await reserveSignupAttempt({ ...env, [key]: value })).toBe(false);
      }
    }
    expect(await reserveSignupAttempt({ ...env, MONTHLY_SIGNUP_LIMIT: '10001' })).toBe(false);
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
  return { expectedVersion, gamesStopped: stopped, emailStopped: stopped, analysisStopped: stopped, reason: 'Investigating the monthly allowance.' };
}

describe('monthly work admission', () => {
  it('overlaps funded preflight reads and settles both while preserving stop and failure order', async () => {
    for (const [available, allowance, expected] of [
      [true, { accepted: 1 }, true],
      [true, null, false],
      [false, new Error('D1 unavailable'), false],
      [new Error('controller unavailable'), { accepted: 1 }, 'unavailable'],
      [true, new Error('D1 unavailable'), 'unavailable'],
    ] as const) {
      let release!: () => void;
      const paused = new Promise<void>(resolve => { release = resolve; });
      const first = vi.fn(async () => {
        await paused;
        if (allowance instanceof Error) throw allowance;
        return allowance;
      });
      const limited = { DB: { prepare: () => ({ bind: () => ({ first }) }) } } as unknown as BudgetEnv;
      const readAvailability = vi.fn(async () => {
        await paused;
        if (available instanceof Error) throw available;
        return available;
      });
      bindIsolatedGameBudget(limited, { manifestDigest: 'a'.repeat(64), maximum: 20_000,
        available: readAvailability, reserve: async () => true });
      const pending = newWorkAllowed(limited, 'games').then(value => ({ value }), error => ({ error }));
      let result: Awaited<typeof pending>;
      try {
        await vi.waitFor(() => {
          expect(readAvailability).toHaveBeenCalledOnce();
          expect(first).toHaveBeenCalledOnce();
        }, { timeout: 500, interval: 1 });
      } finally { release(); result = await pending; }
      if (expected === 'unavailable') expect(result).toMatchObject({ error: { status: 503, code: 'BUDGET_UNAVAILABLE' } });
      else expect(result).toEqual({ value: expected });
    }
  });

  it('serializes concurrent last-slot reservations and never charges a stable game ID twice', async () => {
    const limited = { ...env, MONTHLY_GAME_LIMIT: '3' };
    const ids = Array.from({ length: 12 }, () => `casual:${crypto.randomUUID()}`);
    const accepted = await Promise.all(ids.map(id => reserveMonthlyWork(limited, 'games', id)));
    expect(accepted.filter(Boolean)).toHaveLength(3);
    const first = ids[accepted.indexOf(true)];
    expect(await Promise.all(Array.from({ length: 12 }, () => reserveMonthlyWork(limited, 'games', first)))).toEqual(Array(12).fill(true));
    expect((await budgetStatus(limited)).allowances.find(row => row.kind === 'games')).toMatchObject({ used: 3, remaining: 0, retainedReceipts: 3, accepting: false });
    expect(await newWorkAllowed(limited, 'games')).toBe(false);
  });

  it('reserves all preview tournament games together and rejects changed reservation sizes', async () => {
    const id = `tournament:hourly-${Date.now()}`;
    expect(await reserveMonthlyWork({ ...env, MONTHLY_GAME_LIMIT: '5' }, 'games', id, Date.now(), 6)).toBe(false);
    expect((await budgetStatus(env)).allowances.find(row => row.kind === 'games')?.used).toBe(0);
    const limited = { ...env, MONTHLY_GAME_LIMIT: '6' };
    expect(await reserveMonthlyWork(limited, 'games', id, Date.now(), 6)).toBe(true);
    expect(await reserveMonthlyWork(limited, 'games', id, Date.now(), 6)).toBe(true);
    expect(await reserveMonthlyWork(limited, 'games', id, Date.now(), 3)).toBe(false);
    expect(await reserveMonthlyWork(limited, 'games', `ranked:${crypto.randomUUID()}`)).toBe(false);
    expect((await budgetStatus(limited)).allowances.find(row => row.kind === 'games')).toMatchObject({ used: 6, retainedReceipts: 1 });
  });

  it('keeps accepted work through stops and UTC rollover without refunding or resetting permanent receipts', async () => {
    const first = Date.UTC(2026, 9, 31, 23, 59, 59);
    const next = Date.UTC(2026, 10, 1);
    const limited = { ...env, MONTHLY_GAME_LIMIT: '1' };
    const id = `casual:${crypto.randomUUID()}`;
    expect(await reserveMonthlyWork(limited, 'games', id, first)).toBe(true);
    await setBudgetStops(env, 'owner-fixture', controls(0, true), first);
    expect(await workStopped(env, 'analysis')).toBe(true);
    expect(await reserveMonthlyWork(limited, 'games', id, next)).toBe(true);
    expect(await reserveMonthlyWork(limited, 'games', `casual:${crypto.randomUUID()}`, next)).toBe(false);
    expect(await reserveMonthlyWork({ ...limited, NEW_WORK_STOPPED: 'true' }, 'games', id, next)).toBe(true);
    await setBudgetStops(env, 'owner-fixture', controls(1, false), next);
    expect(await reserveMonthlyWork(limited, 'games', `casual:${crypto.randomUUID()}`, next)).toBe(true);
    const status = await budgetStatus(limited, next);
    expect(status.month).toBe('2026-11');
    expect(status.allowances.find(row => row.kind === 'games')).toMatchObject({ used: 1, retainedReceipts: 2 });
    expect(status.history.find(row => row.kind === 'games' && row.month === '2026-10')?.used).toBe(1);
  });

  it('closes invalid configuration, receipt exhaustion, and unavailable D1 without promising new work', async () => {
    for (const value of ['-1', '10001', '5.5', 'Infinity', 'invalid', '']) {
      const config = { ...env, MONTHLY_GAME_LIMIT: value };
      expect(monthlyLimit(config, 'games')).toBe(0);
      expect(await reserveMonthlyWork(config, 'games', `casual:${crypto.randomUUID()}`)).toBe(false);
    }
    expect(await reserveMonthlyWork({ ...env, NEW_WORK_STOPPED: 'invalid' }, 'games', `casual:${crypto.randomUUID()}`)).toBe(false);
    await env.DB.prepare("UPDATE budget_receipt_counts SET count=15000 WHERE kind='email'").run();
    expect(await reserveMonthlyWork(env, 'email', crypto.randomUUID())).toBe(false);
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
