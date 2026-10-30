import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ACCOUNT_REQUEST_LIMITS, accountRequestStatus, consumeAccountRequest } from '../src/server/abuse';
import { ApiError, errorResponse } from '../src/server/security';
import type { Game } from '../src/server/game';
import type { Actor, ServerMessage } from '../src/shared/protocol';
import { activeGame, player } from './authority-helpers';

async function connect(game: DurableObjectStub<Game>, actor: Actor): Promise<WebSocket> {
  const response = await game.fetch(new Request('https://internal/connect', {
    headers: { Upgrade: 'websocket', 'x-chess-actor': JSON.stringify(actor) },
  }));
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  const initial = nextMessage(socket);
  socket.accept();
  expect((await initial).type).toBe('snapshot');
  return socket;
}

function nextMessage(socket: WebSocket): Promise<ServerMessage> {
  return new Promise(resolve => socket.addEventListener('message', event => resolve(JSON.parse(event.data as string) as ServerMessage), { once: true }));
}

describe('durable account request budgets', () => {
  it('rolls back the account charge when its exhausted-window counter cannot commit', async () => {
    const account = crypto.randomUUID();
    const now = Date.now();
    const { maximum } = ACCOUNT_REQUEST_LIMITS.write;
    const baseline = (await accountRequestStatus(env.DB, now)).exhaustedWindows.write;
    await env.DB.prepare('INSERT INTO request_limits(key,count,window_start) VALUES(?,?,?)')
      .bind(`account:write:${account}`, maximum, now).run();
    await env.DB.prepare(`CREATE TRIGGER reject_exhausted_counter BEFORE INSERT ON request_limits
      WHEN NEW.key='security:exhausted:write' BEGIN SELECT RAISE(ABORT,'counter_write_failed'); END`).run();
    try {
      await expect(consumeAccountRequest(env.DB, account, 'write', now)).rejects.toThrow('counter_write_failed');
      expect(await env.DB.prepare('SELECT count FROM request_limits WHERE key=?')
        .bind(`account:write:${account}`).first('count')).toBe(maximum);
      expect((await accountRequestStatus(env.DB, now)).exhaustedWindows.write).toBe(baseline);
    } finally {
      await env.DB.prepare('DROP TRIGGER reject_exhausted_counter').run();
    }
    await expect(consumeAccountRequest(env.DB, account, 'write', now)).rejects.toMatchObject({ status: 429 });
    await expect(consumeAccountRequest(env.DB, account, 'write', now)).rejects.toMatchObject({ status: 429 });
    expect((await accountRequestStatus(env.DB, now)).exhaustedWindows.write).toBe(baseline + 1);
  });

  it('atomically admits only the cap, counts one exhausted window, and lets a new window or another account proceed', async () => {
    const account = crypto.randomUUID();
    const now = Date.now();
    const { maximum, windowMs } = ACCOUNT_REQUEST_LIMITS.write;
    const baseline = (await accountRequestStatus(env.DB, now)).exhaustedWindows.write;
    const attempts = await Promise.allSettled(Array.from({ length: maximum + 5 }, () => consumeAccountRequest(env.DB, account, 'write', now)));
    expect(attempts.filter(attempt => attempt.status === 'fulfilled')).toHaveLength(maximum);
    const denied = attempts.filter((attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected');
    expect(denied).toHaveLength(5);
    for (const attempt of denied) expect(attempt.reason).toMatchObject({ status: 429, retryAfterSeconds: 60 });
    expect((await accountRequestStatus(env.DB, now)).exhaustedWindows.write).toBe(baseline + 1);
    await expect(consumeAccountRequest(env.DB, crypto.randomUUID(), 'write', now)).resolves.toBeUndefined();
    await expect(consumeAccountRequest(env.DB, account, 'write', now + windowMs)).resolves.toBeUndefined();
    const response = errorResponse(denied[0].reason as ApiError);
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('durable Game protocol budgets', () => {
  it('charges malformed frames across socket replacement and eviction, then restores access in a new window', async () => {
    const { game, white, black, snapshot } = await activeGame();
    await runInDurableObject(game, (_instance, state) => {
      state.storage.sql.exec('UPDATE protocol_limits SET count=28,window_start=? WHERE scope=? AND user_id=?', Date.now(), 'command', white.id);
    });
    const original = await connect(game, white);
    for (let i = 0; i < 2; i++) {
      const message = nextMessage(original);
      original.send('{}');
      expect(await message).toEqual({ type: 'error', code: 'invalid_command' });
    }
    const replaced = new Promise<number>(resolve => original.addEventListener('close', event => resolve(event.code), { once: true }));
    const replacement = await connect(game, white);
    expect(await replaced).toBe(4001);
    await evictDurableObject(game);
    const limited = new Promise<number>(resolve => replacement.addEventListener('close', event => resolve(event.code), { once: true }));
    replacement.send('{}');
    expect(await limited).toBe(1008);
    const command = { type: 'move' as const, id: crypto.randomUUID(), expectedVersion: snapshot.version, from: 'e2', to: 'e4' };
    expect(await game.command(white, command)).toMatchObject({ ok: false, code: 'command_rate_limited', snapshot: { version: snapshot.version, moves: [] } });
    const other = await connect(game, black);
    const otherMessage = nextMessage(other);
    other.send('{}');
    expect(await otherMessage).toEqual({ type: 'error', code: 'invalid_command' });
    expect(await game.securityStatus()).toMatchObject({ counters: { commandWindows: 1 } });
    await runInDurableObject(game, (_instance, state) => {
      state.storage.sql.exec('UPDATE protocol_limits SET window_start=? WHERE scope=? AND user_id=?', Date.now() - 10_000, 'command', white.id);
    });
    const accepted = await game.command(white, command);
    expect(accepted).toMatchObject({ ok: true, snapshot: { version: snapshot.version + 1 } });
    await evictDurableObject(game);
    const retried = await game.command(white, command);
    expect(retried).toMatchObject({ ok: true, receipt: accepted.ok ? accepted.receipt : undefined });
    expect(retried.snapshot.moves).toHaveLength(1);
    other.close(1000, 'Test complete');
  });

  it('keeps per-seat connection windows through eviction without replacing a live socket on denial', async () => {
    const { game, white, black } = await activeGame();
    await runInDurableObject(game, (_instance, state) => {
      state.storage.sql.exec('INSERT INTO protocol_limits(scope,user_id,window_start,count) VALUES(?,?,?,?)', 'connect', white.id, Date.now(), 9);
    });
    const current = await connect(game, white);
    const outsider = await player(true);
    const refused = await game.fetch(new Request('https://internal/connect', { headers: { Upgrade: 'websocket', 'x-chess-actor': JSON.stringify(outsider) } }));
    expect(refused.status).toBe(404);
    await refused.body?.cancel();
    expect(await runInDurableObject(game, (_instance, state) => state.storage.sql.exec('SELECT 1 FROM protocol_limits WHERE user_id=?', outsider.id).toArray())).toHaveLength(0);
    await evictDurableObject(game);
    const denied = await game.fetch(new Request('https://internal/connect', { headers: { Upgrade: 'websocket', 'x-chess-actor': JSON.stringify(white) } }));
    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get('Retry-After'))).toBeGreaterThan(0);
    await denied.body?.cancel();
    expect((await game.securityStatus()).counters.connectWindows).toBe(1);
    expect(current.readyState).toBe(WebSocket.OPEN);
    const stillConnected = nextMessage(current);
    current.send('{}');
    expect(await stillConnected).toEqual({ type: 'error', code: 'invalid_command' });
    const other = await connect(game, black);
    expect(await runInDurableObject(game, (_instance, state) => state.storage.sql.exec('SELECT scope,user_id FROM protocol_limits').toArray())).toHaveLength(4);
    await runInDurableObject(game, (_instance, state) => {
      state.storage.sql.exec('UPDATE protocol_limits SET window_start=? WHERE scope=? AND user_id=?', Date.now() - 60_000, 'connect', white.id);
    });
    const renewed = await connect(game, white);
    renewed.close(1000, 'Test complete');
    other.close(1000, 'Test complete');
  });

  it.each(['oversized', 'binary'] as const)('closes a %s frame before applying a command', async kind => {
    const { game, white } = await activeGame();
    const socket = await connect(game, white);
    const closed = new Promise<number>(resolve => socket.addEventListener('close', event => resolve(event.code), { once: true }));
    socket.send(kind === 'oversized' ? 'x'.repeat(2_049) : new ArrayBuffer(8));
    expect(await closed).toBe(1009);
    expect((await game.snapshot(white)).moves).toHaveLength(0);
    expect((await game.securityStatus()).counters.invalidFrames).toBe(1);
  });
});
