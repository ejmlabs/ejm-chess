import 'vitest';

declare module 'vitest' {
  /** The qualification reporter in scripts/qualification-reporter.mjs reads this record. */
  interface TaskMeta { qualification?: Record<string, unknown> }
}

declare global {
  // Both come from `define` in vitest.qualification.config.ts.
  const __QUALIFICATION_ENTRANTS__: number;
  const __QUALIFICATION_DURATION_MS__: number;
}
