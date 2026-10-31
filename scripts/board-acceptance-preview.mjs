#!/usr/bin/env node
// Local browser acceptance only. Keep the product handler, origin checks,
// authentication and Durable Object implementations unchanged.
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { readD1Migrations } from '@cloudflare/vitest-plugin';
import { randomBytes, randomUUID } from 'node:crypto';
import { open, realpath, stat, unlink } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const { values } = parseArgs({ options: {
  assets: { type: 'string' },
  port: { type: 'string', default: '8799' },
  'lifetime-seconds': { type: 'string', default: '1800' },
  'credentials-file': { type: 'string' },
} });
const port = Number(values.port);
const lifetime = Number(values['lifetime-seconds']);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 8787
  || !Number.isInteger(lifetime) || lifetime < 60 || lifetime > 3600
  || !values.assets || !isAbsolute(values.assets)
  || !values['credentials-file'] || !isAbsolute(values['credentials-file'])) {
  throw new Error('Usage: board-acceptance-preview.mjs --assets /private/tmp/built-assets --port 8799 --lifetime-seconds 1800 --credentials-file /private/tmp/private-preview.json');
}
const assets = await realpath(values.assets);
const credentialsFile = resolve(values['credentials-file']);
if (!assets.startsWith('/private/tmp/') || !credentialsFile.startsWith('/private/tmp/')
  || !await stat(assets).then(info => info.isDirectory())) throw new Error('preview_paths_must_be_temporary');
await stat(resolve(assets, 'play/index.html'));
await stat(resolve(assets, 'account/index.html'));

const product = fileURLToPath(new URL('..', import.meta.url));
const owner = 'board-preview-ipv6';
const secondary = 'board-preview-loopback';
// Cookies ignore ports. Use distinct IP hosts to preserve any existing
// localhost browser session, including the user's development site.
const origins = [`http://[::1]:${port}`, `http://127.0.0.1:${port}`];
const runId = randomUUID();
const bindings = {
  AUTH_SECRET: randomBytes(48).toString('base64url'),
  LOCAL_DEV: 'true',
  TURNSTILE_SITE_KEY: '',
  NEW_WORK_STOPPED: 'false',
  OPERATION_MODE: 'unattended',
  RANKED_ENABLED: 'false',
  TOURNAMENTS_ENABLED: 'false',
  ARENAS_ENABLED: 'false',
  AI_ENABLED: 'false',
  CASUAL_GAME_LIMIT: '8',
  CASUAL_GAME_ID_LIMIT: '16',
};
const bundled = await build({ entryPoints: [resolve(product, 'src/server/index.ts')],
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
  external: ['cloudflare:*', 'node:*'], logLevel: 'silent' });
const script = bundled.outputFiles[0].text;
const worker = (name, origin) => ({ name, routes: [`${origin}/*`], modules: true, script,
  compatibilityDate: '2026-10-19', compatibilityFlags: ['nodejs_compat'],
  unsafeRegisterWorker: false,
  ...(name === owner ? { unsafeDirectSockets: [{ host: '::1', port }] } : {}),
  bindings: { ...bindings, AUTH_BASE_URL: origin },
  d1Databases: { DB: `board-preview-${runId}` },
  durableObjects: {
    GAME: { className: 'Game', scriptName: owner, useSQLite: true },
    COMPETITION: { className: 'Competition', scriptName: owner, useSQLite: true },
  },
  assets: { directory: assets, binding: 'ASSETS', run_worker_first: true,
    routerConfig: { has_user_worker: true },
    assetConfig: { not_found_handling: '404-page' } },
});

let runtime;
let privateFileCreated = false;
let phase = 'runtime';
let responseStatus;
let finish;
const finished = new Promise(resolveFinished => { finish = resolveFinished; });
const onStop = () => finish();
process.once('SIGINT', onStop);
process.once('SIGTERM', onStop);
const deadline = setTimeout(onStop, lifetime * 1000);
try {
  // No persistence root or dev registry is supplied. All storage belongs to
  // this disposable runtime and never touches the running localhost:8787 site.
  runtime = new Miniflare(convertV4MiniflareOptions({
    host: '127.0.0.1', port, cf: false, log: new Log(LogLevel.NONE),
    logRequests: false, unsafeObservability: false,
    telemetry: { enabled: false },
    handleStructuredLogs: () => {},
    handleUncaughtError: () => { process.stderr.write('preview_worker_failed\n'); },
    workers: [worker(owner, origins[0]), worker(secondary, origins[1])],
  }));
  await runtime.ready;
  if ((await runtime.unsafeGetDirectURL(owner)).origin !== origins[0]) {
    throw new Error('preview_ipv6_socket_check_failed');
  }
  phase = 'migrations';
  const db = await runtime.getD1Database('DB', owner);
  for (const migration of await readD1Migrations(resolve(product, 'migrations'))) {
    await db.batch(migration.queries.map(query => db.prepare(query)));
  }
  phase = 'origin-and-assets-checks';
  const checks = [];
  for (const [hostIndex, origin] of origins.entries()) {
    phase = `config-check-${hostIndex}`;
    const configResponse = await fetch(`${origin}/api/config`, { signal: AbortSignal.timeout(15_000) });
    responseStatus = configResponse.status;
    const config = await configResponse.json();
    if (configResponse.status !== 200 || config.local !== true || config.ranked !== false
      || config.ai !== false || config.tournaments !== false) throw new Error('preview_config_check_failed');
    phase = `assets-check-${hostIndex}`;
    const page = await fetch(`${origin}/play/`, { signal: AbortSignal.timeout(15_000), redirect: 'manual' });
    responseStatus = page.status;
    if (page.status !== 200 || !page.headers.get('content-type')?.includes('text/html')) {
      throw new Error('preview_assets_check_failed');
    }
    await page.body?.cancel();
    // A crossed browser Origin must still fail the unchanged public boundary.
    phase = `crossed-origin-check-${hostIndex}`;
    const denied = await fetch(`${origin}/api/auth/sign-up/email`, {
      method: 'POST', headers: { Origin: origins.find(value => value !== origin), 'Content-Type': 'application/json' },
      body: '{}', signal: AbortSignal.timeout(15_000),
    });
    responseStatus = denied.status;
    if (denied.status !== 403) throw new Error('preview_exact_origin_check_failed');
    await denied.body?.cancel();
    checks.push({ origin, assets: true, exactOrigin: true });
  }
  phase = 'private-artifact';
  const privateHandle = await open(credentialsFile, 'wx', 0o600);
  privateFileCreated = true;
  try {
    const accounts = [];
    for (const [index, origin] of origins.entries()) {
      phase = `public-signup-${index}`;
      const username = `board_${index}_${randomBytes(5).toString('hex')}`;
      const password = randomBytes(24).toString('base64url');
      const response = await fetch(`${origin}/api/auth/sign-up/email`, {
        method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Turnstile-Token': 'local-development' },
        body: JSON.stringify({ username, password }), signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error('preview_public_signup_failed');
      const cookie = response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
      await response.body?.cancel();
      if (!cookie) throw new Error('preview_signup_session_missing');
      phase = `public-account-check-${index}`;
      const current = await fetch(`${origin}/api/me`, {
        headers: { Cookie: cookie }, signal: AbortSignal.timeout(15_000),
      });
      const actor = await current.json();
      if (current.status !== 200 || actor?.accountReady !== true || actor.hasRecoveryEmail !== false
        || actor.isAnonymous !== false) throw new Error('preview_public_account_check_failed');
      accounts.push({ origin, username, password });
    }
    phase = 'private-artifact-write';
    await privateHandle.writeFile(`${JSON.stringify({ expiresAt: new Date(Date.now() + lifetime * 1000).toISOString(), accounts }, null, 2)}\n`);
  } finally { await privateHandle.close(); }
  process.stdout.write(`${JSON.stringify({ ready: true, origins, checks, accountsCreated: 2,
    credentialsFile, lifetimeSeconds: lifetime, driverPid: process.pid,
    scope: 'Disposable local browser acceptance; real Game and Competition; no provider bindings.' })}\n`);
  await finished;
} catch {
  process.stderr.write(`${JSON.stringify({ error: 'board_acceptance_preview_failed', phase, responseStatus })}\n`);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  process.removeListener('SIGINT', onStop);
  process.removeListener('SIGTERM', onStop);
  try { await runtime?.dispose(); }
  finally { if (privateFileCreated) await unlink(credentialsFile); }
  process.stdout.write('board_acceptance_preview_disposed\n');
}
