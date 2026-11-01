// Run with: node --test scripts/deploy-canary.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateConfig } from './deploy-canary.mjs';

/** A top-level config in the shape wrangler's config reader returns. */
const good = () => ({
  name: 'ejm-chess',
  vars: {
    AUTH_BASE_URL: 'https://chess.ejmlabs.com', LOCAL_DEV: 'false', OPERATION_MODE: 'unattended', NEW_WORK_STOPPED: 'false',
    RANKED_ENABLED: 'true', ARENAS_ENABLED: 'true', TOURNAMENTS_ENABLED: 'true', AI_ENABLED: 'true', GAME_RETIREMENT_MODE: 'scaled',
  },
  assets: { directory: 'dist', binding: 'ASSETS', run_worker_first: true, not_found_handling: '404-page' },
  workers_dev: false,
  preview_urls: false,
  routes: [{ pattern: 'chess.ejmlabs.com', custom_domain: true }],
  durable_objects: { bindings: [{ name: 'GAME', class_name: 'Game' }, { name: 'COMPETITION', class_name: 'Competition' }] },
  d1_databases: [{ binding: 'DB', database_name: 'ejm-chess', database_id: 'id', migrations_dir: 'migrations' }],
  triggers: { crons: ['* * * * *', '15 3 * * *'] },
  queues: { producers: [], consumers: [] },
});

function problemsAfter(change) {
  const config = good();
  change(config);
  return validateConfig(config);
}

test('the production config passes', () => {
  assert.deepEqual(validateConfig(good()), []);
});

test('each retired key fails by name', () => {
  for (const key of ['TIMEOUT_PROOF_PROFILE', 'MONTHLY_PROOF_LIMIT', 'MONTHLY_GAME_LIMIT', 'SIGNUP_ATTEMPT_LIMIT', 'ANALYSIS_ENABLED', 'ANALYSIS_QUEUE', 'PROVER', 'ANALYZER']) {
    const problems = problemsAfter(config => { config.vars[key] = 'x'; });
    assert.ok(problems.some(p => p.startsWith(`${key} is retired`)), `${key}: ${problems}`);
  }
});

test('retired bindings and queues fail', () => {
  assert.ok(problemsAfter(config => { config.services = [{ binding: 'PROVER', service: 'prover' }]; }).some(p => p.startsWith('PROVER is retired')));
  assert.ok(problemsAfter(config => { config.queues.producers = [{ binding: 'JOBS', queue: 'jobs' }]; }).some(p => p.includes('queue bindings')));
  assert.ok(problemsAfter(config => { config.containers = [{ class_name: 'Prover' }]; }).some(p => p.includes('containers')));
});

test('the asset, host and platform settings are required', () => {
  assert.deepEqual(problemsAfter(config => { delete config.assets.not_found_handling; }), ['assets.not_found_handling must be "404-page"']);
  assert.deepEqual(problemsAfter(config => { config.assets.run_worker_first = false; }), ['assets.run_worker_first must be true']);
  assert.deepEqual(problemsAfter(config => { config.workers_dev = true; }), ['workers_dev must be false']);
  assert.deepEqual(problemsAfter(config => { config.preview_urls = undefined; }), ['preview_urls must be false']);
  assert.deepEqual(problemsAfter(config => { config.routes = []; }), ['routes must include the custom domain chess.ejmlabs.com']);
  assert.deepEqual(problemsAfter(config => { config.triggers.crons = ['* * * * *']; }), ['triggers.crons must include "15 3 * * *"']);
  assert.deepEqual(problemsAfter(config => { config.d1_databases = []; }), ['d1_databases binding DB is missing']);
  assert.deepEqual(problemsAfter(config => { config.durable_objects.bindings.pop(); }), ['durable_objects binding COMPETITION (class Competition) is missing']);
});

test('a wrong flag fails with its name and expected value, never the actual value', () => {
  const problems = problemsAfter(config => { config.vars.RANKED_ENABLED = 'maybe-secret'; config.vars.NEW_WORK_STOPPED = 'true'; });
  assert.deepEqual([...problems].sort(), ['vars.NEW_WORK_STOPPED must be "false"', 'vars.RANKED_ENABLED must be "true"']);
  assert.ok(!problems.join().includes('maybe-secret'));
  assert.deepEqual(problemsAfter(config => { config.vars.RANKED_ENABLED = true; }), ['vars.RANKED_ENABLED must be "true"']);
  assert.deepEqual(problemsAfter(config => { config.vars.AUTH_BASE_URL = 'https://chess.invalid'; }), ['vars.AUTH_BASE_URL must be "https://chess.ejmlabs.com"']);
  assert.deepEqual(problemsAfter(config => { config.vars.LOCAL_DEV = 'true'; }), ['vars.LOCAL_DEV must be unset or "false"']);
});

test('a product limit may be unset or a valid positive integer, and nothing else', () => {
  assert.deepEqual(problemsAfter(config => { config.vars.ARENA_GAME_LIMIT = '500'; config.vars.ARENA_AUTHORITY_BYTE_LIMIT = '4294967296'; }), []);
  for (const bad of ['0', '-1', '1.5', 'many', '', '4294967297']) {
    const problems = problemsAfter(config => { config.vars.ARENA_AUTHORITY_BYTE_LIMIT = bad; });
    assert.deepEqual(problems, ['vars.ARENA_AUTHORITY_BYTE_LIMIT must be unset or a positive integer'], bad);
  }
  assert.deepEqual(problemsAfter(config => { config.vars.RANKED_QUEUE_LIMIT = '0'; }), ['vars.RANKED_QUEUE_LIMIT must be unset or a positive integer']);
});
