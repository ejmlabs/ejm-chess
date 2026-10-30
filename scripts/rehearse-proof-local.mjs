#!/usr/bin/env node
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readD1Migrations } from '@cloudflare/vitest-plugin';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ strict: true, options: {
  describe: { type: 'boolean' }, execute: { type: 'boolean' }, output: { type: 'string' },
  through: { type: 'string', default: 'C00' },
} });
const description = { schema: 'ejm-chess-local-proof-rehearsal-v1', localOnly: true,
  providerQualification: false, productionGatesChanged: false,
  command: 'node scripts/rehearse-proof-local.mjs --execute --output /private/tmp/chess-proof-rehearsal-UNIQUE [--through corpus]',
  workload: 'Private caller -> real Control, Game, Competition and TimeoutProver classes; pinned Docker image; native D1/SQLite',
  defaultWork: 'arm -> select-lite -> C00 -> permanent stop',
  limits: 'Local fixture flags permit only this in-memory bundle. They do not qualify a provider tier, costs or launch gates.',
};
// Fixed runtime dependency of the installed Miniflare, not the solver image.
const ingressImage = 'cloudflare/proxy-everything:3cb1195@sha256:0ef6716c52430096900b150d84a3302057d6cd2319dae7987128c85d0733e3c8';
if (values.describe && !values.execute && !values.output) {
  process.stdout.write(JSON.stringify(description, null, 2) + '\n'); process.exit(0);
}
const output = values.output && resolve(values.output);
if (!values.execute || values.describe || !process.version.startsWith('v24.')
  || !output?.startsWith('/private/tmp/chess-proof-rehearsal-') || !['C00', 'corpus'].includes(values.through)) {
  throw new Error('Use --describe for the local-only command and limits.');
}
// A failed run never replaces its evidence. No provider config is read.
await mkdir(output, { mode: 0o700 });
const product = fileURLToPath(new URL('../', import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const writeJson = (name, value) => writeFile(resolve(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const commands = [], startedAt = new Date().toISOString();
let runtime, failure = null, finalState = null, nativeState = null, sources = {}, bundleDigest = null;
const setup = { statements: 0, d1RowsRead: 0, d1RowsWritten: 0, d1StorageBytes: 0 };
function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 });
  if (result.status !== 0) throw new Error('Local Docker check failed: ' + (result.stderr || result.error?.message || result.status));
  return result.stdout.trim();
}
const paths = ['scripts/rehearse-proof-local.mjs', 'package-lock.json', 'proof/acceptance-manifest.json', 'proof/corpus.json'];
for (const directory of ['src/server', 'src/shared', 'migrations']) {
  for (const file of await readdir(resolve(product, directory), { recursive: true })) {
    if (/\.(ts|sql)$/.test(file)) paths.push(directory + '/' + file);
  }
}
paths.sort();
const hashSources = async () => Object.fromEntries(await Promise.all(paths.map(async path => [path, sha256(await readFile(resolve(product, path)))])));
let call;
try {
  sources = await hashSources();
  const original = JSON.parse(await readFile(resolve(product, 'proof/acceptance-manifest.json'), 'utf8'));
  const image = JSON.parse(docker(['image', 'inspect', original.nativeImage.digest, '--format', '{{json .}}']));
  if (image.Id !== original.nativeImage.digest || image.Os !== 'linux' || image.Architecture !== 'amd64') throw new Error('Pinned local image does not match.');
  const ingress = JSON.parse(docker(['image', 'inspect', ingressImage, '--format', '{{json .}}']));
  const socket = docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
  if (!/^unix:\/\/\//.test(socket)) throw new Error('Only a local Docker socket is allowed.');
  // Synthetic local review records exercise only the compiled interface.
  // They are not owner decisions, cost evidence or provider qualification.
  const fixtureReviews = { costReviewSha256: sha256('local-only-cost-review-fixture'),
    sourcePermitReviewSha256: sha256('local-only-source-permit-review-fixture'),
    ownerResidualCostAcceptanceSha256: sha256('local-only-owner-risk-fixture') };
  const manifest = { ...original, status: 'local-rehearsal-only', executionAvailable: true, adaptersAvailable: true,
    reviewGates: {
      costReview: { status: 'reviewed', sha256: fixtureReviews.costReviewSha256 },
      sourcePermitReview: { status: 'reviewed', sha256: fixtureReviews.sourcePermitReviewSha256 },
      ownerResidualCostAcceptance: { status: 'accepted', sha256: fixtureReviews.ownerResidualCostAcceptanceSha256 },
      providerResourceQualification: { status: 'pending', sha256: null },
    }, sealedRuntimeIdentity: null };
  const digest = sha256(JSON.stringify([{ ...manifest, sealedRuntimeIdentity: null }]));
  const identity = { scope: manifest.scope, manifestDigest: digest, sourceDigest: sha256(JSON.stringify(sources)), ...fixtureReviews,
    accountId: 'a'.repeat(32), controlNamespaceId: 'b'.repeat(32), databaseId: randomUUID(),
    gameNamespaceId: 'c'.repeat(32), competitionNamespaceId: 'd'.repeat(32),
    liteProverNamespaceId: 'e'.repeat(32), basicProverNamespaceId: 'f'.repeat(32),
    privateCaller: manifest.privateCaller, expiresAt: Date.now() + manifest.limits.candidateLifetimeSeconds * 1000 };
  manifest.sealedRuntimeIdentity = identity;
  const bundled = await build({ entryPoints: [resolve(product, 'src/server/proof-acceptance.ts')], bundle: true,
    write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:*', 'node:*'],
    logLevel: 'silent', plugins: [{ name: 'local-proof-fixture-only', setup(builder) {
      builder.onLoad({ filter: /\/proof\/acceptance-manifest\.json$/ }, () => ({ contents: JSON.stringify(manifest), loader: 'json' }));
      builder.onLoad({ filter: /\/src\/server\/proof-pool\.ts$/ }, async ({ path }) => {
        const source = await readFile(path, 'utf8');
        const marker = '} catch {\n      // An uncertain stop remains durable';
        if (source.split(marker).length !== 2) throw new Error('Local native diagnostic marker changed.');
        return { contents: source.replace(marker, '} catch (error) {\n      console.error("Local proof native error:", error);\n      // An uncertain stop remains durable')
          .replace('void monitor.then(settled, settled);', 'void monitor.then(settled, error => { console.error("Local proof monitor:", error); settled(); });'), loader: 'ts' };
      });
    } }] });
  const bundle = bundled.outputFiles[0].text; bundleDigest = sha256(bundle);
  await writeFile(resolve(output, 'worker-local-only.mjs'), bundle, { flag: 'wx', mode: 0o600 });
  await writeJson('local-fixture.json', { ...description, identity, nativeImage: original.nativeImage, sourceFiles: sources,
    ingressImage: { reference: ingressImage, id: ingress.Id, architecture: ingress.Architecture },
    generatedBundleDigest: bundleDigest, fixtureFlagsAreQualificationEvidence: false, fixtureReviewsAreOwnerDecisions: false });
  const token = randomBytes(32).toString('hex');
  const caller = `export default { async fetch(request,env) {
    if (new URL(request.url).hostname !== '127.0.0.1' || request.method !== 'POST'
      || request.headers.get('Authorization') !== 'Bearer ' + env.LOCAL_TOKEN) return new Response('Not found',{status:404});
    return Response.json(await env.CALLER.command(await request.json()));
  } };`;
  const stopped = { TIMEOUT_PROOF_PROFILE: 'off', MONTHLY_PROOF_LIMIT: '0', NEW_WORK_STOPPED: 'true',
    RANKED_ENABLED: 'false', TOURNAMENTS_ENABLED: 'false', ARENAS_ENABLED: 'false', ANALYSIS_ENABLED: 'false',
    AI_ENABLED: 'false', MONTHLY_GAME_LIMIT: '0', MONTHLY_EMAIL_LIMIT: '0', MONTHLY_ANALYSIS_LIMIT: '0' };
  runtime = new Miniflare(convertV4MiniflareOptions({ host: '127.0.0.1', port: 0, cf: false,
    containerEngine: { localDocker: { socketPath: socket, containerEgressInterceptorImage: ingressImage } }, workers: [
      { name: 'proof-local-caller', modules: true, script: caller, compatibilityDate: '2026-10-19',
        bindings: { LOCAL_TOKEN: token }, serviceBindings: { CALLER: { name: 'proof-local-authorities', entrypoint: 'ProofAcceptanceCaller' } } },
      { name: 'proof-local-authorities', modules: true, script: bundle, compatibilityDate: '2026-10-19',
        compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: identity.databaseId },
        bindings: { ...stopped, PROOF_ACCEPTANCE_SCOPE: manifest.scope,
          PROOF_ACCEPTANCE_SOURCE_REVISION: identity.sourceDigest, PROOF_ACCEPTANCE_CONTROL_NAMESPACE_ID: identity.controlNamespaceId,
          PROOF_ACCEPTANCE_MANIFEST_SHA256: digest, PROOF_ACCEPTANCE_EXECUTION: 'sealed-private',
          PROOF_ACCEPTANCE_TIER: 'lite', PROOF_ACCEPTANCE_PROVER_NAMESPACE_ID: identity.liteProverNamespaceId },
        durableObjects: { PROOF_ACCEPTANCE: { className: 'ProofAcceptance', useSQLite: true },
          GAME: { className: 'AcceptanceGame', useSQLite: true }, COMPETITION: { className: 'AcceptanceCompetition', useSQLite: true },
          PROVER: { className: 'AcceptanceTimeoutProver', useSQLite: true, container: { imageName: image.Id } } } },
    ] }));
  const origin = (await runtime.ready).origin;
  const db = await runtime.getD1Database('DB', 'proof-local-authorities');
  for (const migration of await readD1Migrations(new URL('../migrations/', import.meta.url).pathname)) {
    for (const reply of await db.batch(migration.queries.map(query => db.prepare(query)))) {
      setup.statements++; setup.d1RowsRead += reply.meta.rows_read; setup.d1RowsWritten += reply.meta.rows_written;
      setup.d1StorageBytes = Math.max(setup.d1StorageBytes, reply.meta.size_after);
    }
  }
  call = async command => {
    const before = Date.now();
    const response = await runtime.dispatchFetch(origin + '/command', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(command),
      signal: AbortSignal.timeout(45_000) });
    const text = await response.text();
    let result; try { result = JSON.parse(text); } catch { result = { error: text.slice(0, 4096) }; }
    commands.push({ command, status: response.status, startedAt: new Date(before).toISOString(), wallMs: Date.now() - before, result });
    await writeJson('command-' + String(commands.length).padStart(2, '0') + '.json', commands.at(-1));
    if (!response.ok || !result.ok) throw new Error('Local command failed: ' + JSON.stringify(command));
    return result;
  };
  await call({ operation: 'arm' });
  await call({ operation: 'advance', id: 'select-lite' });
  const maximum = values.through === 'corpus' ? 27 : 1;
  for (let index = 0; index < maximum; index++) {
    const id = 'C' + String(index).padStart(2, '0');
    const result = await call({ operation: 'advance', id });
    if (!result.job?.complete || !result.job.passed) throw new Error('Local native fixture did not pass: ' + id);
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  if (call) {
    try {
      await call({ operation: 'stop' }); finalState = (await call({ operation: 'inspect' })).status;
      if (commands.some(item => item.command.id === 'C00')) {
        const prover = await runtime.getDurableObjectNamespace('PROVER', 'proof-local-authorities');
        nativeState = JSON.parse(JSON.stringify(await prover.get(prover.idFromName('timeout-proof-v1-singleton')).acceptanceInspect()));
        if (nativeState.nativeRunning || nativeState.stopDebt || nativeState.pendingStops || nativeState.phase !== 'idle') {
          throw new Error('Local native stop was not confirmed.');
        }
      }
    }
    catch (error) { failure ??= 'Cleanup failed: ' + String(error); }
  }
  if (runtime) await runtime.dispose();
}
const after = await hashSources();
const sourceChanges = paths.filter(path => sources[path] && sources[path] !== after[path]);
const report = { ...description, startedAt, finishedAt: new Date().toISOString(), through: values.through,
  generatedBundleDigest: bundleDigest, setup, sourceChanges, commands: commands.length, finalState, nativeState, failure,
  passed: failure === null && sourceChanges.length === 0 };
await writeJson('report.json', report);
process.stdout.write(JSON.stringify({ report: resolve(output, 'report.json'), passed: report.passed, failure, sourceChanges }) + '\n');
if (!report.passed) process.exitCode = 1;
