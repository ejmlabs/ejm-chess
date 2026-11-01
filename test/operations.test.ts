import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireSeatGuard, createAuth } from '../src/server/auth';
import { budgetStatus } from '../src/server/budget';
import { budgetStopWebhook } from '../src/server/budget-webhook';
import { player } from './authority-helpers';

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM budget_receipts'),
    env.DB.prepare('UPDATE budget_receipt_counts SET count=0'),
    env.DB.prepare('DELETE FROM budget_months'),
    env.DB.prepare('DELETE FROM operations_changes'),
    env.DB.prepare("UPDATE operations_control SET version=0,games_stopped=0,email_stopped=0,changed_at=NULL,changed_by=NULL,reason=NULL WHERE id='product'"),
  ]);
});

describe('budget stops preserve accepted work', () => {
  it('closes new games while an admitted casual invitation can join, finish, settle, and retain its replay', async () => {
    const [white, black, other] = await Promise.all([player(), player(), player()]);
    const id = crypto.randomUUID();
    expect(await acquireSeatGuard(env, white, id, false, true)).toBe(true);
    const game = env.GAME.get(env.GAME.idFromName(id));
    await game.init({ id, white, format: 'blitz', rated: false });
    const secret = 'test-budget-stop-secret-with-at-least-32-bytes';
    await budgetStopWebhook(new Request('http://localhost:8787/api/operations/budget-stop', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'cf-webhook-auth': secret }, body: JSON.stringify({ text: 'This is a test notification.' }) }),
    { ...env, BUDGET_STOP_WEBHOOK_SECRET: secret });
    expect(await acquireSeatGuard(env, other, crypto.randomUUID(), false, true)).toBe(false);
    expect(await acquireSeatGuard(env, white, id, false, true)).toBe(true);
    expect(await acquireSeatGuard(env, black, id)).toBe(true);
    const joined = await game.claimSeat(black);
    if (!joined.ok) throw new Error(joined.code);
    const readyWhite = await game.command(white, { type: 'ready', id: crypto.randomUUID(), expectedVersion: joined.snapshot.version });
    if (!readyWhite.ok) throw new Error(readyWhite.code);
    const readyBlack = await game.command(black, { type: 'ready', id: crypto.randomUUID(), expectedVersion: readyWhite.snapshot.version });
    if (!readyBlack.ok) throw new Error(readyBlack.code);
    const resigned = await game.command(white, { type: 'resign', id: crypto.randomUUID(), expectedVersion: readyBlack.snapshot.version });
    expect(resigned.ok).toBe(true);
    await game.flush();
    await env.COMPETITION.get(env.COMPETITION.idFromName('global')).flush();
    const replay = await env.DB.prepare('SELECT status,reason,pgn,settlement FROM games WHERE id=?').bind(id).first<{ status: string; reason: string; pgn: string; settlement: string }>();
    expect(replay).toMatchObject({ status: 'finished', reason: 'resignation', settlement: 'unrated' });
    expect(replay?.pgn).toContain('0-1');
    expect(await env.DB.prepare('SELECT 1 FROM active_game_seats WHERE game_id=? AND released_at IS NULL').bind(id).first()).toBeNull();
  });

  it('charges uncertain email provider attempts without a monthly cap', async () => {
    const actor = await player();
    await env.DB.prepare('UPDATE user SET emailVerified=0 WHERE id=?').bind(actor.id).run();
    const send = vi.fn(async () => { throw new Error('provider timeout'); });
    const config = { ...env, AUTH_BASE_URL: 'https://chess.ejmlabs.com', LOCAL_DEV: undefined,
      EMAIL_FROM: 'chess@ejmlabs.com', EMAIL: { send } };
    const auth = createAuth(config);
    const request = () => new Request('https://chess.ejmlabs.com/api/auth/send-verification-email', { method: 'POST',
      headers: { Origin: 'https://chess.ejmlabs.com', 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.230' },
      body: JSON.stringify({ email: `${actor.id}@example.test`, callbackURL: '/play/' }) });
    expect((await auth.handler(request())).ok).toBe(false);
    expect((await auth.handler(request())).ok).toBe(false);
    expect(send).toHaveBeenCalledTimes(2);
    expect((await budgetStatus(config)).allowances.find(row => row.kind === 'email')).toMatchObject({ used: 2, accepting: true });
  });
});
