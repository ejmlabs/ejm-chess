import type { CapacityWorkUnits } from './capacity-run';
import type { CapacityWorkflowPlan } from './capacity-workflow';
import { CAPACITY_D1_READ_ATTEMPTS } from './capacity-meter';

export type { CapacityWorkflowPlan } from './capacity-workflow';

function work(values: Partial<CapacityWorkUnits>): CapacityWorkUnits {
  return { workerRequests: 0, nativeDoRequests: 0, workerCpuMs: 0,
    doRowsWritten: 0, doRowsRead: 0, d1RowsWritten: 0, d1RowsRead: 0,
    doStorageBytes: 0, d1StorageBytes: 0, ...values };
}

/** One terminal failure/expiry and one already scheduled tail, never refunded. */
export const CAPACITY_FREEZE_CALLBACK_WORK = work({ nativeDoRequests: 2, doRowsRead: 1_024, doRowsWritten: 3 });

/**
 * Trial budgets for the fixed local corpus. They are enforced limits, not
 * measured upper bounds or permission to provision a provider run. A short
 * or exhausted rehearsal fails qualification without increasing these caps.
 */
export const CAPACITY_WORKFLOW_CANDIDATES: Readonly<Record<'regular' | 'delayed' | 'socket' | 'competition', CapacityWorkflowPlan>> = {
  regular: {
    maximumEvents: 20,
    envelope: work({ nativeDoRequests: 20, doRowsWritten: 120, doRowsRead: 2_048,
      d1RowsWritten: 16, d1RowsRead: CAPACITY_D1_READ_ATTEMPTS * 768, doStorageBytes: 128 * 1024, d1StorageBytes: 512 * 1024 ** 2 }),
    maximumEventWork: work({ nativeDoRequests: 1, doRowsWritten: 40, doRowsRead: 512,
      d1RowsWritten: 16, d1RowsRead: CAPACITY_D1_READ_ATTEMPTS * 640, doStorageBytes: 128 * 1024, d1StorageBytes: 512 * 1024 ** 2 }),
  },
  delayed: {
    maximumEvents: 48,
    envelope: work({ nativeDoRequests: 48, doRowsWritten: 160, doRowsRead: 8_192,
      d1RowsWritten: 32, d1RowsRead: CAPACITY_D1_READ_ATTEMPTS * 1_024, doStorageBytes: 192 * 1024, d1StorageBytes: 512 * 1024 ** 2 }),
    maximumEventWork: work({ nativeDoRequests: 1, doRowsWritten: 40, doRowsRead: 512,
      d1RowsWritten: 16, d1RowsRead: CAPACITY_D1_READ_ATTEMPTS * 640, doStorageBytes: 192 * 1024, d1StorageBytes: 512 * 1024 ** 2 }),
  },
  socket: {
    maximumEvents: 48,
    envelope: work({ nativeDoRequests: 48, doRowsWritten: 192, doRowsRead: 8_192,
      d1RowsWritten: 16, d1RowsRead: CAPACITY_D1_READ_ATTEMPTS * 1_024, doStorageBytes: 192 * 1024, d1StorageBytes: 512 * 1024 ** 2 }),
    maximumEventWork: work({ nativeDoRequests: 1, doRowsWritten: 40, doRowsRead: 512,
      d1RowsWritten: 16, d1RowsRead: CAPACITY_D1_READ_ATTEMPTS * 640, doStorageBytes: 192 * 1024, d1StorageBytes: 512 * 1024 ** 2 }),
  },
  competition: {
    maximumEvents: 240_000,
    envelope: work({ nativeDoRequests: 240_000, doRowsWritten: 1_600_000, doRowsRead: 400_000_000,
      d1RowsWritten: 500_000, d1RowsRead: CAPACITY_D1_READ_ATTEMPTS * 3_000_000, doStorageBytes: 256 * 1024 ** 2, d1StorageBytes: 512 * 1024 ** 2 }),
    maximumEventWork: work({ nativeDoRequests: 1, doRowsWritten: 32_768, doRowsRead: 1_000_000,
      d1RowsWritten: 4_096, d1RowsRead: CAPACITY_D1_READ_ATTEMPTS * 32_768, doStorageBytes: 256 * 1024 ** 2, d1StorageBytes: 512 * 1024 ** 2 }),
  },
};

/** Fixed source corpus: 18,000 regular, 1,000 delayed and 1,000 socket games. */
export function capacityCandidateRunWork(): CapacityWorkUnits {
  const total = work({ d1StorageBytes: 512 * 1024 ** 2 });
  for (const [kind, count] of [['regular', 18_000], ['delayed', 1_000], ['socket', 1_000], ['competition', 1]] as const) {
    const envelope = CAPACITY_WORKFLOW_CANDIDATES[kind].envelope;
    for (const key of Object.keys(total) as (keyof CapacityWorkUnits)[]) {
      // Every authority shares the same D1 database. Its physical high-water
      // mark is reserved once; native DO allocation is per object.
      if (key !== 'd1StorageBytes') total[key] += count * envelope[key];
    }
  }
  // A failed/expired callback can fence the workflow and delete its alarm.
  // Abort disables retries. If deletion was uncertain, one already scheduled
  // tail still rejects before product work. Neither callback releases a permit.
  for (const key of Object.keys(total) as (keyof CapacityWorkUnits)[]) {
    total[key] += 20_001 * CAPACITY_FREEZE_CALLBACK_WORK[key];
  }
  return total;
}

/** Full native rehearsal, exact costs and the frozen owner approval are still required. */
export const VERIFIED_GAME_WORKFLOW_PLAN: CapacityWorkflowPlan | null = null;
export const VERIFIED_DELAYED_GAME_WORKFLOW_PLAN: CapacityWorkflowPlan | null = null;
export const VERIFIED_SOCKET_GAME_WORKFLOW_PLAN: CapacityWorkflowPlan | null = null;
export const VERIFIED_COMPETITION_WORKFLOW_PLAN: CapacityWorkflowPlan | null = null;
