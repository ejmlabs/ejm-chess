#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, readFile, readdir, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { readCapacitySafetyEvidence } from './capacity-safety-evidence.mjs';

// This checks a root-reviewed packet's consistency. It cannot authenticate a
// human decision, establish current tariffs or turn a hash into permission.
const SCHEMA = 'ejm-chess-capacity-seal-review-v2';
const GATES = {
  'src/server/capacity-run.ts': ['SEALED_CAPACITY_MANIFEST', 'VERIFIED_CONTROLLER_PLAN'],
  'src/server/capacity-native.ts': ['VERIFIED_NATIVE_ENVELOPES'],
  'src/server/capacity-work-plan.ts': ['VERIFIED_GAME_WORKFLOW_PLAN', 'VERIFIED_DELAYED_GAME_WORKFLOW_PLAN',
    'VERIFIED_SOCKET_GAME_WORKFLOW_PLAN', 'VERIFIED_COMPETITION_WORKFLOW_PLAN'],
  'src/server/capacity-qualification.ts': ['CAPACITY_PROTOCOL_READY'],
  'scripts/capacity-driver.mjs': ['CAPACITY_DRIVER_EXECUTION_READY'],
};
const CEILINGS = { chargedGames: 20_000, accounts: 6_000, workerRequests: 1_200_000,
  nativeDoRequests: 1_000_000, workerCpuMs: 60_000_000, doRowsWritten: 5_000_000,
  doRowsRead: 500_000_000, d1RowsWritten: 1_000_000, d1RowsRead: 100_000_000,
  doStorageBytes: 3 * 1024 ** 3, d1StorageBytes: 512 * 1024 ** 2, activeObjects: 2_048, durationMs: 3_600_000 };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const check = (condition, code) => { if (!condition) throw new Error(code); };
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) && !/^0+$/.test(value);
const exact = (left, right, code) => check(isDeepStrictEqual(left, right), code);
const keys = (value, names) => exact(Object.keys(value ?? {}).sort(), [...names].sort(), 'capacity_seal_input_fields_invalid');
const utc = value => {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  check(Number.isSafeInteger(parsed) && new Date(parsed).toISOString() === value, 'capacity_seal_utc_invalid');
  return parsed;
};
async function smallJson(path, maximum = 2 * 1024 ** 2) {
  const info = await stat(path);
  check(info.isFile() && info.size <= maximum, 'capacity_seal_file_invalid');
  return JSON.parse(await readFile(path, 'utf8'));
}
async function fileHash(path, maximum = 32 * 1024 ** 2) {
  const info = await stat(path);
  check(info.isFile() && info.size <= maximum, 'capacity_seal_file_invalid');
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(path)) digest.update(bytes);
  return digest.digest('hex');
}
async function reference(value, base, maximum) {
  keys(value, ['file', 'sha256']);
  check(value && typeof value.file === 'string' && hex(value.sha256), 'capacity_seal_reference_missing');
  const file = resolve(base, value.file);
  check(await fileHash(file, maximum) === value.sha256, 'capacity_seal_reference_changed');
  return file;
}
function gatePattern(name) { return new RegExp(`(export const ${name}\\b[^=;]*=\\s*)(null|false)(;)`, 'g'); }
async function closedSources(source) {
  for (const [path, names] of Object.entries(GATES)) {
    const text = await readFile(join(source, path), 'utf8');
    for (const name of names) check([...text.matchAll(gatePattern(name))].length === 1, 'capacity_seal_source_gate_changed');
  }
}
async function sourceHashes(source, expected) {
  const paths = Object.keys(expected ?? {});
  check(paths.length > 0 && paths.length <= 10_000, 'capacity_seal_source_graph_missing');
  exact(paths, [...paths].sort(), 'capacity_seal_source_order_changed');
  for (const path of paths) {
    check(!isAbsolute(path) && !path.split('/').includes('..') && !path.includes('\\')
      && !/(^|\/)(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?|sessions\.private\.json)$/.test(path)
      && hex(expected[path]), 'capacity_seal_source_path_invalid');
    check(await fileHash(join(source, path)) === expected[path], 'capacity_seal_raw_source_changed');
  }
  return hash(JSON.stringify(expected));
}
async function focusedSafety(source, review, base) {
  const safety = await readCapacitySafetyEvidence(source, review.safety, base, CEILINGS);
  const driver = await import(pathToFileURL(join(source, 'scripts/capacity-driver.mjs')).href);
  return { ...safety, sourceDigest: safety.fixture.sourceDigest, driver };
}
async function providerRecord(ref, base, path, freshSince) {
  const value = await smallJson(await reference(ref, base));
  check(value.method === 'GET' && value.http === 200 && value.success === true
    && (!value.errors || value.errors.length === 0) && value.path?.split('?')[0] === path
    && utc(value.checkedAt) >= freshSince && utc(value.checkedAt) <= Date.now(), 'capacity_seal_provider_readback_invalid');
  return value;
}
async function providerPages(refs, base, path, freshSince) {
  check(Array.isArray(refs) && refs.length > 0 && refs.length <= 100, 'capacity_seal_readback_pages_missing');
  const pages = await Promise.all(refs.map(ref => providerRecord(ref, base, path, freshSince)));
  // The zone Worker routes endpoint returns one complete unpaginated list.
  if (/^\/zones\/[a-f0-9]{32}\/workers\/routes$/.test(path)) {
    check(pages.length === 1 && pages[0].path === path && !pages[0].result_info
      && Array.isArray(pages[0].result), 'capacity_seal_routes_readback_invalid');
    return pages[0].result;
  }
  const total = pages[0].result_info?.total_count;
  check(Number.isSafeInteger(total) && total >= 0 && pages.every((page, index) => Array.isArray(page.result)
    && page.result_info?.page === index + 1 && page.result_info.total_count === total), 'capacity_seal_readback_pagination_missing');
  const values = pages.flatMap(page => page.result);
  check(values.length === total, 'capacity_seal_readback_pagination_incomplete');
  return values;
}
async function resources(review, base) {
  const r = review.resources, p = review.providerReadbacks, fresh = utc(review.freshSinceUtc);
  keys(r, ['accountId', 'zoneId', 'runId', 'workerName', 'databaseName', 'databaseId', 'host',
    'gameNamespaceId', 'competitionNamespaceId', 'controllerNamespaceId']);
  keys(p, ['settings', 'productionSettings', 'database', 'aliases', 'schedules', 'namespaces', 'domains', 'routes']);
  check(r && /^[a-f0-9]{32}$/.test(r.accountId) && /^[a-f0-9]{32}$/.test(r.zoneId)
    && /^[a-f0-9-]{36}$/.test(r.runId) && !/^0{8}-0{4}-/.test(r.runId)
    && /^ejm-chess-capacity-[a-z0-9-]+$/.test(r.workerName) && !/local|fixture|unsealed/.test(r.workerName)
    && r.databaseName === r.workerName && /^[a-f0-9-]{36}$/.test(r.databaseId) && !/^0{8}-/.test(r.databaseId)
    && /^chess-capacity-[a-z0-9-]+\.ejmlabs\.com$/.test(r.host), 'capacity_seal_assigned_resources_required');
  const ids = ['gameNamespaceId', 'competitionNamespaceId', 'controllerNamespaceId'].map(key => r[key]);
  check(new Set(ids).size === 3 && ids.every(id => /^[a-f0-9]{32}$/.test(id) && !/^(.)\1+$/.test(id)),
    'capacity_seal_assigned_namespaces_required');
  const prefix = `/accounts/${r.accountId}`, script = `${prefix}/workers/scripts/${r.workerName}`;
  const settings = (await providerRecord(p?.settings, base, `${script}/settings`, fresh)).result;
  const production = (await providerRecord(p?.productionSettings, base, `${prefix}/workers/scripts/ejm-chess/settings`, fresh)).result;
  const database = (await providerRecord(p?.database, base, `${prefix}/d1/database/${r.databaseId}`, fresh)).result;
  const aliases = (await providerRecord(p?.aliases, base, `${script}/subdomain`, fresh)).result;
  const schedules = (await providerRecord(p?.schedules, base, `${script}/schedules`, fresh)).result;
  const namespaces = await providerPages(p?.namespaces, base, `${prefix}/workers/durable_objects/namespaces`, fresh);
  const domains = await providerPages(p?.domains, base, `${prefix}/workers/domains`, fresh);
  const routes = await providerPages(p?.routes, base, `/zones/${r.zoneId}/workers/routes`, fresh);
  check(database?.uuid === r.databaseId && database.name === r.databaseName
    && aliases?.enabled === false && aliases.previews_enabled === false
    && Array.isArray(schedules?.schedules) && schedules.schedules.length === 0,
    'capacity_seal_isolation_readback_invalid');
  // Cloudflare omits observability when the requested disabled default applies.
  check(settings?.limits?.cpu_ms === 50 && settings.compatibility_date === '2026-10-19'
    && (settings.observability == null || settings.observability.enabled === false) && settings.logpush === false
    && Array.isArray(settings.tail_consumers) && settings.tail_consumers.length === 0,
    'capacity_seal_worker_readback_invalid');
  exact(settings.compatibility_flags, ['nodejs_compat'], 'capacity_seal_worker_flags_changed');
  const bindings = settings.bindings;
  exact(bindings?.map(item => item.name).sort(), ['AUTH_SECRET', 'CAPACITY_RUN', 'CAPACITY_TOKEN', 'COMPETITION', 'DB', 'GAME'],
    'capacity_seal_binding_set_invalid');
  check(bindings.every(item => item.type !== 'secret_text' || (!Object.hasOwn(item, 'text') && !Object.hasOwn(item, 'value'))),
    'capacity_seal_secret_value_present');
  check(bindings.find(item => item.name === 'DB')?.id === r.databaseId
    && bindings.filter(item => ['AUTH_SECRET', 'CAPACITY_TOKEN'].includes(item.name)).every(item => item.type === 'secret_text'),
    'capacity_seal_binding_identity_invalid');
  for (const [binding, key, className] of [['GAME', 'gameNamespaceId', 'CapacityGame'],
    ['COMPETITION', 'competitionNamespaceId', 'CapacityCompetition'], ['CAPACITY_RUN', 'controllerNamespaceId', 'CapacityRun']]) {
    const bound = bindings.find(item => item.name === binding), native = namespaces.find(item => item.id === r[key]);
    check(bound?.type === 'durable_object_namespace' && bound.namespace_id === r[key] && bound.class_name === className
      && native?.script === r.workerName && native.class === className && native.use_sqlite === true,
      'capacity_seal_namespace_ownership_invalid');
  }
  check(Array.isArray(production?.bindings) && !production.bindings.some(item =>
    [r.databaseId, ...ids].includes(item.id) || ids.includes(item.namespace_id)), 'capacity_seal_production_resource_reused');
  exact(domains.filter(item => item.service === r.workerName).map(item => item.hostname), [r.host], 'capacity_seal_host_readback_invalid');
  check(!routes.some(item => item.script === r.workerName || item.worker === r.workerName), 'capacity_seal_extra_route_present');
  return r;
}
async function reviewedInputs(review, base, local, source) {
  const r = await resources(review, base), schedule = Object.fromEntries(Object.entries(review.schedule ?? {}).map(([k, v]) => [k, utc(v)]));
  const diagnostic = review.profile === 'registration-diagnostic-v1';
  check(review.profile === undefined || diagnostic, 'capacity_seal_profile_invalid');
  exact(schedule, { ...local.driver.capacityManifestSchedule({ earliestArmAt: schedule.earliestArmAt, profile: review.profile }),
    retentionEndsAt: schedule.earliestArmAt + 30 * 86_400_000 }, 'capacity_seal_fixed_schedule_invalid');
  check(schedule.earliestArmAt % 60_000 === 0 && Date.now() < schedule.earliestArmAt
    && utc(review.freshSinceUtc) < schedule.earliestArmAt, 'capacity_seal_schedule_expired');
  const native = review.nativeReview;
  keys(native, ['record', 'rawSourceDigest', 'controllerPlanSha256', 'envelopesSha256', 'workflowsSha256']);
  const nativeRecord = await smallJson(await reference(native?.record, base));
  // Accept exact source safety before the one approved provider workload.
  // The record must retain its remaining provider and approval limits.
  const providerGaps = ['full-provider-workload', 'provider-at-least-once-delivery', 'provider-and-approval-boundary'];
  check(nativeRecord.schema === 'ejm-chess-capacity-native-source-review-v2'
    && nativeRecord.nativePlanAccepted === true && nativeRecord.sourceSafetyAccepted === true
    && nativeRecord.providerQualification === false && nativeRecord.fullWorkload === false
    && Array.isArray(nativeRecord.gaps) && nativeRecord.gaps.length === providerGaps.length
    && new Set(nativeRecord.gaps.map(gap => gap?.id)).size === providerGaps.length
    && nativeRecord.gaps.every(gap => providerGaps.includes(gap?.id)),
    'capacity_seal_native_review_incomplete');
  check(native.rawSourceDigest === local.sourceDigest && native.controllerPlanSha256 === hash(JSON.stringify(local.fixture.controllerPlan))
    && native.envelopesSha256 === hash(JSON.stringify(local.fixture.envelopes))
    && native.workflowsSha256 === hash(JSON.stringify(local.fixture.workflows)), 'capacity_seal_native_review_changed');
  exact(nativeRecord.inputDigests, { rawSourceDigest: native.rawSourceDigest,
    controllerPlanSha256: native.controllerPlanSha256, envelopesSha256: native.envelopesSha256,
    workflowsSha256: native.workflowsSha256 }, 'capacity_seal_native_review_changed');
  check(nativeRecord.rawSourceDigest === native.rawSourceDigest
    && nativeRecord.sourceIndexEntries === Object.keys(local.fixture.sources).length
    && nativeRecord.localSafetySha256 === review.safety.files['report.json']
    && nativeRecord.localBundleSha256 === review.safety.files['worker-unarmed.mjs'], 'capacity_seal_native_review_changed');
  const diagnosticPlan = local.fixture.registrationDiagnosticPlan;
  if (diagnostic) check(diagnosticPlan && nativeRecord.registrationDiagnosticPlanSha256 === hash(JSON.stringify(diagnosticPlan)),
    'capacity_seal_native_review_changed');
  const nativePlans = { controller: diagnostic ? diagnosticPlan : local.fixture.controllerPlan,
    envelopes: local.fixture.envelopes,
    workflows: diagnostic ? { regular: diagnosticPlan.workflows.Game, delayed: diagnosticPlan.workflows.Game,
      socket: diagnosticPlan.workflows.Game, competition: diagnosticPlan.workflows.Competition } : local.fixture.workflows };
  const cost = review.cost;
  keys(cost, ['accountId', 'ledger', 'accountReadbacks', 'runMaximumCents', 'monthlyOperatingTargetCents',
    'modelledIncrementalCents', 'spendKnown', 'observedSpendCents', 'reviewedAtUtc']);
  await reference(cost?.ledger, base);
  check(cost.accountId === r.accountId && cost.runMaximumCents === 2_500 && cost.monthlyOperatingTargetCents === 10_000
    && (cost.modelledIncrementalCents === null || (Number.isSafeInteger(cost.modelledIncrementalCents)
      && cost.modelledIncrementalCents >= 0 && cost.modelledIncrementalCents <= cost.runMaximumCents))
    && typeof cost.spendKnown === 'boolean'
    && (cost.spendKnown ? Number.isSafeInteger(cost.observedSpendCents) && cost.observedSpendCents >= 0 : cost.observedSpendCents === null)
    && utc(cost.reviewedAtUtc) >= utc(review.freshSinceUtc) && utc(cost.reviewedAtUtc) <= Date.now()
    && Array.isArray(cost.accountReadbacks) && cost.accountReadbacks.length >= 1, 'capacity_seal_cost_observation_missing');
  // Provider reports are observational. Incomplete prices or delayed spend do
  // not become a new financial-review gate or a claim of invoice headroom.
  for (const ref of cost.accountReadbacks) await reference(ref, base);
  const runner = review.runner;
  keys(runner, ['evidence', 'region', 'runnerId', 'transportPath', 'maximumCostCents']);
  await reference(runner?.evidence, base);
  check(runner.region === 'us-west' && ['runnerId', 'transportPath'].every(key => typeof runner[key] === 'string'
    && runner[key].length > 0 && runner[key].length <= 256 && !/local-loopback|Miniflare|fixture|unassigned/i.test(runner[key]))
    && Number.isSafeInteger(runner.maximumCostCents) && runner.maximumCostCents >= 0 && runner.maximumCostCents <= cost.runMaximumCents,
    'capacity_seal_actual_egress_required');
  const template = await smallJson(join(source, 'wrangler.capacity.jsonc'));
  exact(template, { $schema: 'node_modules/wrangler/config-schema.json', name: 'ejm-chess-capacity-unsealed',
    main: 'src/server/capacity-qualification.ts', compatibility_date: '2026-10-19', compatibility_flags: ['nodejs_compat'],
    workers_dev: false, preview_urls: false, routes: [], durable_objects: { bindings: [
      { name: 'GAME', class_name: 'CapacityGame' }, { name: 'COMPETITION', class_name: 'CapacityCompetition' },
      { name: 'CAPACITY_RUN', class_name: 'CapacityRun' }] }, migrations: [{ tag: 'capacity-v1',
      new_sqlite_classes: ['CapacityGame', 'CapacityCompetition', 'CapacityRun'] }], d1_databases: [{ binding: 'DB',
      database_name: 'ejm-chess-capacity-unsealed', database_id: '00000000-0000-0000-0000-000000000000', migrations_dir: 'migrations' }],
    observability: { enabled: false }, limits: { cpu_ms: 50 } }, 'capacity_seal_config_contract_changed');
  const config = { ...template, account_id: r.accountId, name: r.workerName, routes: [{ pattern: r.host, custom_domain: true }],
    d1_databases: [{ ...template.d1_databases[0], database_name: r.databaseName, database_id: r.databaseId }] };
  const driverText = (await readFile(join(source, 'scripts/capacity-driver.mjs'), 'utf8'))
    .replace(gatePattern('CAPACITY_DRIVER_EXECUTION_READY'), (_match, before, _value, end) => before + 'true' + end);
  // True runtime gates are proposed candidate bytes, including ownerApprovedFrozenRun.
  // They do not record permission. Final provenance records approvalPending.
  const manifest = { schema: 'ejm-chess-capacity-v1', ...(diagnostic ? { profile: review.profile } : {}),
    runId: r.runId, digest: '', sourceDigest: local.sourceDigest,
    configDigest: hash(jsonBytes(config)), databaseId: r.databaseId, gameNamespaceId: r.gameNamespaceId,
    competitionNamespaceId: r.competitionNamespaceId, controllerNamespaceId: r.controllerNamespaceId,
    workerName: r.workerName, host: r.host, ...schedule, verified: { allNativePaths: nativeRecord.nativePlanAccepted,
      worstNextOperation: nativeRecord.nativePlanAccepted, nativeActivePermits: nativeRecord.nativePlanAccepted,
      focusedLocalSafety: true, exactResourceReadback: true, ownerApprovedFrozenRun: true } };
  manifest.digest = hash(JSON.stringify(manifest));
  const candidate = { schema: 'ejm-chess-capacity-driver-candidate-v1', manifest, driverDigest: hash(driverText),
    corpusDigest: local.fixture.sources['src/shared/capacity-corpus.ts'], ledgerDigest: cost.ledger.sha256,
    incrementalMaximumCents: 2_500, egressMode: 'single-egress', runners: [{ region: 'us-west', runnerId: runner.runnerId,
      transportPath: runner.transportPath, maximumCostCents: runner.maximumCostCents, evidenceReference: runner.evidence.sha256 }] };
  local.driver.validateCapacityCandidate(candidate, candidate);
  const require = createRequire(join(source, 'package.json')), wranglerPath = require.resolve('wrangler/package.json');
  const wrangler = await smallJson(wranglerPath), pkg = await smallJson(join(source, 'package.json'));
  const wsPath = require.resolve('ws/package.json'), ws = await smallJson(wsPath);
  check(pkg.devDependencies?.wrangler === wrangler.version && wrangler.version === '4.151.3', 'capacity_seal_tool_version_changed');
  check(pkg.devDependencies.ws === ws.version && ws.version === '8.21.0', 'capacity_seal_driver_dependency_changed');
  const cli = resolve(dirname(wranglerPath), wrangler.bin.wrangler);
  const descriptor = { schema: 'ejm-chess-capacity-frozen-inputs-v1', approvalPending: true, sourceDigest: local.sourceDigest,
    safety: review.safety, nativeReview: native, cost, runner, resources: r, providerReadbacks: review.providerReadbacks,
    freshSinceUtc: review.freshSinceUtc, manifest, config, candidate,
    nativePlans,
    tooling: { node: process.version, wrangler: wrangler.version, packageSha256: await fileHash(join(source, 'package.json')),
      wranglerPackageSha256: await fileHash(wranglerPath), cliSha256: await fileHash(cli), sealerSha256: await fileHash(fileURLToPath(import.meta.url)) } };
  descriptor.tooling.ws = ws.version; descriptor.tooling.wsPackageSha256 = await fileHash(wsPath);
  return { descriptor, inputDigest: hash(JSON.stringify(descriptor)), manifest, candidate, config, driverText, cli, nativePlans };
}
async function save(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, typeof value === 'string' || Buffer.isBuffer(value) ? value : jsonBytes(value), { flag: 'wx', mode: 0o600 });
}
async function seal(source, output, local, packet) {
  check(output && relative(source, output).startsWith('../'), 'capacity_seal_output_outside_source_required');
  await mkdir(output, { mode: 0o700 });
  const stage = join(output, 'stage'); await mkdir(stage, { mode: 0o700 });
  for (const path of Object.keys(local.fixture.sources)) {
    await save(join(output, 'raw-source', path), await readFile(join(source, path)));
    if (!path.startsWith('node_modules/')) await save(join(stage, path), await readFile(join(source, path)));
  }
  if (!Object.hasOwn(local.fixture.sources, 'package.json')) {
    await save(join(stage, 'package.json'), await readFile(join(source, 'package.json')));
  }
  await symlink(await realpath(join(source, 'node_modules')), join(stage, 'node_modules'), 'dir');
  const values = { SEALED_CAPACITY_MANIFEST: packet.manifest, VERIFIED_CONTROLLER_PLAN: packet.nativePlans.controller,
    VERIFIED_NATIVE_ENVELOPES: packet.nativePlans.envelopes, VERIFIED_GAME_WORKFLOW_PLAN: packet.nativePlans.workflows.regular,
    VERIFIED_DELAYED_GAME_WORKFLOW_PLAN: packet.nativePlans.workflows.delayed, VERIFIED_SOCKET_GAME_WORKFLOW_PLAN: packet.nativePlans.workflows.socket,
    VERIFIED_COMPETITION_WORKFLOW_PLAN: packet.nativePlans.workflows.competition, CAPACITY_PROTOCOL_READY: true, CAPACITY_DRIVER_EXECUTION_READY: true };
  const substitutions = {};
  for (const [path, names] of Object.entries(GATES)) {
    let text = await readFile(join(stage, path), 'utf8');
    for (const name of names) text = text.replace(gatePattern(name), (_match, before, _value, end) => before + JSON.stringify(values[name]) + end);
    substitutions[path] = { rawSha256: local.fixture.sources[path], generatedSha256: hash(text), values: Object.fromEntries(names.map(name => [name, values[name]])) };
    await writeFile(join(stage, path), text, { mode: 0o600 });
  }
  // Only the direct product entry is bundled. No local entry or diagnostic plugin.
  const configPath = join(stage, 'wrangler.provider.json'); await save(configPath, packet.config);
  const emptyConfigDir = join(output, 'empty-config'); await mkdir(emptyConfigDir, { mode: 0o700 });
  const args = [packet.cli, 'deploy', '--dry-run', '--env', '', '--config', configPath, '--outdir', join(output, 'bundle')];
  const log = await new Promise((resolveLog, reject) => {
    const child = spawn(process.execPath, args, { cwd: stage, shell: false, timeout: 120_000, env: {
      HOME: emptyConfigDir, XDG_CONFIG_HOME: emptyConfigDir, XDG_CACHE_HOME: emptyConfigDir, CI: 'true', NO_COLOR: '1',
      PATH: dirname(process.execPath) + ':/usr/bin:/bin', WRANGLER_SEND_METRICS: 'false',
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    let bytes = 0, text = '';
    for (const pipe of [child.stdout, child.stderr]) pipe.on('data', chunk => {
      bytes += chunk.length; if (bytes > 2 * 1024 ** 2) child.kill(); else text += chunk.toString();
    });
    child.on('error', reject); child.on('close', code => code === 0 && bytes <= 2 * 1024 ** 2
      ? resolveLog(text) : reject(new Error('capacity_seal_wrangler_dry_run_failed')));
  });
  await save(join(output, 'wrangler-dry-run.log'), log);
  await sourceHashes(source, local.fixture.sources); await closedSources(source);
  check(await fileHash(join(stage, 'scripts/capacity-driver.mjs')) === packet.candidate.driverDigest
    && await fileHash(join(stage, 'src/shared/capacity-corpus.ts')) === packet.candidate.corpusDigest
    && await fileHash(configPath) === packet.manifest.configDigest, 'capacity_seal_generated_input_changed');
  const artifacts = {};
  async function collect(directory) {
    await chmod(directory, 0o700);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      check(!entry.isSymbolicLink(), 'capacity_seal_bundle_symlink_rejected');
      if (entry.isDirectory()) await collect(path);
      else { await chmod(path, 0o600); artifacts[relative(output, path)] = await fileHash(path); }
    }
  }
  await collect(join(output, 'bundle'));
  const entries = Object.keys(artifacts).filter(path => /^bundle\/[^/]+\.(?:js|mjs)$/.test(path));
  check(entries.length === 1, 'capacity_seal_bundle_entry_requires_review');
  const deployConfig = { ...packet.config, main: entries[0], no_bundle: true,
    d1_databases: packet.config.d1_databases.map(db => ({ ...db, migrations_dir: 'raw-source/migrations' })) };
  await save(join(output, 'wrangler.deploy.json'), deployConfig);
  await save(join(output, 'candidate.json'), packet.candidate);
  await save(join(output, 'manifest.json'), packet.manifest);
  await save(join(output, 'substitutions.json'), substitutions);
  await save(join(output, 'frozen-inputs.json'), packet.descriptor);
  await save(join(output, 'provenance.json'), { schema: 'ejm-chess-capacity-provider-seal-v1', inputDigest: packet.inputDigest,
    approvalPending: true, buildConfigSha256: packet.manifest.configDigest, deployConfigSha256: hash(jsonBytes(deployConfig)),
    manifestSha256: hash(jsonBytes(packet.manifest)), substitutionsSha256: hash(jsonBytes(substitutions)),
    driverSha256: packet.candidate.driverDigest, corpusSha256: packet.candidate.corpusDigest, ledgerSha256: packet.candidate.ledgerDigest,
    driverPath: 'stage/scripts/capacity-driver.mjs', corpusPath: 'stage/src/shared/capacity-corpus.ts',
    existingInstalledDependencies: await realpath(join(source, 'node_modules')),
    bundle: artifacts, publicWranglerArguments: args.slice(1), offlineCredentialsInherited: false,
    limits: 'Proposed candidate bytes only. Deployment, arming and load are prohibited until root binds the actual human decision to the final provenance and bundle hashes. Hashing and sealing establish integrity, not permission. Provider capacity remains unqualified.' });
}
async function main() {
  const { values } = parseArgs({ strict: true, options: { describe: { type: 'boolean' }, check: { type: 'boolean' },
    seal: { type: 'boolean' }, review: { type: 'string' }, source: { type: 'string' }, output: { type: 'string' } } });
  if (values.describe && Object.keys(values).length === 1) {
    process.stdout.write(JSON.stringify({ schema: SCHEMA, productGatesChanged: false, networkOrWorkload: false, approvalPending: true,
      commands: ['--check --review PRIVATE_REVIEW_JSON [--source PRODUCT_ROOT]',
        '--seal --review PRIVATE_REVIEW_JSON --output NEW_PRIVATE_DIRECTORY [--source PRODUCT_ROOT]'],
      inputs: ['immutable focused native safety record, probes, tests, allowance and source graph', 'retained failed full-local reports',
        'root native-plan review', 'assigned isolated resource and alias/schedule/domain/route readbacks',
        'fixed UTC schedule', 'finite usage ledger and observational account readbacks', 'actual US West runner evidence'],
      limits: 'Sealing prepares proposed candidate bytes before final human approval. Deployment, arming and load are prohibited until root binds the actual human decision to the final provenance and bundle hashes. Consistency checks do not establish authorization, tariffs, provider CPU, billing or public capacity.' }, null, 2) + '\n');
    return;
  }
  check(process.version.startsWith('v24.') && values.check !== values.seal && values.review && !values.describe
    && (!values.check || !values.output) && (!values.seal || values.output), 'capacity_seal_arguments_invalid');
  const source = await realpath(values.source ?? fileURLToPath(new URL('../', import.meta.url)));
  const reviewPath = resolve(values.review), base = dirname(reviewPath), info = await lstat(reviewPath);
  check(info.isFile() && !info.isSymbolicLink() && (info.mode & 0o077) === 0, 'capacity_seal_private_review_required');
  const review = await smallJson(reviewPath);
  check(review.schema === SCHEMA, 'capacity_seal_review_schema_invalid');
  keys(review, ['schema', 'safety', 'resources', 'providerReadbacks', 'freshSinceUtc', 'schedule',
    'nativeReview', 'cost', 'runner', ...(review.profile === undefined ? [] : ['profile'])]);
  keys(review.safety, ['directory', 'files']);
  await closedSources(source);
  const local = await focusedSafety(source, review, base), packet = await reviewedInputs(review, base, local, source);
  if (values.seal) await seal(source, resolve(values.output), local, packet);
  process.stdout.write(JSON.stringify({ schema: 'ejm-chess-capacity-sealer-result-v1', inputDigest: packet.inputDigest,
    candidatePackageWritten: values.seal === true, approvalPending: true, humanDecisionAuthenticatedByTool: false,
    provisioningArmingOrWorkloadRun: false, productGatesChanged: false,
    limits: 'Deployment, arming and load are prohibited until root binds the actual human decision to the final provenance and bundle hashes.' }) + '\n');
}
main().catch(error => {
  process.stderr.write((/^capacity_seal_[a-z_]+$/.test(error?.message) ? error.message : 'capacity_seal_failed_closed') + '\n');
  process.exitCode = 1;
});
