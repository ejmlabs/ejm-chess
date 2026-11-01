#!/usr/bin/env node
// Safe one-command deploy for the protected canary (docs/live-ready-prep.md, steps 2 and 3).
//   node scripts/deploy-canary.mjs --check   preflight and local checks only; no network
//   node scripts/deploy-canary.mjs [--yes]   full run; --yes skips the typed confirmation
// Wrangler reads its credential from the inherited environment, which is never printed.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const uiRoot = join(root, '..', 'ejm-ui');
const wrangler = join(root, 'node_modules', '.bin', 'wrangler');
const ORIGIN = 'https://chess.ejmlabs.com';
// The ejm-ui commit this product builds against, the same pin CI reads.
const UI_COMMIT = JSON.parse(readFileSync(new URL('../.github/ui-source.json', import.meta.url), 'utf8')).revision;
const PENDING = ['0016_cron_heartbeats.sql']; // the one migration this release applies
const CRONS = ['* * * * *', '15 3 * * *'];
const DURABLE = { GAME: 'Game', COMPETITION: 'Competition' };
const VALUES = {
  AUTH_BASE_URL: ORIGIN, RANKED_ENABLED: 'true', ARENAS_ENABLED: 'true', TOURNAMENTS_ENABLED: 'true',
  AI_ENABLED: 'true', NEW_WORK_STOPPED: 'false', OPERATION_MODE: 'unattended', GAME_RETIREMENT_MODE: 'scaled',
};
const RETIRED = /^(TIMEOUT_PROOF_PROFILE|MONTHLY_.*|SIGNUP_ATTEMPT_LIMIT|ANALYSIS_.*|PROVER|ANALYZER)$/;
const LIMIT = /^(ARENA|CASUAL|RANKED)_[A-Z_]*LIMIT$/;
const AUTHORITY_BYTES_MAX = 4294967296;

const fail = (problem, fix) => { throw new Error(`${problem}\n  Fix: ${fix}`); };
const ok = label => console.log(`  ok    ${label}`);
const run = (cmd, args, options) => spawnSync(cmd, args, { cwd: root, encoding: 'utf8', ...options });
const git = (dir, ...args) => run('git', ['-C', dir, ...args]);
const wr = (args, stdio) => run(wrangler, args, { stdio });

/** Every key and binding name at any depth, so a retired setting is found wherever it hides. */
function configNames(value, found = new Set()) {
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      found.add(key);
      if (typeof child === 'string' && (key === 'binding' || key === 'name')) found.add(child);
      configNames(child, found);
    }
  }
  return found;
}

const validLimit = (key, value) => typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value)
  && (key !== 'ARENA_AUTHORITY_BYTE_LIMIT' || Number(value) <= AUTHORITY_BYTES_MAX);

/** Problems with a wrangler-normalized top-level config. Names and expected values only, never actual values. */
export function validateConfig(config) {
  const problems = [];
  const vars = config.vars ?? {};
  for (const [key, want] of Object.entries(VALUES)) if (vars[key] !== want) problems.push(`vars.${key} must be "${want}"`);
  if (vars.LOCAL_DEV !== undefined && vars.LOCAL_DEV !== 'false') problems.push('vars.LOCAL_DEV must be unset or "false"');
  for (const key of Object.keys(vars)) {
    if (LIMIT.test(key) && !validLimit(key, vars[key])) problems.push(`vars.${key} must be unset or a positive integer`);
  }
  for (const name of configNames(config)) if (RETIRED.test(name)) problems.push(`${name} is retired; delete it`);
  if (config.queues?.producers?.length || config.queues?.consumers?.length) problems.push('queue bindings are retired; delete them');
  if (config.containers?.length) problems.push('containers are retired; delete them');
  if (config.assets?.run_worker_first !== true) problems.push('assets.run_worker_first must be true');
  if (config.assets?.not_found_handling !== '404-page') problems.push('assets.not_found_handling must be "404-page"');
  if (config.workers_dev !== false) problems.push('workers_dev must be false');
  if (config.preview_urls !== false) problems.push('preview_urls must be false');
  for (const [name, className] of Object.entries(DURABLE)) {
    if (!config.durable_objects?.bindings?.some(b => b.name === name && b.class_name === className)) {
      problems.push(`durable_objects binding ${name} (class ${className}) is missing`);
    }
  }
  if (!config.d1_databases?.some(d => d.binding === 'DB')) problems.push('d1_databases binding DB is missing');
  for (const cron of CRONS) if (!config.triggers?.crons?.includes(cron)) problems.push(`triggers.crons must include "${cron}"`);
  const host = new URL(ORIGIN).hostname;
  if (![...(config.routes ?? []), config.route].some(r => r?.pattern === host && r.custom_domain === true)) {
    problems.push(`routes must include the custom domain ${host}`);
  }
  return problems;
}

async function loadConfig() {
  let api;
  try { api = await import('wrangler'); } catch { fail('wrangler is not installed.', 'Run npm ci, then re-run.'); }
  try {
    return api.unstable_readConfig({ config: join(root, 'wrangler.jsonc'), env: '' }, { hideWarnings: true });
  } catch {
    return fail('wrangler could not read wrangler.jsonc.', "Restore the private production config; npm run worker:check shows wrangler's own error.");
  }
}

function checkRepo(dir, label) {
  if (git(dir, 'status', '--porcelain').stdout.trim()) fail(`${label} has uncommitted changes.`, 'Commit or discard them, then re-run.');
  ok(`${label} is clean`);
}

async function preflight() {
  if (process.versions.node.split('.')[0] !== '24') fail(`Node 24 is required; this is ${process.versions.node}.`, 'Switch to Node 24, then re-run.');
  ok('Node 24');
  checkRepo(root, 'ejm-chess');
  if (git(root, 'merge-base', '--is-ancestor', 'HEAD', '@{u}').status !== 0) fail('HEAD is not on its upstream branch (as of the last fetch).', 'Push the branch to its upstream, then re-run.');
  ok('HEAD is pushed to its upstream');
  checkRepo(uiRoot, 'ejm-ui');
  if (git(uiRoot, 'rev-parse', 'HEAD').stdout.trim() !== UI_COMMIT) fail(`ejm-ui is not at the pinned ${UI_COMMIT.slice(0, 7)} (.github/ui-source.json).`, `In ../ejm-ui: git fetch origin && git checkout ${UI_COMMIT}.`);
  ok(`ejm-ui is at the pinned ${UI_COMMIT.slice(0, 7)}`);
  const config = await loadConfig();
  const problems = validateConfig(config);
  if (problems.length) fail(`wrangler.jsonc does not match the production values:\n    ${problems.join('\n    ')}`, 'Edit the private wrangler.jsonc (docs/live-ready-prep.md#production-values).');
  ok('wrangler.jsonc matches the production values');
  return config;
}

function localChecks() {
  for (const args of [['ci'], ['run', 'typecheck'], ['test'], ['run', 'build'], ['run', 'worker:check']]) {
    console.log(`  npm ${args.join(' ')}`);
    if (run('npm', args, { stdio: 'inherit' }).status !== 0) fail(`npm ${args.join(' ')} failed.`, 'Fix it using the output above, then re-run.');
  }
  checkRepo(root, 'ejm-chess after the checks');
}

function readJson(args, what) {
  const result = wr(args, ['ignore', 'pipe', 'inherit']);
  if (result.status !== 0) fail(`${what} failed.`, 'Check the Cloudflare credential and network, then re-run.');
  try { return JSON.parse(result.stdout); } catch { return fail(`${what} did not return JSON.`, 'Re-run; if it repeats, use the manual commands in docs/deployment.md.'); }
}

function currentVersion() {
  const latest = readJson(['deployments', 'list', '--env', '', '--json'], 'Reading the deployments').at(-1);
  if (latest?.versions?.length !== 1 || latest.versions[0].percentage !== 100) fail('The live deployment is not one version at 100%.', 'Finish or undo the gradual rollout, then re-run.');
  return latest.versions[0].version_id;
}

function pendingMigrations() {
  const result = wr(['d1', 'migrations', 'list', 'DB', '--remote', '--env', ''], ['ignore', 'pipe', 'inherit']);
  if (result.status !== 0) fail('Reading the D1 migrations failed.', 'Check the Cloudflare credential and network, then re-run.');
  return result.stdout.match(/\d{4}_[\w-]+\.sql/g) ?? [];
}

function probe(path) {
  const result = run('curl', ['-sS', '--max-time', '20', '-o', '/dev/null', '-w', '%{http_code} %{redirect_url}', ORIGIN + path]);
  const [status, redirect = ''] = (result.stdout ?? '').split(' ');
  const viaAccess = /^30\d$/.test(status) && /cloudflareaccess\.com|\/cdn-cgi\/access\//.test(redirect);
  return { ok: viaAccess || status === '401' || status === '403', detail: viaAccess ? `${status} to Access login` : `HTTP ${status}` };
}

async function confirm(lines, yes) {
  console.log(`\nThis changes production (the protected canary):\n${lines.map(l => `  ${l}`).join('\n')}`);
  if (yes) return;
  if (!process.stdin.isTTY) fail('There is no terminal to confirm in.', 'Run it in a terminal, or pass --yes.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('\nType "deploy" to continue: ');
  rl.close();
  if (answer.trim() !== 'deploy') fail('Not confirmed. Nothing was changed.', 'Re-run and type deploy.');
}

function saveRecord(record) {
  const date = new Date().toISOString();
  const lines = [`# Canary deploy ${date}`, `- Outcome: ${record.outcome}`, `- ejm-chess: ${record.sha}`, `- ejm-ui: ${record.uiSha}`,
    `- Rollback target (old version): ${record.old}`, `- New version: ${record.version}`, `- D1 Time Travel bookmark: ${record.bookmark}`,
    `- Migration ${PENDING[0]}: ${record.migrated ? 'applied' : 'not applied'}`, ...record.results.map(r => `- ${r.ok ? 'ok' : 'FAIL'}: ${r.label}${r.detail ? ` (${r.detail})` : ''}`)];
  const file = join(root, '.deploy-records', `${date.slice(0, 19).replace(/:/g, '')}-${record.sha}.md`);
  mkdirSync(join(root, '.deploy-records'), { recursive: true });
  writeFileSync(file, `${lines.join('\n')}\n`);
  console.log(`\nRecord saved: ${file}`);
}

const rollbackCommand = old => `npx wrangler rollback ${old} --env '' --message "Approved chess recovery rollback"`;

function migrateAndDeploy(record) {
  record.bookmark = readJson(['d1', 'time-travel', 'info', 'DB', '--env', '', '--json'], 'Saving the D1 Time Travel bookmark').bookmark;
  if (typeof record.bookmark !== 'string' || !record.bookmark) fail('D1 returned no Time Travel bookmark.', 'Stop here; nothing was changed.');
  console.log(`  D1 Time Travel bookmark: ${record.bookmark}`);
  const inherit = ['ignore', 'inherit', 'inherit'];
  if (wr(['d1', 'migrations', 'apply', 'DB', '--remote', '--env', ''], inherit).status !== 0) {
    fail('The migration failed. D1 rolls back the failed migration; nothing was deployed.', `Read the error above. Restore point if needed: bookmark ${record.bookmark}.`);
  }
  record.migrated = true;
  if (wr(['deploy', '--env', '', '--strict', '--message', `${record.sha} canary`], inherit).status !== 0) {
    fail(`The deploy failed after ${PENDING[0]} was applied. That migration is additive and safe to leave applied. The Worker may still be on the old version; read the output above.`,
      `Resolve the cause above, then deploy by hand (docs/deployment.md). To roll back instead, run this yourself; the script never does: ${rollbackCommand(record.old)}`);
  }
}

function readback(record) {
  console.log('\n6. Readback');
  const check = (label, passed, detail = '') => { record.results.push({ label, ok: passed, detail }); console.log(`  ${passed ? 'ok  ' : 'FAIL'}  ${label}${detail && ` (${detail})`}`); };
  record.version = currentVersion();
  const view = readJson(['versions', 'view', record.version, '--env', '', '--json'], 'Reading the new version');
  check('a new version is live at 100%', record.version !== record.old);
  check('the live version carries this commit', view.annotations?.['workers/message'] === `${record.sha} canary`);
  check('no migration is pending', pendingMigrations().length === 0);
  for (const path of ['/', '/api/config', '/admin/']) {
    const { ok: behind, detail } = probe(path);
    check(`${path} is behind Access (not app content)`, behind, detail);
  }
  if (!record.results.every(r => r.ok)) {
    record.outcome = 'readback failed';
    fail('A readback check failed.', `Close new work with the stop levers (docs/live-ready-prep.md#stop-levers) and, if needed, roll back yourself: ${rollbackCommand(record.old)}`);
  }
  record.outcome = 'complete';
}

function report(record, config) {
  console.log(`\nPaste into docs/verification.md:\n\n## Launch values on the protected canary, ${new Date().toISOString().slice(0, 10)}\n\n`
    + `Source \`${record.sha}\` with ejm-ui \`${record.uiSha}\` deployed Worker \`${config.name}\` version \`${record.version}\`, replacing \`${record.old}\`. `
    + `D1 migration \`${PENDING[0]}\` applied after Time Travel bookmark \`${record.bookmark}\`. Readback: the version carries the commit, no migration is pending, `
    + 'and the host, /api/config and /admin/ stay behind Access.');
  console.log('\nStill human:\n  - Read /api/config, /api/arenas, /api/tournaments and /api/admin/operations in the owner browser (live-ready-prep step 3).'
    + '\n  - Run the two-person canary checklist (step 4).\n  - Confirm the alert email arrives in the inbox (step 5).\n  - Remove full-host Access only after steps 4 and 5 pass (step 6).');
}

async function main() {
  const args = process.argv.slice(2);
  const unknown = args.find(arg => arg !== '--check' && arg !== '--yes');
  if (unknown) fail(`Unknown option ${unknown}.`, 'Use --check or --yes.');
  console.log('1. Preflight (read-only, no network)');
  const config = await preflight();
  console.log('\n2. Local checks');
  localChecks();
  if (args.includes('--check')) return console.log('\nChecks passed. Nothing was changed.');

  console.log('\n3. Remote readback (read-only)');
  readJson(['whoami', '--json'], 'Checking the Cloudflare credential');
  ok('Cloudflare credential accepted');
  const record = { outcome: 'stopped before completion', results: [], migrated: false, version: 'none', bookmark: 'none', old: currentVersion(),
    sha: git(root, 'rev-parse', '--short', 'HEAD').stdout.trim(), uiSha: git(uiRoot, 'rev-parse', '--short', 'HEAD').stdout.trim() };
  ok(`rollback target: version ${record.old}`);
  const pending = pendingMigrations();
  if (pending.join() !== PENDING.join()) fail(`Expected only ${PENDING.join()} pending; found ${pending.join() || 'none'}.`, 'Compare with docs/deployment.md; do not continue until it is explained.');
  ok(`only ${PENDING[0]} is pending`);

  console.log('\n4. Confirm');
  await confirm([`commit ${record.sha}, ejm-ui ${record.uiSha}`, `rollback target ${record.old}`,
    `save a D1 Time Travel bookmark, apply ${PENDING[0]}, deploy "${record.sha} canary"`], args.includes('--yes'));

  console.log('\n5. Change');
  try { migrateAndDeploy(record); readback(record); } finally { saveRecord(record); }
  report(record, config);
}

if (import.meta.main) await main().catch(error => { console.error(`\nSTOP: ${error.message}`); process.exitCode = 1; });
