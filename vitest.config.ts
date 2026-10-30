import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';

export default defineConfig(async () => ({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.jsonc', environment: 'local' },
    miniflare: {
      bindings: {
        AUTH_SECRET: 'local-worker-test-secret-with-at-least-32-bytes',
        TEST_MIGRATIONS: await readD1Migrations('./migrations'),
      },
    },
  })],
  test: { include: ['test/**/*.test.ts'], setupFiles: ['./test/setup.ts'], testTimeout: 20_000 },
}));
