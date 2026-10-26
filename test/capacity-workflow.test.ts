import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { CapacityNativeMeter } from '../src/server/capacity-meter';
import { CapacityWorkflowLedger, type CapacityWorkflowPlan } from '../src/server/capacity-workflow';
import { CapacityRegistrationClaims, claimCapacityStep } from '../src/server/capacity-protocol';
import { CAPACITY_WORKFLOW_CANDIDATES } from '../src/server/capacity-work-plan';
import { CAPACITY_NATIVE_CANDIDATE_ENVELOPES } from '../src/server/capacity-candidate-plan';
import { CapacityTicketCodec, emptyCapacityWork } from '../src/server/capacity-run';
import { capacityFixtureManifest } from './capacity-fixtures';

const work = (writes: number) => ({ ...emptyCapacityWork(), nativeDoRequests: 1,
  doRowsRead: 128, doRowsWritten: writes, doStorageBytes: 128 * 1024 });
const plan = (events = 4): CapacityWorkflowPlan => ({ maximumEvents: events,
  envelope: { ...work(12), nativeDoRequests: events, doRowsRead: 512 }, maximumEventWork: work(8) });

async function registrationFixture(run: (context: {
  state: DurableObjectState; ledger: CapacityWorkflowLedger; claims: CapacityRegistrationClaims;
  ticket: Awaited<ReturnType<CapacityTicketCodec['dispatch']>>; envelope: ReturnType<typeof work>;
  event(): CapacityNativeMeter; sql: SqlStorage;
}) => void): Promise<void> {
  const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
  await runInDurableObject(game, async (_instance, state) => {
    let current = new CapacityNativeMeter();
    const sql = new Proxy(state.storage.sql, { get(target, key) {
      const measured = current.sql(target), value = Reflect.get(measured, key, measured);
      return typeof value === 'function' ? value.bind(measured) : value;
    } });
    const manifest = capacityFixtureManifest();
    const ticket = await new CapacityTicketCodec(env.AUTH_SECRET).dispatch({ runId: manifest.runId,
      manifestDigest: manifest.digest, id: crypto.randomUUID(), objectKey: 'competition',
      generation: 1, operation: 'Competition.workflow', mode: 'workflow' });
    const ledger = new CapacityWorkflowLedger(sql, task => state.storage.transactionSync(task), CAPACITY_WORKFLOW_CANDIDATES.competition);
    run({ state, sql, ledger, ticket, claims: new CapacityRegistrationClaims(sql),
      envelope: CAPACITY_NATIVE_CANDIDATE_ENVELOPES['Competition.qualificationRegister'],
      event: () => (current = new CapacityNativeMeter()) });
  });
}

describe('prepaid native capacity workflow', () => {
  it('reserves the named operation and records the actual completion tail across cold starts', async () => {
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    await runInDurableObject(game, async (_instance, state) => {
      const manifest = capacityFixtureManifest();
      const ticket = await new CapacityTicketCodec(env.AUTH_SECRET).dispatch({ runId: manifest.runId,
        manifestDigest: manifest.digest, id: crypto.randomUUID(), objectKey: `game:${state.id.name}`,
        generation: 1, operation: 'Game.workflow', mode: 'workflow' });
      const execute = (close: boolean) => {
        const meter = new CapacityNativeMeter(), sql = meter.sql(state.storage.sql);
        const ledger = new CapacityWorkflowLedger(sql, run => state.storage.transactionSync(run), plan());
        const ordinal = ledger.claim(ticket, work(4));
        const total = ledger.finish(ordinal, meter, close);
        expect(total.doRowsWritten).toBeGreaterThanOrEqual(meter.snapshot().doRowsWritten);
        expect(total.doRowsRead).toBeGreaterThanOrEqual(meter.snapshot().doRowsRead);
        return total;
      };
      const first = execute(false), second = execute(true);
      expect(first.nativeDoRequests).toBe(1);
      expect(second.nativeDoRequests).toBe(2);
      expect(second.doRowsWritten).toBeGreaterThan(first.doRowsWritten);
      expect(() => execute(false)).toThrow('capacity_workflow_unresolved');
      expect(state.storage.sql.exec<{ unresolved: number; closed: number }>('SELECT unresolved,closed FROM capacity_wrapper_workflow WHERE id=1').one())
        .toEqual({ unresolved: 0, closed: 1 });
    });
  });

  it('keeps an interrupted reservation after reconstruction and rejects new native work', async () => {
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    await runInDurableObject(game, async (_instance, state) => {
      const manifest = capacityFixtureManifest();
      const ticket = await new CapacityTicketCodec(env.AUTH_SECRET).dispatch({ runId: manifest.runId,
        manifestDigest: manifest.digest, id: crypto.randomUUID(), objectKey: `game:${state.id.name}`,
        generation: 1, operation: 'Game.workflow', mode: 'workflow' });
      const create = () => new CapacityWorkflowLedger(new CapacityNativeMeter().sql(state.storage.sql),
        run => state.storage.transactionSync(run), plan());
      expect(create().claim(ticket, work(4))).toBe(1);
      expect(() => create().claim(ticket, work(4))).toThrow('capacity_workflow_unresolved');
      const held = state.storage.sql.exec<{ unresolved: number; reserved: string }>('SELECT unresolved,reserved FROM capacity_wrapper_workflow WHERE id=1').one();
      expect(held.unresolved).toBe(1);
      expect(JSON.parse(held.reserved).doRowsWritten).toBe(4);
    });
  });

  it('refuses a next operation that cannot fit without spending or refunding its slot', async () => {
    const game = env.GAME.get(env.GAME.idFromName(crypto.randomUUID()));
    await runInDurableObject(game, async (_instance, state) => {
      const manifest = capacityFixtureManifest();
      const ticket = await new CapacityTicketCodec(env.AUTH_SECRET).dispatch({ runId: manifest.runId,
        manifestDigest: manifest.digest, id: crypto.randomUUID(), objectKey: `game:${state.id.name}`,
        generation: 1, operation: 'Game.workflow', mode: 'workflow' });
      const meter = new CapacityNativeMeter();
      const ledger = new CapacityWorkflowLedger(meter.sql(state.storage.sql), run => state.storage.transactionSync(run),
        { ...plan(), envelope: { ...plan().envelope, doRowsWritten: 8 } });
      ledger.claim(ticket, work(8));
      expect(() => ledger.claim(ticket, work(4))).toThrow('capacity_workflow_allowance');
      expect(state.storage.sql.exec<{ events: number; unresolved: number }>('SELECT events,unresolved FROM capacity_wrapper_workflow WHERE id=1').one())
        .toEqual({ events: 1, unresolved: 1 });
    });
  });

  it('prepays full registration envelopes, uses no middle guard writes and keeps permanent replay bits', async ({ task }) => {
    const writes: number[] = [];
    await registrationFixture(({ state, sql, ledger, claims, ticket, envelope, event }) => {
      for (let index = 0; index < 32; index++) {
        const meter = event(), permit = claims.claim(index, ledger, ticket, envelope)!;
        expect(permit.consume()).toBe(true);
        expect(permit.consume()).toBe(false);
        if (index === 0) {
          const held = state.storage.sql.exec('SELECT events,unresolved,reserved FROM capacity_wrapper_workflow').one();
          expect(held).toMatchObject({ events: 32, unresolved: 32 });
          for (const key of ['nativeDoRequests', 'doRowsRead', 'doRowsWritten', 'd1RowsRead', 'd1RowsWritten'] as const) {
            expect(JSON.parse(String(held.reserved))[key]).toBe(32 * envelope[key]);
          }
        }
        const before = meter.snapshot().doRowsWritten;
        ledger.finish(permit.ordinal, meter);
        if (index < 31) expect(meter.snapshot().doRowsWritten).toBe(before);
        writes.push(meter.snapshot().doRowsWritten);
        expect(claims.claim(index, ledger, ticket, envelope)).toBeUndefined();
        expect(() => ledger.finish(permit.ordinal, meter)).toThrow('capacity_workflow_completion_invalid');
      }
      expect(writes.slice(1, 31)).toEqual(Array(30).fill(0));
      expect(writes[31]).toBe(1);
      expect(state.storage.sql.exec('SELECT events,unresolved,stopped FROM capacity_wrapper_workflow').one())
        .toMatchObject({ events: 32, unresolved: 0, stopped: 0 });
      expect(claimCapacityStep(sql, work => state.storage.transactionSync(work), 0)).toBe(false);
      expect(claimCapacityStep(sql, work => state.storage.transactionSync(work), 32)).toBe(true);
      const reconstructed = new CapacityWorkflowLedger(sql, work => state.storage.transactionSync(work), CAPACITY_WORKFLOW_CANDIDATES.competition);
      expect(new CapacityRegistrationClaims(sql).claim(0, reconstructed, ticket, envelope)).toBeUndefined();
    });
    (task.meta as Record<string, unknown>).registrationGuard = { slots: 32, eventWrites: writes,
      scope: 'Native SQLite guard measurements only. No provider latency or throughput claim.' };
  });

  it('keeps unused and lost registration slots held and rejects cold reconstruction', async () => {
    await registrationFixture(({ state, sql, ledger, claims, ticket, envelope, event }) => {
      const meter = event(), permit = claims.claim(31, ledger, ticket, envelope)!;
      expect(permit.consume()).toBe(true);
      ledger.finish(permit.ordinal, meter);
      const lost = claims.claim(0, ledger, ticket, envelope)!;
      expect(lost.consume()).toBe(true);
      expect(claims.claim(0, ledger, ticket, envelope)).toBeUndefined();
      expect(claimCapacityStep(sql, work => state.storage.transactionSync(work), 0)).toBe(false);
      const held = state.storage.sql.exec('SELECT events,unresolved,reserved,observed FROM capacity_wrapper_workflow').one();
      expect(held).toMatchObject({ events: 32, unresolved: 32 });
      expect(JSON.parse(String(held.reserved)).nativeDoRequests).toBe(32);
      const cold = new CapacityWorkflowLedger(sql, work => state.storage.transactionSync(work), CAPACITY_WORKFLOW_CANDIDATES.competition);
      expect(() => cold.claim(ticket, envelope)).toThrow('capacity_workflow_unresolved');
      expect(() => new CapacityRegistrationClaims(sql).claim(1, cold, ticket, envelope)).toThrow('capacity_workflow_unresolved');
      expect(state.storage.sql.exec('SELECT events,unresolved,reserved,observed FROM capacity_wrapper_workflow').one()).toEqual(held);
    });
  });

  it('claims only the final sixteen burst bits and rolls back a conflicting block atomically', async () => {
    await registrationFixture(({ state, sql, ledger, claims, ticket, envelope, event }) => {
      for (let index = 9_984; index < 10_000; index++) {
        const meter = event(), permit = claims.claim(index, ledger, ticket, envelope)!;
        expect(permit.consume()).toBe(true);
        ledger.finish(permit.ordinal, meter);
      }
      expect(state.storage.sql.exec('SELECT events,unresolved FROM capacity_wrapper_workflow').one())
        .toEqual({ events: 16, unresolved: 0 });
      expect(claims.claim(10_000, ledger, ticket, envelope)).toBeUndefined();
      expect(claimCapacityStep(sql, work => state.storage.transactionSync(work), 10_000)).toBe(true);
      expect(claimCapacityStep(sql, work => state.storage.transactionSync(work), 30)).toBe(true);
      const before = state.storage.sql.exec('SELECT events,unresolved,reserved FROM capacity_wrapper_workflow').one();
      expect(claims.claim(0, ledger, ticket, envelope)).toBeUndefined();
      expect(state.storage.sql.exec('SELECT events,unresolved,reserved FROM capacity_wrapper_workflow').one()).toEqual(before);
      expect(claimCapacityStep(sql, work => state.storage.transactionSync(work), 0)).toBe(true);
    });
  });

  it('retains every block reservation and saves measured work when one event exceeds its envelope', async () => {
    await registrationFixture(({ state, sql, ledger, claims, ticket, envelope, event }) => {
      const meter = event(), permit = claims.claim(0, ledger, ticket, envelope)!;
      expect(permit.consume()).toBe(true);
      sql.exec('CREATE TABLE capacity_guard_overrun(id INTEGER PRIMARY KEY)');
      for (let index = 0; index < 65; index++) sql.exec('INSERT INTO capacity_guard_overrun VALUES(?)', index);
      expect(() => ledger.finish(permit.ordinal, meter)).toThrow('capacity_workflow_envelope_exceeded');
      const held = state.storage.sql.exec('SELECT stopped,events,unresolved,reserved,observed FROM capacity_wrapper_workflow').one();
      expect(held).toMatchObject({ stopped: 1, events: 32, unresolved: 32 });
      expect(JSON.parse(String(held.reserved)).doRowsWritten).toBe(32 * envelope.doRowsWritten);
      expect(JSON.parse(String(held.observed)).doRowsWritten).toBeGreaterThan(envelope.doRowsWritten);
      expect(() => claims.claim(1, ledger, ticket, envelope)).toThrow('capacity_workflow_unresolved');
    });
  });
});
