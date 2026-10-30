import { ARENA_POLICY } from './arena-policy';
import { ApiError } from './security';

/** Shed registration bursts before primary auth. Durable checks still decide entry. */
export class ArenaRegistrationAdmission {
  private active = 0;

  async run<T>(operation: () => Promise<T>, busy: () => T = () => {
    throw new ApiError(429, 'ARENA_RETRY', 'Registration is busy. Try again in a second.');
  }): Promise<T> {
    if (this.active >= ARENA_POLICY.registrationAuthConcurrency) return busy();
    this.active++;
    try { return await operation(); }
    finally { this.active--; }
  }
}

// Each Worker isolate owns its slots. This is load shedding, not a global limit.
export const arenaRegistrationAdmission = new ArenaRegistrationAdmission();
