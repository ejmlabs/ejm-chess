import { ARENA_POLICY } from './arena-policy';

/**
 * A failing dependency is retried after `baseMs`, then twice as long each time up to `capMs`, so an outage
 * costs a few wakeups a minute instead of one a second while a single transient error still recovers at once.
 * `failures` counts the failures before this one. Waiting that is no failure, such as a queued player, keeps the base.
 */
export function retryDelayMs(failures: number, baseMs: number = ARENA_POLICY.retryMs, capMs: number = ARENA_POLICY.retryCapMs): number {
  return Math.min(capMs, baseMs * 2 ** failures);
}
