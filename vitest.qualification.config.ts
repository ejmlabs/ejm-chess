import { defineConfig } from 'vitest/config';
import base from './vitest.config.ts';

export default defineConfig(async context => {
  const { test, ...config } = await base(context);
  return {
    ...config,
    define: {
      __QUALIFICATION_ENTRANTS__: JSON.stringify(Number(process.env.CHESS_QUALIFICATION_ENTRANTS ?? 2_000)),
      __QUALIFICATION_DURATION_MS__: JSON.stringify(Number(process.env.CHESS_QUALIFICATION_DURATION_MS ?? 900_000)),
    },
    test: {
      ...test,
      include: [`qualification/${process.env.CHESS_QUALIFICATION_PHASE ?? 'arena'}.qualify.ts`],
      testTimeout: 1_200_000,
      hookTimeout: 60_000,
      fileParallelism: false,
      maxWorkers: 1,
      reporters: ['default', './scripts/qualification-reporter.mjs'],
    },
  };
});
