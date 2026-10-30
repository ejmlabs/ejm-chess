import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';

export default defineConfig(async () => ({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.recovery-drill.jsonc' },
    miniflare: { bindings: {
      TEST_MIGRATIONS: await readD1Migrations('./migrations'),
      RECOVERY_DRILL_TOKEN: 'local-test-private-recovery-token-at-least-32-bytes',
      PRODUCTION_RESOURCE_IDS: '99999999-9999-9999-9999-999999999999',
      RECOVERY_DATABASE_ID: '11111111-1111-1111-1111-111111111111',
      RECOVERY_GAME_NAMESPACE_ID: '1'.repeat(32), RECOVERY_COMPETITION_NAMESPACE_ID: '2'.repeat(32),
      RECOVERY_SOURCE_REVISION: 'a'.repeat(40),
    } },
  })],
  test: { include: ['qualification/recovery-drill.qualify.ts'], setupFiles: ['./test/setup.ts'], testTimeout: 20_000 },
}));
