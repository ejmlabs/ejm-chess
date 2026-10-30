import { emptyCapacityWork, type CapacityDispatch, type CapacityTicket, type CapacityWorkUnits } from './capacity-run';
import type { CapacityNativeMeter, CapacityNativeUsage } from './capacity-meter';
import { capacityIntent, capacityRecoveryReleaseAt } from '../shared/capacity-corpus';

/** The complete prepaid object lifetime, including wrapper and shutdown work. */
export interface CapacityWorkflowPlan {
  maximumEvents: number;
  envelope: CapacityWorkUnits;
  maximumEventWork: CapacityWorkUnits;
}

const KEYS = Object.keys(emptyCapacityWork()) as (keyof CapacityWorkUnits)[];
const STORAGE = new Set<keyof CapacityWorkUnits>(['doStorageBytes', 'd1StorageBytes']);
interface WorkflowRow extends Record<string, SqlStorageValue> {
  ticket: string; events: number; unresolved: number; stopped: number; closed: number; profile: number;
  intent_index: number | null; recovery_attempted: number; observed: string; reserved: string;
  retry_read_surcharge: number;
}

interface WorkflowBlock {
  first: number;
  count: number;
  remaining: number;
  actual: CapacityWorkUnits;
  retryReadSurcharge: number;
  completed: Set<number>;
}

function addWork(target: CapacityWorkUnits, value: CapacityWorkUnits): void {
  for (const key of KEYS) target[key] = STORAGE.has(key) ? Math.max(target[key], value[key]) : target[key] + value[key];
}

export function capacityUsageWork(usage: CapacityNativeUsage): CapacityWorkUnits {
  return { ...emptyCapacityWork(), nativeDoRequests: 1, doRowsRead: usage.doRowsRead,
    doRowsWritten: usage.doRowsWritten, d1RowsRead: usage.d1RowsRead + (usage.d1RetryReadSurcharge ?? 0), d1RowsWritten: usage.d1RowsWritten,
    doStorageBytes: usage.doStorageBytes, d1StorageBytes: usage.d1StorageBytes };
}

/**
 * One finite funding ticket covers this object's complete native workflow.
 * Every delivery spends a durable event slot before product work. Completion
 * uses measured native work and retains a one-row completion tail. A cold
 * object with an interrupted event cannot refund or reuse its reservation.
 * Native product commands and corpus step claims retain their own replay rules.
 */
export class CapacityWorkflowLedger {
  private active = new Map<number, CapacityWorkUnits>();
  private blocks = new Map<number, WorkflowBlock>();
  private pending = emptyCapacityWork();
  private stopped = false;
  private profile = 0;
  private intentIndex: number | null = null;
  private recoveryAttempted = false;
  constructor(private sql: SqlStorage, private transact: <R>(run: () => R) => R,
    private plan: CapacityWorkflowPlan, private profiles?: { delayed: CapacityWorkflowPlan; socket: CapacityWorkflowPlan }) {
    if (!Number.isSafeInteger(plan.maximumEvents) || plan.maximumEvents < 1
      || KEYS.some(key => !Number.isSafeInteger(plan.envelope[key]) || plan.envelope[key] < 0
        || !Number.isSafeInteger(plan.maximumEventWork[key]) || plan.maximumEventWork[key] < 0
        || plan.maximumEventWork[key] > plan.envelope[key])) throw new Error('capacity_workflow_plan_invalid');
  }

  /** Only a verified fixed-corpus binding may select a larger Game profile. */
  gameProfile(profile: 'delayed' | 'socket'): void {
    if (!this.profiles) throw new Error('capacity_game_workflow_plan_missing');
    const next = profile === 'delayed' ? 1 : 2;
    if (this.profile !== 0 && this.profile !== next) throw new Error('capacity_workflow_profile_conflict');
    this.plan = this.profiles[profile];
    this.profile = next;
  }

  bindIntent(index: number): void {
    const intent = capacityIntent(index);
    if (this.intentIndex !== null && this.intentIndex !== index) throw new Error('capacity_workflow_intent_conflict');
    if (intent.kind !== 'regular') this.gameProfile(intent.kind);
    this.intentIndex = index;
  }

  recoveryAt(setupEndsAt: number): number | null {
    return this.intentIndex !== null && capacityIntent(this.intentIndex).kind === 'delayed' && !this.recoveryAttempted
      ? capacityRecoveryReleaseAt(this.intentIndex, setupEndsAt) : null;
  }
  claimRecovery(): void {
    if (this.intentIndex === null || capacityIntent(this.intentIndex).kind !== 'delayed' || this.recoveryAttempted) {
      throw new Error('capacity_recovery_invalid');
    }
    this.recoveryAttempted = true;
  }

  claim(ticket: CapacityTicket<CapacityDispatch>, warmEnvelope: CapacityWorkUnits, cold = false): number {
    return this.reserve(ticket, warmEnvelope, cold, 1);
  }

  /** Exact corpus bits and every full event envelope commit together. */
  claimBlock(ticket: CapacityTicket<CapacityDispatch>, envelope: CapacityWorkUnits, count: number,
    claimSteps: () => void): number {
    if (!Number.isSafeInteger(count) || count < 2 || count > 32) throw new Error('capacity_workflow_block_invalid');
    const first = this.reserve(ticket, envelope, false, count, claimSteps);
    const block: WorkflowBlock = { first, count, remaining: count, actual: emptyCapacityWork(),
      retryReadSurcharge: 0, completed: new Set() };
    for (let offset = 0; offset < count; offset++) this.blocks.set(first + offset, block);
    return first;
  }

  /** Warm credits still check the durable stop, identity and unresolved fence. */
  claimReserved(ticket: CapacityTicket<CapacityDispatch>, ordinal: number): void {
    const block = this.blocks.get(ordinal);
    if (this.stopped || !block || block.completed.has(ordinal) || !this.active.has(ordinal)) {
      throw new Error('capacity_workflow_unresolved');
    }
    const saved = this.sql.exec<WorkflowRow>('SELECT * FROM capacity_wrapper_workflow WHERE id=1').one();
    if (saved.ticket !== JSON.stringify(ticket) || saved.stopped !== 0 || saved.closed !== 0
      || saved.unresolved !== this.active.size) throw new Error('capacity_workflow_unresolved');
  }

  private reserve(ticket: CapacityTicket<CapacityDispatch>, warmEnvelope: CapacityWorkUnits, cold: boolean,
    count: number, claimSteps?: () => void): number {
    let reservedEnvelope!: CapacityWorkUnits;
    const first = this.transact(() => {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS capacity_wrapper_workflow(id INTEGER PRIMARY KEY CHECK(id=1),
        ticket TEXT NOT NULL,events INTEGER NOT NULL,unresolved INTEGER NOT NULL,stopped INTEGER NOT NULL,
        closed INTEGER NOT NULL,profile INTEGER NOT NULL,intent_index INTEGER,recovery_attempted INTEGER NOT NULL,
        observed TEXT NOT NULL,reserved TEXT NOT NULL,retry_read_surcharge INTEGER NOT NULL DEFAULT 0)`);
      const saved = this.sql.exec<WorkflowRow>('SELECT * FROM capacity_wrapper_workflow WHERE id=1').toArray()[0];
      if (saved?.profile === 1 || saved?.profile === 2) this.gameProfile(saved.profile === 1 ? 'delayed' : 'socket');
      else if (saved && saved.profile !== 0) throw new Error('capacity_workflow_profile_invalid');
      if (saved?.intent_index !== undefined && saved.intent_index !== null) this.bindIntent(saved.intent_index);
      if (saved) this.recoveryAttempted = saved.recovery_attempted === 1;
      const identity = JSON.stringify(ticket);
      if (this.stopped || (saved && (saved.ticket !== identity || saved.stopped !== 0 || saved.closed !== 0
        || saved.unresolved !== this.active.size))) throw new Error('capacity_workflow_unresolved');
      const events = saved?.events ?? 0;
      const observed = saved ? JSON.parse(saved.observed) as CapacityWorkUnits : emptyCapacityWork();
      const reserved = saved ? JSON.parse(saved.reserved) as CapacityWorkUnits : emptyCapacityWork();
      const envelope = cold ? this.plan.maximumEventWork : { ...warmEnvelope,
        doStorageBytes: this.plan.maximumEventWork.doStorageBytes, d1StorageBytes: this.plan.maximumEventWork.d1StorageBytes };
      if (KEYS.some(key => !Number.isSafeInteger(envelope[key]) || envelope[key] < 0
        || envelope[key] > this.plan.maximumEventWork[key])) throw new Error('capacity_workflow_event_invalid');
      if (events + count > this.plan.maximumEvents || KEYS.some(key => STORAGE.has(key)
        ? Math.max(observed[key], envelope[key]) > this.plan.envelope[key]
        : observed[key] + reserved[key] + count * envelope[key] > this.plan.envelope[key])) {
        throw new Error('capacity_workflow_allowance');
      }
      claimSteps?.();
      for (const key of KEYS) if (!STORAGE.has(key)) reserved[key] += count * envelope[key];
      if (saved) this.sql.exec('UPDATE capacity_wrapper_workflow SET events=events+?,unresolved=unresolved+?,reserved=? WHERE id=1',
        count, count, JSON.stringify(reserved));
      else this.sql.exec(`INSERT INTO capacity_wrapper_workflow(id,ticket,events,unresolved,stopped,closed,profile,intent_index,
        recovery_attempted,observed,reserved,retry_read_surcharge) VALUES(1,?,?,?,0,0,0,NULL,0,?,?,0)`,
      identity, count, count, JSON.stringify(observed), JSON.stringify(reserved));
      reservedEnvelope = envelope;
      return events + 1;
    });
    for (let offset = 0; offset < count; offset++) this.active.set(first + offset, reservedEnvelope);
    return first;
  }

  private projected(recorded: CapacityWorkUnits): CapacityWorkUnits {
    const total = { ...recorded };
    addWork(total, this.pending);
    return total;
  }

  private finishBlock(ordinal: number, meter: CapacityNativeMeter, block: WorkflowBlock): CapacityWorkUnits {
    if (this.stopped || block.completed.has(ordinal)) throw new Error('capacity_workflow_completion_invalid');
    const envelope = this.active.get(ordinal)!;
    let total!: CapacityWorkUnits;
    let actual!: CapacityWorkUnits;
    let failed = false;
    const final = block.remaining === 1;
    try {
      this.transact(() => {
        const saved = this.sql.exec<WorkflowRow>('SELECT * FROM capacity_wrapper_workflow WHERE id=1').one();
        if (saved.unresolved !== this.active.size || saved.stopped !== 0 || saved.closed !== 0) {
          throw new Error('capacity_workflow_completion_invalid');
        }
        actual = capacityUsageWork(meter.snapshot());
        if (final) {
          // One checkpoint write plus a paid failure-stop tail if its measured
          // cursor work exceeds the first tail. All slots retain full funding.
          actual.doRowsRead += 3;
          actual.doRowsWritten += 2;
          actual.doStorageBytes = Math.min(this.plan.envelope.doStorageBytes, actual.doStorageBytes + 32 * 1024);
        }
        total = this.projected(JSON.parse(saved.observed) as CapacityWorkUnits);
        addWork(total, actual);
        failed = KEYS.some(key => actual[key] > envelope[key] || total[key] > this.plan.envelope[key]);
        if (!final && !failed) return;
        if (failed && !final) {
          actual.doRowsRead++;
          actual.doRowsWritten++;
          actual.doStorageBytes = Math.min(this.plan.envelope.doStorageBytes, actual.doStorageBytes + 32 * 1024);
        }
        const recorded = JSON.parse(saved.observed) as CapacityWorkUnits;
        addWork(recorded, block.actual);
        addWork(recorded, actual);
        const reserved = JSON.parse(saved.reserved) as CapacityWorkUnits;
        if (!failed) for (const key of KEYS) if (!STORAGE.has(key)) reserved[key] -= block.count * envelope[key];
        this.sql.exec(`UPDATE capacity_wrapper_workflow SET unresolved=unresolved-?,observed=?,stopped=?,reserved=?,
          retry_read_surcharge=retry_read_surcharge+? WHERE id=1`, failed ? 0 : block.count, JSON.stringify(recorded),
        failed ? 1 : 0, JSON.stringify(reserved), block.retryReadSurcharge + meter.snapshot().d1RetryReadSurcharge);
        if (KEYS.some(key => capacityUsageWork(meter.snapshot())[key] > actual[key])) {
          // Roll back any release. The durable unresolved slots survive even
          // if saving the separate stop record then fails.
          throw new Error('capacity_workflow_completion_tail_exceeded');
        }
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'capacity_workflow_completion_tail_exceeded') throw error;
      this.stopped = true;
      this.transact(() => {
        const saved = this.sql.exec<WorkflowRow>('SELECT * FROM capacity_wrapper_workflow WHERE id=1').one();
        const known = capacityUsageWork(meter.snapshot());
        known.doRowsRead++;
        known.doRowsWritten++;
        known.doStorageBytes = Math.min(this.plan.envelope.doStorageBytes, known.doStorageBytes + 32 * 1024);
        const recorded = JSON.parse(saved.observed) as CapacityWorkUnits;
        addWork(recorded, block.actual);
        addWork(recorded, known);
        this.sql.exec(`UPDATE capacity_wrapper_workflow SET observed=?,stopped=1,
          retry_read_surcharge=retry_read_surcharge+? WHERE id=1`, JSON.stringify(recorded),
        block.retryReadSurcharge + meter.snapshot().d1RetryReadSurcharge);
      });
      throw new Error('capacity_workflow_envelope_exceeded');
    }
    if (failed) { this.stopped = true; throw new Error('capacity_workflow_envelope_exceeded'); }
    if (final) {
      for (let offset = 0; offset < block.count; offset++) {
        this.active.delete(block.first + offset);
        this.blocks.delete(block.first + offset);
      }
      for (const key of KEYS) if (!STORAGE.has(key)) this.pending[key] -= block.actual[key];
    } else {
      block.remaining--;
      block.completed.add(ordinal);
      addWork(block.actual, actual);
      block.retryReadSurcharge += meter.snapshot().d1RetryReadSurcharge;
      addWork(this.pending, actual);
    }
    return total;
  }

  finish(ordinal: number, meter: CapacityNativeMeter, close = false): CapacityWorkUnits {
    if (!this.active.has(ordinal)) throw new Error('capacity_workflow_completion_invalid');
    const envelope = this.active.get(ordinal)!;
    const usage = meter.snapshot();
    if (usage.uncertain || usage.unresolvedD1) throw new Error('capacity_workflow_metrics_uncertain');
    const block = this.blocks.get(ordinal);
    if (block) {
      if (close) throw new Error('capacity_workflow_completion_invalid');
      return this.finishBlock(ordinal, meter, block);
    }
    // The completion below has one singleton primary-key read and one write.
    // Prepay that tail before the final measurement, without recursive writes.
    const actual = capacityUsageWork(usage);
    actual.doRowsRead += 2;
    actual.doRowsWritten++;
    // The singleton row stores two small fixed-width work vectors and one
    // ticket. Updating it may allocate overflow/b-tree pages. Fund a bounded
    // 32KiB tail, then compare the actual final native high water below.
    actual.doStorageBytes = Math.min(this.plan.envelope.doStorageBytes, usage.doStorageBytes + 32 * 1024);
    let total!: CapacityWorkUnits;
    this.transact(() => {
      const saved = this.sql.exec<WorkflowRow>('SELECT * FROM capacity_wrapper_workflow WHERE id=1').one();
      if (saved.unresolved !== this.active.size || saved.stopped !== 0 || saved.closed !== 0
        || (close && saved.unresolved !== 1)) throw new Error('capacity_workflow_completion_invalid');
      total = JSON.parse(saved.observed) as CapacityWorkUnits;
      const reserved = JSON.parse(saved.reserved) as CapacityWorkUnits;
      const exceeded = KEYS.some(key => actual[key] > envelope[key]);
      for (const key of KEYS) total[key] = STORAGE.has(key) ? Math.max(total[key], actual[key]) : total[key] + actual[key];
      for (const key of KEYS) if (!STORAGE.has(key)) reserved[key] -= envelope[key];
      const stopped = exceeded || KEYS.some(key => total[key] > this.plan.envelope[key]);
      this.sql.exec(`UPDATE capacity_wrapper_workflow SET unresolved=unresolved-1,observed=?,stopped=?,closed=?,profile=?,reserved=?,
        intent_index=?,recovery_attempted=?,retry_read_surcharge=retry_read_surcharge+? WHERE id=1`,
        JSON.stringify(total), stopped ? 1 : 0, close ? 1 : 0, this.profile, JSON.stringify(reserved), this.intentIndex,
        this.recoveryAttempted ? 1 : 0, usage.d1RetryReadSurcharge);
      if (stopped) return;
    });
    this.active.delete(ordinal);
    const completed = capacityUsageWork(meter.snapshot());
    if (KEYS.some(key => completed[key] > actual[key]) || KEYS.some(key => total[key] > this.plan.envelope[key])
      || KEYS.some(key => actual[key] > envelope[key])) throw new Error('capacity_workflow_envelope_exceeded');
    return this.projected(total);
  }
}
