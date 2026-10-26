import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CapacityAccountFixtures } from '../src/server/capacity-fixtures';
import { CapacityIntentLedger } from '../src/server/capacity-intents';
import { CapacityNativeMeter } from '../src/server/capacity-meter';
import { CapacityProtocol, type CapacityProtocolHooks } from '../src/server/capacity-protocol';
import { capacityStepResponse } from '../src/server/capacity-qualification';
import type { Competition } from '../src/server/competition';
import type { Env } from '../src/server/env';
import { currentActor, type Actor, type AuthEnv } from '../src/server/auth';
import type { ArenaMe } from '../src/shared/arenas';
import { capacityAccountId, capacityEventId, capacityIntentStepIndex, capacityStep } from '../src/shared/capacity-corpus';
import { capacityFixtureManifest } from './capacity-fixtures';
import { ARENA_POLICY } from '../src/server/arena-policy';

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
afterEach(() => vi.restoreAllMocks());

const primaryAuthEnv: AuthEnv = { ...env, AUTH_BASE_URL: 'https://chess.ejmlabs.com', LOCAL_DEV: 'false' };

async function primaryStep(protocol: CapacityProtocol, request: Request, index: number) {
  return protocol.step(request, index, capacityStep(index).action === 'register' ? null : (await currentActor(request, primaryAuthEnv))!);
}

async function fixture<R>(work: (context: {
  create(authority: Partial<Competition>, game?: unknown): CapacityProtocol;
  native: Competition;
  fixtures: CapacityAccountFixtures;
  hooks: CapacityProtocolHooks;
  intents: CapacityIntentLedger;
  meter: CapacityNativeMeter;
  sql: SqlStorage;
  eventId: string;
  request(cookie?: string): Request;
}) => Promise<R>): Promise<R> {
  const stub = env.COMPETITION.get(env.COMPETITION.idFromName(`capacity-protocol-${crypto.randomUUID()}`));
  return runInDurableObject(stub, async (object, state) => {
    const internal = object as unknown as { env: Env };
    internal.env = { ...internal.env, AUTH_BASE_URL: primaryAuthEnv.AUTH_BASE_URL, LOCAL_DEV: 'false' };
    const manifest = capacityFixtureManifest(Date.UTC(2026, 9, 25, 17, 50));
    vi.spyOn(Date, 'now').mockReturnValue(manifest.earliestArmAt + 5_000);
    const fixtures = new CapacityAccountFixtures(env.DB, state.storage.sql, env, manifest);
    const meter = new CapacityNativeMeter();
    const sql = meter.sql(state.storage.sql);
    const createIntents = () => new CapacityIntentLedger(sql, run => state.storage.transactionSync(run), manifest);
    const intents = createIntents();
    const hooks: CapacityProtocolHooks = {
      retireGame: async () => { throw new Error('unexpected_retirement'); },
      observeGame: async () => { throw new Error('unexpected_game_observation'); },
      fault: async () => { throw new Error('capacity_native_fault_unqualified'); },
    };
    return work({ native: object as unknown as Competition, fixtures, hooks, intents, meter, sql, eventId: capacityEventId(0, manifest.earliestArmAt),
      request: cookie => new Request(`https://${manifest.host}/capacity/step/0`, { headers: cookie ? { Cookie: cookie } : {} }),
      create: (authority, game) => new CapacityProtocol({ authority: new Proxy(authority, { get(target, key) {
        if (key === 'authenticateArenaRegistration') return object.authenticateArenaRegistration.bind(object);
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } }) as Competition,
        env: { ...env, GAME: game ?? { idFromName() { throw new Error('unexpected_game_lookup'); } } } as unknown as Env,
        sql, transactionSync: run => state.storage.transactionSync(run), manifest, fixtures, intents: createIntents(), hooks }),
    });
  });
}

describe('fixed private capacity protocol safeguards', () => {
  it('authenticates registration behind the native guard and rejects forged fixture identities', async ({ task }) => {
    await fixture(async ({ create, fixtures, request, sql }) => {
      const credential = await fixtures.prepare(0);
      const actor = await currentActor(request(credential.cookie), primaryAuthEnv);
      if (!actor) throw new Error('fixture_primary_actor_missing');
      const registerArena = vi.fn(async () => ({ ok: false as const,
        error: { status: 429, code: 'ARENA_RETRY', message: 'Retry registration.' } }));
      const protocol = create({ registerArena });
      const forged = { ...actor, id: capacityAccountId(1) };
      expect(await protocol.step(request(), 0, forged)).toMatchObject({ accepted: false, httpStatus: 401, code: 'SIGN_IN_REQUIRED' });
      const other = await fixtures.prepare(1);
      await expect(protocol.step(request(other.cookie), 0, actor)).rejects.toThrow('capacity_session_invalid');
      sql.exec('UPDATE capacity_fixture_accounts SET ready=0 WHERE account_index=0');
      await expect(protocol.step(request(credential.cookie), 0, actor)).rejects.toThrow('capacity_session_invalid');
      sql.exec('UPDATE capacity_fixture_accounts SET ready=1 WHERE account_index=0');
      const start = performance.now();
      expect(await protocol.step(request(credential.cookie), 0, forged)).toMatchObject({ accepted: false, httpStatus: 429, code: 'ARENA_RETRY' });
      const elapsedMs = performance.now() - start;
      const { id, name, isAnonymous, sessionId, sessionExpiresAt } = actor;
      expect(registerArena).toHaveBeenCalledExactlyOnceWith({ id, name, isAnonymous, sessionId, sessionExpiresAt }, expect.any(String));
      (task.meta as Record<string, unknown>).qualification = { kind: 'native-guarded-registration-auth', elapsedMs,
        scope: 'Real cookie and fixture boundary; no provider latency or capacity claim.' };
    });
  });

  it('preserves the native registration throttle through its HTTP response', async () => {
    await fixture(async ({ create, native, fixtures, request }) => {
      const internal = native as unknown as { env: Env; schedule(): Promise<void> };
      internal.env = { ...internal.env, ARENAS_ENABLED: 'true', ARENA_ENTRANT_LIMIT: '101', TOURNAMENTS_ENABLED: 'false' };
      internal.schedule = async () => {};
      const protocol = create(native);
      const denied = 300 + ARENA_POLICY.registrationBurst;
      for (let index = 300; index < denied; index++) {
        const credential = await fixtures.prepare(index);
        expect(await primaryStep(protocol, request(credential.cookie), index)).toMatchObject({ accepted: true });
      }
      const credential = await fixtures.prepare(denied);
      const reply = await primaryStep(protocol, request(credential.cookie), denied);
      const milestone = Date.now();
      const nativeTiming = { sentAt: milestone, enteredAt: milestone, ticketAt: milestone, claimedAt: milestone,
        methodFinishedAt: milestone, returningAt: milestone, receivedAt: milestone };
      const response = capacityStepResponse(reply, { authMs: 1, authorityMs: 2, native: nativeTiming });
      expect(response.status).toBe(429);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(JSON.parse(response.headers.get('X-Capacity-Native-Timing')!)).toEqual(nativeTiming);
      expect(await response.json()).toMatchObject({ index: denied, accepted: false,
        acceptedAt: null, httpStatus: 429, code: 'ARENA_RETRY' });
      expect(() => capacityStepResponse(reply, { authMs: 1, authorityMs: 2,
        native: { ...nativeTiming, returningAt: milestone - 1 } })).toThrow('capacity_native_metrics_unavailable');
      vi.mocked(Date.now).mockReturnValue(Date.now() + Math.ceil(1_000 / ARENA_POLICY.registrationRate));
      const retried = await primaryStep(protocol, request(credential.cookie), 10_000 + denied);
      expect(retried).toMatchObject({ accepted: true });
      expect(capacityStepResponse(retried).status).toBe(200);
    });
  });

  it('never redispatches an issued registration after its native reply is lost', async () => {
    await fixture(async ({ create, fixtures, request }) => {
      const credential = await fixtures.prepare(0);
      let dispatches = 0;
      const authority = { registerArena: async () => { dispatches++; throw new Error('native_registration_reply_lost'); } };
      await expect(primaryStep(create(authority), request(credential.cookie), 0)).rejects.toThrow('native_registration_reply_lost');
      expect(await primaryStep(create(authority), request(credential.cookie), 0)).toMatchObject({
        accepted: false, acceptedAt: null, code: 'capacity_step_already_issued',
      });
      expect(dispatches).toBe(1);
    });
  });

  it('rejects an unresolved intent before looking up a Game', async () => {
    await fixture(async ({ create, request }) => {
      await expect(primaryStep(create({}), request(), capacityIntentStepIndex(0, 4)))
        .rejects.toThrow('capacity_binding_unresolved');
    });
  });

  it('authenticates the actual white seat for commands and retirement', async () => {
    await fixture(async ({ create, fixtures, hooks, intents, eventId, request }) => {
      const queued = await fixtures.prepare(501);
      const white = await fixtures.prepare(534);
      intents.reserve(1);
      const binding = intents.bind(1, { eventId, gameId: crypto.randomUUID(), reservationId: crypto.randomUUID(),
        whiteId: capacityAccountId(534), blackId: capacityAccountId(1_078), status: 'live' });
      const actors: string[] = [];
      const game = { idFromName: (name: string) => name, get(id: string) {
        expect(id).toBe(binding.gameId);
        return { command: async (actor: Actor) => {
          actors.push(actor.id);
          return { ok: true, receipt: { acceptedAt: Date.now() } };
        } };
      } };
      const protocol = create({}, game);
      const index = capacityIntentStepIndex(1, 4);
      await expect(primaryStep(protocol, request(queued.cookie), index)).rejects.toThrow('capacity_session_invalid');
      expect(actors).toEqual([]);
      expect(await primaryStep(protocol, request(white.cookie), index)).toMatchObject({ accepted: true });
      expect(actors).toEqual([binding.whiteId]);
      const retired: string[] = [];
      hooks.retireGame = async id => { retired.push(id); return true; };
      const retirement = capacityIntentStepIndex(1, 12);
      await expect(primaryStep(protocol, request(queued.cookie), retirement)).rejects.toThrow('capacity_session_invalid');
      expect(retired).toEqual([]);
      expect(await primaryStep(protocol, request(white.cookie), retirement)).toMatchObject({ accepted: true });
      expect(retired).toEqual([binding.gameId]);
    });
  });

  it('records a successful pending observation without inventing a binding', async () => {
    await fixture(async ({ create, fixtures, intents, request }) => {
      const credential = await fixtures.prepare(2);
      intents.reserve(2);
      const protocol = create({});
      for (const within of [2, 3]) {
        const observed = await primaryStep(protocol, request(credential.cookie), capacityIntentStepIndex(2, within));
        expect(observed).toMatchObject({ accepted: true, acceptedAt: Date.now(), code: 'capacity_binding_unresolved' });
        expect(observed.binding).toBeUndefined();
      }
      expect(intents.binding(2)).toBeNull();
    });
  });

  it('dispatches the second queue actor when native discovery already bound its ordinal', async () => {
    await fixture(async ({ create, fixtures, intents, eventId, request }) => {
      const credential = await fixtures.prepare(1_503);
      intents.reserve(503);
      intents.bind(503, { eventId, gameId: crypto.randomUUID(), reservationId: crypto.randomUUID(),
        whiteId: capacityAccountId(503), blackId: capacityAccountId(504), status: 'live' });
      const actors: string[] = [];
      const protocol = create({ queueArena: async (actor, id) => {
        actors.push(actor.id);
        return { ok: true, value: { id, serverNow: Date.now() } as ArenaMe };
      } });
      const index = capacityIntentStepIndex(503, 1);
      expect(await primaryStep(protocol, request(credential.cookie), index)).toMatchObject({ accepted: true });
      expect(await primaryStep(protocol, request(credential.cookie), index)).toMatchObject({
        accepted: false, code: 'capacity_step_already_issued',
      });
      expect(actors).toEqual([capacityAccountId(1_503)]);
    });
  });

  it('discovers distinct native Games when the queue pairs actors from different ordinals', async () => {
    const measured = await fixture(async ({ create, native, fixtures, intents, meter, eventId, request }) => {
      const internal = native as unknown as { env: Env; schedule(): Promise<void> };
      internal.env = { ...internal.env, ARENAS_ENABLED: 'true', ARENA_ENTRANT_LIMIT: '4', TOURNAMENTS_ENABLED: 'false' };
      internal.schedule = async () => {};
      const protocol = create(native);
      const credentials = new Map<number, Awaited<ReturnType<typeof fixtures.prepare>>>();
      const queues: { rowsRead: number; rowsWritten: number }[] = [];
      for (const index of [1, 6, 1_001, 1_006]) {
        const credential = await fixtures.prepare(index);
        credentials.set(index, credential);
        expect(await primaryStep(protocol, request(credential.cookie), index)).toMatchObject({ accepted: true });
      }
      // Concurrent queue arrivals can put the two first actors in one native
      // Game. The requested ordinal does not control Arena's actual pairing.
      for (const [intent, within, account] of [[1, 0, 1], [6, 0, 6], [1, 1, 1_001], [6, 1, 1_006]]) {
        const before = meter.snapshot();
        expect(await primaryStep(protocol, request(credentials.get(account)!.cookie), capacityIntentStepIndex(intent, within)))
          .toMatchObject({ accepted: true });
        const after = meter.snapshot();
        queues.push({ rowsRead: after.doRowsRead - before.doRowsRead, rowsWritten: after.doRowsWritten - before.doRowsWritten });
      }
      expect(await primaryStep(protocol, request(credentials.get(1)!.cookie), capacityIntentStepIndex(1, 2)))
        .toMatchObject({ accepted: true, code: 'capacity_binding_unresolved' });
      intents.reserve(1_000);
      expect(intents.discover(1_000)).toBeNull();
      await native.maintenance();
      const actors = await Promise.all([1, 6, 1_001, 1_006].map(index =>
        fixtures.authenticate(request(credentials.get(index)!.cookie), index)));
      const reservations = await Promise.all(actors.map(actor => native.observeArenaReservation(actor, eventId)));
      expect(reservations[0]!.gameId).toBe(reservations[1]!.gameId);
      expect(reservations[2]!.gameId).toBe(reservations[3]!.gameId);
      expect(reservations[0]!.gameId).not.toBe(reservations[2]!.gameId);
      const beforeDiscovery = meter.snapshot();
      expect(intents.discover(1_000)).toBeNull();
      const afterDiscovery = meter.snapshot();
      const discovery = { rowsRead: afterDiscovery.doRowsRead - beforeDiscovery.doRowsRead,
        rowsWritten: afterDiscovery.doRowsWritten - beforeDiscovery.doRowsWritten };
      expect(discovery.rowsRead).toBeLessThanOrEqual(256);
      expect(discovery.rowsWritten).toBeLessThanOrEqual(16);
      const first = await primaryStep(protocol, request(credentials.get(1)!.cookie), capacityIntentStepIndex(1, 3));
      const second = await primaryStep(create(native), request(credentials.get(6)!.cookie), capacityIntentStepIndex(6, 2));
      expect(first.accepted && second.accepted).toBe(true);
      expect(new Set([first.binding!.gameId, second.binding!.gameId]))
        .toEqual(new Set(reservations.map(value => value!.gameId)));
      for (const bound of [first.binding!, second.binding!]) {
        const nativeReservation = reservations.find(value => value!.gameId === bound.gameId)!;
        expect(bound).toMatchObject({
          whiteAccountIndex: Number.parseInt(nativeReservation.whiteId.slice(-4), 36),
          blackAccountIndex: Number.parseInt(nativeReservation.blackId.slice(-4), 36),
        });
      }
      // A lost response and protocol reconstruction preserve the consumed
      // step and the original mapping. The second fixed observation reads it.
      expect(await primaryStep(create(native), request(credentials.get(1)!.cookie), capacityIntentStepIndex(1, 3)))
        .toMatchObject({ accepted: false, code: 'capacity_step_already_issued' });
      const repeated = await primaryStep(create(native), request(credentials.get(6)!.cookie), capacityIntentStepIndex(6, 3));
      expect(repeated.binding).toEqual(second.binding);
      expect(intents.discover(1)).toMatchObject(first.binding!);
      expect(await Promise.all(actors.map(actor => native.observeArenaReservation(actor, eventId)))).toEqual(reservations);
      const conflict = reservations.find(value => value!.gameId === first.binding!.gameId)!;
      expect(() => intents.bind(6, conflict)).toThrow('capacity_intent_binding_conflict');
      await expect(primaryStep(create(native), request(credentials.get(1)!.cookie), capacityIntentStepIndex(1, 4)))
        .rejects.toThrow('capacity_intent_ledger_fenced');
      return { discovery, queues };
    });
    console.info('capacity-binding-discovery-native-rows', JSON.stringify(measured));
  });
});
