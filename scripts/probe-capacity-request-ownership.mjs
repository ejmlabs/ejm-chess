#!/usr/bin/env node
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readD1Migrations } from '@cloudflare/vitest-plugin';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { capacityFixtureManifest } from '../test/capacity-fixtures.ts';

const [flag, output] = process.argv.slice(2);
if (flag !== '--output' || !output?.startsWith('/private/tmp/')) throw new Error('Use --output /private/tmp/UNIQUE.json');
const product = fileURLToPath(new URL('../', import.meta.url));
const manifest = capacityFixtureManifest(Math.floor(Date.now() / 60_000) * 60_000);
const source = `
import { DurableObject } from 'cloudflare:workers';
import { CapacityNativeWrapper, callCapacityWorkflow } from './src/server/capacity-native';
import { CapacityTicketCodec } from './src/server/capacity-run';
import { CAPACITY_NATIVE_CANDIDATE_ENVELOPES as envelopes } from './src/server/capacity-candidate-plan';
import { CAPACITY_WORKFLOW_CANDIDATES as plans } from './src/server/capacity-work-plan';
const manifest = ${JSON.stringify(manifest)};
const workflows = { Game: plans.regular, Competition: plans.competition, delayed: plans.delayed, socket: plans.socket };
const control = env => env.CAPACITY_RUN.get(env.CAPACITY_RUN.idFromName('only'));
const safe = error => ({ code: /Cannot perform I\\/O on behalf/.test(error.message) ? 'cross-request-io'
  : error.message.match(/\\bcapacity_[a-z0-9_:-]{1,120}\\b/)?.[0] ?? 'native-error',
  frames: (error.stack ?? '').split('\\n').slice(1, 9).filter(line => /^\\s+at [\\w.$<> ():/_-]+:\\d+:\\d+\\)?$/.test(line)) });
export class Counter extends DurableObject {
  funded = new Map(); failures = []; alarms = 0;
  codec = new CapacityTicketCodec('local-ownership-fixture-secret-at-least-32-bytes');
  async available() { return true; }
  async charge() { return true; }
  async linkGame() { return true; }
  async complete() { return true; }
  async begin(id, objectKey, operation, envelope, mode = 'workflow') {
    if (this.funded.has(objectKey)) return this.funded.get(objectKey);
    const ticket = await this.codec.dispatch({ runId: manifest.runId, manifestDigest: manifest.digest,
      id, objectKey, generation: 1, operation, mode });
    this.funded.set(objectKey, ticket); return ticket;
  }
  async failed(value) { if (this.failures.length < 8) this.failures.push(value); }
  async alarmSeen() { this.alarms++; }
  async inspect() { return { failures: this.failures, alarms: this.alarms }; }
}
export class ProbeCompetition extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.native = new CapacityNativeWrapper(ctx, env, 'Competition',
    { manifest, envelopes, workflows, control: control(env) }); }
  async invoke(method, args, ticket) {
    try { return await this.native.rpc(method, args, ticket); }
    catch (error) { await control(this.env).failed({ method, ...safe(error) }); throw error; }
  }
  async prepareQualificationAccount(index, ticket) { return this.invoke('prepareQualificationAccount', [index], ticket); }
  async qualificationStep(request, index, ticket) { return this.invoke('qualificationStep', [request, index], ticket); }
  async alarm() {
    try { await this.native.alarm(); await control(this.env).alarmSeen(); }
    catch (error) { await control(this.env).failed({ method: 'alarm', ...safe(error) }); throw error; }
  }
  async stopFixture() { await this.ctx.storage.deleteAlarm(); await this.ctx.storage.sync(); }
}
let funded = null;
export default { async fetch(request, env) {
  const pathname = new URL(request.url).pathname, run = control(env);
  if (pathname === '/audit') {
    await env.COMPETITION.get(env.COMPETITION.idFromName('global')).stopFixture();
    return Response.json(await run.inspect());
  }
  const match = /^\\/(prepare|register)\\/([0-9]+)$/.exec(pathname);
  if (!match || Number(match[2]) >= 160) return new Response('Not found', { status: 404 });
  const index = Number(match[2]);
  funded ??= run.begin(crypto.randomUUID(), 'competition', 'Competition.workflow', plans.competition.envelope, 'workflow');
  try {
    const reply = await callCapacityWorkflow(env.COMPETITION, await funded,
      match[1] === 'prepare' ? 'Competition.prepareQualificationAccount' : 'Competition.qualificationStep',
      match[1] === 'prepare' ? [index] : [new Request('https://' + manifest.host + '/capacity/step/' + index,
        { headers: { Cookie: request.headers.get('Cookie') } }), index]);
    return Response.json(reply.value);
  } catch (error) { return Response.json(safe(error), { status: 503 }); }
} };`;
const built = await build({ bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
  external: ['cloudflare:*', 'node:*'], logLevel: 'silent',
  stdin: { contents: source, resolveDir: product, sourcefile: 'capacity-request-ownership-local.ts' } });
const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: built.outputFiles[0].text,
  compatibilityDate: '2026-10-19', compatibilityFlags: ['nodejs_compat'], cf: false,
  bindings: { AUTH_SECRET: 'local-ownership-fixture-secret-at-least-32-bytes' },
  d1Databases: ['DB'], durableObjects: { GAME: { className: 'ProbeCompetition', useSQLite: true },
    COMPETITION: { className: 'ProbeCompetition', useSQLite: true }, CAPACITY_RUN: { className: 'Counter', useSQLite: true } },
  host: '127.0.0.1', port: 0 }));
let report;
try {
  const origin = (await runtime.ready).origin;
  const db = await runtime.getD1Database('DB');
  for (const migration of await readD1Migrations(new URL('../migrations/', import.meta.url).pathname)) {
    await db.batch(migration.queries.map(query => db.prepare(query)));
  }
  const cookies = [];
  for (let index = 0; index < 160; index++) {
    const response = await fetch(origin + '/prepare/' + index), value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value)); cookies.push(value.cookie);
  }
  const replies = await Promise.all(Array.from({ length: 160 }, async (_, index) => {
    await new Promise(resolve => setTimeout(resolve, index * 3));
    const response = await fetch(origin + '/register/' + index, { headers: { Cookie: cookies[index] } });
    const value = await response.json();
    return { index, status: response.status, accepted: value.accepted ?? false, code: value.code ?? null, frames: value.frames };
  }));
  await new Promise(resolve => setTimeout(resolve, 250));
  const native = await (await fetch(origin + '/audit')).json();
  report = { schema: 'ejm-chess-local-request-ownership-v1', localOnly: true, providerQualification: false,
    prepared: cookies.length, replies, native,
    passed: replies.every(value => value.status === 200) && native.failures.length === 0 && native.alarms > 0 };
} finally { await runtime.dispose(); }
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
process.stdout.write(JSON.stringify({ output, passed: report.passed, prepared: report.prepared, native: report.native,
  failedRequests: report.replies.filter(value => value.status !== 200).length,
  requestFailureSamples: report.replies.filter(value => value.status !== 200).slice(0, 2) }) + '\n');
if (!report.passed) process.exitCode = 1;
