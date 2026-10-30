import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArenaRegistrationAdmission } from '../src/server/arena-registration-admission';
import { ARENA_POLICY } from '../src/server/arena-policy';

afterEach(() => vi.useRealTimers());

describe('registration admission before primary auth', () => {
  it('sheds the fixed 10,000-offer 3 ms burst without queueing primary reads', async () => {
    vi.useFakeTimers({ now: 0, loopLimit: 30_000 });
    const gate = new ArenaRegistrationAdmission();
    let active = 0, maximum = 0, admitted = 0, denied = 0;
    const offered: number[] = [];
    const replies = Array.from({ length: 10_000 }, (_, index) => new Promise<boolean>(resolve => {
      setTimeout(() => {
        offered.push(Date.now());
        void gate.run(async () => {
          admitted++; active++; maximum = Math.max(maximum, active);
          await new Promise<void>(done => setTimeout(done, 4_999));
          active--;
          return true;
        }, () => { denied++; return false; }).then(resolve);
      }, index * 3);
    }));
    await vi.runAllTimersAsync();
    const results = await Promise.all(replies);
    expect(offered).toHaveLength(10_000);
    expect(offered[0]).toBe(0);
    expect(offered.at(-1)).toBe(29_997);
    expect(maximum).toBe(ARENA_POLICY.registrationAuthConcurrency);
    expect(active).toBe(0);
    expect(admitted).toBeGreaterThan(0);
    expect(denied).toBeGreaterThan(0);
    expect(results.filter(Boolean)).toHaveLength(admitted);
    expect(admitted + denied).toBe(10_000);
    expect(await gate.run(async () => 'recovered')).toBe('recovered');
  });

  it('releases slots when admitted authentication fails', async () => {
    const gate = new ArenaRegistrationAdmission();
    await expect(Promise.all(Array.from({ length: ARENA_POLICY.registrationAuthConcurrency }, () =>
      gate.run(async () => { throw new Error('primary unavailable'); })))).rejects.toThrow('primary unavailable');
    const calls = await Promise.all(Array.from({ length: ARENA_POLICY.registrationAuthConcurrency }, () => gate.run(async () => true)));
    expect(calls.every(Boolean)).toBe(true);
  });
});
