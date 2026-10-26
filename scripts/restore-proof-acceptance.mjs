#!/usr/bin/env node
/** Private operator adapter. Native recovery stays in Wrangler and the real DO APIs. */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import assert from 'node:assert/strict';

process.umask(0o077);
const { values } = parseArgs({ strict: true, options: {
  describe: { type: 'boolean' }, execute: { type: 'boolean' }, action: { type: 'string' },
  config: { type: 'string' }, 'd1-config': { type: 'string' }, output: { type: 'string' },
  games: { type: 'string' }, 'old-prover': { type: 'string' }, baseline: { type: 'string' },
  preserved: { type: 'string' }, review: { type: 'string' },
} });
const schema = 'ejm-chess-private-proof-restore-v1';
const description = { schema, actions: ['capture-prover', 'capture-boundary', 'review', 'restore'],
  default: 'No provider calls. --describe only prints this contract.',
  execution: 'Provider actions require --execute, an exact sealed candidate and a private RECOVERY service binding to ProofRecoveryCaller.',
  resources: 'Existing isolated D1, Control, Game, Competition and selected phase Prover only. Control is never restored.',
  limits: '12 Games, 39 admissions, 78 attempts, one proof month, 96 raw actions, two claims per action key. No native job starts.',
  recovery: 'Save an idle Prover before later proof attempts. After permanent stop, capture baseline with --old-prover, then preserved boundary. Review locally, approve privately, save undo receipts, restore D1 and objects, reapply credits, verify.',
  refusal: 'Different accepted D1/Game/Competition state is unsupported. Missing real bookmarks, usage uncertainty or exhausted reconstruction permits leave admission closed.',
  providerQualified: false,
};
if (values.describe && !values.execute && !values.action) {
  process.stdout.write(JSON.stringify(description, null, 2) + '\n'); process.exit(0);
}
const product = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = values.output && resolve(values.output), outside = output && relative(product, output);
if (!output || !isAbsolute(values.output) || !(outside === '..' || outside.startsWith('../'))
  || !description.actions.includes(values.action) || values.describe
  || values.action !== 'review' && (!values.execute || !values.config || !values['d1-config'])
  || values.action === 'review' && values.execute) throw new Error('Use --describe for the private command and limits.');
await mkdir(output, { mode: 0o700 });
const json = async path => {
  if (!path || (await stat(path)).size > 1_048_576) throw new Error('Use a saved JSON file of at most 1 MiB.');
  return JSON.parse(await readFile(path, 'utf8'));
};
const save = (name, value) => writeFile(resolve(output, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const points = boundary => [boundary.competition, boundary.prover, ...boundary.games];
let proxy, serial = 0;
const startedAt = new Date().toISOString();
await save('run.json', { ...description, action: values.action, startedAt });
try {
  if (values.action === 'review') {
    const baseline = await json(values.baseline), preserved = await json(values.preserved);
    const review = { schema, baseline, preserved, sha256: digest([schema, baseline, preserved]) };
    await save('review.json', review);
    await save('result.json', { preparedOnly: true, runtimeApprovalRequired: true, reviewSha256: review.sha256 });
  } else {
    // Import only after explicit execution. --describe and local review start
    // neither workerd nor a Cloudflare proxy session.
    const { getPlatformProxy, unstable_readConfig } = await import('wrangler');
    const client = unstable_readConfig({ config: resolve(values.config), env: '' });
    const authority = unstable_readConfig({ config: resolve(values['d1-config']), env: '' });
    if (client.services.length !== 1 || client.services[0].binding !== 'RECOVERY'
      || client.services[0].entrypoint !== 'ProofRecoveryCaller' || client.services[0].remote !== true
      || client.d1_databases.length || client.durable_objects.bindings.length || client.containers.length) {
      throw new Error('Use a private client config with one remote RECOVERY service binding only.');
    }
    proxy = await getPlatformProxy({ configPath: resolve(values.config), environment: '', envFiles: [], persist: false, remoteBindings: true });
    const rpc = proxy.env.RECOVERY;
    const call = async (method, input) => {
      const number = String(++serial).padStart(3, '0');
      await save(`${number}-request.json`, { method, operation: input?.operation ?? null, role: input?.role ?? null,
        name: input?.name ?? null, reviewSha256: input?.review?.sha256 ?? input?.receipt?.reviewSha256 ?? input?.reviewSha256 ?? null });
      let timeout;
      try {
        const received = await Promise.race([rpc[method](...(input === undefined ? [] : [input])), new Promise((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('Private restore reply timed out; preserve the whole action envelope.')), 60_000);
        })]);
        const result = JSON.parse(JSON.stringify(received));
        await save(`${number}-response.json`, { ok: true, result }); return result;
      } catch (error) {
        await save(`${number}-response.json`, { ok: false, message: error.message, resultUnknown: true }); throw error;
      } finally { clearTimeout(timeout); }
    };
    const identity = await call('identity');
    const database = authority.d1_databases.find(item => item.binding === 'DB');
    if (!database || database.database_id !== identity.databaseId
      || !/^ejm-chess-proof-/.test(database.database_name) || identity.databaseId === 'ebba66c8-3910-4465-a053-426fcb733833'
      || authority.vars.PROOF_ACCEPTANCE_SOURCE_REVISION !== identity.sourceDigest
      || authority.vars.PROOF_ACCEPTANCE_PROVER_NAMESPACE_ID !== identity.proverNamespaceId) throw new Error('Use the exact isolated D1 and selected phase source seal.');
    await save('identity.json', identity);
    const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
    const native = async (operation, bookmark) => {
      const number = String(++serial).padStart(3, '0');
      const args = ['d1', 'time-travel', operation, 'DB', '--config', resolve(values['d1-config']), '--env', '', '--json',
        ...(bookmark ? ['--bookmark', bookmark] : [])];
      await save(`${number}-d1-request.json`, { args });
      try {
        const result = await promisify(execFile)(process.execPath, [wrangler, ...args], {
          cwd: product, encoding: 'utf8', timeout: 60_000, maxBuffer: 262_144,
          env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' },
        });
        await save(`${number}-d1-response.json`, result);
        const parsed = JSON.parse(result.stdout);
        if (typeof parsed.bookmark !== 'string' || !parsed.bookmark) throw new Error('Native D1 bookmark was not returned.');
        return parsed;
      } catch (error) {
        await save(`${number}-d1-failure.json`, { message: error.message, stdout: error.stdout ?? null,
          stderr: error.stderr ?? null, resultUnknown: true }); throw error;
      }
    };
    const object = (operation, point, extra = {}) => call('object', { operation, role: point.point.kind, name: point.point.name, ...extra });
    if (values.action === 'capture-prover') {
      const point = await call('object', { operation: 'capture', role: 'TimeoutProver', name: 'timeout-proof-v1-singleton' });
      await save('prover.json', point);
    } else if (values.action === 'capture-boundary') {
      const names = await json(values.games);
      if (!Array.isArray(names) || names.length > 12 || new Set(names).size !== names.length
        || names.some(name => typeof name !== 'string' || !/^[\w-]{8,100}$/.test(name))) throw new Error('List at most 12 exact admitted Game IDs.');
      const d1 = await native('info');
      const accepted = await call('d1');
      const competition = await call('object', { operation: 'capture', role: 'Competition', name: 'global' });
      const games = [];
      for (const name of names) games.push(await call('object', { operation: 'capture', role: 'Game', name }));
      const prover = values['old-prover'] ? await json(values['old-prover'])
        : await call('object', { operation: 'capture', role: 'TimeoutProver', name: 'timeout-proof-v1-singleton' });
      const credits = values['old-prover'] ? await call('credits') : prover.credits;
      await save('boundary.json', { schema, sourceDigest: identity.sourceDigest, proverNamespaceId: identity.proverNamespaceId,
        databaseId: identity.databaseId, d1Bookmark: d1.bookmark, d1: accepted, competition, prover, games, credits });
    } else if (values.action === 'restore') {
      const review = await json(values.review);
      assert.equal(review.schema, schema);
      assert.equal(review.sha256, digest([schema, review.baseline, review.preserved]));
      assert.equal(review.baseline.databaseId, identity.databaseId);
      assert.equal(review.baseline.sourceDigest, identity.sourceDigest);
      assert.equal(review.baseline.proverNamespaceId, identity.proverNamespaceId);
      assert.ok(review.preserved.credits.lifecycle.stop_debt || review.preserved.credits.lifecycle.stop_pending,
        'The required debt-preservation drill needs genuine later stop debt.');
      await save('approved-review.json', review);
      await call('record', { operation: 'approve', review });
      const receipts = [];
      for (const point of points(review.baseline)) {
        const receipt = await object('prepare', point, { review });
        await save(`undo-${point.point.objectId}.json`, receipt); receipts.push(receipt);
      }
      await save('d1-undo-before-restore.json', await native('info'));
      await save('d1-native-restore.json', await native('restore', review.baseline.d1Bookmark));
      for (const receipt of receipts) {
        try { await call('object', { operation: 'restart', role: receipt.kind, name: receipt.name, receipt, privateReceiptSaved: true }); }
        catch { /* Native abort loses its reply. The exact restored state must pass reapply. */ }
      }
      const admissions = await call('admissions', review);
      assert.equal(admissions.accepted.authority.sha256, review.preserved.d1.authority.sha256);
      for (const row of review.preserved.credits.admissions) {
        assert.deepEqual(admissions.admissions.find(item => item.game_id === row.game_id), row);
      }
      for (const month of review.preserved.credits.months) {
        assert.ok(admissions.months.some(row => row.slot === month.slot && row.period === month.period && row.used >= month.used));
      }
      const verified = [];
      for (const point of points(review.baseline)) {
        await object('reapply', point, { review });
        const result = await object('verify', point, { review });
        const later = points(review.preserved).find(item => item.point.objectId === point.point.objectId);
        assert.equal(result.budget.events, later.budget.events + 1);
        assert.equal(result.nativeRunning, false);
        if (point.point.kind === 'TimeoutProver') {
          for (const row of review.preserved.credits.attempts) assert.deepEqual(result.attempts.find(item => item.id === row.id), row);
          const before = new Set(point.credits.attempts.map(row => row.id));
          assert.ok(review.preserved.credits.attempts.filter(row => !before.has(row.id)).every(row => result.missingNativeResults.includes(row.id)));
          assert.equal(result.lifecycle.stop_debt, 1); assert.equal(result.lifecycle.phase, 'stopping');
          assert.ok(result.lifecycle.stop_pending >= review.preserved.credits.lifecycle.stop_pending);
        } else assert.equal(result.product.sha256, point.product.sha256);
        verified.push({ kind: point.point.kind, name: point.point.name, result });
      }
      const control = await call('record', { operation: 'read' });
      assert.equal(control.failed, false);
      assert.ok(Object.values(control.actions).reduce((sum, count) => sum + count, 0) <= 96);
      await save('verified.json', { passed: true, providerQualification: 'isolated-native-restore-only',
        reviewSha256: review.sha256, admissionStillClosed: true, admissions, authorities: verified, control });
    }
  }
  process.stdout.write(JSON.stringify({ ok: true, action: values.action, output }) + '\n');
} catch (error) {
  await save('failure.json', { passed: false, action: values.action, message: error.message,
    admissionMustStayClosed: true, completedAt: new Date().toISOString() });
  process.stderr.write(error.message + '\n'); process.exitCode = 1;
} finally { await proxy?.dispose(); }
