import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { budgetStatus, reserveMonthlyWork } from '../src/server/budget';
import { budgetStopWebhook } from '../src/server/budget-webhook';
import { setBudgetStops } from '../src/server/operations';
import handler from '../src/server/index';

const origin = 'http://localhost:8787';
const secret = 'test-budget-stop-secret-with-at-least-32-bytes';
const config = { ...env, BUDGET_STOP_WEBHOOK_SECRET: secret };
function request(body: unknown = { text: 'This is a test notification.' }, token = secret): Request {
  return new Request(origin + '/api/operations/budget-stop', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'cf-webhook-auth': token }, body: JSON.stringify(body) });
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM budget_receipts'),
    env.DB.prepare('UPDATE budget_receipt_counts SET count=0'),
    env.DB.prepare('DELETE FROM budget_months'),
    env.DB.prepare('DELETE FROM operations_changes'),
    env.DB.prepare("UPDATE operations_control SET version=0,games_stopped=0,email_stopped=0,analysis_stopped=0,changed_at=NULL,changed_by=NULL,reason=NULL WHERE id='product'"),
  ]);
});

describe('dedicated budget stop webhook', () => {
  it('disables missing/invalid configuration and rejects unauthenticated calls before body parsing or D1', async () => {
    const prepare = vi.fn(() => { throw new Error('D1 must not be called'); });
    const bindings = { ...config, DB: { prepare } as unknown as D1Database };
    const malformed = (token?: string) => new Request(origin + '/api/operations/budget-stop', { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { 'cf-webhook-auth': token } : {}) }, body: 'not JSON' });
    for (const configured of [undefined, 'short', 'invalid secret with spaces that must be rejected']) {
      await expect(budgetStopWebhook(malformed(secret), { ...bindings, BUDGET_STOP_WEBHOOK_SECRET: configured })).rejects.toMatchObject({ status: 404 });
    }
    for (const token of [undefined, 'wrong-secret', 'x'.repeat(129)]) {
      await expect(budgetStopWebhook(malformed(token), bindings)).rejects.toMatchObject({ status: 403, code: 'WEBHOOK_AUTH_REQUIRED' });
    }
    expect(prepare).not.toHaveBeenCalled();
  });

  it('bounds authenticated notification bodies and leaves the stop state untouched on malformed input', async () => {
    const prepare = vi.fn(() => { throw new Error('D1 must not be called'); });
    const bindings = { ...config, DB: { prepare } as unknown as D1Database };
    for (const body of [{}, { text: 0 }, { text: '   ' }, { text: 'x'.repeat(4_097) }]) {
      await expect(budgetStopWebhook(request(body), bindings)).rejects.toMatchObject({ status: 400, code: 'INVALID_NOTIFICATION' });
    }
    const malformed = new Request(origin + '/api/operations/budget-stop', { method: 'POST', headers: { 'Content-Type': 'application/json', 'cf-webhook-auth': secret }, body: '{' });
    await expect(budgetStopWebhook(malformed, bindings)).rejects.toMatchObject({ status: 400, code: 'INVALID_JSON' });
    await expect(budgetStopWebhook(request({ text: 'stop', extra: 'x'.repeat(8_193) }), bindings)).rejects.toMatchObject({ status: 413 });
    expect(prepare).not.toHaveBeenCalled();
    expect((await budgetStatus(env)).control).toMatchObject({ version: 0, games_stopped: 0, email_stopped: 0, analysis_stopped: 0 });
  });

  it('stops monotonically across an owner version race and repeated test notifications without trusting payload controls or dollars', async () => {
    const accepted = `casual:${crypto.randomUUID()}`;
    expect(await reserveMonthlyWork(env, 'games', accepted)).toBe(true);
    const outcomes = await Promise.allSettled([
      setBudgetStops(env, 'owner-fixture', { expectedVersion: 0, gamesStopped: false, emailStopped: false, analysisStopped: false, reason: 'Owner reviewed the current allowance.' }),
      budgetStopWebhook(request({ text: 'private notification text', amount: 0, gamesStopped: false, data: { account_id: 'private-account-reference' } }), config),
    ]);
    expect(outcomes[1].status).toBe('fulfilled');
    const stopped = await budgetStatus(env);
    expect(stopped.control).toMatchObject({ games_stopped: 1, email_stopped: 1, analysis_stopped: 1, changed_by: 'cloudflare:budget-stop' });
    expect(JSON.stringify(stopped)).not.toContain('private notification text');
    expect(JSON.stringify(stopped)).not.toContain('private-account-reference');
    await Promise.all(Array.from({ length: 8 }, () => budgetStopWebhook(request(), config)));
    expect((await budgetStatus(env)).control.version).toBe(stopped.control.version);
    expect(await reserveMonthlyWork(env, 'games', accepted)).toBe(true);
    expect(await reserveMonthlyWork(env, 'games', `casual:${crypto.randomUUID()}`)).toBe(false);
  });

  it('accepts only its independent secret on the canonical Worker route and keeps normal security headers', async () => {
    const context = createExecutionContext();
    const response = await handler.fetch(request(), config, context);
    await waitOnExecutionContext(context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, stopped: true });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    const denied = await handler.fetch(new Request(origin + '/api/admin/operations/budget', { method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', 'cf-webhook-auth': secret }, body: '{}' }), config, context);
    expect([401, 403]).toContain(denied.status);
    await expect(budgetStopWebhook(new Request(origin + '/api/operations/budget-stop', { headers: { 'cf-webhook-auth': secret } }), config)).rejects.toMatchObject({ status: 405 });
  });

  it('returns a retryable failure when the authenticated stop cannot commit', async () => {
    const prepare = vi.fn(() => { throw new Error('provider outage'); });
    await expect(budgetStopWebhook(request(), { ...config, DB: { prepare } as unknown as D1Database })).rejects.toMatchObject({ status: 503, code: 'BUDGET_UNAVAILABLE' });
    expect(prepare).toHaveBeenCalledOnce();
  });
});
