#!/usr/bin/env node
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CAPACITY_SAFETY_FILES, CAPACITY_SAFETY_TESTS, capacitySafetyHash as hash,
  validateCapacitySafetyReports } from './capacity-safety-evidence.mjs';

const { values } = parseArgs({ strict: true, options: { describe: { type: 'boolean' }, execute: { type: 'boolean' },
  output: { type: 'string' }, 'prior-failure': { type: 'string', multiple: true } } });
if (values.describe && Object.keys(values).length === 1) {
  process.stdout.write(JSON.stringify({ schema: 'ejm-chess-focused-capacity-safety-v1', localOnly: true,
    providerQualification: false, fullWorkload: false, productionGatesChanged: false,
    command: 'node scripts/qualify-capacity-safety.mjs --execute --output /private/tmp/chess-capacity-safety-UNIQUE --prior-failure FAILED_LOCAL_REPORT_JSON',
    checks: ['lost replies and durable fences', 'finite work and physical accounting',
      'one normal Game workflow with drained delivery', 'one actual native abort and one-use retirement acknowledgement'],
    limit: 'This replaces the redundant full-local performance prerequisite. The full provider workload, CPU and shutdown audit remain required.' }, null, 2) + '\n');
  process.exit(0);
}
const output = values.output && resolve(values.output), product = fileURLToPath(new URL('../', import.meta.url));
if (!values.execute || values.describe || !process.version.startsWith('v24.')
  || !output?.startsWith('/private/tmp/chess-capacity-safety-') || !values['prior-failure']?.length) {
  throw new Error('Use --describe for the focused local safety command.');
}
await mkdir(output, { mode: 0o700 });
const save = (name, value) => writeFile(resolve(output, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n',
  { flag: 'wx', mode: 0o600 });
const hashPaths = async paths => Object.fromEntries(await Promise.all(paths.map(async path =>
  [path, hash(await readFile(resolve(product, path)))])));
const startedAt = new Date().toISOString(), priorFailedFullWorkloads = [];
for (const file of values['prior-failure']) {
  const bytes = await readFile(resolve(file)), report = JSON.parse(bytes);
  if (report.localOnly !== true || report.fullWorkload !== true || report.providerQualification !== false || report.passed !== false) {
    throw new Error('A retained failed full-local report is required.');
  }
  priorFailedFullWorkloads.push({ file: resolve(file), sha256: hash(bytes) });
}
const compile = { bundle: true, write: false, format: 'esm', target: 'es2022', metafile: true, logLevel: 'silent' };
const plansBuild = await build({ ...compile, platform: 'node', stdin: { resolveDir: product, sourcefile: 'capacity-safety-plans.ts',
  contents: `export { CAPACITY_NATIVE_CANDIDATE_ENVELOPES, capacityControllerCandidatePlan,
    capacityRegistrationDiagnosticPlan } from './src/server/capacity-candidate-plan';
    export { CAPACITY_WORKFLOW_CANDIDATES } from './src/server/capacity-work-plan';` } });
const plans = await import('data:text/javascript;base64,' + Buffer.from(plansBuild.outputFiles[0].text).toString('base64'));
const controllerPlan = plans.capacityControllerCandidatePlan();
const registrationDiagnosticPlan = plans.capacityRegistrationDiagnosticPlan();
const worker = await build({ ...compile, platform: 'browser', external: ['cloudflare:*', 'node:*'],
  entryPoints: [resolve(product, 'src/server/capacity-qualification.ts')] });
const testsBuild = await build({ ...compile, platform: 'browser', external: ['cloudflare:*', 'node:*', 'vitest'],
  entryPoints: Object.keys(CAPACITY_SAFETY_TESTS).map(path => resolve(product, path)), outdir: 'capacity-safety-unused-output' });
const allowanceEntry = `import { capacityControllerAllowance, CAPACITY_CEILINGS } from './src/server/capacity-run';
  export default { fetch() { return Response.json({allowance:capacityControllerAllowance(${JSON.stringify(controllerPlan)}),
    registrationDiagnosticAllowance:capacityControllerAllowance(${JSON.stringify(registrationDiagnosticPlan)}),ceilings:CAPACITY_CEILINGS}); } };`;
const allowanceBuild = await build({ ...compile, platform: 'browser', external: ['cloudflare:*', 'node:*'],
  stdin: { resolveDir: product, sourcefile: 'capacity-safety-allowance.ts', contents: allowanceEntry } });
const extras = ['scripts/qualify-capacity-safety.mjs', 'scripts/capacity-safety-evidence.mjs', 'scripts/seal-capacity-provider.mjs',
  'scripts/probe-capacity-workflow.mjs', 'scripts/probe-capacity-retirement.mjs', 'scripts/capacity-driver.mjs',
  'scripts/rehearse-capacity-local.mjs', 'package.json', 'package-lock.json', 'wrangler.capacity.jsonc',
  'wrangler.jsonc', 'tsconfig.json', 'tsconfig.worker.json', 'vitest.config.ts', 'test/setup.ts',
  ...(await readdir(resolve(product, 'migrations'))).filter(name => name.endsWith('.sql')).map(name => 'migrations/' + name)];
const paths = [...new Set([worker, plansBuild, testsBuild, allowanceBuild].flatMap(build => Object.keys(build.metafile.inputs))
  .filter(path => !['capacity-safety-plans.ts', 'capacity-safety-allowance.ts'].includes(path)).concat(extras))].sort();
const sources = await hashPaths(paths), sourceDigest = hash(JSON.stringify(sources));
const fixture = { schema: 'ejm-chess-capacity-safety-source-v1', localOnly: true, providerQualification: false,
  sourceDigest, configDigest: sources['wrangler.capacity.jsonc'], sources, controllerPlan, registrationDiagnosticPlan,
  workflows: plans.CAPACITY_WORKFLOW_CANDIDATES, envelopes: plans.CAPACITY_NATIVE_CANDIDATE_ENVELOPES,
  unarmedBundleSha256: hash(worker.outputFiles[0].text), allowanceBundleSha256: hash(allowanceBuild.outputFiles[0].text) };
await save('source.json', fixture);
await save('worker-unarmed.mjs', worker.outputFiles[0].text);
await save('allowance-local-only.mjs', allowanceBuild.outputFiles[0].text);
const executions = [];
async function run(args, logName) {
  const start = Date.now(), result = await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, { cwd: product, shell: false, timeout: 90_000,
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: 'true', NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false',
        WRANGLER_LOG_PATH: resolve(output, 'wrangler.log') } });
    let text = '', size = 0;
    for (const pipe of [child.stdout, child.stderr]) pipe.on('data', bytes => {
      size += bytes.length; if (size > 2 * 1024 ** 2) child.kill(); else text += bytes.toString();
    });
    child.on('error', reject); child.on('close', code => resolveRun({ code, text, bounded: size <= 2 * 1024 ** 2 }));
  });
  await save(logName, result.text);
  executions.push({ arguments: args, exitCode: result.code, wallMs: Date.now() - start, boundedOutput: result.bounded });
  if (result.code !== 0 || !result.bounded) throw new Error('capacity_focused_check_failed:' + logName);
}
let failure = null, checked = null;
try {
  const escaped = Object.values(CAPACITY_SAFETY_TESTS).flat().map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  await run(['node_modules/vitest/vitest.mjs', 'run', ...Object.keys(CAPACITY_SAFETY_TESTS), '-t', escaped.join('|'),
    '--reporter=default', '--reporter=json', '--outputFile.json=' + resolve(output, 'focused-tests.json')], 'focused-tests.log');
  await run(['scripts/probe-capacity-workflow.mjs', '--output', resolve(output, 'native-workflow.json')], 'native-workflow.log');
  await run(['scripts/probe-capacity-retirement.mjs', '--output', resolve(output, 'native-retirement.json')], 'native-retirement.log');
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: allowanceBuild.outputFiles[0].text,
    compatibilityDate: '2026-10-19', compatibilityFlags: ['nodejs_compat'], cf: false, host: '127.0.0.1', port: 0 }));
  let allowance;
  try { allowance = await (await runtime.dispatchFetch('http://capacity-safety.local/allowance')).json(); }
  finally { await runtime.dispose(); }
  await save('allowance.json', allowance);
  const after = await hashPaths(paths), sourceChanges = paths.filter(path => sources[path] !== after[path]);
  checked = { schema: 'ejm-chess-focused-capacity-safety-v1', localOnly: true, providerQualification: false,
    fullWorkload: false, productionGatesChanged: false, passed: sourceChanges.length === 0, failure: null,
    sourceDigest, sourceChanges, priorFailedFullWorkloads, startedAt, finishedAt: new Date().toISOString(), executions };
  const read = async name => JSON.parse(await readFile(resolve(output, name), 'utf8'));
  validateCapacitySafetyReports({ report: checked, fixture, tests: await read('focused-tests.json'),
    workflow: await read('native-workflow.json'), retirement: await read('native-retirement.json'), allowance }, allowance.ceilings);
} catch (error) { failure = error instanceof Error ? error.message : 'capacity_focused_safety_failed'; }
const report = { ...checked, schema: 'ejm-chess-focused-capacity-safety-v1', localOnly: true, providerQualification: false,
  fullWorkload: false, productionGatesChanged: false, passed: failure === null && checked?.passed === true,
  failure, sourceDigest, priorFailedFullWorkloads, startedAt, finishedAt: new Date().toISOString(), executions,
  scope: 'Focused native safety only. Prior failed full-local runs remain failed. No provider CPU, throughput, resource ownership, billing or full shutdown is proved.' };
await save('report.json', report);
if (report.passed) {
  const files = Object.fromEntries(await Promise.all(CAPACITY_SAFETY_FILES.map(async name => [name, hash(await readFile(resolve(output, name)))])));
  await save('record.json', { directory: output, files });
}
process.stdout.write(JSON.stringify({ output, passed: report.passed, failure, sourceDigest, providerQualification: false }) + '\n');
if (!report.passed) process.exitCode = 1;
