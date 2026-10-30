import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import type { D1Migration } from '@cloudflare/vitest-plugin';
import type { Env } from '../src/server/env';

declare global {
  namespace Cloudflare {
    interface Env extends ChessTestEnv {}
  }
}
interface ChessTestEnv extends Env { TEST_MIGRATIONS: D1Migration[] }

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
