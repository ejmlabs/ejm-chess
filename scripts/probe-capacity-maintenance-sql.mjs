#!/usr/bin/env node
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readD1Migrations } from '@cloudflare/vitest-plugin';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { capacityFixtureManifest } from '../test/capacity-fixtures.ts';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--output' || !args[1].startsWith('/private/tmp/')) {
  throw new Error('Usage: node scripts/probe-capacity-maintenance-sql.mjs --output /private/tmp/report.json');
}
const manifest = capacityFixtureManifest();
const product = fileURLToPath(new URL('..', import.meta.url));
const source = `
import { DurableObject } from 'cloudflare:workers';
import { CapacityNativeWrapper } from './src/server/capacity-native';
import { CapacityTicketCodec, emptyCapacityWork } from './src/server/capacity-run';
const manifest=${JSON.stringify(manifest)};
const secret='local-maintenance-sql-fixture-secret-at-least-32-bytes';
const envelope={...emptyCapacityWork(),nativeDoRequests:1,doRowsRead:1000000,doRowsWritten:10000,
  d1RowsRead:100000,d1RowsWritten:10000,doStorageBytes:536870912,d1StorageBytes:536870912};
const controlFor=env=>env.CAPACITY_RUN.get(env.CAPACITY_RUN.idFromName('local-statement-control'));
export class ProbeRun extends DurableObject {
  codec=new CapacityTicketCodec(secret);operations=[];
  async available(){return true;}
  async charge(){throw new Error('probe_no_game_charge');}
  async linkGame(){throw new Error('probe_no_game_link');}
  async begin(id,objectKey,operation,_envelope,mode='rpc'){
    if(operation!=='Competition.maintenance'||objectKey!=='competition'||this.operations.length>=2)throw new Error('probe_operation_bound');
    this.operations.push(operation);
    return this.codec.dispatch({runId:manifest.runId,manifestDigest:manifest.digest,id,objectKey,generation:1,operation,mode});
  }
  async complete(){return true;}
  async inspect(){return this.operations;}
}
export class ForbiddenGame extends DurableObject {
  async status(){throw new Error('probe_no_game');}
}
export class ProbeCompetition extends DurableObject {
  constructor(ctx,env){super(ctx,env);this.native=new CapacityNativeWrapper(ctx,env,'Competition',
    {manifest,envelopes:{'Competition.maintenance':envelope},control:controlFor(env)});}
  async maintenance(ticket){
    const statements=new Map();
    globalThis.__capacitySqlProbe=(query,bindings,read,written)=>{
      const key=query.replace(/\\s+/g,' ').trim();
      const row=statements.get(key)??{query:key,original:query,bindings,calls:0,rowsRead:0,rowsWritten:0};
      row.rowsRead+=read;row.rowsWritten+=written;statements.set(key,row);
    };
    globalThis.__capacitySqlStatement=query=>{
      const key=query.replace(/\\s+/g,' ').trim(),row=statements.get(key);
      if(row)row.calls++;
    };
    let reply;
    try {reply=await this.native.rpc('maintenance',[],ticket);}
    finally {globalThis.__capacitySqlProbe=null;globalThis.__capacitySqlStatement=null;}
    const sqlRows=[...statements.values()].sort((a,b)=>b.rowsRead-a.rowsRead);
    for(const row of sqlRows.slice(0,8)){
      if(!row.query.startsWith('SELECT'))continue;
      row.plan=this.ctx.storage.sql.exec('EXPLAIN QUERY PLAN '+row.original,...row.bindings).toArray();
    }
    for(const row of sqlRows){delete row.original;delete row.bindings;}
    reply.value={maintenance:reply.value,statements:sqlRows};return reply;
  }
  async alarm(){await this.ctx.storage.deleteAlarm();}
  async seed(){
    const sql=this.ctx.storage.sql,now=Date.now(),id='000-local-maintenance-registered';
    sql.exec(\`INSERT INTO arena_events(id,cadence,pool,starts_at,closes_at,status,next_at,entrants,revision,projected_revision,project_after)
      VALUES(?,'hourly','blitz',?,?,'running',?,2000,1,1,?)\`,id,now-1,now+120000,now,now+3600000);
    for(let index=0;index<2000;index++){
      const uid='statement-fixture-'+String(index).padStart(4,'0');
      const actor={id:uid,name:uid,isAnonymous:false,sessionId:'not-used',sessionExpiresAt:now+3600000};
      sql.exec(\`INSERT INTO arena_entries(event_id,user_id,actor,name,rating,state,joined_at,rating_band)
        VALUES(?,?,?,?,1500,'registered',?,7)\`,id,uid,JSON.stringify(actor),uid,now);
    }
    await this.ctx.storage.deleteAlarm();
    return {entrants:sql.exec('SELECT COUNT(*) AS n FROM arena_entries').one().n,
      queued:sql.exec("SELECT COUNT(*) AS n FROM arena_entries WHERE state='queued'").one().n,
      intents:sql.exec('SELECT COUNT(*) AS n FROM arena_intents').one().n};
  }
  async stop(){await this.ctx.storage.deleteAlarm();}
}
export default {async fetch(_request,env){
  const control=controlFor(env),comp=env.COMPETITION.get(env.COMPETITION.idFromName('global'));
  const run=async()=>{
    const ticket=await control.begin(crypto.randomUUID(),'competition','Competition.maintenance',envelope);
    const reply=await comp.maintenance(ticket);await control.complete(ticket,reply.actual,reply.drained);return reply;
  };
  await run();const seeded=await comp.seed();const measured=await run();await comp.stop();
  return Response.json({seeded,measured,operations:await control.inspect()});
}};`;
const plugin = { name: 'local-maintenance-sql-statements', setup(builder) {
  builder.onLoad({ filter: /capacity-meter\.ts$/ }, async ({ path }) => {
    let text = await readFile(path, 'utf8');
    const metric = 'meter.usage.doRowsRead += nextRead - read;';
    const execution = 'record();\n        return new Proxy(cursor,';
    if (!text.includes(metric) || !text.includes(execution)) throw new Error('probe_meter_marker_missing');
    text = text.replace(metric, 'globalThis.__capacitySqlProbe?.(query, bindings, nextRead-read, nextWritten-written);\n            ' + metric)
      .replace(execution, 'record();\n        globalThis.__capacitySqlStatement?.(query);\n        return new Proxy(cursor,');
    return { contents: text, loader: 'ts' };
  });
} };
const bundled = await build({ stdin: { contents: source, resolveDir: product, sourcefile: 'capacity-maintenance-sql-local.ts' },
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
  external: ['cloudflare:*', 'node:*'], logLevel: 'silent', plugins: [plugin] });
const bundle = bundled.outputFiles[0].text;
const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle,
  compatibilityDate: '2026-10-19', compatibilityFlags: ['nodejs_compat'], cf: false,
  d1Databases: { DB: 'local-maintenance-sql' },
  bindings: { AUTH_SECRET: 'local-maintenance-sql-fixture-secret-at-least-32-bytes', CAPACITY_TOKEN: 'local-fixture-unused' },
  durableObjects: { GAME: { className: 'ForbiddenGame', useSQLite: true },
    COMPETITION: { className: 'ProbeCompetition', useSQLite: true }, CAPACITY_RUN: { className: 'ProbeRun', useSQLite: true } },
  host: '127.0.0.1', port: 0 }));
try {
  const db = await runtime.getD1Database('DB');
  for (const migration of await readD1Migrations(new URL('../migrations/', import.meta.url).pathname)) {
    await db.batch(migration.queries.map(query => db.prepare(query)));
  }
  const response = await runtime.dispatchFetch('http://maintenance-sql.local/');
  if (!response.ok) throw new Error('probe_http_'+response.status+':'+(await response.text()).slice(0,2000));
  const observed = await response.json();
  const sqlTotals=observed.measured.value.statements.reduce((sum,row)=>({rowsRead:sum.rowsRead+row.rowsRead,
    rowsWritten:sum.rowsWritten+row.rowsWritten}),{rowsRead:0,rowsWritten:0});
  const report={schema:'ejm-chess-capacity-maintenance-sql-local-v1',at:new Date().toISOString(),node:process.version,
    bundleSha256:createHash('sha256').update(bundle).digest('hex'),observed,sqlTotals,activationGateReady:false,
    scope:'One warm native Competition maintenance call over 2000 registered nonterminal entries and zero queued entries or Games. Statement cursor deltas and bounded EXPLAIN plans isolate repeated scans. No real-time cadence, capacity, provider or proposed optimization claim.'};
  await writeFile(args[1],JSON.stringify(report,null,2)+'\n');
  process.stdout.write(JSON.stringify({report:args[1],seeded:observed.seeded,actual:observed.measured.actual,
    sqlTotals,top:observed.measured.value.statements.slice(0,8)})+'\n');
} finally { await runtime.dispose(); }
