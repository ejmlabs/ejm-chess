import type { BudgetEnv } from './budget';
import type { TournamentCadence } from '../shared/tournaments';

/** Only the private entry can install this policy on its own environment object. */
export interface IsolatedGameBudget {
  readonly manifestDigest: string;
  readonly maximum: 20_000;
  /** Fixed isolated load fixtures. Production never installs this capability. */
  readonly arenaStarts?: Readonly<Record<TournamentCadence, number>>;
  available(): Promise<boolean>;
  reserve(id: string, units: number): Promise<boolean>;
}

const isolated = new WeakMap<BudgetEnv, { policy: IsolatedGameBudget; database: D1Database }>();

/**
 * Runtime capability, not an environment setting. A copied environment loses
 * it. The private entry must verify its sealed resource manifest first and
 * bind only its own wrapped D1 handle. Production never calls this function.
 */
export function bindIsolatedGameBudget(env: BudgetEnv, policy: IsolatedGameBudget): void {
  if (isolated.has(env) || !/^[a-f0-9]{64}$/.test(policy.manifestDigest) || policy.maximum !== 20_000) {
    throw new Error('capacity_budget_binding_invalid');
  }
  const starts = policy.arenaStarts;
  if (starts && (Object.keys(starts).length !== 3 || ['hourly', 'daily', 'weekly'].some(cadence =>
    !Number.isSafeInteger(starts[cadence as TournamentCadence]) || starts[cadence as TournamentCadence] < 1))) {
    throw new Error('capacity_calendar_binding_invalid');
  }
  const bound = starts ? { ...policy, arenaStarts: Object.freeze({ ...starts }) } : policy;
  isolated.set(env, { policy: Object.freeze(bound), database: env.DB });
}

export function isolatedGameBudget(env: BudgetEnv): IsolatedGameBudget | undefined {
  const bound = isolated.get(env);
  if (bound && bound.database !== env.DB) throw new Error('capacity_budget_resource_changed');
  return bound?.policy;
}
