import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { createPlaceholderEmail } from '@better-auth/core/utils/email';
import type { Actor, GameResult, GameSnapshot, InitGame } from '../src/shared/protocol';
import type { Env } from '../src/server/env';
import type { Competition } from '../src/server/competition';
import type { Game } from '../src/server/game';

export async function player(anonymous = false, options: { recoveryEmail?: boolean } = {}): Promise<Actor> {
  const now = Date.now();
  const id = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const username = anonymous ? null : `p${id.replaceAll('-', '').slice(0, 23)}`;
  const email = options.recoveryEmail === false ? createPlaceholderEmail({ identifier: id, namespace: 'chess' }) : `${id}@example.test`;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO user(id,name,email,emailVerified,isAnonymous,username,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?)')
      .bind(id, `Player ${id.slice(0, 6)}`, email, anonymous || options.recoveryEmail === false ? 0 : 1, anonymous ? 1 : 0, username, new Date(now - 30 * 86_400_000).toISOString(), new Date(now).toISOString()),
    ...(!anonymous ? [env.DB.prepare('INSERT INTO account(id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)')
      // This authority fixture never authenticates a password. Native hashing is covered by auth tests.
      .bind(crypto.randomUUID(), id, 'credential', id, 'fake-test-only-password-hash', new Date(now).toISOString(), new Date(now).toISOString())] : []),
    env.DB.prepare('INSERT INTO session(id,userId,token,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
      .bind(sessionId, id, crypto.randomUUID(), new Date(now + 86_400_000).toISOString(), new Date(now).toISOString(), new Date(now).toISOString()),
  ]);
  return { id, name: `Player ${id.slice(0, 6)}`, isAnonymous: anonymous, sessionId, sessionExpiresAt: now + 86_400_000 };
}

export async function enableRanked(stub: DurableObjectStub<Competition> | DurableObjectStub<Game>): Promise<void> {
  await runInDurableObject(stub as DurableObjectStub<Game>, instance => {
    const internal = instance as unknown as { env: Env };
    internal.env = { ...internal.env, RANKED_ENABLED: 'true' };
  });
}

/** Direct Game unit fixtures admit an ID without exercising HTTP admission. */
export async function admitGameFixture(input: InitGame): Promise<void> {
  if (input.rated || input.tournament) return;
  await env.DB.prepare('INSERT OR IGNORE INTO casual_game_admissions(game_id,creator_id,created_at,reservation_id) VALUES(?,?,?,?)')
    .bind(input.id, input.white.id, Date.now(), input.reservationId ?? null).run();
}

export async function activeGame(): Promise<{ game: DurableObjectStub<Game>; white: Actor; black: Actor; snapshot: GameSnapshot }> {
  const [white, black] = await Promise.all([player(), player()]);
  const id = crypto.randomUUID();
  const game = env.GAME.get(env.GAME.idFromName(id));
  await admitGameFixture({ id, format: 'blitz', rated: false, white, black });
  await game.init({ id, format: 'blitz', rated: false, white, black });
  const first = await game.command(white, { type: 'ready', id: crypto.randomUUID(), expectedVersion: 0 });
  if (!first.ok) throw new Error(first.code);
  const second = await game.command(black, { type: 'ready', id: crypto.randomUUID(), expectedVersion: first.snapshot.version });
  if (!second.ok) throw new Error(second.code);
  return { game, white, black, snapshot: second.snapshot };
}

/**
 * For fixtures and qualification harnesses that own the clock: the object must not arm real alarms.
 * Alarm scheduling is private product code, so this is the one place that reaches it.
 * `bindings` replace the object's private env bindings.
 */
export async function holdAlarms(stub: DurableObjectStub<Competition> | DurableObjectStub<Game>, bindings: Partial<Env> = {}): Promise<void> {
  await runInDurableObject(stub as DurableObjectStub<Game>, async (instance, state) => {
    const internal = instance as unknown as { env: Env; schedule(): Promise<void> };
    internal.env = { ...internal.env, ...bindings };
    internal.schedule = async () => {};
    await state.storage.deleteAlarm();
  });
}

/** Rewrites an active game into the state a flag left before timeouts were resolved at the flag. */
export async function pendingAdjudicationGame() {
  const setup = await activeGame();
  const flaggedAt = setup.snapshot.clocks.deadline!;
  await env.DB.batch([setup.white, setup.black].map(actor => env.DB.prepare('INSERT INTO active_game_seats(user_id,game_id,acquired_at) VALUES(?,?,?)')
    .bind(actor.id, setup.snapshot.id, Date.now())));
  await runInDurableObject(setup.game, (instance, state) => {
    const stored = JSON.parse(state.storage.sql.exec<{ value: string }>('SELECT value FROM game_state').one().value);
    Object.assign(stored, { status: 'pending-adjudication', version: stored.version + 1, deadline: null, endedAt: flaggedAt,
      outcome: { winner: null, score: null, reason: 'timeout-needs-review' }, remaining: { ...stored.remaining, w: 0 } });
    state.storage.sql.exec('UPDATE game_state SET value=?', JSON.stringify(stored));
    const result = (instance as unknown as { result(saved: unknown): GameResult }).result(stored);
    state.storage.sql.exec('INSERT INTO result_delivery(id,value) VALUES(1,?)', JSON.stringify({ result, attempts: 0, nextAttemptAt: flaggedAt }));
  });
  return { ...setup, flaggedAt };
}
