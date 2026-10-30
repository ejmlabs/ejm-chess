import { CAPACITY_INGRESS_BLOCK_REQUESTS } from './capacity-run';

export const CAPACITY_INGRESS_GRANT_WAIT_MS = 5_000;

/**
 * A thin isolate-local consumer of durable, permanently charged grants. It
 * never grants more work after an uncertain reply, and never returns unused
 * capacity. Followers own their wait and its bounded native timer. Only the
 * granting request awaits its RPC, preserving every request's I/O lifetime.
 */
export class CapacityIngressBudget {
  private remaining = 0;
  private granting = false;
  private waiters = new Set<() => void>();
  private failed = false;

  constructor(private issueCloseAt: number, private now: () => number = Date.now) {}

  private wake(): void {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  stop(): void { this.failed = true; this.wake(); }

  private async wait(): Promise<void> {
    let wake!: () => void;
    let timer!: ReturnType<typeof setTimeout>;
    try {
      await new Promise<void>(resolve => {
        wake = resolve;
        this.waiters.add(wake);
        timer = setTimeout(() => this.stop(), Math.max(0,
          Math.min(this.issueCloseAt - this.now(), CAPACITY_INGRESS_GRANT_WAIT_MS)));
      });
    } finally {
      clearTimeout(timer);
      this.waiters.delete(wake);
    }
  }

  async consume(grant: (id: string) => Promise<boolean>): Promise<boolean> {
    if (this.failed || this.now() >= this.issueCloseAt) { this.stop(); return false; }
    while (this.remaining === 0) {
      if (this.granting) await this.wait();
      else {
        this.granting = true;
        try {
          if (await grant(crypto.randomUUID())) this.remaining = CAPACITY_INGRESS_BLOCK_REQUESTS;
          else this.failed = true;
        } catch { this.failed = true; }
        finally { this.granting = false; this.wake(); }
      }
      if (this.failed || this.now() >= this.issueCloseAt) { this.stop(); return false; }
    }
    this.remaining--;
    return true;
  }
}
