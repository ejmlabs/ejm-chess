#!/usr/bin/env node
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { capacityFixtureManifest } from '../test/capacity-fixtures.ts';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--output' || !args[1].startsWith('/private/tmp/')) {
  throw new Error('Usage: node scripts/probe-capacity-controller.mjs --output /private/tmp/report.json');
}
const product = fileURLToPath(new URL('..', import.meta.url));
const manifest = capacityFixtureManifest();
const workKeys = ['workerRequests', 'nativeDoRequests', 'workerCpuMs', 'doRowsWritten', 'doRowsRead',
  'd1RowsWritten', 'd1RowsRead', 'doStorageBytes', 'd1StorageBytes'];
const zeroWork = Object.fromEntries(workKeys.map(key => [key, 0]));
const controlMethods = ['arm', 'stop', 'status', 'available', 'reserveIngress', 'charge', 'linkGame', 'begin',
  'complete', 'prepareRetirement', 'confirmRetirement'];
const facadePlan = { maximumPhysicalBytes: 300 * 1024 ** 2, maximumIncarnations: 4,
  bootstrapEnvelope: { ...zeroWork, doRowsRead: 64, doRowsWritten: 40 },
  methods: Object.fromEntries(controlMethods.map(method => [method, { maximumCalls: method === 'arm' ? 1 : 128,
    envelope: { ...zeroWork, nativeDoRequests: 1, doRowsRead: 64, doRowsWritten: 16 } }])) };
// These rows model retained keys and indexes only. They are not admitted games
// or native workload evidence, and their fixture inserts are excluded below.
const retained = { games: 20_000, dispatches: 400_000, ingress: 4_688 };
const source = `
import { DurableObject } from 'cloudflare:workers';
import { CapacityRun, CapacityRunStore, CAPACITY_CONTROL_METHODS, capacityRetirementAck, emptyCapacityWork } from './src/server/capacity-run';
import { CapacityNativeMeter } from './src/server/capacity-meter';
export { CapacityRun };
export class GuardedControllerProbe extends CapacityRun {
  async inspectFixture() {
    return this.ctx.storage.sql.exec('SELECT controller_calls,controller_incarnations,observed FROM capacity_run WHERE id=1').one();
  }
  async terminateFixture() { this.ctx.abort('controller-local-fixture-restart'); }
}
const manifest=${JSON.stringify(manifest)};
const retained=${JSON.stringify(retained)};
const zero=emptyCapacityWork(),json=JSON.stringify(zero);
const plan={maximumPhysicalBytes:300*1024**2,maximumIncarnations:4,
  bootstrapEnvelope:{...zero,doRowsRead:64,doRowsWritten:40},methods:Object.fromEntries(CAPACITY_CONTROL_METHODS.map(method=>[method,
  {maximumCalls:method==='arm'?1:1000,envelope:{...zero,nativeDoRequests:1,doRowsRead:64,doRowsWritten:32}}]))};
const drained={pendingNative:0,alarm:false,sockets:0,alarmPossible:false,socketPossible:false};
export class ControllerProbe extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env);this.meter=new CapacityNativeMeter();this.clock=manifest.earliestArmAt;
    this.store=new CapacityRunStore(this.meter.sql(ctx.storage.sql),f=>ctx.storage.transactionSync(f),manifest,()=>this.clock);
    this.constructorUsage=this.meter.snapshot();this.samples=[];
  }
  measure(method,f) {
    this.clock++;
    const before=this.meter.snapshot();
    try {
      const operation=method.split('-')[0];
      const run=()=>{
        if(method!=='arm'&&!this.store.claimControllerCall(operation,plan))throw new Error('fixture_control_slot');
        return f();
      };
      // Real completion and acknowledgement methods claim before awaited
      // signature validation. Keep those claims separate in this fixture too.
      if(operation==='complete'||operation==='confirmRetirement')return run();
      const result=this.store.fuseRunUpdates(run);
      if(!result.ok)throw result.error;
      return result.value;
    } finally {const after=this.meter.snapshot();this.samples.push({method,
      rowsRead:after.doRowsRead-before.doRowsRead,rowsWritten:after.doRowsWritten-before.doRowsWritten,
      physicalBytes:after.doStorageBytes});}
  }
  async seed() {
    if(!this.measure('arm',()=>this.store.arm(plan)))throw new Error('fixture_arm');
    const sql=this.ctx.storage.sql;
    const gameId="'controller-fixture-'||printf('%05d',x)";
    for(let start=0;start<retained.games;start+=1000) {
      const end=Math.min(start+999,retained.games-1);
      const prefix='WITH RECURSIVE n(x) AS (VALUES(?) UNION ALL SELECT x+1 FROM n WHERE x<?) ';
      sql.exec(prefix+"INSERT INTO capacity_charges SELECT 'arena:'||"+gameId+',1,? FROM n',start,end,this.clock);
      sql.exec(prefix+'INSERT INTO capacity_game_ids SELECT '+gameId+",'arena:'||"+gameId+' FROM n',start,end);
      sql.exec(prefix+"INSERT INTO capacity_permits SELECT 'game:'||"+gameId+',0,0,1,NULL,0 FROM n',start,end);
      sql.exec(prefix+"INSERT INTO capacity_retirements SELECT 'game:'||"+gameId+",1,'00000000-0000-4000-8000-000000000000',1 FROM n",start,end);
      sql.exec(prefix+"INSERT INTO capacity_object_storage SELECT 'game:'||"+gameId+',65536 FROM n',start,end);
    }
    for(let start=0;start<retained.dispatches;start+=1000) {
      const end=Math.min(start+999,retained.dispatches-1);
      sql.exec("WITH RECURSIVE n(x) AS (VALUES(?) UNION ALL SELECT x+1 FROM n WHERE x<?) INSERT INTO capacity_dispatches SELECT 'retained-dispatch-'||x,'game:controller-fixture-'||printf('%05d',x % ?),1,'Game.status','rpc',?,1,? FROM n",start,end,retained.games,json,json);
    }
    sql.exec("WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<?) INSERT INTO capacity_ingress_blocks SELECT printf('%08d-0000-4000-8000-000000000000',x),? FROM n",retained.ingress-1,this.clock);
    sql.exec('UPDATE capacity_run SET charges=? WHERE id=1',retained.games);
    return {physicalBytes:sql.databaseSize};
  }
  async exercise() {
    for(let index=0;index<100;index++) {
      const id='controller-fixture-'+String(index).padStart(5,'0'),key='game:'+id,receipt='arena:'+id;
      this.measure('available',()=>this.store.available());
      this.measure('charge-existing',()=>this.store.charge(receipt,1));
      if(!this.measure('linkGame-reacquire',()=>this.store.linkGame(id,receipt)))throw new Error('fixture_link');
      const ticket=this.measure('begin',()=>this.store.begin('sample-dispatch-'+index,key,'Game.status',zero));
      if(!ticket)throw new Error('fixture_dispatch');
      if(!this.measure('complete',()=>this.store.complete(ticket,zero,drained)))throw new Error('fixture_complete');
      const value=this.measure('prepareRetirement',()=>this.store.prepareRetirement(key,zero));
      if(!value)throw new Error('fixture_retirement');
      if(!this.measure('confirmRetirement',()=>this.store.confirmRetirement(value,capacityRetirementAck(value))))throw new Error('fixture_ack');
      this.measure('status',()=>this.store.status());
    }
    const rows=this.ctx.storage.sql.exec("SELECT (SELECT COUNT(*) FROM capacity_game_ids) AS games,(SELECT COUNT(*) FROM capacity_dispatches) AS dispatches,(SELECT COUNT(*) FROM capacity_retirements) AS retirements,(SELECT COUNT(*) FROM capacity_ingress_blocks) AS ingress").one();
    return {constructorUsage:this.constructorUsage,samples:this.samples,rows,status:this.store.status(),usage:this.meter.snapshot()};
  }
  async fresh() {
    if(!this.measure('arm',()=>this.store.arm(plan)))throw new Error('fixture_fresh_arm');
    const id='controller-fresh-fixture',key='game:'+id,receipt='arena:'+id;
    this.measure('reserveIngress',()=>this.store.reserveIngress(crypto.randomUUID()));
    if(!this.measure('charge-first',()=>this.store.charge(receipt,1)))throw new Error('fixture_fresh_charge');
    if(!this.measure('linkGame-first',()=>this.store.linkGame(id,receipt)))throw new Error('fixture_fresh_link');
    const ticket=this.measure('begin',()=>this.store.begin('fresh-dispatch',key,'Game.status',zero));
    if(!ticket)throw new Error('fixture_fresh_dispatch');
    this.measure('stop',()=>this.store.stop('local-fixture-stop'));
    this.measure('begin-denied',()=>this.store.begin('after-stop',key,'Game.status',zero));
    this.measure('available-denied',()=>this.store.available());
    this.measure('reserveIngress-denied',()=>this.store.reserveIngress(crypto.randomUUID()));
    this.measure('charge-existing',()=>this.store.charge(receipt,1));
    this.measure('charge-denied',()=>this.store.charge('arena:unrelated-fresh-fixture',1));
    this.measure('linkGame-denied',()=>this.store.linkGame(id,receipt));
    if(!this.measure('complete',()=>this.store.complete(ticket,zero,drained)))throw new Error('fixture_fresh_complete');
    const value=this.measure('prepareRetirement',()=>this.store.prepareRetirement(key,zero));
    if(!value||!this.measure('confirmRetirement',()=>this.store.confirmRetirement(value,capacityRetirementAck(value))))throw new Error('fixture_fresh_retire');
    return {samples:this.samples,status:this.measure('status',()=>this.store.status()),usage:this.meter.snapshot()};
  }
}
export default {async fetch(request,env) {
  if(new URL(request.url).pathname!=='/exercise')return new Response('Not found',{status:404});
  const control=env.RUN.get(env.RUN.idFromName('one-controller-retained-fixture'));
  const seed=await control.seed();
  const fresh=await env.RUN.get(env.RUN.idFromName('one-controller-fresh-fixture')).fresh();
  let hiddenMethodError;
  try{await env.HIDDEN.get(env.HIDDEN.idFromName('private-controller-rpc-check')).run();}
  catch(error){hiddenMethodError=error.message;}
  const guardedId=env.GUARDED.idFromName('guarded-controller-accounting-fixture');
  const guarded=env.GUARDED.get(guardedId);
  const facadeArm=await guarded.arm();
  for(let index=0;index<100;index++)await guarded.status();
  const beforeRestart=await guarded.inspectFixture();
  let restartError;
  try{await guarded.terminateFixture();}catch(error){restartError=error.message;}
  const restarted=env.GUARDED.get(guardedId);
  const afterRestart=await restarted.status();
  const afterCold=await restarted.inspectFixture();
  return Response.json({seed,...await control.exercise(),fresh,hiddenMethodError,
    facade:{armed:facadeArm,beforeRestart,afterRestart,afterCold,restartError}});
}};`;
const bundled = await build({ stdin: { contents: source, resolveDir: product, sourcefile: 'capacity-controller-local-fixture.ts' },
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:*', 'node:*'], logLevel: 'silent',
  plugins: [{ name: 'local-controller-fixture', setup(plugin) {
    plugin.onLoad({ filter: /\/src\/server\/capacity-run\.ts$/ }, async ({ path }) => {
      const original = await readFile(path, 'utf8');
      const text = original.replace('export const SEALED_CAPACITY_MANIFEST: CapacityManifest | null = null;',
        'export const SEALED_CAPACITY_MANIFEST: CapacityManifest | null = ' + JSON.stringify(manifest) + ';')
        .replace('export const VERIFIED_CONTROLLER_PLAN: CapacityControllerPlan | null = null;',
          'export const VERIFIED_CONTROLLER_PLAN: CapacityControllerPlan | null = ' + JSON.stringify(facadePlan) + ';');
      if (text === original) throw new Error('local_controller_fixture_gate_not_replaced');
      return { contents: text, loader: 'ts' };
    });
  } }] });
const bundle = bundled.outputFiles[0].text;
const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle,
  compatibilityDate: '2026-10-19', compatibilityFlags: ['nodejs_compat'], cf: false,
  bindings: { AUTH_SECRET: 'local-controller-fixture-secret-at-least-32-bytes' },
  durableObjects: { RUN: { className: 'ControllerProbe', useSQLite: true }, HIDDEN: { className: 'CapacityRun', useSQLite: true },
    GUARDED: { className: 'GuardedControllerProbe', useSQLite: true } },
  host: '127.0.0.1', port: 0 }));
const started = performance.now();
try {
  const response = await runtime.dispatchFetch('http://capacity-controller.local/exercise');
  if (!response.ok) throw new Error('local_controller_http_' + response.status + ':' + (await response.text()).slice(0, 1000));
  const observed = await response.json();
  const methods = {};
  for (const sample of [...observed.samples, ...observed.fresh.samples]) {
    const summary = methods[sample.method] ??= { samples: 0, maxRowsRead: 0, maxRowsWritten: 0 };
    summary.samples++;
    summary.maxRowsRead = Math.max(summary.maxRowsRead, sample.rowsRead);
    summary.maxRowsWritten = Math.max(summary.maxRowsWritten, sample.rowsWritten);
  }
  const checks = {
    retainedKeys: observed.rows.games === retained.games && observed.rows.dispatches === retained.dispatches + 100,
    retainedGenerations: observed.rows.retirements === retained.games + 100,
    noUnresolvedDispatch: observed.status.unresolvedDispatches === 0,
    noNewAdmission: observed.status.charges === retained.games,
    lifetimeRetained: observed.status.activeObjects === 2,
    nativeMetricsAvailable: observed.usage.uncertain === false && observed.fresh.usage.uncertain === false,
    freshAndStoppedPaths: observed.fresh.status.charges === 1 && observed.fresh.status.unresolvedDispatches === 0,
    privateMethodNotRpc: /does not implement the method ["']run["']/.test(observed.hiddenMethodError ?? ''),
    guardedWarmBootstrapOnce: observed.facade.armed === true && observed.facade.beforeRestart.controller_incarnations === 1
      && JSON.parse(observed.facade.beforeRestart.controller_calls).status === 100,
    guardedRestartConsumesIncarnation: observed.facade.afterCold.controller_incarnations === 2
      && JSON.parse(observed.facade.afterCold.controller_calls).status === 101
      && observed.facade.afterRestart.stopReason === null,
    guardedRestartKeepsPrepayment: observed.facade.beforeRestart.observed === observed.facade.afterCold.observed,
  };
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const report = { schema: 'ejm-chess-controller-retained-local-v1', at: new Date().toISOString(), node: process.version,
    runtime: { miniflare: lock.packages['node_modules/miniflare']?.version, workerd: lock.packages['node_modules/workerd']?.version },
    sourceSha256: createHash('sha256').update(await readFile(new URL('../src/server/capacity-run.ts', import.meta.url))).digest('hex'),
    bundleSha256: createHash('sha256').update(bundle).digest('hex'), retained, facadePlan, checks, methods, observed,
    wallMs: performance.now() - started, activationGateReady: false,
    scope: 'Native SQLite store/index observations at 20000 synthetic retained Game keys and 400000 completed dispatch rows, plus the real guarded controller facade for 100 warm status RPCs and one raw-abort/restart. A local-only build plugin substitutes the manifest/plan without changing source gates. Direct fixture inserts, fixture inspection/restart RPCs and deterministic metadata clock are excluded from measurements. This is not native admission, real throughput, controller RPC CPU, provider cost, a full finite delivery proof or full-workload qualification.' };
  await writeFile(args[1], JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ report: args[1], checks, methods, physicalBytes: observed.status.physicalBytes, wallMs: report.wallMs }) + '\n');
  if (Object.values(checks).some(value => !value)) process.exitCode = 1;
} finally { await runtime.dispose(); }
