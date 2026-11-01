import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { createPlaceholderEmail } from '@better-auth/core/utils/email';
import { vi } from 'vitest';
import type { Actor, GameResult, GameSnapshot, InitGame, Pool } from '../src/shared/protocol';
import type { ArenaProjection } from '../src/server/arena-projection';
import type { Env } from '../src/server/env';
import type { Competition } from '../src/server/competition';
import type { Game } from '../src/server/game';

type Authority = DurableObjectStub<Competition>;
type Authoritative = Authority | DurableObjectStub<Game>;
/** Bindings to lay over an object's own, or a function of its current ones when a fake must wrap the real binding. */
type Bindings = Partial<Env> | ((current: Env) => Partial<Env>);

/** The private members of Competition and Game that fixtures touch. Product code does not expose them. */
interface Internals {
  env: Env;
  schedule(completedThrough?: number): Promise<void>;
  flush(): Promise<void>;
  project(value: unknown): Promise<void>;
  applyFinished(result: GameResult, sequence: number, epoch: number, now: number): unknown;
  load(): { white: { id: string } };
  result(saved: unknown): GameResult;
  arenas: { ensure(): void; maintenance(): Promise<void>; nextDue(): number | null; projection: ArenaProjection };
  casuals: { nextDue(): number | null };
}
const internals = (instance: object) => instance as unknown as Internals;

/** The one door to private members, for reading and calling. Changing them goes through the helpers below, so a refactor has one place to fix. */
export const privates: (instance: object) => Readonly<Internals> = internals;

/** Lays bindings over a live object's own and returns the undo. Runs inside `runInDurableObject`, next to work that needs the instance. */
export function swapBindings(instance: object, bindings: Bindings): () => void {
  const target = internals(instance);
  const previous = target.env;
  target.env = { ...previous, ...(typeof bindings === 'function' ? bindings(previous) : bindings) };
  return () => { target.env = previous; };
}

/** `swapBindings` from outside the object. The undo is for a case that must leave a shared object as it found it. */
export async function patchBindings(stub: Authoritative, bindings: Bindings): Promise<() => Promise<void>> {
  let undo!: () => void;
  await runInDurableObject(stub as DurableObjectStub<Game>, instance => { undo = swapBindings(instance, bindings); });
  return () => runInDurableObject(stub as DurableObjectStub<Game>, () => undo());
}

/** Stands in for a binding: `overrides` answer and every other property reaches the real one, so a test can lose, hold or count one reply. */
export function intercept<T extends object>(target: T, overrides: Record<string, unknown>): T {
  return new Proxy(target, { get(real, property) {
    if (typeof property === 'string' && Object.hasOwn(overrides, property)) return overrides[property];
    const value = Reflect.get(real, property);
    return typeof value === 'function' ? (...args: unknown[]) => Reflect.apply(value, real, args) : value;
  } });
}

/** Bindings whose Game stubs answer `overrides(game)` and forward the rest, for faulting what a Competition asks a Game. */
export const gamesAnswering = (overrides: (game: DurableObjectStub<Game>) => Record<string, unknown>) => ({ GAME }: Env): Partial<Env> => ({
  GAME: intercept(GAME, { get: (id: DurableObjectId) => { const game = GAME.get(id); return intercept(game, overrides(game)); } }),
});

/** A Game beside an isolated Competition must settle and verify its reservation there, not with the global one. */
export const settlesWith = (competition: Authority) => ({ COMPETITION }: Env): Partial<Env> => ({
  COMPETITION: intercept(COMPETITION, { get: () => COMPETITION.get(COMPETITION.idFromString(competition.id.toString())) }),
});

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

export async function enableRanked(stub: Authoritative): Promise<void> {
  await patchBindings(stub, { RANKED_ENABLED: 'true' });
}

/**
 * Queues two accounts on `competition` until it reserves their ranked Game. A pair that waits is aged past the match wait.
 * `holdAlarms` also stops the Game arming real alarms. `region` is the queue region both sides join with.
 */
export async function rankedPair(competition: Authority, [a, b]: readonly [Actor, Actor],
  options: { pool?: Pool; region?: string; holdAlarms?: boolean } = {}) {
  const { pool = 'blitz', region, holdAlarms: hold = false } = options;
  await competition.joinQueue(a, pool, region);
  let queue = await competition.joinQueue(b, pool, region);
  if (queue.status === 'queued') {
    await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec('UPDATE queue SET joined_at=? WHERE user_id IN (?,?)', Date.now() - 120_000, a.id, b.id));
    queue = await competition.queueStatus(b);
  }
  if (queue.status !== 'reserved' && queue.status !== 'live') throw new Error('not_paired');
  const game = env.GAME.get(env.GAME.idFromName(queue.gameId));
  if (hold) await holdAlarms(game, { RANKED_ENABLED: 'true' });
  else await enableRanked(game);
  const initial = await game.snapshot(a);
  return { game, initial, white: initial.white.id === a.id ? a : b, black: initial.white.id === a.id ? b : a };
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
 * `bindings` are laid over the object's private env bindings.
 */
export async function holdAlarms(stub: Authoritative, bindings: Bindings = {}): Promise<void> {
  await runInDurableObject(stub as DurableObjectStub<Game>, async (instance, state) => {
    swapBindings(instance, bindings);
    internals(instance).schedule = async () => {};
    await state.storage.deleteAlarm();
  });
}

/** A Game that must not deliver its own result, so the test delivers each one and can inject a lost reply. */
export async function holdDelivery(game: DurableObjectStub<Game>, bindings: Bindings = {}): Promise<void> {
  await holdAlarms(game, bindings);
  await runInDurableObject(game, instance => { internals(instance).flush = async () => {}; });
}

/** An isolated Competition whose alarm is held. Pass `existing` to reconfigure one after a restart. */
export async function heldCompetition(bindings: Bindings = {}, existing?: Authority): Promise<Authority> {
  const stub = existing ?? env.COMPETITION.get(env.COMPETITION.idFromName(crypto.randomUUID()));
  await holdAlarms(stub, bindings);
  return stub;
}

/** Stops arena control from creating future events, so a test owns every event row. Arena control is private. */
export async function holdArenaEvents(stub: Authority): Promise<void> {
  await runInDurableObject(stub, instance => { internals(instance).arenas.ensure = () => {}; });
}

/** Counts how often a path re-arms the alarm without arming one, to prove an unchanged request leaves the alarm alone. */
export const spyOnSchedule = (instance: object) => vi.spyOn(internals(instance), 'schedule').mockResolvedValue();

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
    const result = privates(instance).result(stored);
    state.storage.sql.exec('INSERT INTO result_delivery(id,value) VALUES(1,?)', JSON.stringify({ result, attempts: 0, nextAttemptAt: flaggedAt }));
  });
  return { ...setup, flaggedAt };
}
