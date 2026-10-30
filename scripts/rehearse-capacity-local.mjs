#!/usr/bin/env node
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readD1Migrations } from '@cloudflare/vitest-plugin';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { CapacityBindings, CapacityTrace, CapacityTransport, CAPACITY_DRIVER_TIMING, CAPACITY_LOCAL_REGISTRATION_PROFILE_MS, capacityCalendarSchedule,
  capacityDriverDigests, localCapacityFetch, runCapacitySchedule, runLocalCapacityRehearsal } from './capacity-driver.mjs';
import { CAPACITY_CORPUS, CAPACITY_PREPARATION_BATCH_SIZE, capacityPreparationAccounts } from '../src/shared/capacity-corpus.ts';

const { values } = parseArgs({ options: {
  describe: { type: 'boolean' }, execute: { type: 'boolean' },
  'preparation-probe': { type: 'boolean' },
  'preparation-batch-probe': { type: 'boolean' },
  'preparation-stall': { type: 'boolean' },
  'request-ownership-probe': { type: 'boolean' },
  'request-ownership-cold': { type: 'boolean' },
  'registration-profile': { type: 'boolean' },
  output: { type: 'string' }, 'start-at': { type: 'string' },
}, strict: true });
if (values.describe && (Object.keys(values).length === 1
  || (values['registration-profile'] === true && Object.keys(values).length === 2))) {
  const profiling = values['registration-profile'] === true;
  process.stdout.write(JSON.stringify({ schema: profiling ? 'ejm-chess-local-registration-cpu-profile-v1' : 'ejm-chess-local-capacity-rehearsal-v1', localOnly: true,
    fullWorkload: !profiling, qualificationPassed: false,
    providerQualification: false, productionGatesChanged: false,
    workload: profiling ? 'Original setup and first 60 seconds of registration. A Worker CPU profile, no full qualification.'
      : 'Full fixed corpus, real clocks, native Game/Competition, loopback HTTP and WebSockets, real Cache API',
    command: 'node scripts/rehearse-capacity-local.mjs --execute '
      + (profiling ? '--registration-profile ' : '') + '--output /private/tmp/chess-rehearsal-UNIQUE [--start-at ISO_UTC]',
    duration: profiling ? '60-second registration maximum after unchanged setup. Same early failure stop, then drain and dispose.'
      : 'Single-egress audit after the 30-minute admission close; 60-minute hard stop, no clock acceleration or outcome fixtures',
    failure: 'A failed allowance, missed schedule or uncertain result remains a failure. No automatic restart.',
    registrationProfile: { command: 'node scripts/rehearse-capacity-local.mjs --execute --registration-profile --output /private/tmp/chess-rehearsal-UNIQUE --start-at ISO_UTC',
      fullWorkload: false, providerQualification: false, qualificationPassed: false,
      registrationWindowMs: CAPACITY_LOCAL_REGISTRATION_PROFILE_MS, samplingIntervalUs: 2_000,
      maximumProfileBytes: 32 * 1024 ** 2, inspectorHost: '127.0.0.1',
      limits: 'Original setup, accounts and registration slots. Same first-failure stop, 256 in-flight cap and request deadlines. Local CPU attribution only.' },
  }, null, 2) + '\n');
  process.exit(0);
}
const output = values.output && resolve(values.output);
if (!values.execute || values.describe || !process.version.startsWith('v24.')
  || !output?.startsWith('/private/tmp/chess-rehearsal-')) {
  throw new Error('Use --describe for the local-only command and limits.');
}
const product = fileURLToPath(new URL('../', import.meta.url));
const preparationBatch = values['preparation-batch-probe'] === true;
const preparationOnly = values['preparation-probe'] === true || preparationBatch;
const preparationStall = values['preparation-stall'] === true;
const ownershipOnly = values['request-ownership-probe'] === true;
const ownershipCold = values['request-ownership-cold'] === true;
const registrationProfiling = values['registration-profile'] === true;
const shortProbe = preparationOnly || ownershipOnly;
if ([preparationOnly, ownershipOnly, registrationProfiling].filter(Boolean).length > 1) throw new Error('Choose one bounded local diagnostic.');
if (ownershipCold && !ownershipOnly) throw new Error('Cold ownership arrivals are a bounded local diagnostic only.');
if (preparationStall && !preparationOnly) throw new Error('A preparation stall is a bounded local diagnostic only.');
const anchor = values['start-at'] ? Date.parse(values['start-at'])
  : Math.ceil((Date.now() + (shortProbe ? 10_000 : 120_000)) / 60_000) * 60_000;
const schedule = capacityCalendarSchedule(anchor);
if (anchor < Date.now() + (shortProbe ? 5_000 : 60_000) || anchor > Date.now() + 86_400_000) {
  throw new Error('The fixed start must be between one minute and one day from now.');
}
// Exclusive creation prevents a failed run from replacing its retained record.
await mkdir(output, { mode: 0o700 });
const writeJson = (name, value) => writeFile(resolve(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const sha256 = value => createHash('sha256').update(value).digest('hex');
async function hashPaths(paths) {
  return Object.fromEntries(await Promise.all(paths.map(async path => [path, sha256(await readFile(resolve(product, path)))])));
}
const startedAt = new Date().toISOString(), started = performance.now();
const compile = { bundle: true, write: false, format: 'esm', target: 'es2022', logLevel: 'silent' };

// Import only source-owned trial plans. The build makes their type-only
// dependencies safe for Node without importing Cloudflare runtime classes.
const plansBuild = await build({ ...compile, platform: 'node', metafile: true, stdin: {
  contents: `export { CAPACITY_NATIVE_CANDIDATE_ENVELOPES, capacityControllerCandidatePlan }
    from './src/server/capacity-candidate-plan';
    export { CAPACITY_WORKFLOW_CANDIDATES } from './src/server/capacity-work-plan';`,
  resolveDir: product, sourcefile: 'capacity-local-plans.ts',
} });
const plans = await import('data:text/javascript;base64,' + Buffer.from(plansBuild.outputFiles[0].text).toString('base64'));
const controllerPlan = plans.capacityControllerCandidatePlan();
const unarmedBuild = await build({ ...compile, platform: 'browser', metafile: true,
  external: ['cloudflare:*', 'node:*'], entryPoints: [resolve(product, 'src/server/capacity-qualification.ts')] });
const fixedSources = [...new Set([...Object.keys(unarmedBuild.metafile.inputs),
  ...Object.keys(plansBuild.metafile.inputs).filter(path => path !== 'capacity-local-plans.ts'),
  'scripts/rehearse-capacity-local.mjs', 'scripts/capacity-driver.mjs', 'package-lock.json', 'wrangler.capacity.jsonc',
  ...(await readdir(resolve(product, 'migrations'))).filter(file => file.endsWith('.sql')).map(file => 'migrations/' + file),
])].sort();
const initialSources = await hashPaths(fixedSources);
const sourceDigest = sha256(JSON.stringify(initialSources));
const configDigest = sha256(await readFile(new URL('../wrangler.capacity.jsonc', import.meta.url)));
const manifest = { schema: 'ejm-chess-capacity-v1', runId: randomUUID(), digest: '', sourceDigest, configDigest,
  databaseId: randomUUID(), gameNamespaceId: '1'.repeat(32), competitionNamespaceId: '2'.repeat(32),
  controllerNamespaceId: '3'.repeat(32), workerName: 'ejm-chess-capacity-local-fixture',
  host: 'chess-capacity-local.ejmlabs.com', ...schedule, retentionEndsAt: anchor + 30 * 86_400_000,
  // These flags select a local fixture bundle only. The report cannot qualify
  // provider ownership or approval, and no generated bundle is deployed.
  verified: { allNativePaths: true, worstNextOperation: true, nativeActivePermits: true,
    focusedLocalSafety: true, exactResourceReadback: true, ownerApprovedFrozenRun: true },
};
manifest.digest = sha256(JSON.stringify(manifest));
const substitutions = {
  'capacity-run.ts': { SEALED_CAPACITY_MANIFEST: manifest, VERIFIED_CONTROLLER_PLAN: controllerPlan },
  'capacity-native.ts': { VERIFIED_NATIVE_ENVELOPES: plans.CAPACITY_NATIVE_CANDIDATE_ENVELOPES },
  'capacity-work-plan.ts': {
    VERIFIED_GAME_WORKFLOW_PLAN: plans.CAPACITY_WORKFLOW_CANDIDATES.regular,
    VERIFIED_DELAYED_GAME_WORKFLOW_PLAN: plans.CAPACITY_WORKFLOW_CANDIDATES.delayed,
    VERIFIED_SOCKET_GAME_WORKFLOW_PLAN: plans.CAPACITY_WORKFLOW_CANDIDATES.socket,
    VERIFIED_COMPETITION_WORKFLOW_PLAN: plans.CAPACITY_WORKFLOW_CANDIDATES.competition,
  },
  'capacity-qualification.ts': { CAPACITY_PROTOCOL_READY: true },
};
const plugin = { name: 'local-capacity-fixture-only', setup(builder) {
  builder.onLoad({ filter: /capacity-(run|native|work-plan|qualification|fixtures)\.ts$/ }, async ({ path }) => {
    let contents = await readFile(path, 'utf8');
    const replacements = substitutions[path.slice(path.lastIndexOf('/') + 1)] ?? {};
    for (const [name, value] of Object.entries(replacements)) {
      const pattern = new RegExp(`(export const ${name}\\b[\\s\\S]*?=\\s*)(?:null|false)(;)`, 'g');
      if ([...contents.matchAll(pattern)].length !== 1) throw new Error('Local fixture marker changed: ' + name);
      contents = contents.replace(pattern, (_match, prefix, end) => prefix + JSON.stringify(value) + end);
    }
    if (ownershipCold && path.endsWith('capacity-run.ts')) {
      const marker = "const dispatch = await this.#run('begin',";
      if (contents.split(marker).length !== 2) throw new Error('Local cold-funding marker changed.');
      contents = contents.replace(marker, `
        if (objectKey === 'competition' && operation === 'Competition.workflow')
          await new Promise(resolve => setTimeout(resolve, 100));
        ${marker}`);
    }
    if (path.endsWith('capacity-qualification.ts')) {
      const marker = '// The frozen controller plan includes this one denied/failed-isolate';
      if (contents.split(marker).length !== 2) throw new Error('Local diagnostic marker changed.');
      contents = contents.replace(marker, `
      const code = error instanceof Error ? error.message.match(/\\bcapacity_[a-z0-9_:-]{1,120}\\b/)?.[0]
        ?? (/Cannot perform I\\/O on behalf/.test(error.message) ? 'cross-request-io'
          : /D1_ERROR/.test(error.message) ? 'D1_ERROR'
          : ['AbortError', 'TimeoutError', 'TypeError', 'SyntaxError'].includes(error.name) ? error.name : 'unknown-native-error') : 'unknown-native-error';
      const codes = globalThis.__localCapacityProbeCodes ??= [];
      if (codes.length < 8) codes.push(code);
      const frames = globalThis.__localCapacityProbeFrames ??= [];
      if (frames.length < 8) frames.push({ code, frames: (error.stack ?? '').split('\\n').slice(1, 9)
        .filter(line => /^\\s+at [\\w.$<> ():/_-]+:\\d+:\\d+\\)?$/.test(line)) });
      ${marker}`);
    }
    if (ownershipOnly && path.endsWith('capacity-native.ts')) {
      const marker = '// No release on an uncertain reply, rejected bound or incomplete I/O.';
      if (contents.split(marker).length !== 2) throw new Error('Local native failure marker changed.');
      contents = contents.replace(marker, `
        const failure = { code: /Cannot perform I\\/O on behalf/.test(error.message) ? 'cross-request-io'
          : error.message.match(/\\bcapacity_[a-z0-9_:-]{1,120}\\b/)?.[0] ?? 'native-error',
          frames: (error.stack ?? '').split('\\n').slice(1, 9)
            .filter(line => /^\\s+at [\\w.$<> ():/_-]+:\\d+:\\d+\\)?$/.test(line)) };
        const diagnosticSql = this.ctx.storage.sql;
        diagnosticSql.exec('CREATE TABLE IF NOT EXISTS local_ownership_errors(payload TEXT NOT NULL)');
        if (diagnosticSql.exec('SELECT COUNT(*) AS n FROM local_ownership_errors').one().n < 8)
          diagnosticSql.exec('INSERT INTO local_ownership_errors VALUES(?)', JSON.stringify(failure));
        ${marker}`);
      const classMarker = 'export class CapacityCompetition extends DurableObject<CapacityEnv> {';
      if (contents.split(classMarker).length !== 2) throw new Error('Local diagnostic class marker changed.');
      contents = contents.replace(classMarker, `${classMarker}
        async localOwnershipFailures() {
          const sql = this.ctx.storage.sql;
          return sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_ownership_errors'").toArray().length
            ? sql.exec('SELECT payload FROM local_ownership_errors').toArray().map(row => JSON.parse(row.payload)) : [];
        }`);
    }
    if (preparationStall && path.endsWith('capacity-fixtures.ts')) {
      const marker = preparationBatch ? 'async prepareBatch(first: number): Promise<CapacityAccountCredential[]> {'
        : 'async prepare(index: number): Promise<CapacityAccountCredential> {';
      if (contents.split(marker).length !== 2) throw new Error('Local preparation marker changed.');
      contents = preparationBatch ? contents.replace(marker, `${marker}
        if (first === 0) await new Promise(resolve => setTimeout(resolve, 10_000));`)
        : contents.replace(marker, `${marker}
        if (index >= 1024 && index < 1062) await new Promise(resolve => setTimeout(resolve,
          Math.max(0, this.manifest.earliestArmAt + 23_230 - Date.now())));`);
    }
    if (preparationBatch && path.endsWith('capacity-native.ts')) {
      const marker = 'export class CapacityCompetition extends DurableObject<CapacityEnv> {';
      if (contents.split(marker).length !== 2) throw new Error('Local preparation readback marker changed.');
      contents = contents.replace(marker, `${marker}
        async localPreparationReadback() {
          const sql = this.ctx.storage.sql;
          return sql.exec('SELECT COUNT(*) AS fixtures,SUM(ready) AS ready FROM capacity_fixture_accounts').one();
        }`);
    }
    return { contents, loader: 'ts' };
  });
} };
const entry = `
import entry from './src/server/capacity-qualification';
import { VERIFIED_CONTROLLER_PLAN, capacityControllerAllowance, CAPACITY_CEILINGS } from './src/server/capacity-run';
export { CapacityRun } from './src/server/capacity-run';
export { CapacityGame, CapacityCompetition } from './src/server/capacity-native';
export default { async fetch(request, env) {
  const url = new URL(request.url);
  if (!['127.0.0.1', ${JSON.stringify(manifest.host)}].includes(url.hostname)
    || request.headers.get('Host') !== ${JSON.stringify(manifest.host)})
    return new Response('Local fixture only', {status:403});
  if (url.pathname === '/__local/allowance' && request.method === 'GET')
    return Response.json({allowance:capacityControllerAllowance(VERIFIED_CONTROLLER_PLAN),ceilings:CAPACITY_CEILINGS});
  if (url.pathname === '/__local/probe-codes' && request.method === 'GET')
    return Response.json(globalThis.__localCapacityProbeCodes ?? []);
  if (${preparationBatch} && url.pathname === '/__local/preparation-readback' && request.method === 'GET')
    return Response.json(await env.COMPETITION.get(env.COMPETITION.idFromName('global')).localPreparationReadback());
  if (${ownershipOnly} && url.pathname === '/__local/ownership-frames' && request.method === 'GET')
    return Response.json({ worker: globalThis.__localCapacityProbeFrames ?? [],
      native: await env.COMPETITION.get(env.COMPETITION.idFromName('global')).localOwnershipFailures() });
  if (${shortProbe || registrationProfiling} && url.pathname === '/__local/probe-stop' && request.method === 'POST') {
    const controller = env.CAPACITY_RUN.get(env.CAPACITY_RUN.idFromName(${JSON.stringify(manifest.runId)}));
    await controller.stop();
    return Response.json(await controller.status());
  }
  return entry.fetch(new Request('https://' + ${JSON.stringify(manifest.host)} + url.pathname + url.search, request), env);
} };`;
const bundled = await build({ ...compile, platform: 'browser', metafile: true, plugins: [plugin],
  external: ['cloudflare:*', 'node:*'], stdin: { contents: entry, resolveDir: product, sourcefile: 'capacity-local-loopback-entry.ts' } });
const bundle = bundled.outputFiles[0].text;
const inputPaths = [...new Set([...Object.keys(bundled.metafile.inputs).filter(path => !path.startsWith('capacity-local-')),
  ...fixedSources])].sort();
const sources = await hashPaths(inputPaths);
if (inputPaths.some(path => !Object.hasOwn(initialSources, path))) throw new Error('Local bundle introduced an unhashed source dependency.');
if (fixedSources.some(path => initialSources[path] !== sources[path])) throw new Error('Source changed while preparing the local bundle.');
await writeJson('local-fixture.json', { localOnly: true, providerQualification: false, manifest, controllerPlan,
  ...(registrationProfiling ? { fullWorkload: false, qualificationPassed: false } : {}),
  workflows: plans.CAPACITY_WORKFLOW_CANDIDATES, envelopes: plans.CAPACITY_NATIVE_CANDIDATE_ENVELOPES,
  generatedBundleDigest: sha256(bundle), sources });
await writeFile(resolve(output, 'worker-local-only.mjs'), bundle, { flag: 'wx', mode: 0o600 });
const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle,
  compatibilityDate: '2026-10-19', compatibilityFlags: ['nodejs_compat'], cf: false,
  d1Databases: { DB: 'local-capacity-rehearsal' },
  bindings: { AUTH_SECRET: randomBytes(48).toString('base64url'), CAPACITY_TOKEN: randomBytes(32).toString('base64url') },
  durableObjects: { GAME: { className: 'CapacityGame', useSQLite: true },
    COMPETITION: { className: 'CapacityCompetition', useSQLite: true },
    CAPACITY_RUN: { className: 'CapacityRun', useSQLite: true } },
  host: '127.0.0.1', port: 0,
  ...(registrationProfiling ? { inspectorPort: 0, inspectorHost: '127.0.0.1' } : {}),
}));
let result = null, failure = null, nativeFailureCodes = [];
let runtimeOrigin = null;
let cpuProfile = null, diagnosticStop = null, runtimeDisposedAt = null;
const setup = { d1RowsRead: 0, d1RowsWritten: 0, d1StorageBytes: 0, queries: 0 };
try {
  const origin = (await runtime.ready).origin;
  runtimeOrigin = origin;
  const allowanceResponse = await localCapacityFetch(origin + '/__local/allowance', { headers: { Host: manifest.host } });
  const allowance = await allowanceResponse.json();
  await writeJson('allowance.json', allowance);
  if (!allowanceResponse.ok || !allowance.allowance) throw new Error('Trial controller and workflow allowances exceed the fixed run limits.');
  const db = await runtime.getD1Database('DB');
  const migrations = await readD1Migrations(new URL('../migrations/', import.meta.url).pathname);
  for (const migration of migrations) {
    for (const reply of await db.batch(migration.queries.map(query => db.prepare(query)))) {
      setup.d1RowsRead += reply.meta.rows_read;
      setup.d1RowsWritten += reply.meta.rows_written;
      setup.d1StorageBytes = Math.max(setup.d1StorageBytes, reply.meta.size_after);
      setup.queries++;
    }
  }
  const env = await runtime.getBindings();
  const credentials = { runId: manifest.runId, manifestDigest: manifest.digest, token: env.CAPACITY_TOKEN,
    accounts: Array(CAPACITY_CORPUS.accounts).fill(null) };
  const candidate = { schema: 'ejm-chess-capacity-driver-candidate-v1', manifest,
    ...(registrationProfiling ? { fullWorkload: false, providerQualification: false, qualificationPassed: false } : {}),
    ...await capacityDriverDigests(), ledgerDigest: sha256(JSON.stringify({ controllerPlan, setup, sources })),
    incrementalMaximumCents: 2_500, egressMode: 'single-egress', runners: [{ region: 'us-west',
      runnerId: 'local-loopback-only', transportPath: 'Miniflare loopback', maximumCostCents: 0,
      evidenceReference: 'local-fixture.json' }] };
  await writeJson('candidate-local-only.json', candidate);
  process.stdout.write(JSON.stringify({ localOnly: true, providerQualification: false, output,
    ...(registrationProfiling ? { fullWorkload: false, qualificationPassed: false } : {}),
    startAt: new Date(anchor).toISOString(), finishAt: new Date(registrationProfiling
      ? anchor + CAPACITY_DRIVER_TIMING.registrationBurstOffsetMs + CAPACITY_LOCAL_REGISTRATION_PROFILE_MS + 5_000
      : manifest.hardCloseAt).toISOString(), setup }) + '\n');
  if (registrationProfiling) cpuProfile = await registrationCpuProfile(runtime,
    anchor + CAPACITY_DRIVER_TIMING.registrationBurstOffsetMs, output);
  if (ownershipOnly) {
    const headers = { Authorization: 'Bearer ' + env.CAPACITY_TOKEN, Origin: 'https://' + manifest.host, Host: manifest.host,
      'Content-Type': 'application/json' };
    const invoke = async (path, cookie) => {
      const response = await localCapacityFetch(origin + path, { method: 'POST', body: '{}',
        headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) }, signal: AbortSignal.timeout(5_000) });
      const body = await response.text();
      let value;
      try { value = JSON.parse(body); }
      catch { value = { code: body === 'Qualification stopped' ? 'qualification-stopped'
        : /never generate a response|code had hung/.test(body)
          ? 'runtime-request-hung' : 'non-json-reply' }; }
      return { status: response.status, value };
    };
    await new Promise(resolve => setTimeout(resolve, Math.max(0, anchor - Date.now())));
    const arm = await invoke('/capacity/arm');
    if (arm.status !== 200 || arm.value.armed !== true) throw new Error('Local ownership controller did not arm.');
    const cookies = [], failures = [], replies = [];
    let preparationCalls = 0;
    // Recover the same 160 fixtures to put the first registration burst across
    // the exact 6,144-slot native ingress boundary. This is no throughput claim.
    const prepare = async index => {
      const reply = await invoke('/capacity/prepare/' + index);
      preparationCalls++;
      if (reply.status !== 200) failures.push({ kind: 'prepare', index, status: reply.status, code: reply.value.code ?? null });
      else cookies[index] ??= reply.value.cookie;
    };
    if (ownershipCold) await Promise.all(Array.from({ length: 8 }, (_, index) => prepare(index)));
    for (let index = ownershipCold ? 8 : 0; index < 160 && failures.length === 0; index++) await prepare(index);
    for (let at = 160; at < 6_128 && failures.length === 0; at += 8) {
      await Promise.all(Array.from({ length: Math.min(8, 6_128 - at) }, (_, slot) => prepare((at + slot) % 160)));
    }
    if (failures.length === 0) await Promise.all(Array.from({ length: 160 }, async (_, index) => {
      await new Promise(resolve => setTimeout(resolve, index * 3));
      const reply = await invoke('/capacity/step/' + index, cookies[index]);
      const value = { index, status: reply.status, accepted: reply.value.accepted ?? false, code: reply.value.code ?? null };
      replies.push(value);
      if (reply.status !== 200 && reply.status !== 429) failures.push({ kind: 'step', ...value });
    }));
    const diagnostics = await (await localCapacityFetch(origin + '/__local/ownership-frames', { headers: { Host: manifest.host } })).json();
    const control = await (await localCapacityFetch(origin + '/__local/probe-stop', { method: 'POST', headers: { Host: manifest.host } })).json();
    result = { requestOwnershipOnly: true, coldFundingOverlap: ownershipCold, fullWorkload: false, preparationCalls, uniqueAccounts: cookies.length,
      registrationCalls: replies.length, replies, failures, diagnostics, control,
      passed: preparationCalls === 6_128 && replies.length === 160 && failures.length === 0
        && diagnostics.worker.length === 0 && diagnostics.native.length === 0 };
  } else if (preparationOnly) {
    const trace = new CapacityTrace(resolve(output, 'trace.jsonl.gz'));
    const transport = new CapacityTransport({ origin: 'https://' + manifest.host, credentials,
      bindings: new CapacityBindings(), earliestArmAt: anchor, issueCloseAt: manifest.issueCloseAt,
      hardCloseAt: manifest.hardCloseAt, fetcher: (url, init) => localCapacityFetch(origin + new URL(url).pathname,
        { ...init, headers: { ...init.headers, Host: manifest.host } }) });
    let ready = true;
    function* jobs() {
      yield { kind: 'arm', at: anchor };
      yield { kind: 'status', at: anchor + 1_000 };
      for (let index = 0; index < (preparationBatch ? CAPACITY_CORPUS.accounts : 2_049);
        index += preparationBatch ? CAPACITY_PREPARATION_BATCH_SIZE : 1) yield { kind: 'prepare', index,
        ...(preparationBatch ? { count: capacityPreparationAccounts(index).length } : {}),
        at: anchor + CAPACITY_DRIVER_TIMING.fixturePrepareOffsetMs + index * CAPACITY_DRIVER_TIMING.fixturePrepareIntervalMs,
        replyDeadlineAt: anchor + CAPACITY_DRIVER_TIMING.credentialSealOffsetMs };
    }
    try {
      let lastPreparationAcknowledgedAt = null;
      const totals = await runCapacitySchedule(jobs(), { issueCloseAt: manifest.issueCloseAt, hardCloseAt: manifest.hardCloseAt,
        ready: () => ready, record: async value => {
          if (value.kind === 'prepare' && value.type === 'acknowledged' && value.accepted) lastPreparationAcknowledgedAt = value.acknowledgedAt;
          await trace.write(value);
        }, issue: async job => {
          try { return await transport.issue(job); } catch (error) { ready = false; throw error; }
        } });
      const codesResponse = await localCapacityFetch(origin + '/__local/probe-codes', { headers: { Host: manifest.host } });
      const stopped = await localCapacityFetch(origin + '/__local/probe-stop', { method: 'POST', headers: { Host: manifest.host } });
      const primary = preparationBatch ? await db.prepare(`SELECT
        (SELECT COUNT(*) FROM user) AS users,(SELECT COUNT(*) FROM account WHERE providerId='credential') AS credentials,
        (SELECT COUNT(*) FROM session) AS sessions`).first() : null;
      const native = preparationBatch ? await (await localCapacityFetch(origin + '/__local/preparation-readback',
        { headers: { Host: manifest.host } })).json() : null;
      const credentialDeadlineAt = anchor + CAPACITY_DRIVER_TIMING.credentialSealOffsetMs;
      const countsValid = !preparationBatch || primary?.users === 6_000 && primary.credentials === 6_000
        && primary.sessions === 6_000 && native.fixtures === 6_000 && native.ready === 6_000
        && credentials.accounts.filter(Boolean).length === 6_000 && lastPreparationAcknowledgedAt <= credentialDeadlineAt;
      result = { preparationOnly: true, preparationBatch, preparationStall, fullWorkload: false, passed: totals.passed && countsValid,
        ...(preparationBatch ? { primary, native, credentialDeadlineAt, lastPreparationAcknowledgedAt,
          deadlineMarginMs: credentialDeadlineAt - lastPreparationAcknowledgedAt, modeledColdTailMs: preparationStall ? 10_000 : 0 } : {}),
        prepared: credentials.accounts.filter(Boolean).length, totals, codes: await codesResponse.json(), control: await stopped.json() };
    } finally { transport.close(); await trace.close(); }
  } else {
    result = await runLocalCapacityRehearsal({ candidate, credentials, tracePath: resolve(output, 'trace.jsonl.gz'),
      sessionsArtifactPath: resolve(output, 'sessions.private.json'), loopbackOrigin: origin,
      ...(registrationProfiling ? { registrationProfile: { ready: () => cpuProfile.ready() } } : {}) });
  }
} catch (error) {
  failure = error instanceof Error ? error.message : 'Unknown local rehearsal failure';
} finally {
  if (cpuProfile) {
    try { await cpuProfile.stop(); }
    catch { failure ??= 'Local registration CPU profile was not captured.'; }
    finally { cpuProfile.close(); }
  }
  if (runtimeOrigin) {
    if (registrationProfiling) {
      try {
        const response = await localCapacityFetch(runtimeOrigin + '/__local/probe-stop', { method: 'POST',
          headers: { Host: manifest.host }, signal: AbortSignal.timeout(5_000) });
        const control = await response.json();
        diagnosticStop = { acknowledged: response.ok && control.stopReason === 'owner-stop',
          stopReason: control.stopReason, unresolvedDispatches: control.unresolvedDispatches };
        if (!diagnosticStop.acknowledged) failure ??= 'Local diagnostic stop was not acknowledged.';
      } catch { failure ??= 'Local diagnostic stop was not acknowledged.'; }
    }
    try {
      const response = await localCapacityFetch(runtimeOrigin + '/__local/probe-codes', { headers: { Host: manifest.host } });
      nativeFailureCodes = await response.json();
    } catch { nativeFailureCodes = ['local-diagnostic-readback-unavailable']; }
  }
  await runtime.dispose();
  runtimeDisposedAt = new Date().toISOString();
}
const sourcesAfter = await hashPaths(inputPaths);
const sourceChanges = inputPaths.filter(path => sources[path] !== sourcesAfter[path]);
const report = { schema: registrationProfiling ? 'ejm-chess-local-registration-cpu-profile-v1'
  : ownershipOnly ? 'ejm-chess-local-capacity-request-ownership-v1'
  : preparationOnly ? 'ejm-chess-local-capacity-preparation-probe-v1' : 'ejm-chess-local-capacity-rehearsal-v1', localOnly: true,
  fullWorkload: !shortProbe && !registrationProfiling,
  ...(registrationProfiling ? { qualificationPassed: false, cpuProfile: cpuProfile?.metadata() ?? null,
    diagnosticStop, runtimeDisposedAt, diagnosticCompleted: result?.diagnosticScheduleCompleted === true
      && cpuProfile?.metadata().captured === true && cpuProfile.metadata().failure === null
      && sourceChanges.length === 0 && failure === null } : {}),
  providerQualification: false, productionGatesChanged: false, node: process.version, startedAt,
  finishedAt: new Date().toISOString(), wallMs: performance.now() - started, sourceChanges,
  setup, result, nativeFailureCodes, failure, passed: !registrationProfiling && result?.passed === true && sourceChanges.length === 0 && failure === null,
  limits: 'Local CPU and loopback observations do not prove Cloudflare 50ms CPU, WAN latency, billing or resource ownership.' };
await writeJson('report.json', report);
process.stdout.write(JSON.stringify({ report: resolve(output, 'report.json'), passed: report.passed, failure, sourceChanges }) + '\n');
if (registrationProfiling ? !report.diagnosticCompleted : !report.passed) process.exitCode = 1;

/** The supported workerd inspector profiles the user Worker, not this driver. */
async function registrationCpuProfile(runtime, registrationStartsAt, directory) {
  const maximumBytes = 32 * 1024 ** 2;
  const inspector = await runtime.getInspectorURL();
  if (inspector.protocol !== 'ws:' || inspector.hostname !== '127.0.0.1'
    || inspector.username || inspector.password || !inspector.port) throw new Error('local_profile_inspector_invalid');
  const discovery = new URL('/json/list', inspector);
  discovery.protocol = 'http:';
  const response = await fetch(discovery, { redirect: 'error', signal: AbortSignal.timeout(5_000) });
  if (!response.ok || !response.body) throw new Error('local_profile_discovery_failed');
  let discoveryBytes = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    discoveryBytes += chunk.byteLength;
    if (discoveryBytes > 64 * 1024) throw new Error('local_profile_discovery_limit');
    chunks.push(Buffer.from(chunk));
  }
  const targets = JSON.parse(Buffer.concat(chunks, discoveryBytes).toString('utf8'));
  const users = Array.isArray(targets) ? targets.filter(target => target.description === 'workers'
    || (typeof target.id === 'string' && target.id.startsWith('core:user:'))) : [];
  if (users.length !== 1) throw new Error('local_profile_target_ambiguous');
  const target = new URL(users[0].webSocketDebuggerUrl);
  if (target.protocol !== 'ws:' || target.hostname !== '127.0.0.1' || target.port !== inspector.port
    || target.username || target.password) throw new Error('local_profile_target_invalid');
  const socket = new globalThis.WebSocket(target);
  const pending = new Map();
  let ordinal = 0, failed = null, closing = false, active = false;
  let startTimer = null, stopTimer = null, startPromise = null, stopPromise = null;
  const capture = { samplingIntervalUs: 2_000, registrationStartsAt,
    registrationCutoffAt: registrationStartsAt + CAPACITY_LOCAL_REGISTRATION_PROFILE_MS,
    maximumBytes, captured: false, profilerAffected: true };
  const timestamp = () => ({ wallMs: Date.now(), monotonicMs: performance.now() });
  const fail = error => {
    failed ??= error;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(failed); }
    pending.clear();
  };
  socket.addEventListener('message', event => {
    try {
      if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > maximumBytes + 64 * 1024) {
        throw new Error('local_profile_message_limit');
      }
      const reply = JSON.parse(event.data);
      const item = pending.get(reply.id);
      if (!item) return;
      pending.delete(reply.id); clearTimeout(item.timer);
      // workerd acknowledges void commands without a result, as Wrangler allows.
      if (reply.error != null) {
        const error = new Error('local_profile_protocol_failed:' + item.method);
        item.reject(error); fail(error); return;
      }
      item.resolve(reply.result);
    } catch { fail(new Error('local_profile_reply_invalid')); }
  });
  socket.addEventListener('error', () => fail(new Error('local_profile_socket_failed')));
  socket.addEventListener('close', () => { if (!closing) fail(new Error('local_profile_socket_closed')); });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    if (failed || socket.readyState !== globalThis.WebSocket.OPEN) {
      reject(failed ?? new Error('local_profile_socket_unavailable')); return;
    }
    const id = ++ordinal;
    const timer = setTimeout(() => fail(new Error('local_profile_command_timeout:' + method)), 5_000);
    pending.set(id, { method, resolve, reject, timer });
    try { socket.send(JSON.stringify({ id, method, params })); }
    catch { fail(new Error('local_profile_send_failed')); }
  });
  const close = () => {
    closing = true; clearTimeout(startTimer); clearTimeout(stopTimer);
    fail(new Error('local_profile_closed')); socket.close();
  };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('local_profile_connect_timeout')), 5_000);
      const done = action => { clearTimeout(timer); socket.removeEventListener('open', opened);
        socket.removeEventListener('error', errored); socket.removeEventListener('close', errored); action(); };
      const opened = () => done(resolve);
      const errored = () => done(() => reject(new Error('local_profile_connect_failed')));
      socket.addEventListener('open', opened, { once: true });
      socket.addEventListener('error', errored, { once: true });
      socket.addEventListener('close', errored, { once: true });
    });
    await command('Profiler.enable');
    await command('Profiler.setSamplingInterval', { interval: capture.samplingIntervalUs });
  } catch (error) { close(); throw error; }

  const stop = () => stopPromise ??= (async () => {
    clearTimeout(startTimer); clearTimeout(stopTimer);
    if (startPromise) await startPromise;
    if (!active) { fail(new Error('local_profile_not_started')); throw failed; }
    capture.stopRequested = timestamp();
    const { profile } = await command('Profiler.stop');
    capture.stopAcknowledged = timestamp(); active = false;
    if (!profile || !Array.isArray(profile.nodes) || !Array.isArray(profile.samples)
      || !Array.isArray(profile.timeDeltas) || profile.samples.length !== profile.timeDeltas.length
      || !Number.isFinite(profile.startTime) || !Number.isFinite(profile.endTime)
      || profile.endTime < profile.startTime) throw new Error('local_profile_capture_invalid');
    const encoded = JSON.stringify(profile) + '\n';
    const bytes = Buffer.byteLength(encoded);
    if (bytes > maximumBytes) throw new Error('local_profile_output_limit');
    await writeFile(resolve(directory, 'registration.cpuprofile'), encoded, { flag: 'wx', mode: 0o600 });
    Object.assign(capture, { captured: true, file: 'registration.cpuprofile', bytes,
      sha256: sha256(encoded), startTimeUs: profile.startTime, endTimeUs: profile.endTime, samples: profile.samples.length });
  })().catch(error => { fail(error); throw error; });
  if (Date.now() >= registrationStartsAt - 500) { close(); throw new Error('local_profile_start_late'); }
  startTimer = setTimeout(() => {
    startPromise = (async () => {
      capture.startRequested = timestamp();
      await command('Profiler.start'); active = true; capture.startAcknowledged = timestamp();
    })().catch(error => { fail(error); throw error; });
    void startPromise.catch(() => {});
  }, registrationStartsAt - 500 - Date.now());
  stopTimer = setTimeout(() => { void stop().catch(() => {}); }, capture.registrationCutoffAt - Date.now());
  return { ready: () => active && failed === null, stop, close,
    metadata: () => ({ ...capture, failure: failed?.message === 'local_profile_closed' ? null : failed?.message ?? null }) };
}
