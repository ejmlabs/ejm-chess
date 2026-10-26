#!/usr/bin/env node
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { capacityFixtureManifest } from '../test/capacity-fixtures.ts';

// Fixed local native fixture only. This is never a deployed entry or driver.
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--output' || !args[1].startsWith('/private/tmp/')) {
  throw new Error('Usage: node scripts/probe-capacity-retirement.mjs --output /private/tmp/report.json');
}
const product = fileURLToPath(new URL('..', import.meta.url));
const manifest = capacityFixtureManifest();
const source = `
import { DurableObject } from 'cloudflare:workers';
import { CapacityRunStore, CapacityTicketCodec, capacityRetirementAck, emptyCapacityWork } from './src/server/capacity-run';
import { CapacityNativeWrapper, callCapacityNative } from './src/server/capacity-native';
import { CapacityNativeMeter } from './src/server/capacity-meter';
const manifest = ${JSON.stringify(manifest)};
const secret = 'local-native-retirement-fixture-key-at-least-32-bytes';
const work = {...emptyCapacityWork(),nativeDoRequests:1,doRowsRead:10000,doRowsWritten:10000,doStorageBytes:100000};
const resetWork = {...emptyCapacityWork(),nativeDoRequests:8,doRowsRead:10000,doRowsWritten:10000,doStorageBytes:100000};
export class ProbeRun extends DurableObject {
  meter = new CapacityNativeMeter();
  costs = [];
  constructor(ctx,env) {
    super(ctx,env);
    this.store = new CapacityRunStore(this.meter.sql(ctx.storage.sql),f=>ctx.storage.transactionSync(f),manifest);
    this.codec = new CapacityTicketCodec(secret);
  }
  measure(method,f) {
    const before=this.meter.snapshot();
    try { return f(); } finally { const after=this.meter.snapshot();this.costs.push({method,
      rowsRead:after.doRowsRead-before.doRowsRead,rowsWritten:after.doRowsWritten-before.doRowsWritten}); }
  }
  async arm(){return this.measure('arm',()=>this.store.arm());}
  async charge(id,n){return this.measure('charge',()=>this.store.charge(id,n));}
  async linkGame(id,r){return this.measure('linkGame',()=>this.store.linkGame(id,r));}
  async available(){return this.measure('available',()=>this.store.available());}
  async begin(id,key,operation,envelope,mode='rpc') {
    const value=this.measure('begin',()=>this.store.begin(id,key,operation,envelope,mode));
    return value?this.codec.dispatch(value):null;
  }
  async complete(ticket,actual,drained) {
    if(!await this.codec.validDispatch(ticket,manifest,ticket.objectKey,ticket.operation))return false;
    return this.measure('complete',()=>this.store.complete(ticket,actual,drained));
  }
  async prepareRetirement(key,envelope) {
    const value=this.measure('prepareRetirement',()=>this.store.prepareRetirement(key,envelope));
    return value?this.codec.retirement(value):null;
  }
  async confirmRetirement(value,ack) {
    if(!await this.codec.validRetirement(value,manifest))return false;
    return this.measure('confirmRetirement',()=>this.store.confirmRetirement(value,ack));
  }
  async status(){return this.measure('status',()=>this.store.status());}
  async observations(){return {costs:this.costs,usage:this.meter.snapshot()};}
}
export class ProbeGame extends DurableObject {
  incarnation=crypto.randomUUID();
  constructor(ctx,env) {
    super(ctx,env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS local_probe(id INTEGER PRIMARY KEY,preserved INTEGER,alarm_entered INTEGER,alarm_returned INTEGER,retire_caught INTEGER,retire_returned INTEGER)');
    ctx.storage.sql.exec('INSERT OR IGNORE INTO local_probe VALUES(1,1,0,0,0,0)');
    const control=env.RUN.get(env.RUN.idFromName('one-local-run'));
    const nativeEnv={DB:{},GAME:env.GAME,COMPETITION:env.GAME,CAPACITY_RUN:env.RUN,AUTH_SECRET:secret,CAPACITY_TOKEN:'local-fixture-unused'};
    this.native=new CapacityNativeWrapper(ctx,nativeEnv,'Game',{manifest,envelopes:{'Game.status':work,'Game.retire':resetWork},control});
  }
  async status(ticket){return this.native.rpc('status',[],ticket);}
  async retire(value) {
    try {await this.native.retire(value);} catch(error) {
      this.ctx.storage.sql.exec('UPDATE local_probe SET retire_caught=retire_caught+1 WHERE id=1');throw error;
    }
    this.ctx.storage.sql.exec('UPDATE local_probe SET retire_returned=retire_returned+1 WHERE id=1');
  }
  async alarm() {
    this.ctx.storage.sql.exec('UPDATE local_probe SET alarm_entered=alarm_entered+1 WHERE id=1');
    await this.native.alarm();
    this.ctx.storage.sql.exec('UPDATE local_probe SET alarm_returned=alarm_returned+1 WHERE id=1');
  }
  async inspect(){return {incarnation:this.incarnation,probe:this.ctx.storage.sql.exec('SELECT * FROM local_probe').one(),
    wrapper:this.ctx.storage.sql.exec('SELECT * FROM capacity_wrapper_state').one(),
    consumed:this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM capacity_wrapper_dispatches').one().n,
    alarm:await this.ctx.storage.getAlarm()};}
}
export default {async fetch(request,env) {
  if(new URL(request.url).pathname!=='/exercise')return new Response('Not found',{status:404});
  const control=env.RUN.get(env.RUN.idFromName('one-local-run'));
  const id='one-local-retirement-game',key='game:'+id,receipt='casual:'+id;
  if(!await control.arm()||!await control.charge(receipt,1)||!await control.linkGame(id,receipt))throw new Error('fixture_admission');
  await callCapacityNative(env.GAME,control,key,'Game.status',work);
  const before=await env.GAME.get(env.GAME.idFromName(id)).inspect();
  const grant=await control.prepareRetirement(key,resetWork);
  if(!grant)throw new Error('fixture_retirement_fence');
  const fresh=env.GAME.get(env.GAME.idFromName(id));
  let firstError;
  try{await fresh.retire(grant);}catch(error){firstError={name:error.name,message:error.message};}
  const exact=firstError?.message===capacityRetirementAck(grant);
  const confirmed=exact&&await control.confirmRetirement(grant,firstError.message);
  const retired=await control.status();
  let poisonedReplay;
  try{await fresh.status({});}catch(error){poisonedReplay={name:error.name,message:error.message};}
  const repeatedConfirm=await control.confirmRetirement(grant,poisonedReplay?.message??'missing');
  const reacquired=await control.linkGame(id,receipt);
  await callCapacityNative(env.GAME,control,key,'Game.status',work);
  const after=await env.GAME.get(env.GAME.idFromName(id)).inspect();
  await new Promise(resolve=>setTimeout(resolve,2500));
  const afterRetryWindow=await env.GAME.get(env.GAME.idFromName(id)).inspect();
  const status=await control.status();
  return Response.json({before,grant,firstError,confirmed,retired,poisonedReplay,repeatedConfirm,reacquired,
    after,afterRetryWindow,status,controllerObservations:await control.observations()});
}};`;
const bundled = await build({ stdin: { contents: source, resolveDir: product, sourcefile: 'capacity-retirement-local-fixture.ts' },
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:*', 'node:*'], logLevel: 'silent' });
const bundle = bundled.outputFiles[0].text;
const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle,
  compatibilityDate: '2026-10-19', compatibilityFlags: ['nodejs_compat'], cf: false,
  durableObjects: { GAME: { className: 'ProbeGame', useSQLite: true }, RUN: { className: 'ProbeRun', useSQLite: true } },
  host: '127.0.0.1', port: 0 }));
const started = performance.now();
const cpuStart = process.cpuUsage();
try {
  const response = await runtime.dispatchFetch('http://capacity-retirement.local/exercise');
  if (!response.ok) throw new Error('local_retirement_http_' + response.status + ':' + (await response.text()).slice(0,1000));
  const observed = await response.json();
  const checks = {
    exactPrivateAbort: observed.firstError?.message === 'capacity-retired:' + manifest.runId + ':game:one-local-retirement-game:1:' + observed.grant.nonce,
    lifetimeReleasedOnce: observed.confirmed === true && observed.retired.activeObjects === 2 && observed.repeatedConfirm === false,
    poisonedStubReplaysOriginalError: observed.poisonedReplay?.message === observed.firstError?.message,
    reacquiredBeforeNewGeneration: observed.reacquired === true && observed.status.activeObjects === 3 && observed.after.wrapper.generation === 2,
    freshNativeIncarnation: observed.after.incarnation !== observed.before.incarnation,
    durableStatePreserved: observed.after.probe.preserved === 1 && observed.after.consumed === 2,
    actualAlarmInterrupted: observed.after.probe.alarm_entered === 1 && observed.after.probe.alarm_returned === 0,
    abortCannotBeCaught: observed.after.probe.retire_caught === 0 && observed.after.probe.retire_returned === 0,
    noFutureAlarm: observed.after.alarm === null && observed.afterRetryWindow.alarm === null && observed.afterRetryWindow.probe.alarm_entered === 1,
    noUnresolvedDispatch: observed.status.unresolvedDispatches === 0,
    measuredControllerRows: observed.controllerObservations.usage.uncertain === false,
  };
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const sourceHashes = {};
  for (const name of ['src/server/capacity-run.ts','src/server/capacity-native.ts','src/server/capacity-meter.ts']) {
    sourceHashes[name] = createHash('sha256').update(await readFile(new URL('../' + name, import.meta.url))).digest('hex');
  }
  const report = { schema: 'ejm-chess-native-retirement-local-v1', at: new Date().toISOString(), node: process.version,
    runtime: { miniflare: lock.packages['node_modules/miniflare']?.version, workerd: lock.packages['node_modules/workerd']?.version },
    bundleSha256: createHash('sha256').update(bundle).digest('hex'), sourceHashes, checks, observed,
    wallMs: performance.now() - started, driverCpu: process.cpuUsage(cpuStart), driverMaxRssBytes: process.resourceUsage().maxRSS * 1024,
    activationGateReady: false,
    scope: 'One native local Game.status wrapper, one durable controller, one interrupted private retirement alarm and a generation reacquisition. Probe metadata and inspect calls add local fixture work outside the candidate meter. This does not qualify provider CPU, cost, alarm placement, full Game rules, complete work envelopes or the 19000-game workload.' };
  await writeFile(args[1], JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ report: args[1], checks, wallMs: report.wallMs }) + '\n');
  if (Object.values(checks).some(value => !value)) process.exitCode = 1;
} finally { await runtime.dispose(); }
