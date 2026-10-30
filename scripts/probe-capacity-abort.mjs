#!/usr/bin/env node
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

// Native local lifecycle evidence only. This fixture is never a deploy entry.
// Reuse the workerd runtime already pinned by Wrangler; install no load tool.
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--output' || !args[1].startsWith('/private/tmp/')) {
  throw new Error('Usage: node scripts/probe-capacity-abort.mjs --output /private/tmp/report.json');
}
const source = String.raw`
import { DurableObject } from 'cloudflare:workers';
export class AbortProbe extends DurableObject {
  incarnation = crypto.randomUUID();
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS probe(id INTEGER PRIMARY KEY,nonce TEXT,committed INTEGER,after_abort INTEGER DEFAULT 0,caught INTEGER DEFAULT 0,alarms INTEGER DEFAULT 0)');
  }
  async prepare() {
    const nonce = crypto.randomUUID();
    this.ctx.storage.sql.exec('INSERT INTO probe(id,nonce,committed) VALUES(1,?,1)', nonce);
    await this.ctx.storage.setAlarm(Date.now()+600000);
    await this.ctx.storage.sync();
    return {nonce,incarnation:this.incarnation};
  }
  async reset(nonce) {
    const row = this.ctx.storage.sql.exec('SELECT nonce FROM probe WHERE id=1').one();
    if (row.nonce !== nonce) throw new Error('wrong_probe_nonce');
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.sync();
    try { this.ctx.abort('capacity-probe-abort:'+nonce,{retryAlarm:false}); }
    catch { this.ctx.storage.sql.exec('UPDATE probe SET caught=1 WHERE id=1'); }
    this.ctx.storage.sql.exec('UPDATE probe SET after_abort=1 WHERE id=1');
    return {unexpected:true};
  }
  async inspect() {
    return {incarnation:this.incarnation,row:this.ctx.storage.sql.exec('SELECT * FROM probe WHERE id=1').one(),alarm:await this.ctx.storage.getAlarm()};
  }
  async armAbortAlarm() { await this.ctx.storage.setAlarm(Date.now()+10); }
  async alarm() {
    this.ctx.storage.sql.exec('UPDATE probe SET alarms=alarms+1 WHERE id=1');
    await this.ctx.storage.sync();
    this.ctx.abort('capacity-probe-alarm-abort',{retryAlarm:false});
  }
}
export default {
  async fetch(request,env) {
    const stub=env.PROBE.get(env.PROBE.idFromName('one-local-abort-probe'));
    const path=new URL(request.url).pathname;
    if(path==='/prepare') return Response.json(await stub.prepare());
    if(path==='/inspect') return Response.json(await stub.inspect());
    if(path==='/alarm') {await stub.armAbortAlarm();return Response.json({armed:true});}
    if(path==='/reset') {
      const {nonce}=await request.json();
      try {return Response.json({returned:await stub.reset(nonce)});}
      catch(error) {return Response.json({error:{name:error.name,message:error.message,remote:error.remote??null,
        durableObjectReset:error.durableObjectReset??null,retryable:error.retryable??null,
        overloaded:error.overloaded??null,keys:Object.getOwnPropertyNames(error)}});}
    }
    return new Response('Not found',{status:404});
  }
};`;

const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: source,
  compatibilityDate: '2026-10-19', compatibilityFlags: ['nodejs_compat'], cf: false,
  durableObjects: { PROBE: { className: 'AbortProbe', useSQLite: true } },
  host: '127.0.0.1', port: 0 }));
const started = performance.now();
const cpuStart = process.cpuUsage();
let report;
try {
  const request = async (path, body) => {
    const response = await runtime.dispatchFetch('http://capacity-lifecycle.local' + path,
      body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
    if (!response.ok) throw new Error(`local_probe_http_${response.status}`);
    return response.json();
  };
  const prepared = await request('/prepare');
  const reset = await request('/reset', { nonce: prepared.nonce });
  const after = await request('/inspect');
  await request('/alarm');
  let alarm;
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    alarm = await request('/inspect');
    if (alarm.row.alarms) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  await new Promise(resolve => setTimeout(resolve, 2_500));
  const afterRetryWindow = await request('/inspect');
  const checks = {
    taggedAbortException: reset.error?.message === 'capacity-probe-abort:' + prepared.nonce,
    nativeResetFlagObserved: reset.error?.durableObjectReset === true,
    freshIncarnation: after.incarnation !== prepared.incarnation,
    committedStatePreserved: after.row.committed === 1 && after.row.nonce === prepared.nonce,
    abortCannotBeCaught: after.row.caught === 0 && after.row.after_abort === 0,
    alarmDeletedBeforeReset: after.alarm === null,
    noImmediateAlarmRetry: afterRetryWindow.row.alarms === 1 && afterRetryWindow.alarm === null,
  };
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  report = { schema: 'ejm-chess-native-abort-local-v1', at: new Date().toISOString(), node: process.version,
    runtime: { miniflare: lock.packages['node_modules/miniflare']?.version, workerd: lock.packages['node_modules/workerd']?.version },
    sourceSha256: createHash('sha256').update(source).digest('hex'), checks, reset, prepared, after, alarm, afterRetryWindow,
    wallMs: performance.now() - started, driverCpu: process.cpuUsage(cpuStart), driverMaxRssBytes: process.resourceUsage().maxRSS * 1024,
    activationGateReady: false,
    acknowledgmentLimit: 'The initial hypothesis expected remote=true, but native abort has no remote property. durableObjectReset is observed in this pinned local runtime and is not a documented release acknowledgment. No permit release is implemented from this signal.',
    scope: 'One local native workerd object. A tagged abort exception, fresh incarnation, preserved SQLite and immediate alarm-retry behavior are measured. This is not provider billing evidence or a complete permit/lifetime proof.' };
  await writeFile(args[1], JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ report: args[1], checks, remoteAbort: reset.error, wallMs: report.wallMs }) + '\n');
  if (Object.values(checks).some(value => !value)) process.exitCode = 1;
} finally { await runtime.dispose(); }
