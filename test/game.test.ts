import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Chess } from 'chess.js';
import { parseReplay } from '../src/client/replay';
import { positionOutcome, timeoutOutcome } from '../src/server/adjudication';
import { activeGame, admitGameFixture, player } from './authority-helpers';
import type { GameCommand, GameResult, InitGame, ServerMessage } from '../src/shared/protocol';

afterEach(() => { vi.restoreAllMocks(); });

describe('durable game authority', () => {
  it('exports and replays names with quotes, backslashes, and line breaks without changing account names', async () => {
    const [white, black] = await Promise.all([player(), player()]);
    white.name = 'Ada "Check"\\team\n[Result "0-1"]';
    black.name = 'B\\club\r\n[White "Other"]\u2028End';
    await env.DB.batch([white, black].map(actor => env.DB.prepare('UPDATE user SET name=? WHERE id=?').bind(actor.name, actor.id)));
    const id = crypto.randomUUID();
    const game = env.GAME.get(env.GAME.idFromName(id));
    await admitGameFixture({ id, format: 'blitz', rated: false, white, black });
    const initial = await game.init({ id, format: 'blitz', rated: false, white, black });
    const first = await game.command(white, { type: 'ready', id: crypto.randomUUID(), expectedVersion: initial.version });
    const second = await game.command(black, { type: 'ready', id: crypto.randomUUID(), expectedVersion: first.snapshot.version });
    const moved = await game.command(white, { type: 'move', id: crypto.randomUUID(), expectedVersion: second.snapshot.version, from: 'e2', to: 'e4' });
    const ended = await game.command(black, { type: 'resign', id: crypto.randomUUID(), expectedVersion: moved.snapshot.version });
    expect([first.ok, second.ok, moved.ok, ended.ok]).toEqual([true, true, true, true]);
    expect(ended.snapshot.white.name).toBe(white.name);
    expect(ended.snapshot.black?.name).toBe(black.name);
    const result = (await game.status())!.result!;
    await game.flush();
    await env.COMPETITION.get(env.COMPETITION.idFromName('global')).flush();
    const saved = await env.DB.prepare('SELECT pgn,white_name,black_name FROM games WHERE id=?').bind(id)
      .first<{ pgn: string; white_name: string; black_name: string }>();
    expect(saved).toEqual({ pgn: result.pgn, white_name: white.name, black_name: black.name });
    const replay = parseReplay(saved!.pgn);
    expect(replay).toMatchObject({ white: "Ada 'Check'/team [Result '0-1']", black: "B/club [White 'Other'] End", result: '1-0' });
    expect(replay.moves.map(move => move.san)).toEqual(['e4']);
    expect(replay.moves.at(-1)?.after).toBe(ended.snapshot.fen);
    await evictDurableObject(game);
    expect((await game.status())?.result).toEqual(result);
    expect(await env.DB.prepare('SELECT name FROM user WHERE id=?').bind(white.id).first('name')).toBe(white.name);
    expect(await env.DB.prepare('SELECT name FROM user WHERE id=?').bind(black.id).first('name')).toBe(black.name);
  });

  it('preserves the stored export of a legacy terminal game without a header format marker', async () => {
    const { game, white, snapshot } = await activeGame();
    await runInDurableObject(game, async (instance, state) => {
      (instance as unknown as { schedule(): Promise<void> }).schedule = async () => {};
      await state.storage.deleteAlarm();
    });
    const ended = await game.command(white, { type: 'resign', id: crypto.randomUUID(), expectedVersion: snapshot.version });
    expect(ended.ok).toBe(true);
    const legacyName = 'Old "nickname"\\club\nPlayer';
    const legacy = await runInDurableObject(game, (_instance, state) => {
      const row = state.storage.sql.exec<{ value: string }>('SELECT value FROM game_state').one();
      const stored = JSON.parse(row.value) as { pgnHeaderVersion?: 1; white: { name: string } };
      delete stored.pgnHeaderVersion;
      stored.white.name = legacyName;
      state.storage.sql.exec('UPDATE game_state SET value=?', JSON.stringify(stored));
      const pending = state.storage.sql.exec<{ value: string }>('SELECT value FROM result_delivery').one();
      const delivery = JSON.parse(pending.value) as { result: GameResult };
      delivery.result.pgn = delivery.result.pgn.replace(`[White "${delivery.result.white.name}"]`, `[White "${legacyName}"]`);
      delivery.result.white.name = legacyName;
      state.storage.sql.exec('UPDATE result_delivery SET value=?', JSON.stringify(delivery));
      return delivery.result;
    });
    await evictDurableObject(game);
    expect((await game.status())?.result).toEqual(legacy);
  });

  it('accepts arena metadata only for round one and rejects unknown tournament formats', async () => {
    const [white, black] = await Promise.all([player(), player()]);
    const id = crypto.randomUUID();
    const game = env.GAME.get(env.GAME.idFromName(id));
    const input: InitGame = { id, format: 'blitz', rated: false, reservationId: crypto.randomUUID(), white, black,
      tournament: { id: 'arena-metadata-contract', format: 'arena-v1', round: 1, deadlineAt: Date.now() + 1_080_000 } };
    await runInDurableObject(game, async instance => {
      await expect(instance.init({ ...input, tournament: { ...input.tournament!, round: 2 } })).rejects.toThrow('invalid_game');
      await expect(instance.init({ ...input, tournament: { ...input.tournament!, format: 'unknown' } } as unknown as InitGame)).rejects.toThrow('invalid_game');
    });
    const snapshot = await game.init(input);
    expect(snapshot).toMatchObject({ rated: false, tournament: input.tournament });
    expect(snapshot.ai).toBeUndefined();
  });

  it('expires an unjoined invitation durably when a late claimant is refused', async () => {
    const [white, claimant] = await Promise.all([player(), player()]);
    const id = crypto.randomUUID();
    const game = env.GAME.get(env.GAME.idFromName(id));
    const before = Date.now();
    await admitGameFixture({ id, format: 'blitz', rated: false, white });
    const invite = await game.init({ id, format: 'blitz', rated: false, white });
    expect(invite.readinessDeadline).toBeGreaterThanOrEqual(before + 600_000);
    expect(invite.readinessDeadline).toBeLessThanOrEqual(Date.now() + 600_000);
    await env.DB.prepare('INSERT INTO active_game_seats(user_id,game_id,acquired_at) VALUES(?,?,?)').bind(white.id, id, before).run();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(invite.readinessDeadline!);
    expect(await game.claimSeat(claimant)).toEqual({ ok: false, code: 'seat_unavailable' });
    const persisted = await runInDurableObject(game, (_instance, state) => JSON.parse(state.storage.sql.exec<{ value: string }>('SELECT value FROM game_state').one().value));
    expect(persisted).toMatchObject({ status: 'finished', black: null, startedAt: null, endedAt: invite.readinessDeadline,
      outcome: { winner: null, score: null, reason: 'readiness-expired' } });
    await game.flush();
    await env.COMPETITION.get(env.COMPETITION.idFromName('global')).flush();
    clock.mockRestore();
    expect(await env.DB.prepare('SELECT released_at FROM active_game_seats WHERE user_id=? AND game_id=?').bind(white.id, id).first('released_at')).toEqual(expect.any(Number));
    expect(await env.DB.prepare('SELECT score,settlement FROM games WHERE id=?').bind(id).first()).toEqual({ score: null, settlement: 'unrated' });
  });

  it('accepts one of two simultaneous moves at the same board version', async () => {
    const { game, white, snapshot } = await activeGame();
    const commands: GameCommand[] = ['e4', 'd4'].map(target => ({ type: 'move', id: crypto.randomUUID(),
      expectedVersion: snapshot.version, from: `${target[0]}2`, to: target }));
    const replies = await Promise.all(commands.map(command => game.command(white, command)));
    expect(replies.filter(reply => reply.ok)).toHaveLength(1);
    expect(replies.filter(reply => !reply.ok)).toMatchObject([{ ok: false, code: 'stale_version' }]);
    const acceptedIndex = replies.findIndex(reply => reply.ok);
    await evictDurableObject(game);
    const retried = await game.command(white, commands[acceptedIndex]);
    expect(retried).toMatchObject({ ok: true, receipt: replies[acceptedIndex].ok ? replies[acceptedIndex].receipt : undefined });
    expect(retried.snapshot.moves).toHaveLength(1);
    expect(retried.snapshot.version).toBe(snapshot.version + 1);
    expect(retried.snapshot.moves[0].to).toBe(commands[acceptedIndex].type === 'move' ? commands[acceptedIndex].to : undefined);
  });

  it('keeps one immutable terminal result when draw acceptance and resignation overlap', async () => {
    const { game, white, black, snapshot } = await activeGame();
    await runInDurableObject(game, async (instance, state) => {
      (instance as unknown as { schedule(): Promise<void> }).schedule = async () => {};
      await state.storage.deleteAlarm();
    });
    const offer = await game.command(black, { type: 'offer-draw', id: crypto.randomUUID(), expectedVersion: snapshot.version });
    if (!offer.ok) throw new Error(offer.code);
    const replies = await Promise.all([
      game.command(white, { type: 'accept-draw', id: crypto.randomUUID(), expectedVersion: offer.snapshot.version }),
      game.command(black, { type: 'resign', id: crypto.randomUUID(), expectedVersion: offer.snapshot.version }),
    ]);
    expect(replies.filter(reply => reply.ok)).toHaveLength(1);
    expect(replies.filter(reply => !reply.ok)).toMatchObject([{ ok: false, code: 'game_over' }]);
    const terminal = await game.status();
    expect(terminal?.status).toBe('finished');
    expect(terminal?.version).toBe(offer.snapshot.version + 1);
    expect(['draw-agreement', 'resignation']).toContain(terminal?.result?.outcome.reason);
    expect(await runInDurableObject(game, (_instance, state) => state.storage.sql.exec('SELECT value FROM result_delivery').toArray())).toHaveLength(1);
    await evictDurableObject(game);
    expect(await game.status()).toEqual(terminal);
    await game.flush();
    await game.flush();
    const competition = env.COMPETITION.get(env.COMPETITION.idFromName('global'));
    expect(await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec('SELECT sequence FROM result_events WHERE game_id=?', snapshot.id).toArray())).toHaveLength(1);
    expect((await game.status())?.result?.terminalDigest).toBe(terminal?.result?.terminalDigest);
  });

  it('applies a retried legal move once and rejects a reused ID with another move', async () => {
    const { game, white, snapshot } = await activeGame();
    const command: GameCommand = { type: 'move', id: crypto.randomUUID(), expectedVersion: snapshot.version, from: 'e2', to: 'e4' };
    const accepted = await game.command(white, command);
    expect(accepted.ok).toBe(true);
    await evictDurableObject(game);
    const retried = await game.command(white, command);
    expect(retried.ok).toBe(true);
    if (!accepted.ok || !retried.ok) throw new Error('move_rejected');
    expect(retried.receipt).toEqual(accepted.receipt);
    expect(retried.snapshot.moves).toHaveLength(1);
    expect(retried.snapshot.clocks.w).toBe(accepted.snapshot.clocks.w);
    const conflict = await game.command(white, { ...command, to: 'e3' });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.code).toBe('command_id_conflict');
  });

  it('rejects another identity, out-of-turn moves, and stale board versions', async () => {
    const { game, white, black, snapshot } = await activeGame();
    const outsider = await player(true);
    const unauthorized = await runInDurableObject(game, async instance => {
      try { await instance.command(outsider, { type: 'resign', id: crypto.randomUUID(), expectedVersion: snapshot.version }); return 'unexpected_success'; }
      catch (error) { return (error as Error).message; }
    });
    expect(unauthorized).toBe('not_a_player');
    const wrongTurn = await game.command(black, { type: 'move', id: crypto.randomUUID(), expectedVersion: snapshot.version, from: 'e7', to: 'e5' });
    expect(wrongTurn.ok).toBe(false);
    if (!wrongTurn.ok) expect(wrongTurn.code).toBe('not_your_turn');
    const stale = await game.command(white, { type: 'move', id: crypto.randomUUID(), expectedVersion: 0, from: 'e2', to: 'e4' });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe('stale_version');
    expect((await game.snapshot(white)).moves).toHaveLength(0);
  });

  it.each(['move', 'accept-draw', 'resign'] as const)('checks a late clock before %s even if its alarm has not fired', async type => {
    const { game, white, black, snapshot } = await activeGame();
    const offered = await game.command(black, { type: 'offer-draw', id: crypto.randomUUID(), expectedVersion: snapshot.version });
    if (!offered.ok) throw new Error('offer_rejected');
    const deadline = offered.snapshot.clocks.deadline!;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(deadline);
    const base = { id: crypto.randomUUID(), expectedVersion: offered.snapshot.version };
    const reply = await game.command(white, type === 'move' ? { ...base, type, from: 'e2', to: 'e4' } : { ...base, type });
    clock.mockRestore();
    expect(reply.ok).toBe(false);
    expect(reply.snapshot.status).toBe('pending-adjudication');
    expect(reply.snapshot.outcome?.reason).toBe('timeout-needs-review');
    expect(reply.snapshot.outcome?.score).toBeNull();
    expect(reply.snapshot.moves).toHaveLength(0);
  });

  it('restores repetition history after eviction', async () => {
    const { game, white, black, snapshot } = await activeGame();
    let version = snapshot.version;
    for (let cycle = 0; cycle < 2; cycle++) {
      for (const [actor, from, to] of [[white, 'g1', 'f3'], [black, 'g8', 'f6'], [white, 'f3', 'g1'], [black, 'f6', 'g8']] as const) {
        const reply = await game.command(actor, { type: 'move', id: crypto.randomUUID(), expectedVersion: version, from, to });
        expect(reply.ok).toBe(true);
        version = reply.snapshot.version;
      }
      if (cycle === 0) await evictDurableObject(game);
    }
    const result = await game.snapshot(white);
    expect(result.status).toBe('finished');
    expect(result.outcome).toMatchObject({ score: 0.5, reason: 'threefold-repetition' });
  });

  it('keeps the terminal outbox through a lost reply and releases seats after retry', async () => {
    const { game, white, black, snapshot } = await activeGame();
    await env.DB.batch([white, black].map(actor => env.DB.prepare('INSERT INTO active_game_seats(user_id,game_id,acquired_at) VALUES(?,?,?)').bind(actor.id, snapshot.id, Date.now())));
    await runInDurableObject(game, instance => {
      const internal = instance as unknown as { env: { COMPETITION: DurableObjectNamespace } };
      const binding = internal.env.COMPETITION;
      internal.env = { ...internal.env, COMPETITION: { ...binding, idFromName: binding.idFromName.bind(binding), get: () => ({ settle: async () => { throw new Error('lost_reply'); } }) } as unknown as DurableObjectNamespace };
    });
    const done = await game.command(white, { type: 'resign', id: crypto.randomUUID(), expectedVersion: snapshot.version });
    expect(done.snapshot.status).toBe('finished');
    await game.flush();
    const delivery = await runInDurableObject(game, (_instance, state) => state.storage.sql.exec('SELECT value FROM result_delivery').toArray());
    expect(delivery).toHaveLength(1);
    const result = (await game.status())!.result!;
    const receipt = { eventId: result.eventId, terminalDigest: result.terminalDigest };
    await evictDurableObject(game);
    expect(await game.retryResultDelivery({ ...receipt, eventId: crypto.randomUUID() })).toBe(false);
    expect(await game.retryResultDelivery({ ...receipt, terminalDigest: 'different-result' })).toBe(false);
    await game.flush();
    expect(await runInDurableObject(game, (_instance, state) => state.storage.sql.exec('SELECT value FROM result_delivery').toArray())).toHaveLength(1);
    expect(await game.retryResultDelivery(receipt)).toBe(true);
    expect(await game.retryResultDelivery(receipt)).toBe(true);
    expect((await game.status())!.result).toEqual(result);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM active_game_seats WHERE game_id=? AND released_at IS NULL').bind(snapshot.id).first('count')).toBe(0);
    expect(await runInDurableObject(game, (_instance, state) => state.storage.sql.exec('SELECT value FROM result_delivery').toArray())).toHaveLength(0);
  });

  it('resumes a hibernating socket and revokes the replaced connection', async () => {
    const { game, white, snapshot } = await activeGame();
    const connect = async () => {
      const response = await game.fetch(new Request('https://internal/connect', { headers: { Upgrade: 'websocket', 'x-chess-actor': JSON.stringify(white) } }));
      expect(response.status).toBe(101);
      const socket = response.webSocket!;
      const initial = new Promise<ServerMessage>(resolve => socket.addEventListener('message', event => resolve(JSON.parse(event.data as string) as ServerMessage), { once: true }));
      socket.accept();
      expect((await initial).type).toBe('snapshot');
      return socket;
    };
    const old = await connect();
    await evictDurableObject(game);
    const accepted = new Promise<ServerMessage>(resolve => old.addEventListener('message', function onMessage(event) {
      const data = JSON.parse(event.data as string) as ServerMessage;
      if (data.type === 'command') { old.removeEventListener('message', onMessage); resolve(data); }
    }));
    const id = crypto.randomUUID();
    old.send(JSON.stringify({ type: 'move', id, expectedVersion: snapshot.version, from: 'e2', to: 'e4' }));
    expect(await accepted).toMatchObject({ type: 'command', id, reply: { ok: true } });
    const closed = new Promise<number>(resolve => old.addEventListener('close', event => resolve(event.code), { once: true }));
    const replacement = await connect();
    expect(await closed).toBe(4001);
    replacement.close(1000, 'Test complete');
  });

  it('normalizes abnormal peer closure without echoing its invalid code or long reason', async () => {
    const { game, white } = await activeGame();
    const response = await game.fetch(new Request('https://internal/connect', { headers: { Upgrade: 'websocket', 'x-chess-actor': JSON.stringify(white) } }));
    const socket = response.webSocket!;
    socket.accept();
    const closed = new Promise<number>(resolve => socket.addEventListener('close', event => resolve(event.code), { once: true }));
    await runInDurableObject(game, (instance, state) => instance.webSocketClose(state.getWebSockets()[0], 1006, 'x'.repeat(500)));
    expect(await closed).toBe(1000);
  });
});

describe('online adjudication boundary', () => {
  it('continues at halfmove99 and applies the fifty-move rule only after a quiet move reaches100', () => {
    const chess = new Chess('7k/8/6K1/8/8/8/8/R7 w - - 99 1');
    expect(positionOutcome(chess)).toBeNull();
    chess.move('Ra2');
    expect(positionOutcome(chess)).toEqual({ winner: null, score: 0.5, reason: 'fifty-move-rule' });
    const reset = new Chess('7k/8/6K1/8/8/8/7P/R7 w - - 99 1');
    reset.move('h3');
    expect(positionOutcome(reset)).toBeNull();
  });

  it('gives checkmate precedence over the generic fifty-move draw predicate', () => {
    const chess = new Chess();
    ['f3', 'e5', 'g4', 'Qh4#'].forEach(move => chess.move(move));
    const fields = chess.fen().split(' ');
    fields[4] = '100';
    const final = new Chess(fields.join(' '));
    expect(final.isDrawByFiftyMoves()).toBe(true);
    expect(positionOutcome(final)).toEqual({ winner: 'b', score: 0, reason: 'checkmate' });
  });

  it('does not invent a timeout win in blocked or two-knight positions', () => {
    const blocked = new Chess('5b2/p7/Pp3k2/1Pp1pBp1/2P1P1P1/5K2/8/8 w - - 0 1');
    expect(timeoutOutcome(blocked, 'w').reason).toBe('timeout-needs-review');
    const twoKnights = new Chess('7k/8/5KNN/8/8/8/8/8 b - - 0 1');
    expect(timeoutOutcome(twoKnights, 'b').reason).toBe('timeout-needs-review');
    expect(timeoutOutcome(new Chess('7k/8/5KB1/8/8/8/8/8 b - - 0 1'), 'b').score).toBe(0.5);
  });
});
