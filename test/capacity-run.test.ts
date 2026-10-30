import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bindIsolatedGameBudget, isolatedGameBudget } from '../src/server/capacity-policy';
import { capacityRetirementAck, capacityControllerAllowance, CAPACITY_CEILINGS, CAPACITY_CONTROL_METHODS,
  CAPACITY_INGRESS_BLOCK_REQUESTS, CapacityRunStore, emptyCapacityWork, type CapacityControllerPlan,
  type CapacityControlMethod, type CapacityDispatch, type CapacityDrain, type CapacityManifest, type CapacityWorkUnits } from '../src/server/capacity-run';
import { CapacityIngressBudget, CAPACITY_INGRESS_GRANT_WAIT_MS } from '../src/server/capacity-ingress';
import { capacityFixtureManifest } from './capacity-fixtures';
import { monthlyLimit, newWorkAllowed, reserveMonthlyWork } from '../src/server/budget';
import { capacityRegistrationDiagnosticPlan } from '../src/server/capacity-candidate-plan';
import { CAPACITY_REGISTRATION_DIAGNOSTIC, capacityRegistrationDiagnosticSchedule } from '../src/shared/capacity-corpus';

const T0 = Date.UTC(2026, 9, 31, 23, 50);
const manifest = () => capacityFixtureManifest(T0);

// Trusted callers retain an issued ticket until the real native reply. The
// fixture keeps that ticket across store reconstruction and never reissues it.
const issued = new Map<string, CapacityDispatch>();
beforeEach(() => issued.clear());
function begin(store: CapacityRunStore, id: string, key: string, envelope: CapacityWorkUnits): boolean {
  const ticket = store.begin(id, key, key === 'competition' ? 'Competition.health' : 'Game.status', envelope);
  if (ticket) issued.set(id, ticket);
  return ticket !== null;
}
function complete(store: CapacityRunStore, id: string, actual: CapacityWorkUnits,
  drained: Pick<CapacityDrain, 'pendingNative' | 'alarm' | 'sockets'>): boolean {
  const ticket = issued.get(id);
  if (!ticket) throw new Error('fixture_ticket_missing');
  return store.complete(ticket, actual, { alarmPossible: false, socketPossible: false, ...drained });
}

function controllerPlan(): CapacityControllerPlan {
  return { maximumPhysicalBytes: 1_000_000, maximumIncarnations: 3,
    bootstrapEnvelope: { ...emptyCapacityWork(), doRowsRead: 10, doRowsWritten: 30 },
    methods: Object.fromEntries(CAPACITY_CONTROL_METHODS.map(method => [method, {
      maximumCalls: 10, envelope: { ...emptyCapacityWork(), nativeDoRequests: 1, doRowsRead: 100, doRowsWritten: 100 },
    }])) as CapacityControllerPlan['methods'] };
}

// Retained private namespaces keep their original tables and prepaid plan.
function retainedControllerTables(sql: SqlStorage): void {
  for (const statement of [
    'CREATE TABLE capacity_charges(receipt_id TEXT PRIMARY KEY,units INTEGER NOT NULL,charged_at INTEGER NOT NULL)',
    'CREATE TABLE capacity_game_ids(game_id TEXT PRIMARY KEY,receipt_id TEXT NOT NULL)',
    `CREATE TABLE capacity_permits(object_key TEXT PRIMARY KEY,open INTEGER NOT NULL,unresolved INTEGER NOT NULL,
      generation INTEGER NOT NULL,retiring_nonce TEXT,trigger_uncertain INTEGER NOT NULL)`,
    `CREATE TABLE capacity_dispatches(id TEXT PRIMARY KEY,object_key TEXT NOT NULL,generation INTEGER NOT NULL,
      operation TEXT NOT NULL,mode TEXT NOT NULL,envelope TEXT NOT NULL,completed INTEGER NOT NULL DEFAULT 0,observed TEXT)`,
    `CREATE TABLE capacity_retirements(object_key TEXT NOT NULL,generation INTEGER NOT NULL,
      nonce TEXT NOT NULL,acknowledged INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(object_key,generation))`,
    'CREATE TABLE capacity_object_storage(object_key TEXT PRIMARY KEY,peak_bytes INTEGER NOT NULL)',
    'CREATE TABLE capacity_ingress_blocks(id TEXT PRIMARY KEY,charged_at INTEGER NOT NULL)',
  ]) sql.exec(statement);
}

function fused<T>(store: CapacityRunStore, plan: CapacityControllerPlan, method: CapacityControlMethod,
  work: () => T, cold = false): T {
  const result = store.fuseRunUpdates(() => {
    if (!store.enterController(method, plan, cold)?.allowed) throw new Error('fixture_controller_denied');
    return work();
  });
  if (!result.ok) throw result.error;
  return result.value;
}

describe('once-only private capacity authority', () => {
  it('funds every diagnostic ingress call across fresh Worker consumers', async () => {
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    await runInDurableObject(game, async (_instance, state) => {
      const m = { ...manifest(), ...capacityRegistrationDiagnosticSchedule(T0), profile: CAPACITY_REGISTRATION_DIAGNOSTIC.profile };
      const plan = capacityRegistrationDiagnosticPlan();
      const store = new CapacityRunStore(state.storage.sql, run => state.storage.transactionSync(run), m, () => T0);
      expect(fused(store, plan, 'arm', () => true, true)).toBe(true);
      const calls = CAPACITY_REGISTRATION_DIAGNOSTIC.registrations + CAPACITY_REGISTRATION_DIAGNOSTIC.accounts / 32;
      let accepted = 0;
      for (let index = 0; index < calls; index++) {
        const worker = new CapacityIngressBudget(m.issueCloseAt, () => T0);
        if (await worker.consume(async id => {
          try { return fused(store, plan, 'reserveIngress', () => store.reserveIngress(id)); }
          catch { return false; }
        })) accepted++;
      }
      expect(accepted).toBe(calls);
      expect(store.status()).toMatchObject({ stopReason: null, observed: {
        workerRequests: 32 + calls * CAPACITY_INGRESS_BLOCK_REQUESTS,
      } });
    });
  });
  it('confirms the short registration stop only from one completed zero-Game workflow', async () => {
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    await runInDurableObject(game, (_instance, state) => {
      const m = { ...manifest(), ...capacityRegistrationDiagnosticSchedule(T0), profile: CAPACITY_REGISTRATION_DIAGNOSTIC.profile };
      const plan = capacityRegistrationDiagnosticPlan();
      expect(capacityControllerAllowance(plan)).not.toBeNull();
      let now = T0;
      const store = new CapacityRunStore(state.storage.sql, run => state.storage.transactionSync(run), m, () => now);
      expect(fused(store, plan, 'arm', () => true, true)).toBe(true);
      const ticket = fused(store, plan, 'begin', () => store.begin(crypto.randomUUID(), 'competition',
        'Competition.workflow', plan.workflows!.Competition.envelope, 'workflow'))!;
      now = m.admissionsCloseAt;
      const receipt = { at: now, games: 0, socketWorkflows: 0, pendingNative: 0, gameOutboxes: 0,
        competitionOutboxes: 0, projectionBuilds: 0, unfinishedGames: 0, sockets: 0, alarms: 0,
        registration: { fixtures: 256, entrants: 120, steps: 768, queues: 0 } };
      expect(store.confirmShutdown(ticket, receipt)).toBe(false);
      expect(fused(store, plan, 'complete', () => store.complete(ticket, emptyCapacityWork(),
        { pendingNative: 0, alarm: false, sockets: 0, alarmPossible: false, socketPossible: false }))).toBe(true);
      expect(store.confirmShutdown(ticket, { ...receipt, registration: { ...receipt.registration, queues: 1 } })).toBe(false);
      expect(store.confirmShutdown(ticket, { ...receipt, games: 1 })).toBe(false);
      expect(fused(store, plan, 'confirmShutdown', () => store.confirmShutdown(ticket, receipt))).toBe(true);
      expect(store.confirmShutdown(ticket, receipt)).toBe(false);
      expect(store.status()).toMatchObject({ charges: 0, activeObjects: 2, unresolvedDispatches: 0,
        nativeShutdown: { ...receipt, completedWorkflows: 1, confirmedRetirements: 0, retainedLifetimePermits: 2 } });
      expect(store.arm()).toBe(false);
    });
  });
  it('recovers only the saved Competition workflow after a stop and reconstruction', async () => {
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    await runInDurableObject(game, (_instance, state) => {
      const m = manifest();
      const plan = capacityRegistrationDiagnosticPlan();
      const create = () => new CapacityRunStore(state.storage.sql, run => state.storage.transactionSync(run), m, () => T0);
      let store = create();
      expect(fused(store, plan, 'arm', () => true, true)).toBe(true);
      expect(store.recoverCompetitionWorkflow()).toBeNull();
      const ticket = fused(store, plan, 'begin', () => store.begin(crypto.randomUUID(), 'competition',
        'Competition.workflow', plan.workflows!.Competition.envelope, 'workflow'))!;
      store.stop('controller-call-allowance');
      const before = store.status();
      store = create();
      expect(fused(store, plan, 'begin', () => store.recoverCompetitionWorkflow())).toEqual(ticket);
      expect(store.status()).toMatchObject({ stopReason: 'controller-call-allowance',
        activeObjects: before.activeObjects, unresolvedDispatches: 1, observed: before.observed });
      expect(store.begin(crypto.randomUUID(), 'competition', 'Competition.workflow',
        plan.workflows!.Competition.envelope, 'workflow')).toBeNull();
      expect(fused(store, plan, 'complete', () => store.complete(ticket, emptyCapacityWork(),
        { pendingNative: 0, alarm: false, sockets: 0, alarmPossible: false, socketPossible: false }))).toBe(true);
      expect(store.recoverCompetitionWorkflow()).toBeNull();
      expect(store.status()).toMatchObject({ stopReason: 'controller-call-allowance', unresolvedDispatches: 0 });
    });
  });
  it('refuses a shutdown receipt without the complete native workflow and retirement records', async () => {
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    await runInDurableObject(game, (_instance, state) => {
      const m = manifest(); let now = T0;
      const store = new CapacityRunStore(state.storage.sql, run => state.storage.transactionSync(run), m, () => now);
      expect(store.arm()).toBe(true);
      now = m.admissionsCloseAt;
      const receipt = { at: m.admissionsCloseAt, games: 20_000, socketWorkflows: 1_000, pendingNative: 0,
        gameOutboxes: 0, competitionOutboxes: 0, projectionBuilds: 0, unfinishedGames: 0, sockets: 0, alarms: 0 };
      expect(store.confirmShutdown({ runId: m.runId, manifestDigest: m.digest, id: crypto.randomUUID(),
        objectKey: 'competition', generation: 1, operation: 'Competition.workflow', mode: 'workflow' }, receipt)).toBe(false);
      expect(state.storage.sql.exec('SELECT 1 FROM capacity_native_shutdown').toArray()).toEqual([]);
    });
  });

  it('funds each whole workflow once and keeps its lifetime permit until real completion', async () => {
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    await runInDurableObject(game, (_instance, state) => {
      const envelope = { ...emptyCapacityWork(), nativeDoRequests: 4, doRowsWritten: 20, doRowsRead: 200 };
      const workflow = { maximumEvents: 4, envelope, maximumEventWork: { ...envelope, nativeDoRequests: 1 } };
      const plan = { ...controllerPlan(), runWork: { ...envelope }, workflows: { Game: workflow, Competition: workflow } };
      const store = new CapacityRunStore(state.storage.sql, run => state.storage.transactionSync(run), manifest(), () => T0);
      expect(fused(store, plan, 'arm', () => true, true)).toBe(true);
      const before = store.status();
      const first = fused(store, plan, 'begin', () => store.begin(crypto.randomUUID(), 'competition', 'Competition.workflow', envelope, 'workflow'))!;
      const repeated = fused(store, plan, 'begin', () => store.begin(crypto.randomUUID(), 'competition', 'Competition.workflow', envelope, 'workflow'));
      expect(repeated).toEqual(first);
      expect(store.status()).toMatchObject({ unresolvedDispatches: 1, observed: before.armed ? before.observed : null,
        reserved: emptyCapacityWork() });
      expect(fused(store, plan, 'complete', () => store.complete(first,
        { ...emptyCapacityWork(), nativeDoRequests: 2, doRowsWritten: 7, doRowsRead: 10 },
        { pendingNative: 0, alarm: false, sockets: 0, alarmPossible: false, socketPossible: false }))).toBe(true);
      expect(store.status()).toMatchObject({ unresolvedDispatches: 0, observed: before.armed ? before.observed : null });
      expect(fused(store, plan, 'begin', () => store.begin(crypto.randomUUID(), 'competition', 'Competition.workflow', envelope, 'workflow'))).toBeNull();
    });
  });

  it('does not arm without a compiled, verified, fixed manifest or renew an existing run', async () => {
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    const result = await runInDurableObject(game, (_instance, state) => {
      const m = manifest();
      const create = (value: CapacityManifest | null, at = T0) => new CapacityRunStore(state.storage.sql,
        run => state.storage.transactionSync(run), value, () => at);
      const absent = create(null).arm();
      const unverified = create({ ...m, verified: { ...m.verified, allNativePaths: false } } as unknown as CapacityManifest).arm();
      const late = create(m, m.latestArmAt + 1).arm();
      const armed = create(m).arm();
      const repeated = create(m).arm();
      const changed = create({ ...m, runId: crypto.randomUUID(), digest: 'd'.repeat(64) }).arm();
      return { absent, unverified, late, armed, repeated, changed };
    });
    expect(result).toEqual({ absent: false, unverified: false, late: false, armed: true, repeated: false, changed: false });
  });

  it('keeps uncertain receipts charged across stop, store reconstruction and month change', async () => {
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    const result = await runInDurableObject(game, (_instance, state) => {
      const m = manifest();
      let now = T0;
      const create = () => new CapacityRunStore(state.storage.sql, run => state.storage.transactionSync(run), m, () => now);
      let store = create();
      if (!store.arm()) throw new Error('fixture_arm');
      const id = `arena:${crypto.randomUUID()}`;
      const charged = store.charge(id, 1);
      const linked = store.linkGame(id.slice(6), id);
      const repeatLink = store.linkGame(id.slice(6), id);
      const secondLink = store.linkGame(crypto.randomUUID(), id);
      // A lost reply leaves this charged receipt. Reconstruct the actual store
      // from native SQLite, then cross UTC month within the fixed run window.
      now = T0 + 15 * 60_000;
      store = create(); store.stop('local-fault');
      const retry = store.charge(id, 1);
      const changedUnits = store.charge(id, 2);
      const newAfterStop = store.charge(`arena:${crypto.randomUUID()}`, 1);
      const status = store.status();
      now = m.issueCloseAt;
      const afterWorkExpiry = store.charge(id, 1);
      return { charged, linked, repeatLink, secondLink, retry, changedUnits, newAfterStop, status, afterWorkExpiry };
    });
    expect(result).toMatchObject({ charged: true, linked: true, repeatLink: true, secondLink: false, retry: true,
      changedUnits: false, newAfterStop: false, afterWorkExpiry: false,
      status: { armed: true, charges: 1, activeObjects: 3, stopReason: 'local-fault' } });
  });

  it('holds unresolved native permits and reserved work through lost replies and expiry', async () => {
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    const result = await runInDurableObject(game, (_instance, state) => {
      const m = manifest(); let now = T0;
      const create = () => new CapacityRunStore(state.storage.sql, run => state.storage.transactionSync(run), m, () => now);
      let store = create(); store.arm();
      const id = crypto.randomUUID(); const receipt = `arena:${id}`;
      store.charge(receipt, 1); store.linkGame(id, receipt);
      const beforeDispatch = store.status();
      const envelope = { ...emptyCapacityWork(), nativeDoRequests: 1, doRowsWritten: 100 };
      const unknown = begin(store, 'unknown-event', `game:${crypto.randomUUID()}`, envelope);
      const accepted = begin(store, 'native-event', `game:${id}`, envelope);
      const duplicate = begin(store, 'native-event', `game:${id}`, envelope);
      store = create();
      const uncertainCompletion = complete(store, 'native-event', { ...emptyCapacityWork(), nativeDoRequests: 1 },
        { pendingNative: 1, alarm: false, sockets: 0 });
      now = m.issueCloseAt;
      const lateNewWork = begin(store, 'late-event', `game:${id}`, envelope);
      const beforeDrain = store.status();
      const completed = complete(store, 'native-event', { ...emptyCapacityWork(), nativeDoRequests: 1, doRowsWritten: 20 },
        { pendingNative: 0, alarm: false, sockets: 0 });
      return { beforeDispatch, unknown, accepted, duplicate, uncertainCompletion, lateNewWork, beforeDrain, completed, final: store.status() };
    });
    expect(result).toMatchObject({ beforeDispatch: { activeObjects: 3, unresolvedDispatches: 0 },
      unknown: false, accepted: true, duplicate: false, uncertainCompletion: false, lateNewWork: false,
      beforeDrain: { activeObjects: 3, unresolvedDispatches: 1, reserved: { nativeDoRequests: 1, doRowsWritten: 100 } },
      completed: true, final: { activeObjects: 3, unresolvedDispatches: 0, observed: { nativeDoRequests: 1, doRowsWritten: 20 } } });
  });

  it('reserves the worst next operation and keeps alarms, sockets and overlapping events charged', async () => {
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    const result = await runInDurableObject(game, (_instance, state) => {
      const store = new CapacityRunStore(state.storage.sql, run => state.storage.transactionSync(run), manifest(), () => T0);
      store.arm();
      const id = crypto.randomUUID(); store.charge(`casual:${id}`, 1); store.linkGame(id, `casual:${id}`);
      const work = { ...emptyCapacityWork(), doRowsRead: CAPACITY_CEILINGS.doRowsRead - 1 };
      const first = begin(store, 'overlap-one', `game:${id}`, work);
      const second = begin(store, 'overlap-two', `game:${id}`, emptyCapacityWork());
      complete(store, 'overlap-one', emptyCapacityWork(), { pendingNative: 0, alarm: false, sockets: 0 });
      const overlapping = store.status();
      complete(store, 'overlap-two', emptyCapacityWork(), { pendingNative: 0, alarm: true, sockets: 2 });
      const alarmHeld = store.status();
      begin(store, 'last-work', `game:${id}`, work);
      const denied = begin(store, 'too-much-work', `game:${id}`, { ...emptyCapacityWork(), doRowsRead: 2 });
      return { first, second, overlapping, alarmHeld, denied, status: store.status() };
    });
    expect(result).toMatchObject({ first: true, second: true, denied: false,
      overlapping: { activeObjects: 3, unresolvedDispatches: 1 }, alarmHeld: { activeObjects: 3, unresolvedDispatches: 0 },
      status: { stopReason: 'native-work-allowance', unresolvedDispatches: 1 } });
  });

  it('denies the 2049th object while preserving every unresolved native permit', async () => {
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    const result = await runInDurableObject(game, (_instance, state) => {
      const store = new CapacityRunStore(state.storage.sql, run => state.storage.transactionSync(run), manifest(), () => T0);
      store.arm();
      let accepted = 0;
      for (let index = 0; index < 2047; index++) {
        const id = `capacity-game-${index}`;
        store.charge(`arena:${id}`, 1); store.linkGame(id, `arena:${id}`);
        if (begin(store, `event-${index}`, `game:${id}`, emptyCapacityWork())) accepted++;
      }
      return { accepted, status: store.status() };
    });
    expect(result).toMatchObject({ accepted: 2046,
      status: { activeObjects: 2048, unresolvedDispatches: 2046, stopReason: 'active-object-allowance' } });
  });

  it('allows the exception only on the exact private capability while using normal receipts', async () => {
    const id = `arena:${crypto.randomUUID()}`;
    const isolated = { ...env, MONTHLY_GAME_LIMIT: '20000' };
    let reservations = 0;
    const arenaStarts = { hourly: T0 + 600_000, daily: T0 + 600_000, weekly: T0 - 6_600_000 };
    bindIsolatedGameBudget(isolated, { manifestDigest: 'a'.repeat(64), maximum: 20_000,
      arenaStarts,
      available: async () => true, reserve: async () => { reservations++; return true; } });
    arenaStarts.weekly = T0;
    expect(isolatedGameBudget(isolated)?.arenaStarts?.weekly).toBe(T0 - 6_600_000);
    expect(Object.isFrozen(isolatedGameBudget(isolated)?.arenaStarts)).toBe(true);
    expect(isolatedGameBudget({ ...isolated })).toBeUndefined();
    expect(monthlyLimit(isolated, 'games')).toBe(20_000);
    expect(monthlyLimit(isolated, 'email')).toBe(Number.MAX_SAFE_INTEGER);
    expect(await newWorkAllowed(isolated, 'games')).toBe(true);
    expect(await reserveMonthlyWork(isolated, 'games', id)).toBe(true);
    expect(await reserveMonthlyWork(isolated, 'games', id)).toBe(true);
    expect(reservations).toBe(2);
    expect(await env.DB.prepare("SELECT units FROM budget_receipts WHERE kind='games' AND id=?").bind(id).first('units')).toBe(1);
    const denied = { ...env };
    bindIsolatedGameBudget(denied, { manifestDigest: 'b'.repeat(64), maximum: 20_000,
      available: async () => false, reserve: async () => false });
    expect(await newWorkAllowed(denied, 'games')).toBe(false);
    const blocked = `arena:${crypto.randomUUID()}`;
    expect(await reserveMonthlyWork(denied, 'games', blocked)).toBe(false);
    expect(await env.DB.prepare("SELECT 1 FROM budget_receipts WHERE kind='games' AND id=?").bind(blocked).first()).toBeNull();
    const changedDatabase = { ...env };
    bindIsolatedGameBudget(changedDatabase, { manifestDigest: 'c'.repeat(64), maximum: 20_000,
      available: async () => true, reserve: async () => true });
    changedDatabase.DB = env.DB.withSession('first-primary') as unknown as D1Database;
    expect(() => monthlyLimit(changedDatabase, 'games')).toThrow('capacity_budget_resource_changed');
  });

  it('charges finite ingress grants once and rejects all new grants/dispatches after a stop', async () => {
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    const result = await runInDurableObject(game, (_instance, state) => {
      const m = manifest();
      const create = () => new CapacityRunStore(state.storage.sql, run => state.storage.transactionSync(run), m, () => T0);
      let store = create(); store.arm();
      const grant = crypto.randomUUID();
      const accepted = store.reserveIngress(grant);
      const duplicate = store.reserveIngress(grant);
      store = create();
      const reconstructed = store.reserveIngress(grant);
      const id = crypto.randomUUID(); store.charge(`arena:${id}`, 1); store.linkGame(id, `arena:${id}`);
      const running = begin(store, 'accepted-before-stop', `game:${id}`, emptyCapacityWork());
      store.stop('owner-stop');
      const afterStop = store.reserveIngress(crypto.randomUUID());
      const workAfterStop = begin(store, 'new-after-stop', `game:${id}`, emptyCapacityWork());
      const completion = complete(store, 'accepted-before-stop', emptyCapacityWork(), { pendingNative: 0, alarm: false, sockets: 0 });
      return { accepted, duplicate, reconstructed, running, afterStop, workAfterStop, completion, status: store.status() };
    });
    expect(result).toMatchObject({ accepted: true, duplicate: false, reconstructed: false, running: true,
      afterStop: false, workAfterStop: false, completion: true,
      status: { stopReason: 'owner-stop', observed: { workerRequests: CAPACITY_INGRESS_BLOCK_REQUESTS, workerCpuMs: CAPACITY_INGRESS_BLOCK_REQUESTS * 50 } } });
  });

  it('does not double-spend grants under concurrent ingress or retry an uncertain grant', async () => {
    let grants = 0;
    const budget = new CapacityIngressBudget(Date.now() + 60_000);
    const grant = async () => { grants++; return true; };
    const responses = await Promise.all(Array.from({ length: CAPACITY_INGRESS_BLOCK_REQUESTS + 1 }, () => budget.consume(grant)));
    expect(responses.every(Boolean)).toBe(true);
    expect(grants).toBe(2);
    let attempts = 0;
    const lost = new CapacityIngressBudget(Date.now() + 60_000);
    const uncertain = async () => { attempts++; throw new Error('lost_grant_reply'); };
    expect(await Promise.all([lost.consume(uncertain), lost.consume(uncertain)])).toEqual([false, false]);
    expect(await lost.consume(uncertain)).toBe(false);
    expect(attempts).toBe(1);
  });

  it('obtains new ingress grants from the current request after each 256-slot block', async () => {
    const budget = new CapacityIngressBudget(Date.now() + 60_000);
    const grantingRequests: number[] = [];
    let currentRequest = 0;
    for (; currentRequest <= CAPACITY_INGRESS_BLOCK_REQUESTS * 2; currentRequest++) {
      const request = currentRequest;
      expect(await budget.consume(async () => {
        if (request !== currentRequest) throw new Error('request_io_expired');
        grantingRequests.push(request);
        return true;
      })).toBe(true);
    }
    expect(grantingRequests).toEqual([0, 256, 512]);
  });

  it.each(['accepted', 'denied', 'rejected', 'stopped', 'expired', 'wait-timeout'] as const)
  ('cleans request-owned ingress waits after a %s grant', async outcome => {
    vi.useFakeTimers();
    try {
      const budget = new CapacityIngressBudget(Date.now() + (outcome === 'expired' ? 100 : 60_000));
      let resolve!: (accepted: boolean) => void, reject!: (error: Error) => void;
      let attempts = 0;
      const owner = budget.consume(() => { attempts++; return new Promise<boolean>((yes, no) => { resolve = yes; reject = no; }); });
      const follower = budget.consume(async () => { attempts++; return true; });
      expect(vi.getTimerCount()).toBe(1);
      if (outcome === 'stopped') budget.stop();
      else if (outcome === 'expired') await vi.advanceTimersByTimeAsync(100);
      else if (outcome === 'wait-timeout') await vi.advanceTimersByTimeAsync(CAPACITY_INGRESS_GRANT_WAIT_MS);
      else if (outcome === 'rejected') reject(new Error('lost_grant_reply'));
      else resolve(outcome === 'accepted');
      expect(await follower).toBe(outcome === 'accepted');
      expect(vi.getTimerCount()).toBe(0);
      if (['stopped', 'expired', 'wait-timeout'].includes(outcome)) resolve(true);
      expect(await owner).toBe(outcome === 'accepted');
      if (outcome !== 'accepted') expect(await budget.consume(async () => { attempts++; return true; })).toBe(false);
      expect(attempts).toBe(1);
    } finally { vi.useRealTimers(); }
  });

  it.each(['fresh', 'retained'] as const)('preserves prepaid calls across lost replies and restart with %s tables', async schema => {
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    const result = await runInDurableObject(game, (_instance, state) => {
      if (schema === 'retained') retainedControllerTables(state.storage.sql);
      const m = manifest();
      const plan: CapacityControllerPlan = { maximumPhysicalBytes: 1_000_000,
        maximumIncarnations: 3, bootstrapEnvelope: { ...emptyCapacityWork(), doRowsRead: 10, doRowsWritten: 30 },
        methods: Object.fromEntries(CAPACITY_CONTROL_METHODS.map(method => [method, {
          maximumCalls: method === 'status' ? 2 : 1,
          envelope: { ...emptyCapacityWork(), nativeDoRequests: 1, doRowsRead: 100, doRowsWritten: 100 },
        }])) as CapacityControllerPlan['methods'] };
      const create = () => new CapacityRunStore(state.storage.sql, run => state.storage.transactionSync(run), m, () => T0);
      let store = create();
      const armed = store.arm(plan);
      const before = store.status();
      // The first reply is lost. Reconstruction must not restore its slot or
      // reduce the complete prepaid controller allowance.
      const first = store.claimControllerCall('status', plan);
      store = create();
      const second = store.claimControllerCall('status', plan, true);
      // A cold rejected method still consumes its incarnation. Reconstruction
      // or a lost response cannot make its constructor work free.
      const exhausted = store.claimControllerCall('status', plan, true);
      const changed = { ...plan, methods: { ...plan.methods, begin: { ...plan.methods.begin,
        envelope: { ...plan.methods.begin.envelope, doRowsWritten: plan.methods.begin.envelope.doRowsWritten - 1 } } } };
      const changedPlan = store.claimControllerCall('complete', changed);
      return { armed, first, second, exhausted, changedPlan, before, after: store.status() };
    });
    expect(result).toMatchObject({ armed: true, first: true, second: true, exhausted: false, changedPlan: false,
      before: { controllerIncarnations: 1, observed: {
        nativeDoRequests: 13, doRowsRead: 1_343, doRowsWritten: 1_391, doStorageBytes: 1_000_000,
        workerRequests: 32, workerCpuMs: 1_600 } },
      after: { controllerIncarnations: 3, stopReason: 'controller-call-allowance', observed: {
        nativeDoRequests: 13, doRowsRead: 1_343, doRowsWritten: 1_391, doStorageBytes: 1_000_000,
        workerRequests: 32, workerCpuMs: 1_600 } } });
  });

  it('rejects a controller plan that exceeds the shared allowance before arming', async () => {
    const methods = Object.fromEntries(CAPACITY_CONTROL_METHODS.map(method => [method, {
      maximumCalls: method === 'arm' ? 1 : CAPACITY_CEILINGS.nativeDoRequests,
      envelope: { ...emptyCapacityWork(), nativeDoRequests: 1 },
    }])) as CapacityControllerPlan['methods'];
    const plan = { maximumPhysicalBytes: 1_000_000, maximumIncarnations: 1,
      bootstrapEnvelope: emptyCapacityWork(), methods };
    expect(capacityControllerAllowance(plan)).toBeNull();
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    const armed = await runInDurableObject(game, (_instance, state) => {
      const store = new CapacityRunStore(state.storage.sql, run => state.storage.transactionSync(run), manifest(), () => T0);
      return store.arm(plan);
    });
    expect(armed).toBe(false);
  });

  it('keeps fused call and cold claims when validation or operation storage fails', async () => {
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    const result = await runInDurableObject(game, (_instance, state) => {
      const plan = controllerPlan(); const m = manifest();
      let now = T0;
      const create = () => new CapacityRunStore(state.storage.sql, run => state.storage.transactionSync(run), m, () => now);
      let store = create(); store.arm(plan);
      const prepaid = store.status();
      now++;
      expect(() => fused(store, plan, 'charge', () => store.charge('invalid', 1), true)).toThrow('capacity_charge_invalid');
      const id = crypto.randomUUID(); const receipt = `arena:${id}`;
      fused(store, plan, 'charge', () => store.charge(receipt, 1));
      fused(store, plan, 'linkGame', () => store.linkGame(id, receipt));
      // Fail after begin inserts its dispatch. The operation's native nested
      // transaction must roll it back while the outer call claim commits.
      state.storage.sql.exec(`CREATE TRIGGER fixture_permit_failure BEFORE UPDATE OF unresolved ON capacity_permits
        BEGIN SELECT RAISE(ABORT,'fixture_permit_failure'); END`);
      expect(() => fused(store, plan, 'begin', () => store.begin('rolled-back-dispatch', `game:${id}`,
        'Game.status', { ...emptyCapacityWork(), doRowsWritten: 7 }))).toThrow('fixture_permit_failure');
      state.storage.sql.exec('DROP TRIGGER fixture_permit_failure');
      store = create();
      return { prepaid, final: store.status(),
        ledger: state.storage.sql.exec<{ controller_calls: string; last_now: number }>(
          'SELECT controller_calls,last_now FROM capacity_run WHERE id=1').one(),
        dispatch: state.storage.sql.exec("SELECT 1 FROM capacity_dispatches WHERE id='rolled-back-dispatch'").toArray(),
        permit: state.storage.sql.exec<{ unresolved: number }>('SELECT unresolved FROM capacity_permits WHERE object_key=?', `game:${id}`).one() };
    });
    expect(result.final).toMatchObject({ charges: 1, activeObjects: 3, unresolvedDispatches: 0, controllerIncarnations: 2,
      stopReason: null, reserved: emptyCapacityWork() });
    expect(result.final).toMatchObject({ observed: result.prepaid.armed ? result.prepaid.observed : {} });
    expect(JSON.parse(result.ledger.controller_calls)).toMatchObject({ arm: 1, charge: 2, linkGame: 1, begin: 1 });
    expect(result.ledger.last_now).toBe(T0 + 1);
    expect(result.dispatch).toEqual([]);
    expect(result.permit.unresolved).toBe(0);
  });

  it.each(['fresh', 'retained'] as const)('preserves fused receipts, first links and retirement fences with %s tables', async schema => {
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    const result = await runInDurableObject(game, (_instance, state) => {
      if (schema === 'retained') retainedControllerTables(state.storage.sql);
      const plan = controllerPlan(); const m = manifest();
      const create = () => new CapacityRunStore(state.storage.sql, run => state.storage.transactionSync(run), m, () => T0);
      let store = create(); store.arm(plan);
      const id = crypto.randomUUID(); const receipt = `arena:${id}`; const key = `game:${id}`;
      expect(fused(store, plan, 'charge', () => store.charge(receipt, 1))).toBe(true);
      expect(fused(store, plan, 'charge', () => store.charge(receipt, 2))).toBe(false);
      expect(fused(store, plan, 'linkGame', () => store.linkGame(id, receipt))).toBe(true);
      expect(fused(store, plan, 'linkGame', () => store.linkGame(crypto.randomUUID(), receipt))).toBe(false);
      const envelope = { ...emptyCapacityWork(), doRowsWritten: 7 };
      const ticket = fused(store, plan, 'begin', () => store.begin('fused-dispatch', key, 'Game.status', envelope));
      if (!ticket) throw new Error('fixture_dispatch');
      store = create();
      expect(fused(store, plan, 'charge', () => store.charge(receipt, 1))).toBe(true);
      expect(fused(store, plan, 'begin', () => store.begin('fused-dispatch', key, 'Game.status', envelope))).toBeNull();
      expect(fused(store, plan, 'prepareRetirement', () => store.prepareRetirement(key, emptyCapacityWork()))).toBeNull();
      const held = store.status();
      expect(store.complete(ticket, emptyCapacityWork(), { pendingNative: 0, alarm: false, sockets: 0,
        alarmPossible: false, socketPossible: false })).toBe(true);
      const retirement = fused(store, plan, 'prepareRetirement', () => store.prepareRetirement(key, envelope));
      if (!retirement) throw new Error('fixture_retirement');
      store = create();
      expect(fused(store, plan, 'linkGame', () => store.linkGame(id, receipt))).toBe(false);
      expect(store.confirmRetirement(retirement, 'connection_closed')).toBe(false);
      expect(store.confirmRetirement(retirement, capacityRetirementAck(retirement))).toBe(true);
      expect(store.confirmRetirement(retirement, capacityRetirementAck(retirement))).toBe(false);
      expect(fused(store, plan, 'linkGame', () => store.linkGame(id, receipt))).toBe(true);
      const next = fused(store, plan, 'begin', () => store.begin('fused-next-generation', key, 'Game.status', emptyCapacityWork()));
      if (schema === 'retained') expect(state.storage.sql.exec('SELECT rowid FROM capacity_game_ids').toArray()).toHaveLength(1);
      return { held, final: store.status(), generation: next?.generation };
    });
    expect(result).toMatchObject({ held: { charges: 1, activeObjects: 3, unresolvedDispatches: 1,
      reserved: { doRowsWritten: 7 } }, final: { charges: 1, activeObjects: 3, unresolvedDispatches: 1,
      reserved: emptyCapacityWork() }, generation: 2 });
    if (!result.held.armed || !result.final.armed) throw new Error('fixture_armed');
    expect(result.final.observed).toEqual({ ...result.held.observed, doRowsWritten: result.held.observed.doRowsWritten + 7 });
  });

  it('commits fused expiry denials without regressing the retained clock', async () => {
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    const result = await runInDurableObject(game, (_instance, state) => {
      const m = manifest(); const plan = controllerPlan(); let now = T0;
      const store = new CapacityRunStore(state.storage.sql, run => state.storage.transactionSync(run), m, () => now);
      store.arm(plan);
      const receipt = `arena:${crypto.randomUUID()}`;
      fused(store, plan, 'charge', () => store.charge(receipt, 1));
      now = m.admissionsCloseAt;
      const admission = fused(store, plan, 'charge', () => store.charge(`arena:${crypto.randomUUID()}`, 1));
      const existing = fused(store, plan, 'charge', () => store.charge(receipt, 1));
      now = m.issueCloseAt;
      const work = fused(store, plan, 'begin', () => store.begin('fused-expired', 'competition', 'Competition.health', emptyCapacityWork()));
      now--;
      let reached = false;
      expect(() => fused(store, plan, 'available', () => { reached = true; return store.available(); })).toThrow('fixture_controller_denied');
      const ledger = state.storage.sql.exec<{ last_now: number; controller_calls: string }>(
        'SELECT last_now,controller_calls FROM capacity_run WHERE id=1').one();
      return { admission, existing, work, reached, ledger, final: store.status() };
    });
    expect(result).toMatchObject({ admission: false, existing: true, work: null, reached: false,
      final: { charges: 1, activeObjects: 2, unresolvedDispatches: 0, stopReason: 'admission-expired' } });
    expect(result.ledger.last_now).toBe(manifest().issueCloseAt);
    expect(JSON.parse(result.ledger.controller_calls)).toMatchObject({ charge: 3, begin: 1, available: 0 });
  });

  it('denies unfunded cold restarts and corrupt call counters without refunding the prepaid plan', async () => {
    const plan: CapacityControllerPlan = { maximumPhysicalBytes: 1_000_000, maximumIncarnations: 1,
      bootstrapEnvelope: { ...emptyCapacityWork(), doRowsRead: 10, doRowsWritten: 30 },
      methods: Object.fromEntries(CAPACITY_CONTROL_METHODS.map(method => [method, {
        maximumCalls: 4, envelope: { ...emptyCapacityWork(), nativeDoRequests: 1, doRowsRead: 100, doRowsWritten: 100 },
      }])) as CapacityControllerPlan['methods'] };
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    const result = await runInDurableObject(game, (_instance, state) => {
      const m = manifest();
      const create = () => new CapacityRunStore(state.storage.sql, run => state.storage.transactionSync(run), m, () => T0);
      let store = create();
      const armed = store.arm(plan); const before = store.status();
      store = create();
      const cold = store.enterController('begin', plan, true); const after = store.status();
      state.storage.sql.exec('UPDATE capacity_run SET controller_calls=? WHERE id=1', JSON.stringify({ arm: 1 }));
      const corrupt = store.enterController('complete', plan, false);
      return { armed, cold, corrupt, before, after, final: store.status() };
    });
    expect(result).toMatchObject({ armed: true, cold: null, corrupt: null,
      before: { controllerIncarnations: 1 },
      after: { controllerIncarnations: 1, stopReason: 'controller-incarnation-allowance' } });
    expect(result.after).toMatchObject({ observed: result.before.armed ? result.before.observed : {} });
    expect(result.final).toMatchObject({ observed: result.before.armed ? result.before.observed : {} });
  });

  it('charges physical storage high water marks once and keeps unknown growth reserved', async () => {
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    const result = await runInDurableObject(game, (_instance, state) => {
      const store = new CapacityRunStore(state.storage.sql, run => state.storage.transactionSync(run), manifest(), () => T0);
      store.arm(); const id = crypto.randomUUID();
      store.charge(`arena:${id}`, 1); store.linkGame(id, `arena:${id}`);
      const first = { ...emptyCapacityWork(), doStorageBytes: 100_000, d1StorageBytes: 100_000 };
      const next = { ...emptyCapacityWork(), doStorageBytes: 10_000, d1StorageBytes: 10_000 };
      begin(store, 'first-bytes', `game:${id}`, first);
      const firstUsage = { ...emptyCapacityWork(), doStorageBytes: 64_000, d1StorageBytes: 80_000 };
      const completed = complete(store, 'first-bytes', firstUsage, { pendingNative: 0, alarm: false, sockets: 0 });
      const duplicate = complete(store, 'first-bytes', firstUsage, { pendingNative: 0, alarm: false, sockets: 0 });
      begin(store, 'next-bytes', `game:${id}`, next);
      const progressed = complete(store, 'next-bytes', { ...emptyCapacityWork(), doStorageBytes: 70_000, d1StorageBytes: 90_000 },
        { pendingNative: 0, alarm: false, sockets: 0 });
      begin(store, 'uncertain-bytes', `game:${id}`, next);
      const refused = complete(store, 'uncertain-bytes', { ...emptyCapacityWork(), doStorageBytes: 90_000, d1StorageBytes: 90_000 },
        { pendingNative: 0, alarm: false, sockets: 0 });
      return { completed, duplicate, progressed, refused, status: store.status() };
    });
    expect(result).toMatchObject({ completed: true, duplicate: true, progressed: true, refused: false,
      status: { stopReason: 'native-envelope-exceeded', unresolvedDispatches: 1,
        observed: { doStorageBytes: 70_000, d1StorageBytes: 90_000 },
        reserved: { doStorageBytes: 10_000, d1StorageBytes: 10_000 } } });
  });

  it('rejects a changed source under the same digest and regressed completion clocks', async () => {
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    const result = await runInDurableObject(game, (_instance, state) => {
      const m = manifest(); let now = T0;
      const create = (value = m) => new CapacityRunStore(state.storage.sql, run => state.storage.transactionSync(run), value, () => now);
      const store = create(); store.arm(); const id = crypto.randomUUID();
      store.charge(`arena:${id}`, 1); store.linkGame(id, `arena:${id}`);
      begin(store, 'pending-clock', `game:${id}`, emptyCapacityWork());
      const changed = create({ ...m, sourceDigest: 'd'.repeat(64) });
      const newCharge = changed.charge(`arena:${crypto.randomUUID()}`, 1);
      const changedCompletion = complete(changed, 'pending-clock', emptyCapacityWork(), { pendingNative: 0, alarm: false, sockets: 0 });
      now--;
      const regressed = complete(store, 'pending-clock', emptyCapacityWork(), { pendingNative: 0, alarm: false, sockets: 0 });
      return { newCharge, changedCompletion, regressed, status: store.status() };
    });
    expect(result).toMatchObject({ newCharge: false, changedCompletion: false, regressed: false,
      status: { stopReason: 'clock-regressed', unresolvedDispatches: 1 } });
  });

  it('fences every unresolved caller and consumes one exact generation retirement before reacquiring', async () => {
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    const result = await runInDurableObject(game, (_instance, state) => {
      const m = manifest();
      const create = () => new CapacityRunStore(state.storage.sql, run => state.storage.transactionSync(run), m, () => T0);
      let store = create(); store.arm();
      const id = crypto.randomUUID(); const key = `game:${id}`; const receipt = `arena:${id}`;
      store.charge(receipt, 1); store.linkGame(id, receipt);
      const ticket = store.begin('queued-rpc', key, 'Game.status', emptyCapacityWork());
      if (!ticket) throw new Error('fixture_dispatch');
      const whileQueued = store.prepareRetirement(key, emptyCapacityWork());
      const completed = store.complete(ticket, emptyCapacityWork(), {
        pendingNative: 0, alarm: false, sockets: 0, alarmPossible: true, socketPossible: false });
      const prepaid = { ...emptyCapacityWork(), nativeDoRequests: 8, doRowsWritten: 100, doRowsRead: 100 };
      const retirement = store.prepareRetirement(key, prepaid);
      if (!retirement) throw new Error('fixture_retirement');
      const whileFenced = store.begin('after-fence', key, 'Game.status', emptyCapacityWork());
      const relinkWhileFenced = store.linkGame(id, receipt);
      const duplicatePrepare = store.prepareRetirement(key, prepaid);
      const wrongMessage = store.confirmRetirement(retirement, 'connection_closed');
      const wrongNonce = store.confirmRetirement({ ...retirement, nonce: crypto.randomUUID() }, capacityRetirementAck(retirement));
      store = create();
      const beforeAck = store.status();
      // The store fixture supplies the raw emitter's exact acknowledgment.
      // Native running-alarm/reset semantics are covered by a separate probe.
      const confirmed = store.confirmRetirement(retirement, capacityRetirementAck(retirement));
      const repeatedAck = store.confirmRetirement(retirement, capacityRetirementAck(retirement));
      const retired = store.status();
      const reacquired = store.linkGame(id, receipt);
      const next = store.begin('next-generation', key, 'Game.status', emptyCapacityWork());
      const lateOldAck = store.confirmRetirement(retirement, capacityRetirementAck(retirement));
      return { whileQueued, completed, whileFenced, relinkWhileFenced, duplicatePrepare, wrongMessage, wrongNonce,
        beforeAck, confirmed, repeatedAck, retired, reacquired, generation: next?.generation, lateOldAck, final: store.status() };
    });
    expect(result).toMatchObject({ whileQueued: null, completed: true, whileFenced: null, relinkWhileFenced: false,
      duplicatePrepare: null, wrongMessage: false, wrongNonce: false,
      beforeAck: { activeObjects: 3, observed: { nativeDoRequests: 8, doRowsWritten: 100, doRowsRead: 100 } },
      confirmed: true, repeatedAck: false, retired: { activeObjects: 2 }, reacquired: true, generation: 2,
      lateOldAck: false, final: { activeObjects: 3, unresolvedDispatches: 1 } });
  });

  it('retains every socket generation and all lost or expired retirement allowances', async () => {
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    const result = await runInDurableObject(game, (_instance, state) => {
      const m = manifest(); let now = T0;
      const create = () => new CapacityRunStore(state.storage.sql, run => state.storage.transactionSync(run), m, () => now);
      let store = create(); store.arm();
      const link = () => { const id = crypto.randomUUID(); store.charge(`casual:${id}`, 1); store.linkGame(id, `casual:${id}`); return `game:${id}`; };
      const socketKey = link();
      const ticket = store.begin('past-socket', socketKey, 'Game.snapshot', emptyCapacityWork());
      if (!ticket) throw new Error('fixture_dispatch');
      store.complete(ticket, emptyCapacityWork(), { pendingNative: 0, alarm: false, sockets: 0, alarmPossible: false, socketPossible: true });
      const socketRetirement = store.prepareRetirement(socketKey, emptyCapacityWork());
      const quietKey = link();
      const prepaid = { ...emptyCapacityWork(), nativeDoRequests: 8, doRowsWritten: 100 };
      const retirement = store.prepareRetirement(quietKey, prepaid);
      if (!retirement) throw new Error('fixture_retirement');
      store = create();
      const lostRetry = store.prepareRetirement(quietKey, prepaid);
      const afterLost = store.status();
      now = m.hardCloseAt;
      const afterExpiry = store.confirmRetirement(retirement, capacityRetirementAck(retirement));
      return { socketRetirement, lostRetry, afterLost, afterExpiry, final: store.status() };
    });
    expect(result).toMatchObject({ socketRetirement: null, lostRetry: null,
      afterLost: { activeObjects: 4, observed: { nativeDoRequests: 8, doRowsWritten: 100 } },
      afterExpiry: false, final: { activeObjects: 4, stopReason: 'compute-expired' } });
  });
});
