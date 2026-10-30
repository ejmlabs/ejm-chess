import { env } from 'cloudflare:workers';
import { applyD1Migrations, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callCapacityNative, callCapacityWorkflow, CapacityNativeHost, CapacityNativeWrapper, type CapacityControl, type CapacityEnv, type CapacityNativeReply, type CapacityOperation } from '../src/server/capacity-native';
import { CapacityNativeMeter, CAPACITY_D1_READ_ATTEMPTS, CAPACITY_WARM_D1_READ_ROWS } from '../src/server/capacity-meter';
import { CapacityWorkflowLedger } from '../src/server/capacity-workflow';
import { CAPACITY_FREEZE_CALLBACK_WORK, CAPACITY_WORKFLOW_CANDIDATES } from '../src/server/capacity-work-plan';
import { CAPACITY_NATIVE_CANDIDATE_ENVELOPES, capacityRegistrationDiagnosticPlan } from '../src/server/capacity-candidate-plan';
import { authenticateCapacitySession, CapacityAccountFixtures, type CapacityAccountCredential } from '../src/server/capacity-fixtures';
import { CAPACITY_BINDING_HEADER, signCapacityBinding } from '../src/server/capacity-binding';
import { CAPACITY_CEILINGS, CapacityTicketCodec, emptyCapacityWork, type CapacityDispatch,
  type CapacityManifest, type CapacityShutdownReceipt, type CapacityTicket, type CapacityWorkUnits } from '../src/server/capacity-run';
import { Game } from '../src/server/game';
import { Competition } from '../src/server/competition';
import type { Actor } from '../src/server/auth';
import type { GameSnapshot } from '../src/shared/protocol';
import { activeGame, admitGameFixture, player } from './authority-helpers';
import { capacityFixtureManifest, capacityFixtureStart } from './capacity-fixtures';
import { capacityAccountId, capacityEventId, capacityIntent, capacityIntentStepIndex, capacityStep,
  CAPACITY_PREPARATION_BATCH_SIZE, CAPACITY_REGISTRATION_DIAGNOSTIC,
  capacityRegistrationDiagnosticSchedule, type CapacityStepReply } from '../src/shared/capacity-corpus';
import { ARENA_POLICY } from '../src/server/arena-policy';
import { capacityFailureFromError } from '../src/shared/capacity-failure';

const probeEnvelope = (): CapacityWorkUnits => ({ ...emptyCapacityWork(),
  nativeDoRequests: 1, doRowsRead: 100_000, doRowsWritten: 10_000, d1RowsRead: 10_000, d1RowsWritten: 10_000 });
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
afterEach(() => vi.restoreAllMocks());

function fixtureControl(manifest: CapacityManifest): CapacityControl {
  const codec = new CapacityTicketCodec(env.AUTH_SECRET);
  return { available: async () => true, charge: async () => true, linkGame: async () => true,
    begin: async (id, objectKey, operation, _envelope, mode = 'rpc') => codec.dispatch({
      runId: manifest.runId, manifestDigest: manifest.digest, id, objectKey, generation: 1, operation, mode }),
    complete: async () => true, prepareRetirement: async () => null, confirmRetirement: async () => false };
}
async function fixtureTicket(control: CapacityControl, objectKey: string, operation: CapacityOperation) {
  const ticket = await control.begin(crypto.randomUUID(), objectKey, operation, probeEnvelope());
  if (!ticket) throw new Error('fixture_ticket_denied');
  return ticket;
}
function fixtureEnv(): CapacityEnv {
  // The focused Game adapter probe does not measure the receiving Competition.
  // Preserve that native behavior behind a ticket reply in this local fixture.
  const competition = new Proxy(env.COMPETITION, { get(namespace, key) {
    if (key === 'get') return (id: DurableObjectId) => {
      const stub = namespace.get(id) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      return new Proxy({}, { get(_target, member) {
        if (typeof member !== 'string') return;
        return async (...args: unknown[]) => {
          const ticket = args.pop() as CapacityTicket<CapacityDispatch>;
          const value = await stub[member](...args);
          return { ticketId: ticket.id, value, actual: emptyCapacityWork(),
            drained: { pendingNative: 0, alarm: false, sockets: 0, alarmPossible: false, socketPossible: false } };
        };
      } });
    };
    const value = Reflect.get(namespace, key, namespace);
    return typeof value === 'function' ? value.bind(namespace) : value;
  } });
  return { ...env, COMPETITION: competition } as unknown as CapacityEnv;
}

async function alarmFixture(kind: 'Game' | 'Competition', state: DurableObjectState) {
  const manifest = capacityFixtureManifest(), control = fixtureControl(manifest);
  const envelope = { ...probeEnvelope(), doStorageBytes: 1024 ** 2, d1StorageBytes: 512 * 1024 ** 2 };
  const workflow = { maximumEvents: 8, maximumEventWork: envelope,
    envelope: { ...envelope, nativeDoRequests: 8, doRowsRead: 800_000, doRowsWritten: 80_000,
      d1RowsRead: 80_000, d1RowsWritten: 80_000 } };
  const method = kind === 'Game' ? 'status' : 'health';
  const envelopes = { [`${kind}.${method}`]: envelope, [`${kind}.alarm`]: envelope };
  const create = () => new CapacityNativeWrapper<Game | Competition>(state, fixtureEnv(), kind,
    { manifest, envelopes, control, workflows: { Game: workflow, Competition: workflow } });
  const ticket = await new CapacityTicketCodec(env.AUTH_SECRET).dispatch({ runId: manifest.runId,
    manifestDigest: manifest.digest, id: crypto.randomUUID(),
    objectKey: kind === 'Game' ? `game:${state.id.name}` : 'competition',
    generation: 1, operation: `${kind}.workflow`, mode: 'workflow' });
  await create().rpc(method, [], ticket);
  return { create, ticket, workflow, envelope, control };
}

/** Fixed primary accounts and normal initialization, without a full load run. */
async function readyWorkflowFixture(state: DurableObjectState, intentIndex = 1_000) {
  const manifest = capacityFixtureManifest(Math.floor(Date.now() / 60_000) * 60_000);
  const control = fixtureControl(manifest), intent = capacityIntent(intentIndex);
  const fixtures = new CapacityAccountFixtures(env.DB, state.storage.sql, env, manifest);
  const accounts: { index: number; credential: CapacityAccountCredential; actor: Actor }[] = [];
  for (const index of intent.queueAccounts) {
    const credential = await fixtures.prepare(index);
    const request = new Request(`https://${manifest.host}/capacity/account/${index}`, { headers: { Cookie: credential.cookie } });
    accounts.push({ index, credential, actor: await fixtures.authenticate(request, index) });
  }
  const envelope = { ...probeEnvelope(), doStorageBytes: 1024 ** 2, d1StorageBytes: 512 * 1024 ** 2 };
  const workflow = { maximumEvents: 8, maximumEventWork: envelope,
    envelope: { ...envelope, nativeDoRequests: 8, doRowsRead: 800_000, doRowsWritten: 80_000,
      d1RowsRead: 80_000, d1RowsWritten: 80_000 } };
  const envelopes = Object.fromEntries(['init', 'qualificationReadyCold', 'qualificationReady', 'alarm'].map(method =>
    [`Game.${method}`, envelope])) as Record<CapacityOperation, CapacityWorkUnits>;
  const create = () => new CapacityNativeWrapper<Game>(state, fixtureEnv(), 'Game',
    { manifest, envelopes, control, workflows: { Game: workflow, Competition: workflow } });
  const ticket = await new CapacityTicketCodec(env.AUTH_SECRET).dispatch({ runId: manifest.runId,
    manifestDigest: manifest.digest, id: crypto.randomUUID(), objectKey: `game:${state.id.name}`,
    generation: 1, operation: 'Game.workflow', mode: 'workflow' });
  const eventId = capacityEventId(intent.eventIndex, manifest.earliestArmAt), reservationId = crypto.randomUUID();
  const proof = await signCapacityBinding({ intentIndex, eventIndex: intent.eventIndex, eventId,
    gameId: state.id.name!, reservationId, whiteId: accounts[0].actor.id, blackId: accounts[1].actor.id,
    whiteAccountIndex: accounts[0].index, blackAccountIndex: accounts[1].index,
    generation: ticket.generation, workflowNonce: ticket.id }, manifest, env.AUTH_SECRET);
  const request = (index: number) => {
    const actor = capacityStep(index).actor;
    if (actor.kind !== 'bound-seat') throw new Error('fixture_bound_seat_required');
    return new Request(`https://${manifest.host}/capacity/step/${index}`, {
      headers: { Cookie: accounts[actor.role === 'black' ? 1 : 0].credential.cookie, [CAPACITY_BINDING_HEADER]: proof },
    });
  };
  const wrapper = create();
  await wrapper.rpc('init', [{ id: state.id.name!, format: 'blitz', rated: false,
    white: accounts[0].actor, black: accounts[1].actor, reservationId,
    tournament: { id: eventId, format: 'arena-v1', round: 1, deadlineAt: Date.now() + 600_000 } }], ticket);
  const whiteStep = capacityIntentStepIndex(intentIndex, 4), blackStep = capacityIntentStepIndex(intentIndex, 5);
  const first = await wrapper.rpc<CapacityStepReply>('qualificationStep', [request(whiteStep), whiteStep], ticket);
  expect(first.value.accepted).toBe(true);
  return { create, wrapper, request, blackStep, ticket, control, envelope };
}

/** Include meters whose native work throws before it can take a snapshot. */
function observeAlarmMeters() {
  const meters = new Set<CapacityNativeMeter>();
  const originalSql = CapacityNativeMeter.prototype.sql;
  const originalAlarm = CapacityNativeMeter.prototype.alarm;
  vi.spyOn(CapacityNativeMeter.prototype, 'sql').mockImplementation(function (this: CapacityNativeMeter, sql) {
    meters.add(this); return originalSql.call(this, sql);
  });
  vi.spyOn(CapacityNativeMeter.prototype, 'alarm').mockImplementation(function (this: CapacityNativeMeter, kind, run) {
    meters.add(this); return originalAlarm.call(this, kind, run);
  });
  return () => [...meters].map(meter => meter.snapshot());
}

describe('private native capacity adapter', () => {
  it('keeps cold registration claims ahead of overlapping warm blocks across clean reincarnation', async ({ task }) => {
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    const observed = await runInDurableObject(game, async (_instance, state) => {
      const start = capacityFixtureStart();
      vi.spyOn(Date, 'now').mockReturnValue(start + 8_000);
      const manifest = capacityFixtureManifest(start), control = fixtureControl(manifest);
      const create = () => new CapacityNativeHost<Competition>(state, fixtureEnv(), 'Competition', manifest, control,
        CAPACITY_NATIVE_CANDIDATE_ENVELOPES, { Game: CAPACITY_WORKFLOW_CANDIDATES.regular,
          Competition: CAPACITY_WORKFLOW_CANDIDATES.competition });
      const ticket = await new CapacityTicketCodec(env.AUTH_SECRET).dispatch({ runId: manifest.runId,
        manifestDigest: manifest.digest, id: crypto.randomUUID(), objectKey: 'competition', generation: 1,
        operation: 'Competition.workflow', mode: 'workflow' });
      const preparer = create(), credentials = new Map<number, CapacityAccountCredential>();
      for (const index of [0, 16, 17, 32, 33]) {
        credentials.set(index, (await preparer.invoke<CapacityAccountCredential>(ticket,
          'prepareQualificationAccount', [index])).value);
      }
      const original = Competition.prototype.authenticateArenaRegistration;
      const authenticate = vi.spyOn(Competition.prototype, 'authenticateArenaRegistration');
      const register = vi.spyOn(Competition.prototype, 'registerArena');
      const replies: CapacityNativeReply<CapacityStepReply>[] = [];
      // Each fresh wrapper starts with no native product object. Hold its real
      // authenticated first call while a warm call reaches the same32-slot block.
      for (const first of [16, 32]) {
        const host = create();
        let entered!: () => void, release!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        const held = new Promise<void>(resolve => { release = resolve; });
        authenticate.mockImplementationOnce(async function (this: Competition, request) {
          const actor = await original.call(this, request);
          entered();
          await held;
          return actor;
        });
        const offer = (index: number) => host.invoke<CapacityStepReply>(ticket, 'qualificationStep', [
          new Request(`https://${manifest.host}/capacity/step/${index}`,
            { headers: { Cookie: credentials.get(index)!.cookie } }), index, null,
        ]);
        const cold = offer(first);
        await Promise.race([started, cold.then(() => { throw new Error('cold_registration_did_not_reach_auth_hold'); })]);
        try { replies.push(await offer(first + 1)); }
        finally { release(); }
        replies.push(await cold);
        expect(replies.slice(-2).map(reply => reply.value.accepted)).toEqual([true, true]);
        expect(state.storage.sql.exec('SELECT unresolved,stopped FROM capacity_wrapper_workflow WHERE id=1').one())
          .toEqual({ unresolved: 0, stopped: 0 });
      }
      const replay = create();
      const duplicate = await replay.invoke<CapacityStepReply>(ticket, 'qualificationStep', [
        new Request(`https://${manifest.host}/capacity/step/16`,
          { headers: { Cookie: credentials.get(16)!.cookie } }), 16, null,
      ]);
      expect(duplicate.value).toMatchObject({ accepted: false, code: 'capacity_step_already_issued' });
      expect(register).toHaveBeenCalledTimes(4);
      expect(replies.every(reply => !reply.usage.uncertain && reply.usage.unresolvedD1 === 0)).toBe(true);
      await state.storage.deleteAlarm();
      return replies.map(reply => ({ accepted: reply.value.accepted, usage: reply.usage }));
    });
    (task.meta as Record<string, unknown>).qualification = { scenario: 'cold-registration-overlap-and-reincarnation', observed,
      scope: 'Real local cookie auth and native SQLite overlap. No provider throughput claim or recovery of interrupted permits.' };
  });

  it('replays the five failed provider account confirmations after native busy denials', async ({ task }) => {
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    const observed = await runInDurableObject(game, async (_instance, state) => {
      const start = capacityFixtureStart();
      vi.spyOn(Date, 'now').mockReturnValue(start + 8_000);
      const manifest = capacityFixtureManifest(start), control = fixtureControl(manifest);
      const host = new CapacityNativeHost<Competition>(state, fixtureEnv(), 'Competition', manifest, control,
        CAPACITY_NATIVE_CANDIDATE_ENVELOPES, { Game: CAPACITY_WORKFLOW_CANDIDATES.regular,
          Competition: CAPACITY_WORKFLOW_CANDIDATES.competition });
      const ticket = await new CapacityTicketCodec(env.AUTH_SECRET).dispatch({ runId: manifest.runId,
        manifestDigest: manifest.digest, id: crypto.randomUUID(), objectKey: 'competition', generation: 1,
        operation: 'Competition.workflow', mode: 'workflow' });
      await host.invoke(ticket, 'prepareQualificationAccount', [0]);
      const credentials = new Map<number, CapacityAccountCredential>();
      for (const first of [800, 832]) {
        const prepared = await host.invoke<CapacityAccountCredential[]>(ticket, 'prepareQualificationAccounts', [first]);
        for (const credential of prepared.value) credentials.set(credential.accountIndex, credential);
      }
      const authority = (host as unknown as { native: { registrationAuthentication: {
        run<T>(operation: () => Promise<T>): Promise<T>;
      } } }).native;
      let release!: () => void;
      const barrier = new Promise<void>(resolve => { release = resolve; });
      const held = Array.from({ length: ARENA_POLICY.registrationAuthConcurrency }, () =>
        authority.registrationAuthentication.run(() => barrier));
      const replies: { index: number; accepted: boolean; httpStatus?: number; code?: string }[] = [];
      const offer = async (index: number, account: number) => {
        const request = new Request(`https://${manifest.host}/capacity/step/${index}`,
          { headers: { Cookie: credentials.get(account)!.cookie } });
        const reply = await host.invoke<CapacityStepReply>(ticket, 'qualificationStep', [request, index, null]);
        replies.push({ index, accepted: reply.value.accepted, httpStatus: reply.value.httpStatus, code: reply.value.code });
        return reply;
      };
      try {
        for (const first of [829, 6_829]) for (let offset = 0; offset < 5; offset++) {
          expect((await offer(first + offset, 829 + offset)).value)
            .toMatchObject({ accepted: false, httpStatus: 429, code: 'ARENA_RETRY' });
        }
      } finally { release(); await Promise.all(held); }
      for (let offset = 0; offset < 5; offset++) {
        const reply = await offer(10_829 + offset, 829 + offset);
        expect(reply.value.accepted).toBe(true);
        expect(reply.usage.uncertain).toBe(false);
        expect(reply.usage.unresolvedD1).toBe(0);
      }
      return replies;
    });
    (task.meta as Record<string, unknown>).qualification = { scenario: 'full22-failed-account-confirmations', observed,
      scope: 'Five exact account selectors, ten native busy denials, five real cookie-authenticated confirmations. Busy slots use a test-only barrier. Does not reproduce the provider exception or its retained authority state.' };
  });

  it('meters native registration cookie auth and account limits inside the unchanged warm envelope', async ({ task }) => {
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    const observed = await runInDurableObject(game, async (_instance, state) => {
      const start = capacityFixtureStart();
      const now = vi.spyOn(Date, 'now').mockReturnValue(start + 8_000);
      const manifest = capacityFixtureManifest(start), control = fixtureControl(manifest);
      const host = new CapacityNativeHost<Competition>(state, fixtureEnv(), 'Competition', manifest, control,
        CAPACITY_NATIVE_CANDIDATE_ENVELOPES, { Game: CAPACITY_WORKFLOW_CANDIDATES.regular,
          Competition: CAPACITY_WORKFLOW_CANDIDATES.competition });
      const ticket = await new CapacityTicketCodec(env.AUTH_SECRET).dispatch({ runId: manifest.runId,
        manifestDigest: manifest.digest, id: crypto.randomUUID(), objectKey: 'competition', generation: 1,
        operation: 'Competition.workflow', mode: 'workflow' });
      await host.invoke(ticket, 'prepareQualificationAccount', [0]);
      const prepared: CapacityAccountCredential[] = [];
      for (let first = 0; first <= ARENA_POLICY.registrationBurst; first += CAPACITY_PREPARATION_BATCH_SIZE) {
        prepared.push(...(await host.invoke<CapacityAccountCredential[]>(ticket, 'prepareQualificationAccounts', [first])).value);
      }
      const replies: CapacityNativeReply<CapacityStepReply>[] = [];
      for (let index = 0; index <= ARENA_POLICY.registrationBurst; index++) {
        const request = new Request(`https://${manifest.host}/capacity/step/${index}`,
          { headers: { Cookie: prepared[index].cookie } });
        const reply = await host.invoke<CapacityStepReply>(ticket, 'qualificationStep', [request, index, null]);
        expect(reply.value).toMatchObject(index < ARENA_POLICY.registrationBurst ? { accepted: true }
          : { accepted: false, httpStatus: 429, code: 'ARENA_RETRY' });
        expect(reply.usage.uncertain).toBe(false);
        expect(reply.usage.unresolvedD1).toBe(0);
        expect(reply.usage.d1RowsRead + reply.usage.d1RetryReadSurcharge)
          .toBeLessThanOrEqual(CAPACITY_NATIVE_CANDIDATE_ENVELOPES['Competition.qualificationRegister'].d1RowsRead);
        expect(reply.usage.d1RowsWritten)
          .toBeLessThanOrEqual(CAPACITY_NATIVE_CANDIDATE_ENVELOPES['Competition.qualificationRegister'].d1RowsWritten);
        replies.push(reply);
      }
      // The first product auth reused fixture schema discovery, and every
      // admitted or token-denied call charged its fresh account request write.
      expect(Math.max(...replies.map(reply => reply.usage.d1RowsRead))).toBeLessThan(128);
      expect(replies.every(reply => reply.usage.d1RowsWritten > 0)).toBe(true);
      now.mockReturnValue(Date.now() + Math.ceil(1_000 / ARENA_POLICY.registrationRate));
      const index = ARENA_POLICY.registrationBurst + 1;
      const request = new Request(`https://${manifest.host}/capacity/step/${index}`,
        { headers: { Cookie: prepared.value[index].cookie } });
      expect((await host.invoke<CapacityStepReply>(ticket, 'qualificationStep', [request, index, null])).value.accepted).toBe(true);
      return replies.map(reply => ({ accepted: reply.value.accepted, usage: reply.usage }));
    });
    (task.meta as Record<string, unknown>).qualification = { scenario: 'native-registration-auth-envelope', observed,
      scope: 'Real local package auth, primary account writes and arena entry. No provider latency or capacity claim.' };
  });

  it('prepays a real retry burst once and retains its slots after a lost reply and cold restart', async ({ task }) => {
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    const result = await runInDurableObject(game, async (_instance, state) => {
      const start = capacityFixtureStart();
      vi.spyOn(Date, 'now').mockReturnValue(start + 8_000);
      const manifest = capacityFixtureManifest(start), control = fixtureControl(manifest);
      const create = () => new CapacityNativeHost<Competition>(state, fixtureEnv(), 'Competition', manifest, control,
        CAPACITY_NATIVE_CANDIDATE_ENVELOPES, { Game: CAPACITY_WORKFLOW_CANDIDATES.regular,
          Competition: CAPACITY_WORKFLOW_CANDIDATES.competition });
      const host = create();
      const ticket = await new CapacityTicketCodec(env.AUTH_SECRET).dispatch({ runId: manifest.runId,
        manifestDigest: manifest.digest, id: crypto.randomUUID(), objectKey: 'competition', generation: 1,
        operation: 'Competition.workflow', mode: 'workflow' });
      await host.invoke(ticket, 'prepareQualificationAccount', [0]);
      const credentials: CapacityAccountCredential[] = [];
      for (let first = 0; first < 192; first += 32) {
        credentials.push(...(await host.invoke<CapacityAccountCredential[]>(ticket, 'prepareQualificationAccounts', [first])).value);
      }
      const offer = async (index: number) => {
        const request = new Request(`https://${manifest.host}/capacity/step/${index}`, {
          headers: { Cookie: credentials[index].cookie } });
        const actor = await authenticateCapacitySession(env.DB, env, manifest, request, index);
        return host.invoke<CapacityStepReply>(ticket, 'qualificationStep', [request, index, actor]);
      };
      const original = Competition.prototype.registerArena;
      const register = vi.spyOn(Competition.prototype, 'registerArena');
      const retryWrites: number[] = [];
      for (let index = 0; index < 160; index++) {
        const reply = await offer(index);
        expect(reply.value).toMatchObject(index < ARENA_POLICY.registrationBurst ? { accepted: true } : {
          accepted: false, httpStatus: 429, code: 'ARENA_RETRY' });
        expect(reply.usage).toMatchObject({ uncertain: false, unresolvedD1: 0 });
        if (index >= 128) retryWrites.push(reply.usage.doRowsWritten);
      }
      expect(retryWrites.slice(1, 31)).toEqual(Array(30).fill(0));
      expect(retryWrites[31]).toBe(1);
      expect(retryWrites.reduce((sum, writes) => sum + writes, 0)).toBe(4);
      expect((await offer(128)).value).toMatchObject({ accepted: false, code: 'capacity_step_already_issued' });
      expect(register).toHaveBeenCalledTimes(160);
      register.mockImplementationOnce(async function (this: Competition, ...args) {
        await original.apply(this, args);
        throw new Error('native_registration_reply_lost');
      });
      await expect(offer(160)).rejects.toThrow('"stage":"arena-register"');
      expect((await offer(160)).value).toMatchObject({ accepted: false, code: 'capacity_step_already_issued' });
      expect(register).toHaveBeenCalledTimes(161);
      const held = state.storage.sql.exec('SELECT events,unresolved,reserved,observed FROM capacity_wrapper_workflow').one();
      expect(held.unresolved).toBe(32);
      expect(JSON.parse(String(held.reserved)).nativeDoRequests).toBe(32);
      await expect(create().invoke(ticket, 'maintenance')).rejects.toThrow('capacity_workflow_unresolved');
      expect(state.storage.sql.exec('SELECT events,unresolved,reserved,observed FROM capacity_wrapper_workflow').one()).toEqual(held);
      await state.storage.deleteAlarm();
      return { accepted: ARENA_POLICY.registrationBurst, retryReplies: 160 - ARENA_POLICY.registrationBurst,
        measuredRetryBlock: { slots: 32, eventWrites: retryWrites,
        totalGuardWrites: retryWrites.reduce((sum, writes) => sum + writes, 0) }, heldSlots: held.unresolved };
    });
    (task.meta as Record<string, unknown>).registrationGuard = { ...result,
      scope: 'Real local Competition rate replies and native SQLite work. No provider latency or throughput claim.' };
  });

  it('keeps coalesced registration alarms inside their native event meters', async ({ task }) => {
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    const result = await runInDurableObject(game, async (_instance, state) => {
      const start = Math.ceil(Date.now() / 60_000) * 60_000;
      const now = vi.spyOn(Date, 'now').mockReturnValue(start + 8_000);
      const manifest: CapacityManifest = { ...capacityFixtureManifest(start),
        ...capacityRegistrationDiagnosticSchedule(start), profile: CAPACITY_REGISTRATION_DIAGNOSTIC.profile };
      const control = fixtureControl(manifest), plans = capacityRegistrationDiagnosticPlan();
      const ticket = await new CapacityTicketCodec(env.AUTH_SECRET).dispatch({ runId: manifest.runId,
        manifestDigest: manifest.digest, id: crypto.randomUUID(), objectKey: 'competition', generation: 1,
        operation: 'Competition.workflow', mode: 'workflow' });
      const host = new CapacityNativeHost<Competition>(state, fixtureEnv(), 'Competition', manifest, control,
        CAPACITY_NATIVE_CANDIDATE_ENVELOPES, plans.workflows);
      await host.invoke(ticket, 'prepareQualificationAccount', [0]);
      const batch = await host.invoke<CapacityAccountCredential[]>(ticket, 'prepareQualificationAccounts', [0]);
      const internal = Competition.prototype as unknown as {
        schedule(): Promise<void>; updateAlarm(completedThrough: number | null): Promise<void>;
      };
      const schedules = vi.spyOn(internal, 'schedule'), passes = vi.spyOn(internal, 'updateAlarm');
      const getAlarm = state.storage.getAlarm.bind(state.storage);
      let entered!: () => void, release!: () => void;
      const reading = new Promise<void>(resolve => { entered = resolve; });
      const paused = new Promise<void>(resolve => { release = resolve; });
      const read = vi.spyOn(state.storage, 'getAlarm').mockImplementationOnce(async () => {
        const value = await getAlarm(); entered(); await paused; return value;
      });
      now.mockReturnValue(start + 30_000);
      const began = performance.now();
      const pending = batch.value.map(async (account, index) => {
        const request = new Request(`https://${manifest.host}/capacity/step/${index}`, { headers: { Cookie: account.cookie } });
        const actor = await authenticateCapacitySession(env.DB, env, manifest, request, index);
        return host.invoke<CapacityStepReply>(ticket, 'qualificationStep', [request, index, actor]);
      });
      try {
        await reading;
        for (let wait = 0; schedules.mock.calls.length < batch.value.length && wait < 2_000; wait++) {
          await new Promise(resolve => setTimeout(resolve, 1));
        }
        expect(schedules.mock.calls.length).toBe(batch.value.length);
        release();
        const replies = await Promise.all(pending);
        expect(passes).toHaveBeenCalledTimes(2);
        expect(replies.every(reply => reply.value.accepted && !reply.usage.uncertain && reply.usage.unresolvedD1 === 0)).toBe(true);
        const elapsedMs = performance.now() - began;
        schedules.mockRestore(); passes.mockRestore(); read.mockRestore();
        now.mockReturnValue(start + 55_000);
        await host.invoke(ticket, 'maintenance');
        const stopped = await host.invoke<CapacityShutdownReceipt>(ticket, 'finishQualification');
        return { elapsedMs, registrations: replies.length, alarmPasses: 2, shutdown: stopped.value,
          closed: state.storage.sql.exec('SELECT closed,unresolved FROM capacity_wrapper_workflow WHERE id=1').one() };
      } finally {
        release(); await Promise.allSettled(pending);
        schedules.mockRestore(); passes.mockRestore(); read.mockRestore();
      }
    });
    expect(result.closed).toMatchObject({ closed: 1, unresolved: 0 });
    expect(result.shutdown.registration).toEqual({ fixtures: 32, entrants: 32, steps: 32, queues: 0 });
    (task.meta as Record<string, unknown>).registrationAlarmBurst = result;
  });

  it('closes the registration diagnostic from real accounts and rejects all Game work', async () => {
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    const result = await runInDurableObject(game, async (_instance, state) => {
      const start = Math.ceil(Date.now() / 60_000) * 60_000;
      const now = vi.spyOn(Date, 'now').mockReturnValue(start + 8_000);
      const manifest: CapacityManifest = { ...capacityFixtureManifest(start),
        ...capacityRegistrationDiagnosticSchedule(start), profile: CAPACITY_REGISTRATION_DIAGNOSTIC.profile };
      const control = fixtureControl(manifest), plans = capacityRegistrationDiagnosticPlan();
      const ticket = await new CapacityTicketCodec(env.AUTH_SECRET).dispatch({ runId: manifest.runId,
        manifestDigest: manifest.digest, id: crypto.randomUUID(), objectKey: 'competition', generation: 1,
        operation: 'Competition.workflow', mode: 'workflow' });
      const host = new CapacityNativeHost<Competition>(state, fixtureEnv(), 'Competition', manifest, control,
        CAPACITY_NATIVE_CANDIDATE_ENVELOPES, plans.workflows);
      for (const [method, args] of [['prepareQualificationAccounts', [256]], ['qualificationStep', [new Request('https://invalid.test'), 256]],
        ['qualificationSocket', [new Request('https://invalid.test'), 0]], ['queueArena', []]] as [string, unknown[]][]) {
        await expect(host.invoke(ticket, method, args)).rejects.toThrow('capacity_competition_method_invalid');
      }
      const gameHost = new CapacityNativeHost<Game>(state, fixtureEnv(), 'Game', manifest, control,
        CAPACITY_NATIVE_CANDIDATE_ENVELOPES, plans.workflows);
      await expect(gameHost.invoke(await fixtureTicket(control, `game:${state.id.name}`, 'Game.status'), 'status'))
        .rejects.toThrow('capacity_competition_method_invalid');
      await host.invoke(ticket, 'prepareQualificationAccount', [0]);
      const batch = await host.invoke<CapacityAccountCredential[]>(ticket, 'prepareQualificationAccounts', [0]);
      now.mockReturnValue(start + 30_000);
      const registered: CapacityStepReply[] = [];
      for (const index of [0, 6_000, 10_000]) {
        const request = new Request(`https://${manifest.host}/capacity/step/${index}`,
          { headers: { Cookie: batch.value[0].cookie } });
        const actor = await authenticateCapacitySession(env.DB, env, manifest, request, 0);
        registered.push((await host.invoke<CapacityStepReply>(ticket, 'qualificationStep', [request, index, actor])).value);
      }
      now.mockReturnValue(start + 55_000);
      await host.invoke(ticket, 'maintenance');
      const stopped = await host.invoke<CapacityShutdownReceipt>(ticket, 'finishQualification');
      return { registered, stopped, closed: state.storage.sql.exec('SELECT closed,unresolved FROM capacity_wrapper_workflow WHERE id=1').one() };
    });
    expect(result.registered.every(reply => reply.accepted)).toBe(true);
    expect(result.stopped.value).toMatchObject({ games: 0, socketWorkflows: 0, pendingNative: 0, gameOutboxes: 0,
      competitionOutboxes: 0, projectionBuilds: 0, unfinishedGames: 0, sockets: 0, alarms: 0,
      registration: { fixtures: 32, entrants: 1, steps: 3, queues: 0 } });
    expect(result.stopped.drained).toMatchObject({ pendingNative: 0, alarm: false, sockets: 0 });
    expect(result.closed).toMatchObject({ closed: 1, unresolved: 0 });
  });

  for (const kind of ['Game', 'Competition'] as const) {
    it(`freezes a cold interrupted ${kind} alarm before native work`, async ({ task }) => {
      const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
      await runInDurableObject(game, async (_instance, state) => {
        // The mock proves the requested abort policy, not platform eviction.
        const abort = vi.spyOn(state, 'abort').mockImplementation(() => undefined as never);
        const fixture = await alarmFixture(kind, state);
        new CapacityWorkflowLedger(state.storage.sql, run => state.storage.transactionSync(run), fixture.workflow)
          .claim(fixture.ticket, fixture.envelope, true);
        const before = state.storage.sql.exec('SELECT events,unresolved,reserved,observed FROM capacity_wrapper_workflow').one();
        const begin = vi.spyOn(fixture.control, 'begin'), complete = vi.spyOn(fixture.control, 'complete');
        const nativeAlarm = vi.spyOn(kind === 'Game' ? Game.prototype : Competition.prototype, 'alarm');
        const measurements = observeAlarmMeters();
        await state.storage.setAlarm(Date.now() + 120_000);
        await fixture.create().alarm();
        const [usage] = measurements();
        expect(measurements()).toHaveLength(1);
        expect(nativeAlarm).not.toHaveBeenCalled();
        expect(begin).not.toHaveBeenCalled();
        expect(complete).not.toHaveBeenCalled();
        expect(state.storage.sql.exec('SELECT events,unresolved,reserved,observed FROM capacity_wrapper_workflow').one()).toEqual(before);
        expect(state.storage.sql.exec('SELECT stopped FROM capacity_wrapper_workflow').one().stopped).toBe(1);
        expect(await state.storage.getAlarm()).toBeNull();
        expect(abort).toHaveBeenCalledExactlyOnceWith(expect.any(String), { retryAlarm: false });
        expect(usage).toMatchObject({ d1RowsRead: 0, d1RowsWritten: 0, unresolvedD1: 0, uncertain: false });
        expect(usage.doRowsRead).toBeLessThanOrEqual(CAPACITY_FREEZE_CALLBACK_WORK.doRowsRead / 2);
        expect(usage.doRowsWritten).toBeLessThanOrEqual(2);
        (task.meta as Record<string, unknown>).qualification = { kind, scenario: 'cold-interrupted-alarm', terminal: usage };
      });
    });

    it(`fences a failed ${kind} alarm and its scheduled tail after uncertain cleanup`, async ({ task }) => {
      const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
      await runInDurableObject(game, async (_instance, state) => {
        const abort = vi.spyOn(state, 'abort').mockImplementation(() => undefined as never);
        let failDeletion = false;
        const deleteAlarm = state.storage.deleteAlarm.bind(state.storage);
        vi.spyOn(state.storage, 'deleteAlarm').mockImplementation(async () => {
          if (failDeletion) { failDeletion = false; throw new Error('fixture_alarm_cleanup_uncertain'); }
          return deleteAlarm();
        });
        const fixture = await alarmFixture(kind, state);
        const before = state.storage.sql.exec('SELECT events,unresolved,reserved,observed FROM capacity_wrapper_workflow').one();
        const begin = vi.spyOn(fixture.control, 'begin'), complete = vi.spyOn(fixture.control, 'complete');
        const nativeAlarm = vi.spyOn(kind === 'Game' ? Game.prototype : Competition.prototype, 'alarm')
          .mockImplementation(async function (this: Game | Competition) {
            const nativeContext = (this as unknown as { ctx: DurableObjectState }).ctx;
            await nativeContext.storage.setAlarm(Date.now() + 120_000);
            throw new Error('fixture_native_alarm_failed');
          });
        const measurements = observeAlarmMeters();
        failDeletion = true;
        await expect(fixture.create().alarm()).rejects.toThrow('fixture_alarm_cleanup_uncertain');
        expect(nativeAlarm).toHaveBeenCalledTimes(1);
        expect(abort).toHaveBeenCalledExactlyOnceWith(expect.any(String), { retryAlarm: false });
        expect(await state.storage.getAlarm()).not.toBeNull();
        const held = state.storage.sql.exec('SELECT events,unresolved,reserved,observed,stopped FROM capacity_wrapper_workflow').one();
        expect(held).toMatchObject({ events: Number(before.events) + 1, unresolved: 1, observed: before.observed, stopped: 1 });
        expect(JSON.parse(String(held.reserved)).nativeDoRequests).toBe(1);
        expect(measurements()).toHaveLength(2);
        await fixture.create().alarm();
        const [admitted, cleanup, tail] = measurements();
        expect(measurements()).toHaveLength(3);
        expect(nativeAlarm).toHaveBeenCalledTimes(1);
        expect(state.storage.sql.exec('SELECT events,unresolved,reserved,observed,stopped FROM capacity_wrapper_workflow').one()).toEqual(held);
        expect(await state.storage.getAlarm()).toBeNull();
        expect(begin).not.toHaveBeenCalled();
        expect(complete).not.toHaveBeenCalled();
        expect(abort).toHaveBeenCalledTimes(2);
        expect(abort).toHaveBeenLastCalledWith(expect.any(String), { retryAlarm: false });
        expect(cleanup.uncertain).toBe(true);
        expect(tail.uncertain).toBe(false);
        for (const usage of [admitted, cleanup, tail]) {
          expect(usage).toMatchObject({ d1RowsRead: 0, d1RowsWritten: 0, unresolvedD1: 0 });
        }
        expect(cleanup.doRowsRead + tail.doRowsRead).toBeLessThanOrEqual(CAPACITY_FREEZE_CALLBACK_WORK.doRowsRead);
        expect(cleanup.doRowsWritten + tail.doRowsWritten).toBe(CAPACITY_FREEZE_CALLBACK_WORK.doRowsWritten);
        (task.meta as Record<string, unknown>).qualification = { kind, scenario: 'failed-alarm-with-scheduled-tail', admitted, cleanup, tail };
      });
    });
  }

  it('meters a prepaid workflow across native events and reconstruction without per-event controller RPCs', async () => {
    const { game, black, snapshot } = await activeGame();
    const ended = await game.command(black, { id: crypto.randomUUID(), type: 'resign', expectedVersion: snapshot.version });
    expect(ended.ok).toBe(true);
    await game.flush();
    await runInDurableObject(game, async (_instance, state) => {
      const manifest = capacityFixtureManifest(), control = fixtureControl(manifest);
      const begin = vi.spyOn(control, 'begin'), complete = vi.spyOn(control, 'complete');
      const envelope = { ...probeEnvelope(), doStorageBytes: 1024 ** 2, d1StorageBytes: 512 * 1024 ** 2 };
      const workflow = { maximumEvents: 4, maximumEventWork: envelope,
        envelope: { ...envelope, nativeDoRequests: 4, doRowsRead: 400_000, doRowsWritten: 40_000,
          d1RowsRead: 40_000, d1RowsWritten: 40_000 } };
      const ticket = await new CapacityTicketCodec(env.AUTH_SECRET).dispatch({ runId: manifest.runId,
        manifestDigest: manifest.digest, id: crypto.randomUUID(), objectKey: `game:${state.id.name}`,
        generation: 1, operation: 'Game.workflow', mode: 'workflow' });
      const create = () => new CapacityNativeHost<Game>(state, fixtureEnv(), 'Game', manifest, control,
        { 'Game.status': envelope, 'Game.finishWorkflow': envelope }, { Game: workflow, Competition: workflow });
      const host = create();
      expect((await host.invoke(ticket, 'status')).value).toMatchObject({ status: 'finished' });
      const second = await host.invoke(ticket, 'status');
      expect(second.workflowActual!.nativeDoRequests).toBe(2);
      const closed = await create().invoke(ticket, 'finishWorkflow');
      expect(closed.workflowActual!.nativeDoRequests).toBe(3);
      expect(closed.workflowActual!.doRowsWritten).toBeGreaterThan(second.workflowActual!.doRowsWritten);
      await expect(create().invoke(ticket, 'status')).rejects.toThrow('capacity_workflow_unresolved');
      expect(begin).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
    });
  });

  it('funds auth startup when a warm preparation overtakes the cold native event', async ({ task }) => {
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    await runInDurableObject(game, async (_instance, state) => {
      const manifest = capacityFixtureManifest(), control = fixtureControl(manifest);
      const begin = vi.spyOn(control, 'begin'), complete = vi.spyOn(control, 'complete');
      let firstBatch = true, release!: () => void, entered!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const batchEntered = new Promise<void>(resolve => { entered = resolve; });
      // Delay only the first real D1 batch. A later native event owns startup.
      const db = new Proxy(env.DB, { get(target, member) {
        if (member === 'batch') return async (statements: D1PreparedStatement[]) => {
          if (firstBatch) { firstBatch = false; entered(); await held; }
          return target.batch(statements);
        };
        const value = Reflect.get(target, member, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      const workflow = CAPACITY_WORKFLOW_CANDIDATES.competition;
      const wrapper = new CapacityNativeWrapper<Competition>(state, { ...fixtureEnv(), DB: db }, 'Competition',
        { manifest, envelopes: CAPACITY_NATIVE_CANDIDATE_ENVELOPES, control,
          workflows: { Game: CAPACITY_WORKFLOW_CANDIDATES.regular, Competition: workflow } });
      const ticket = await new CapacityTicketCodec(env.AUTH_SECRET).dispatch({ runId: manifest.runId,
        manifestDigest: manifest.digest, id: crypto.randomUUID(), objectKey: 'competition',
        generation: 1, operation: 'Competition.workflow', mode: 'workflow' });
      const cold = wrapper.rpc<CapacityAccountCredential>('prepareQualificationAccount', [5_980], ticket);
      await batchEntered;
      const warm = wrapper.rpc<CapacityAccountCredential>('prepareQualificationAccount', [5_981], ticket);
      let warmReply!: CapacityNativeReply<CapacityAccountCredential>;
      try {
        warmReply = await warm;
        expect(warmReply.value.accountIndex).toBe(5_981);
        expect(warmReply.usage.d1RowsRead).toBeGreaterThan(128);
        expect(warmReply.usage.d1RowsRead)
          .toBeLessThanOrEqual(CAPACITY_NATIVE_CANDIDATE_ENVELOPES['Competition.prepareQualificationAccount'].d1RowsRead);
        const overlap = state.storage.sql.exec('SELECT events,unresolved,stopped,closed,reserved FROM capacity_wrapper_workflow WHERE id=1').one();
        expect(overlap).toMatchObject({ events: 2, unresolved: 1, stopped: 0, closed: 0 });
        expect(JSON.parse(String(overlap.reserved)).d1RowsRead).toBe(workflow.maximumEventWork.d1RowsRead);
      } finally {
        release();
        await Promise.allSettled([cold, warm]);
      }
      const coldReply = await cold;
      expect(coldReply.value.accountIndex).toBe(5_980);
      const settled = state.storage.sql.exec('SELECT events,unresolved,stopped,closed,reserved,observed FROM capacity_wrapper_workflow WHERE id=1').one();
      expect(settled).toMatchObject({ events: 2, unresolved: 0, stopped: 0, closed: 0 });
      expect(JSON.parse(String(settled.reserved))).toEqual(emptyCapacityWork());
      expect(JSON.parse(String(settled.observed)).nativeDoRequests).toBe(2);
      expect(begin).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      (task.meta as Record<string, unknown>).qualification = { kind: 'Competition', scenario: 'warm-event-auth-startup',
        warm: warmReply.usage, cold: coldReply.usage,
        scope: 'Two real fixture preparations overlap at a test-only D1 batch barrier. The warm event initializes auth before the cold event resumes. No provider or full workload qualification.' };
    });
  });

  it('holds an interrupted second ready reservation and fences reconstructed work and its alarm', async ({ task }) => {
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    await runInDurableObject(game, async (_instance, state) => {
      const fixture = await readyWorkflowFixture(state);
      const begin = vi.spyOn(fixture.control, 'begin'), complete = vi.spyOn(fixture.control, 'complete');
      const command = vi.spyOn(Game.prototype, 'command'), nativeAlarm = vi.spyOn(Game.prototype, 'alarm');
      // The command transaction commits before Game.committed awaits sync.
      const sync = vi.spyOn(state.storage, 'sync').mockRejectedValueOnce(new Error('fixture_ready_commit_reply_lost'));
      const interrupted = await fixture.wrapper.rpc('qualificationStep',
        [fixture.request(fixture.blackStep), fixture.blackStep], fixture.ticket).catch(error => error);
      expect(capacityFailureFromError(interrupted)).toMatchObject({ kind: 'Game', stage: 'native-method',
        index: fixture.blackStep, code: 'capacity_run_unresolved', causeCode: null });
      expect(interrupted.message).not.toContain('fixture_ready_commit_reply_lost');
      sync.mockRestore();
      const persisted = () => JSON.parse(state.storage.sql.exec<{ value: string }>('SELECT value FROM game_state WHERE id=1').one().value);
      expect(persisted()).toMatchObject({ status: 'active', version: 2, white: { ready: true }, black: { ready: true } });
      expect(state.storage.sql.exec('SELECT COUNT(*) AS n FROM command_receipts').one().n).toBe(2);
      const held = state.storage.sql.exec('SELECT events,unresolved,observed,reserved FROM capacity_wrapper_workflow WHERE id=1').one();
      expect(held).toMatchObject({ events: 3, unresolved: 1 });
      const reserved = JSON.parse(String(held.reserved)) as CapacityWorkUnits;
      expect(reserved).toMatchObject({ nativeDoRequests: 1, doRowsRead: fixture.envelope.doRowsRead,
        doRowsWritten: fixture.envelope.doRowsWritten, d1RowsRead: fixture.envelope.d1RowsRead,
        d1RowsWritten: fixture.envelope.d1RowsWritten });
      await expect(fixture.create().rpc('qualificationStep',
        [fixture.request(fixture.blackStep), fixture.blackStep], fixture.ticket)).rejects.toThrow('capacity_workflow_unresolved');
      expect(command).toHaveBeenCalledTimes(1);
      const abort = vi.spyOn(state, 'abort').mockImplementation(() => undefined as never);
      const measurements = observeAlarmMeters();
      await fixture.create().alarm();
      const [terminal] = measurements();
      expect(measurements()).toHaveLength(1);
      expect(state.storage.sql.exec('SELECT events,unresolved,observed,reserved FROM capacity_wrapper_workflow WHERE id=1').one()).toEqual(held);
      expect(state.storage.sql.exec('SELECT stopped FROM capacity_wrapper_workflow WHERE id=1').one().stopped).toBe(1);
      expect(await state.storage.getAlarm()).toBeNull();
      expect(abort).toHaveBeenCalledExactlyOnceWith(expect.any(String), { retryAlarm: false });
      expect(nativeAlarm).not.toHaveBeenCalled();
      expect(begin).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      expect(persisted()).toMatchObject({ status: 'active', version: 2 });
      expect(terminal).toMatchObject({ uncertain: false, unresolvedD1: 0, d1RowsRead: 0, d1RowsWritten: 0 });
      expect(terminal.doRowsRead).toBeLessThanOrEqual(CAPACITY_FREEZE_CALLBACK_WORK.doRowsRead / 2);
      expect(terminal.doRowsWritten).toBeLessThanOrEqual(2);
      (task.meta as Record<string, unknown>).qualification = { kind: 'Game', scenario: 'interrupted-second-ready',
        heldEventSlots: Number(held.unresolved), heldNativeRequests: reserved.nativeDoRequests, terminal,
        scope: 'Real ready mutation with an injected sync failure. Abort is mocked; physical eviction and provider behavior remain unqualified.' };
    });
  });

  it('rejects second ready replay after a completed native reply is lost and the wrapper is reconstructed', async ({ task }) => {
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    await runInDurableObject(game, async (_instance, state) => {
      const fixture = await readyWorkflowFixture(state, 1_001);
      const begin = vi.spyOn(fixture.control, 'begin'), complete = vi.spyOn(fixture.control, 'complete');
      const command = vi.spyOn(Game.prototype, 'command');
      let wrapper = fixture.wrapper, loseReply = true;
      const namespace = { idFromName: (name: string) => env.GAME.idFromName(name), get: () => ({
        async qualificationStep(request: Request, index: number, ticket: CapacityTicket<CapacityDispatch>) {
          const reply = await wrapper.rpc<CapacityStepReply>('qualificationStep', [request, index], ticket);
          if (loseReply) { loseReply = false; throw new Error('fixture_completed_ready_reply_lost'); }
          return reply;
        },
      }) };
      const issue = () => callCapacityWorkflow<CapacityStepReply>(namespace, fixture.ticket, 'Game.qualificationStep',
        [fixture.request(fixture.blackStep), fixture.blackStep]);
      await expect(issue()).rejects.toThrow('fixture_completed_ready_reply_lost');
      const completed = state.storage.sql.exec('SELECT events,unresolved,reserved,observed FROM capacity_wrapper_workflow WHERE id=1').one();
      expect(completed).toMatchObject({ events: 3, unresolved: 0 });
      expect(JSON.parse(String(completed.reserved)).nativeDoRequests).toBe(0);
      expect(JSON.parse(String(completed.observed)).nativeDoRequests).toBe(3);
      wrapper = fixture.create();
      const repeated = await issue();
      expect(repeated.value).toMatchObject({ accepted: false, acceptedAt: null, code: 'capacity_step_already_issued' });
      expect(command).toHaveBeenCalledTimes(1);
      expect(state.storage.sql.exec('SELECT COUNT(*) AS n FROM command_receipts').one().n).toBe(2);
      expect(JSON.parse(state.storage.sql.exec<{ value: string }>('SELECT value FROM game_state WHERE id=1').one().value))
        .toMatchObject({ status: 'active', version: 2, white: { ready: true }, black: { ready: true } });
      const afterReplay = state.storage.sql.exec('SELECT events,unresolved,reserved,observed FROM capacity_wrapper_workflow WHERE id=1').one();
      expect(afterReplay).toMatchObject({ events: 4, unresolved: 0 });
      expect(JSON.parse(String(afterReplay.reserved)).nativeDoRequests).toBe(0);
      expect(JSON.parse(String(afterReplay.observed)).nativeDoRequests).toBe(4);
      expect(begin).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      await state.storage.deleteAlarm();
      (task.meta as Record<string, unknown>).qualification = { kind: 'Game', scenario: 'completed-second-ready-reply-lost',
        completedEvents: Number(completed.events), eventsAfterReplay: Number(afterReplay.events), nativeCommands: command.mock.calls.length,
        scope: 'Loss is injected after the real native completion. This covers the wrapper and durable step fence, without HTTP or provider qualification.' };
    });
  });

  it('does not confirm native shutdown for an empty Game', async () => {
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    await runInDurableObject(game, async (_instance, state) => {
      const manifest = capacityFixtureManifest(), control = fixtureControl(manifest);
      const envelope = { ...probeEnvelope(), doStorageBytes: 1024 ** 2, d1StorageBytes: 512 * 1024 ** 2 };
      const ticket = await fixtureTicket(control, `game:${state.id.name}`, 'Game.finishWorkflow');
      const host = new CapacityNativeHost<Game>(state, fixtureEnv(), 'Game', manifest, control,
        { 'Game.finishWorkflow': envelope });
      await expect(host.invoke(ticket, 'finishWorkflow')).rejects.toThrow('capacity_shutdown_game_pending');
    });
  });

  it('reserves before activation and settles only after the real native reply without retrying lost work', async () => {
    const manifest = capacityFixtureManifest();
    const control = fixtureControl(manifest);
    const order: string[] = [];
    const originalBegin = control.begin;
    let completes = 0; let gets = 0;
    control.begin = async (...args) => { order.push('reserve'); return originalBegin(...args); };
    control.complete = async () => { order.push('complete'); completes++; return true; };
    let nativeEntered!: () => void;
    const entered = new Promise<void>(resolve => { nativeEntered = resolve; });
    let nativeReply!: (value: CapacityNativeReply<string>) => void;
    const reply = new Promise<CapacityNativeReply<string>>(resolve => { nativeReply = resolve; });
    let currentTicket!: CapacityTicket<CapacityDispatch>;
    const namespace = { idFromName: (name: string) => env.GAME.idFromName(name), get() {
      gets++; order.push('get');
      return { status: async (ticket: CapacityTicket<CapacityDispatch>) => {
        currentTicket = ticket; order.push('native'); nativeEntered(); return reply;
      } };
    } };
    const pending = callCapacityNative<string>(namespace, control, `game:${crypto.randomUUID()}`, 'Game.status', probeEnvelope());
    await entered;
    expect(order).toEqual(['reserve', 'get', 'native']);
    expect(completes).toBe(0);
    nativeReply({ ticketId: currentTicket.id, value: 'native-reply', actual: emptyCapacityWork(),
      usage: new CapacityNativeMeter().snapshot(),
      drained: { pendingNative: 0, alarm: false, sockets: 0, alarmPossible: false, socketPossible: false } });
    expect(await pending).toBe('native-reply');
    expect(order).toEqual(['reserve', 'get', 'native', 'complete']);
    const lost = { ...namespace, get() { gets++; return { status: async () => { throw new Error('lost-native-reply'); } }; } };
    await expect(callCapacityNative(lost, control, `game:${crypto.randomUUID()}`, 'Game.status', probeEnvelope())).rejects.toThrow('lost-native-reply');
    expect(gets).toBe(2);
    expect(completes).toBe(1);
  });

  it('binds authenticated tickets to one run, object, operation and generation', async () => {
    const manifest = capacityFixtureManifest();
    const codec = new CapacityTicketCodec(env.AUTH_SECRET);
    const key = `game:${crypto.randomUUID()}`;
    const ticket = await fixtureTicket(fixtureControl(manifest), key, 'Game.status');
    expect(await codec.validDispatch(ticket, manifest, key, 'Game.status')).toBe(true);
    expect(await codec.validDispatch(ticket, manifest, key, 'Game.init')).toBe(false);
    expect(await codec.validDispatch(ticket, manifest, `game:${crypto.randomUUID()}`, 'Game.status')).toBe(false);
    expect(await codec.validDispatch({ ...ticket, generation: 2 }, manifest, key, 'Game.status')).toBe(false);
    expect(await codec.validDispatch(ticket, { ...manifest, digest: 'd'.repeat(64) }, key, 'Game.status')).toBe(false);
    expect(await new CapacityTicketCodec('different-private-ticket-secret-at-least-32-bytes').validDispatch(ticket, manifest, key, 'Game.status')).toBe(false);
  });

  it.each(['fresh', 'retained'] as const)('consumes a ticket once across host reconstruction with %s tables', async schema => {
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    await runInDurableObject(game, async (_instance, state) => {
      if (schema === 'retained') {
        state.storage.sql.exec('CREATE TABLE capacity_wrapper_dispatches(id TEXT PRIMARY KEY,generation INTEGER NOT NULL)');
        state.storage.sql.exec("INSERT INTO capacity_wrapper_dispatches VALUES('retained-dispatch',1)");
      }
      const manifest = capacityFixtureManifest(); const control = fixtureControl(manifest);
      const host = new CapacityNativeHost<Game>(state, fixtureEnv(), 'Game', manifest, control, { 'Game.status': probeEnvelope() });
      const ticket = await fixtureTicket(control, `game:${state.id.name}`, 'Game.status');
      const first = await host.invoke(ticket, 'status');
      expect(first.value).toBeNull();
      await expect(host.invoke(ticket, 'status')).rejects.toThrow('SQLITE_CONSTRAINT');
      const reconstructed = new CapacityNativeHost<Game>(state, fixtureEnv(), 'Game', manifest, control, { 'Game.status': probeEnvelope() });
      await expect(reconstructed.invoke(ticket, 'status')).rejects.toThrow('SQLITE_CONSTRAINT');
      expect(state.storage.sql.exec('SELECT id FROM capacity_wrapper_dispatches ORDER BY id').toArray()).toEqual(
        [...(schema === 'retained' ? [{ id: 'retained-dispatch' }] : []), { id: ticket.id }].sort((a, b) => a.id < b.id ? -1 : 1));
      if (schema === 'retained') expect(state.storage.sql.exec('SELECT rowid FROM capacity_wrapper_dispatches').toArray()).toHaveLength(2);
    });
  });

  it('charges native Competition bridges to the current event after construction', async () => {
    const actor = await player(false, { recoveryEmail: false });
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    const result = await runInDurableObject(game, async (_instance, state) => {
      const traces = new Map<CapacityNativeMeter, string[]>();
      const completed: string[][] = [];
      const originalSql = CapacityNativeMeter.prototype.sql;
      const originalSnapshot = CapacityNativeMeter.prototype.snapshot;
      vi.spyOn(CapacityNativeMeter.prototype, 'sql').mockImplementation(function (this: CapacityNativeMeter, native) {
        const calls = traces.get(this) ?? []; traces.set(this, calls);
        const measured = originalSql.call(this, native);
        return new Proxy(measured, { get(target, key) {
          if (key === 'exec') return (query: string, ...bindings: unknown[]) => { calls.push(query); return target.exec(query, ...bindings); };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
      });
      vi.spyOn(CapacityNativeMeter.prototype, 'snapshot').mockImplementation(function (this: CapacityNativeMeter) {
        completed.push([...(traces.get(this) ?? [])]);
        return originalSnapshot.call(this);
      });
      const manifest = capacityFixtureManifest();
      const control = fixtureControl(manifest);
      const envelopes = Object.fromEntries(['health', 'registerArena', 'queueArena'].map(method =>
        [`Competition.${method}`, probeEnvelope()])) as Record<CapacityOperation, CapacityWorkUnits>;
      const host = new CapacityNativeHost<Competition>(state, fixtureEnv(), 'Competition', manifest, control, envelopes);
      await host.invoke(await fixtureTicket(control, 'competition', 'Competition.health'), 'health');
      const now = Date.now(); const id = `capacity-bridge-${crypto.randomUUID()}`;
      state.storage.sql.exec(`INSERT INTO arena_events(id,cadence,pool,starts_at,closes_at,status,next_at)
        VALUES(?,'hourly','blitz',?,?,'running',?)`, id, now - 1, now + 600_000, now + 600_000);
      const registered = await host.invoke<Awaited<ReturnType<Competition['registerArena']>>>(
        await fixtureTicket(control, 'competition', 'Competition.registerArena'), 'registerArena', [actor, id]);
      const queued = await host.invoke<Awaited<ReturnType<Competition['queueArena']>>>(
        await fixtureTicket(control, 'competition', 'Competition.queueArena'), 'queueArena', [actor, id]);
      await state.storage.deleteAlarm();
      return { registered: registered.value, queued: queued.value, completed,
        slot: state.storage.sql.exec('SELECT state,game_id FROM slots WHERE user_id=?', actor.id).one() };
    });
    expect(result.registered).toMatchObject({ ok: true });
    expect(result.queued).toMatchObject({ ok: true, value: { state: 'reserving' } });
    expect(result.slot.state).toBe('tournament');
    expect(result.completed).toHaveLength(3);
    expect(result.completed[2].some(query => query.startsWith('INSERT INTO slots('))).toBe(true);
    expect(result.completed[0].some(query => query.startsWith('INSERT INTO slots('))).toBe(false);
  });

  it('meters primary fixture creation and signed-session verification inside admitted native replies', async ({ task }) => {
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    const result = await runInDurableObject(game, async (_instance, state) => {
      const manifest = capacityFixtureManifest(), control = fixtureControl(manifest);
      const envelopes = Object.fromEntries(['prepareQualificationAccount', 'authenticateQualificationAccount'].map(method =>
        [`Competition.${method}`, probeEnvelope()])) as Record<CapacityOperation, CapacityWorkUnits>;
      envelopes['Competition.authenticateQualificationAccount'] = { ...probeEnvelope(),
        d1RowsRead: CAPACITY_D1_READ_ATTEMPTS * CAPACITY_WARM_D1_READ_ROWS };
      const host = new CapacityNativeHost<Competition>(state, fixtureEnv(), 'Competition', manifest, control, envelopes);
      const prepared = await host.invoke<{ cookie: string; accountIndex: number }>(
        await fixtureTicket(control, 'competition', 'Competition.prepareQualificationAccount'), 'prepareQualificationAccount', [5_999]);
      const request = new Request(`https://${manifest.host}/capacity/step/0`, { headers: { Cookie: prepared.value.cookie } });
      const authenticated = await host.invoke<{ id: string; accountReady: boolean }>(
        await fixtureTicket(control, 'competition', 'Competition.authenticateQualificationAccount'), 'authenticateQualificationAccount', [request, 5_999]);
      await state.storage.deleteAlarm();
      return { accountIndex: prepared.value.accountIndex, actor: authenticated.value,
        created: prepared.usage, checked: authenticated.usage };
    });
    expect(result.accountIndex).toBe(5_999);
    expect(result.actor).toMatchObject({ id: capacityAccountId(5_999), accountReady: true });
    expect(result.created.d1RowsWritten).toBeGreaterThanOrEqual(3);
    expect(result.checked.d1RowsRead).toBeGreaterThan(0);
    expect(result.checked.d1RowsRead).toBeLessThanOrEqual(CAPACITY_WARM_D1_READ_ROWS);
    expect(result.checked).toMatchObject({ d1RowsWritten: 0, d1Statements: 2, d1Retries: 0,
      d1RetryReadSurcharge: 0, unresolvedD1: 0, uncertain: false });
    expect(result.checked.doRowsRead).toBeGreaterThan(0);
    expect(result.created.uncertain || result.checked.uncertain).toBe(false);
    (task.meta as Record<string, unknown>).warmPrimaryAuth = { usage: result.checked,
      singleAttemptReadBound: CAPACITY_WARM_D1_READ_ROWS,
      threeAttemptReadAllowance: CAPACITY_D1_READ_ATTEMPTS * CAPACITY_WARM_D1_READ_ROWS,
      scope: 'Real local primary auth after fixture preparation warmed the stable package context. No provider latency claim.' };
  });

  it('creates a bounded real primary batch, authenticates every cookie and rejects changed credentials', async () => {
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    const result = await runInDurableObject(game, async (_instance, state) => {
      const manifest = capacityFixtureManifest(), control = fixtureControl(manifest);
      const envelopes = Object.fromEntries(['prepareQualificationAccounts', 'authenticateQualificationAccount'].map(method =>
        [`Competition.${method}`, probeEnvelope()])) as Record<CapacityOperation, CapacityWorkUnits>;
      const host = new CapacityNativeHost<Competition>(state, fixtureEnv(), 'Competition', manifest, control, envelopes);
      const batch = await host.invoke<CapacityAccountCredential[]>(
        await fixtureTicket(control, 'competition', 'Competition.prepareQualificationAccounts'), 'prepareQualificationAccounts', [0]);
      const ids: string[] = [];
      for (const credential of batch.value) {
        const request = new Request(`https://${manifest.host}/capacity/step/0`, { headers: { Cookie: credential.cookie } });
        const actor = await host.invoke<{ id: string; accountReady: boolean }>(
          await fixtureTicket(control, 'competition', 'Competition.authenticateQualificationAccount'),
          'authenticateQualificationAccount', [request, credential.accountIndex]);
        expect(actor.value.accountReady).toBe(true);
        ids.push(actor.value.id);
      }
      await env.DB.prepare("UPDATE account SET providerId='changed' WHERE id=?").bind(`${capacityAccountId(0)}:credential`).run();
      await expect(host.invoke(await fixtureTicket(control, 'competition', 'Competition.prepareQualificationAccounts'),
        'prepareQualificationAccounts', [0])).rejects.toThrow('capacity_fixture_primary_state_unresolved');
      await state.storage.deleteAlarm();
      return { ids, usage: batch.usage };
    });
    expect(result.ids).toEqual(Array.from({ length: CAPACITY_PREPARATION_BATCH_SIZE }, (_, index) => capacityAccountId(index)));
    expect(result.usage).toMatchObject({ uncertain: false, unresolvedD1: 0, d1RetryReadSurcharge: 0 });
    expect(result.usage.d1RowsRead).toBeLessThanOrEqual(640);
    expect(result.usage.d1RowsWritten).toBeGreaterThanOrEqual(3 * CAPACITY_PREPARATION_BATCH_SIZE);
    expect(result.usage.d1Statements).toBe(3 * CAPACITY_PREPARATION_BATCH_SIZE + 1);
  });

  it('retains fixture and authenticated read retry charges across workflow reconstruction', async () => {
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    await runInDurableObject(game, async (_instance, state) => {
      let retry = true;
      const decorate = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, { get(target, member) {
        if (member === 'bind') return (...values: unknown[]) => decorate(target.bind(...values));
        if (member === 'all') return async () => {
          const reply = await target.all();
          if (!retry || reply.meta.rows_written) return reply;
          retry = false;
          return { ...reply, meta: { ...reply.meta, total_attempts: 3 } };
        };
        const value = Reflect.get(target, member, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      const db = new Proxy(env.DB, { get(target, member) {
        if (member === 'prepare') return (query: string) => decorate(target.prepare(query));
        const value = Reflect.get(target, member, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      const manifest = capacityFixtureManifest(), control = fixtureControl(manifest);
      const ticket = await new CapacityTicketCodec(env.AUTH_SECRET).dispatch({ runId: manifest.runId,
        manifestDigest: manifest.digest, id: crypto.randomUUID(), objectKey: 'competition',
        generation: 1, operation: 'Competition.workflow', mode: 'workflow' });
      const envelopes = { ...CAPACITY_NATIVE_CANDIDATE_ENVELOPES,
        'Competition.authenticateQualificationAccount': {
          ...CAPACITY_NATIVE_CANDIDATE_ENVELOPES['Competition.qualificationBinding'], d1RowsRead: 24,
        } };
      const create = () => new CapacityNativeWrapper<Competition>(state, { ...fixtureEnv(), DB: db }, 'Competition',
        { manifest, envelopes, control,
          workflows: { Game: CAPACITY_WORKFLOW_CANDIDATES.regular, Competition: CAPACITY_WORKFLOW_CANDIDATES.competition } });
      const first = await create().rpc<CapacityAccountCredential[]>('prepareQualificationAccounts', [64], ticket);
      expect(first.usage).toMatchObject({ uncertain: false, unresolvedD1: 0, d1Retries: 2, d1RetryReadSurcharge: 1_280 });
      expect(first.workflowActual!.d1RowsRead).toBe(first.usage.d1RowsRead + 1_280);
      const reconstructed = create();
      const next = await reconstructed.rpc<CapacityAccountCredential[]>('prepareQualificationAccounts', [96], ticket);
      // The real HTTP preparation path funds one separate schema-startup
      // fixture before registration. Recreate that step after this restart.
      const startup = await reconstructed.rpc<CapacityAccountCredential>('prepareQualificationAccount', [96], ticket);
      retry = true;
      const credential = next.value[0];
      const request = new Request(`https://${manifest.host}/capacity/step/0`, { headers: { Cookie: credential.cookie } });
      const checked = await reconstructed.rpc<{ id: string; accountReady: boolean }>(
        'authenticateQualificationAccount', [request, credential.accountIndex], ticket);
      expect(checked.value).toMatchObject({ id: capacityAccountId(96), accountReady: true });
      expect(checked.usage).toMatchObject({ uncertain: false, unresolvedD1: 0, d1Retries: 2, d1RetryReadSurcharge: 16 });
      const saved = state.storage.sql.exec('SELECT observed,retry_read_surcharge,unresolved FROM capacity_wrapper_workflow WHERE id=1').one();
      expect(saved).toMatchObject({ retry_read_surcharge: 1_296, unresolved: 0 });
      expect(JSON.parse(String(saved.observed)).d1RowsRead)
        .toBe(first.usage.d1RowsRead + next.usage.d1RowsRead + startup.usage.d1RowsRead + checked.usage.d1RowsRead + 1_296);
      await state.storage.deleteAlarm();
    });
  });

  it('measures real readiness, legal moves, resignation and delivery without changing native authority', async ({ task }) => {
    const [white, black] = await Promise.all([player(false, { recoveryEmail: false }), player(false, { recoveryEmail: false })]);
    const id = crypto.randomUUID();
    await admitGameFixture({ id, format: 'blitz', rated: false, white, black });
    const game = env.GAME.get(env.GAME.idFromName(id));
    const result = await runInDurableObject(game, async (_instance, state) => {
      const nativeCalls: CapacityWorkUnits[] = [];
      const manifest = capacityFixtureManifest();
      const control = fixtureControl(manifest);
      control.complete = async (ticket, usage) => { if (ticket.objectKey === `game:${id}`) nativeCalls.push(usage); return true; };
      const methods = ['init', 'command', 'status', 'flush'];
      const envelopes = Object.fromEntries([...methods.map(method => [`Game.${method}`, probeEnvelope()]),
        ['Competition.settle', probeEnvelope()]]) as Record<CapacityOperation, CapacityWorkUnits>;
      const host = new CapacityNativeHost<Game>(state, fixtureEnv(), 'Game', manifest, control, envelopes);
      const measured: Array<{ method: string; usage: Awaited<ReturnType<typeof host.invoke>>['usage'] }> = [];
      const invoke = async <T>(method: string, args: unknown[] = []) => {
        const ticket = await fixtureTicket(control, `game:${id}`, `Game.${method}`);
        const reply = await host.invoke<T>(ticket, method, args);
        await control.complete(ticket, reply.actual, reply.drained);
        measured.push({ method, usage: reply.usage });
        // This local adapter probe uses the existing test Game binding.
        // Its alarm is not the private CapacityGame, so it is not alarm proof.
        await state.storage.deleteAlarm();
        return reply.value;
      };
      let snapshot = await invoke<GameSnapshot>('init', [{ id, format: 'blitz', rated: false, white, black }]);
      for (const actor of [white, black]) {
        const reply = await invoke<Awaited<ReturnType<Game['command']>>>('command', [actor,
          { id: crypto.randomUUID(), type: 'ready', expectedVersion: snapshot.version }]);
        if (!reply.ok) throw new Error(reply.code); snapshot = reply.snapshot;
      }
      for (const [actor, from, to] of [[white, 'e2', 'e4'], [black, 'e7', 'e5'], [white, 'g1', 'f3'], [black, 'b8', 'c6']] as const) {
        const reply = await invoke<Awaited<ReturnType<Game['command']>>>('command', [actor,
          { id: crypto.randomUUID(), type: 'move', expectedVersion: snapshot.version, from, to }]);
        if (!reply.ok) throw new Error(reply.code); snapshot = reply.snapshot;
      }
      const ended = await invoke<Awaited<ReturnType<Game['command']>>>('command', [black,
        { id: crypto.randomUUID(), type: 'resign', expectedVersion: snapshot.version }]);
      const actual = await invoke<Awaited<ReturnType<Game['status']>>>('status');
      await invoke<void>('flush');
      return { ended, actual, measured, nativeCalls,
        pendingDelivery: state.storage.sql.exec('SELECT 1 FROM result_delivery').toArray().length };
    });
    expect(result.ended).toMatchObject({ ok: true, snapshot: { status: 'finished', outcome: { reason: 'resignation', winner: 'w' } } });
    expect(result.actual?.result).toMatchObject({ id, plies: 4, rated: false });
    expect(result.pendingDelivery).toBe(0);
    expect(result.measured).toHaveLength(10);
    expect(result.measured.every(item => !item.usage.uncertain && item.usage.unresolvedD1 === 0)).toBe(true);
    expect(result.measured.filter(item => item.method === 'command').every(item => item.usage.doRowsWritten > 0 && item.usage.d1RowsRead > 0)).toBe(true);
    expect(result.nativeCalls.reduce((sum, work) => sum + work.nativeDoRequests, 0)).toBe(10);
    expect(Math.max(...result.measured.map(item => item.usage.doStorageBytes))).toBeLessThan(CAPACITY_CEILINGS.doStorageBytes);
    (task.meta as Record<string, unknown>).qualification = { kind: 'capacity-native-game-adapter-probe', measured: result.measured,
      scope: 'One local four-ply casual Game. Existing test namespace and initialized schema. Native alarm delivery, cold schema, Competition work, all storage bounds, CPU and provider cost remain unqualified.' };
  });

  it('rejects missing envelopes and denied permits before invoking native initialization', async () => {
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    await runInDurableObject(game, async (_instance, state) => {
      let begins = 0;
      const manifest = capacityFixtureManifest();
      const control = fixtureControl(manifest);
      const ticket = await fixtureTicket(control, `game:${state.id.name}`, 'Game.init');
      control.begin = async () => { begins++; return null; };
      control.complete = async () => { throw new Error('must_not_complete'); };
      const host = new CapacityNativeHost<Game>(state, env as unknown as CapacityEnv, 'Game', capacityFixtureManifest(), control,
        { 'Game.init': probeEnvelope() });
      await expect(host.invoke(ticket, 'captureRecoveryPoint')).rejects.toThrow('capacity_native_envelope_missing');
      await expect(host.invoke({ ...ticket, generation: 2 }, 'init', [])).rejects.toThrow('capacity_native_ticket_invalid');
      const namespace = { get() { throw new Error('must_not_get_native_stub'); } } as unknown as DurableObjectNamespace;
      await expect(callCapacityNative(namespace, control, `game:${state.id.name}`, 'Game.init', probeEnvelope())).rejects.toThrow('capacity_native_work_denied');
      expect(begins).toBe(1);
      expect(state.storage.sql.exec('SELECT 1 FROM game_state').toArray()).toEqual([]);
    });
  });
});
