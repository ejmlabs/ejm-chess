#!/usr/bin/env node
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readD1Migrations } from '@cloudflare/vitest-plugin';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { capacityFixtureManifest } from '../test/capacity-fixtures.ts';

const { values } = parseArgs({ options: { output: { type: 'string' },
  'history-versions': { type: 'string', default: '23' } } });
const output = values.output;
const historyVersions = Number(values['history-versions']);
if (!output?.startsWith('/private/tmp/') || !Number.isInteger(historyVersions) || historyVersions < 1 || historyVersions > 23) {
  throw new Error('Usage: node scripts/probe-capacity-feasibility.mjs --output /private/tmp/report.json [--history-versions 1..23]');
}
const projectionPasses = Math.ceil((2_000 * historyVersions + 64) / 32) + 64;
const product = fileURLToPath(new URL('..', import.meta.url));
const manifest = capacityFixtureManifest();
const localSource = `
import { DurableObject } from 'cloudflare:workers';
import { CapacityNativeWrapper, callCapacityNative } from './src/server/capacity-native';
import { CapacityTicketCodec, emptyCapacityWork } from './src/server/capacity-run';
import { capacityAccountId } from './src/shared/capacity-corpus';
const manifest=${JSON.stringify(manifest)};
const secret='local-feasibility-fixture-secret-at-least-32-bytes';
const envelope={...emptyCapacityWork(),nativeDoRequests:1,doRowsRead:10000000,doRowsWritten:100000,
  d1RowsRead:1000000,d1RowsWritten:100000,doStorageBytes:536870912,d1StorageBytes:536870912};
const methods=['Game.init','Game.status','Game.command','Game.alarm','Game.observeQualificationGame',
  'Competition.prepareQualificationAccount','Competition.authenticateQualificationAccount',
  'Competition.registerArena','Competition.queueArena','Competition.observeArenaReservation',
  'Competition.maintenance','Competition.settle','Competition.probeProjectionAdvance','Competition.probeProjectionCleanup'];
const envelopes=Object.fromEntries(methods.map(key=>[key,envelope]));
const controlFor=env=>env.CAPACITY_RUN.get(env.CAPACITY_RUN.idFromName('one-local-feasibility-control'));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export class ProbeRun extends DurableObject {
  phase='setup';events=[];starts=new Map();calls={};failures=[];codec=new CapacityTicketCodec(secret);
  async noteFailure(method,message){this.failures.push({phase:this.phase,method,message});}
  async phaseName(value){this.phase=value;}
  count(method){this.calls[method]=(this.calls[method]??0)+1;}
  async available(){this.count('available');return true;}
  async charge(){this.count('charge');return true;}
  async linkGame(){this.count('linkGame');return true;}
  async begin(id,objectKey,operation,_envelope,mode='rpc'){
    this.count('begin');if(this.events.length>=15000)throw new Error('probe_event_bound');
    this.starts.set(id,{phase:this.phase,operation,mode,objectKey});
    return this.codec.dispatch({runId:manifest.runId,manifestDigest:manifest.digest,id,objectKey,generation:1,operation,mode});
  }
  async complete(ticket,actual,drained){
    this.count('complete');const start=this.starts.get(ticket.id);if(!start)throw new Error('probe_unknown_reply');
    this.starts.delete(ticket.id);this.events.push({...start,actual,drained});return true;
  }
  async inspect(){return {events:this.events,calls:this.calls,failures:this.failures,unresolved:[...this.starts.values()]};}
}

export class ProbeGame extends DurableObject {
  constructor(ctx,env){super(ctx,env);this.native=new CapacityNativeWrapper(ctx,env,'Game',
    {manifest,envelopes,control:controlFor(env)});}
  async init(value,ticket){try{return await this.native.rpc('init',[value],ticket);}catch(error){await controlFor(this.env).noteFailure('Game.init',error.message);throw error;}}
  async status(ticket){return this.native.rpc('status',[],ticket);}
  async command(actor,command,ticket){return this.native.rpc('command',[actor,command],ticket);}
  async observeQualificationGame(ticket){return this.native.rpc('observeQualificationGame',[],ticket);}
  async alarm(){await this.native.alarm();}
  async fixtureInspect(){return {alarm:await this.ctx.storage.getAlarm(),physicalBytes:this.ctx.storage.sql.databaseSize,
    state:this.ctx.storage.sql.exec('SELECT value FROM game_state WHERE id=1').toArray()[0]?.value,
    pendingDelivery:this.ctx.storage.sql.exec('SELECT 1 FROM result_delivery LIMIT 1').toArray().length};}
  async fixtureStop(){await this.ctx.storage.deleteAlarm();await this.ctx.storage.sync();}
}

export class ProbeCompetition extends DurableObject {
  constructor(ctx,env){super(ctx,env);this.native=new CapacityNativeWrapper(ctx,env,'Competition',
    {manifest,envelopes,control:controlFor(env)});}
  async prepareQualificationAccount(index,ticket){return this.native.rpc('prepareQualificationAccount',[index],ticket);}
  async authenticateQualificationAccount(request,index,ticket){return this.native.rpc('authenticateQualificationAccount',[request,index],ticket);}
  async registerArena(actor,id,ticket){return this.native.rpc('registerArena',[actor,id],ticket);}
  async queueArena(actor,id,ticket){return this.native.rpc('queueArena',[actor,id],ticket);}
  async observeArenaReservation(actor,id,ticket){return this.native.rpc('observeArenaReservation',[actor,id],ticket);}
  async maintenance(ticket){return this.native.rpc('maintenance',[],ticket);}
  async settle(result,ticket){return this.native.rpc('settle',[result],ticket);}
  async probeProjectionAdvance(ticket){return this.native.rpc('probeProjectionAdvance',[],ticket);}
  async probeProjectionCleanup(ticket){return this.native.rpc('probeProjectionCleanup',[],ticket);}
  // This mechanics probe controls maintenance calls so each actual row envelope
  // has one named phase. It does not claim ordinary Competition alarm evidence.
  async alarm(){await this.ctx.storage.deleteAlarm();}
  async fixtureSeed(id){
    const sql=this.ctx.storage.sql,now=Date.now();
    sql.exec(\`INSERT INTO arena_events(id,cadence,pool,starts_at,closes_at,status,next_at,entrants,revision,projected_revision)
      VALUES(?,'hourly','blitz',?,?,'running',?,1998,46000,46000)\`,id,now-1,now+120000,now);
    const actors=await this.env.DB.prepare(\`SELECT u.id,u.name,s.id AS sessionId,s.expiresAt
      FROM user u JOIN session s ON s.userId=u.id ORDER BY u.id LIMIT 2000\`).all();
    if(actors.results.length!==2000)throw new Error('probe_fixture_accounts');
    for(const row of actors.results.slice(2)){
      const actor={id:row.id,name:row.name,isAnonymous:false,sessionId:row.sessionId,sessionExpiresAt:Date.parse(row.expiresAt)};
      sql.exec(\`INSERT INTO arena_entries(event_id,user_id,actor,name,rating,state,joined_at,rating_band)
        VALUES(?,?,?,?,1500,'registered',?,7)\`,id,row.id,JSON.stringify(actor),row.name,now);
    }
    // Nonterminal entrant-version metadata only. No Game, result, score or
    // settlement receipt is fabricated. These inserts are excluded from usage.
    for(let pass=0;pass<${historyVersions};pass++)sql.exec(\`INSERT INTO arena_entry_versions
      (event_id,user_id,revision,name,points_half,games,visible)
      SELECT event_id,user_id,?+rowid,name,0,0,1 FROM arena_entries WHERE event_id=?\`,pass*2000,id);
    sql.exec("DELETE FROM arena_meta WHERE key='public-cleanup-at'");
    await this.ctx.storage.deleteAlarm();
    return {entrants:sql.exec('SELECT COUNT(*) AS n FROM arena_entries').one().n,
      versions:sql.exec('SELECT COUNT(*) AS n FROM arena_entry_versions').one().n,physicalBytes:sql.databaseSize};
  }
  async fixtureProjection(id){
    const sql=this.ctx.storage.sql;
    return {event:sql.exec('SELECT revision,projected_revision,generation,project_after,entrants,unresolved FROM arena_events WHERE id=?',id).one(),
      builds:sql.exec('SELECT event_id,phase,row_count,page_number FROM arena_projection_builds').toArray(),
      snapshots:sql.exec('SELECT COUNT(*) AS n FROM arena_snapshot_rows').one().n,
      versions:sql.exec('SELECT COUNT(*) AS n FROM arena_entry_versions').one().n,
      intents:sql.exec('SELECT game_id,status FROM arena_intents').toArray(),
      physicalBytes:sql.databaseSize};
  }
  async fixtureStop(){await this.ctx.storage.deleteAlarm();await this.ctx.storage.sync();}
}

export default {async fetch(request,env){
  if(new URL(request.url).pathname!=='/exercise')return new Response('Not found',{status:404});
  const control=controlFor(env),competition=env.COMPETITION.get(env.COMPETITION.idFromName('global'));
  try {
  const comp=(method,args=[])=>callCapacityNative(env.COMPETITION,control,'competition','Competition.'+method,envelope,args);
  const gameCall=(id,method,args=[])=>callCapacityNative(env.GAME,control,'game:'+id,'Game.'+method,envelope,args);
  const credentials=[];
  await control.phaseName('account-fixture');
  for(let index=0;index<2000;index++){
    const value=await comp('prepareQualificationAccount',[index]);
    if(index<2)credentials.push(value);
  }
  const eventId='local-feasibility-'+manifest.runId;
  const seeded=await competition.fixtureSeed(eventId);
  await control.phaseName('primary-auth');
  const actors=[];
  for(let index=0;index<2;index++)actors.push(await comp('authenticateQualificationAccount',[
    new Request('https://'+manifest.host+'/local-fixture',{headers:{Cookie:credentials[index].cookie}}),index]));
  await control.phaseName('registration-new');
  for(const actor of actors){const value=await comp('registerArena',[actor,eventId]);if(!value.ok)throw new Error(value.error.code);}
  await control.phaseName('registration-existing');
  const repeat=await comp('registerArena',[actors[0],eventId]);if(!repeat.ok)throw new Error(repeat.error.code);
  await control.phaseName('queue');
  for(const actor of actors){const value=await comp('queueArena',[actor,eventId]);if(!value.ok)throw new Error(value.error.code);}
  await control.phaseName('normal-initialize');
  for(let pass=0;pass<5;pass++){
    await comp('maintenance');
    const current=await competition.fixtureProjection(eventId);
    if(current.intents.some(intent=>intent.status==='live'))break;
    if(pass===4)throw new Error('probe_native_initialization_pass_bound');
  }
  await control.phaseName('binding-observation');
  const binding=await comp('observeArenaReservation',[actors[0],eventId]);
  if(!binding)throw new Error('probe_binding_missing');
  const id=binding.gameId,byId=new Map(actors.map(actor=>[actor.id,actor]));
  const white=byId.get(binding.whiteId),black=byId.get(binding.blackId);
  if(!white||!black)throw new Error('probe_actual_seats');
  await control.phaseName('commands');
  for(const [index,actor] of [white,black].entries()){
    const value=await gameCall(id,'command',[actor,{id:'probe-ready-'+index,type:'ready',expectedVersion:index}]);
    if(!value.ok)throw new Error(value.code);
  }
  const moves=[['e2','e4'],['e7','e5'],['g1','f3'],['b8','c6']];
  for(let index=0;index<moves.length;index++){
    const [from,to]=moves[index];
    const value=await gameCall(id,'command',[index%2===0?white:black,{id:'probe-move-'+index,type:'move',expectedVersion:index+2,from,to}]);
    if(!value.ok)throw new Error(value.code);
  }
  await control.phaseName('resignation-and-native-delivery');
  const resigned=await gameCall(id,'command',[white,{id:'probe-resign',type:'resign',expectedVersion:6}]);
  if(!resigned.ok)throw new Error(resigned.code);
  let observed;
  for(let turn=0;turn<100;turn++){
    await pause(10);observed=await env.GAME.get(env.GAME.idFromName(id)).fixtureInspect();
    if(observed.pendingDelivery===0)break;
  }
  if(observed.pendingDelivery!==0)throw new Error('probe_result_delivery_pending');
  const terminal=await gameCall(id,'status');
  if(terminal.result?.plies!==4||terminal.result?.status!=='finished')throw new Error('probe_terminal_result');
  await control.phaseName('duplicate-result');
  for(let copy=0;copy<5;copy++){
    const reply=await comp('settle',[terminal.result]);if(!reply.accepted||reply.pending)throw new Error('probe_duplicate_unsettled');
  }
  await control.phaseName('normal-release-and-projection');
  await comp('maintenance');
  const cycles=[];
  for(let cycle=0;cycle<2;cycle++){
    let current=await competition.fixtureProjection(eventId);
    if(!current.builds.length&&current.event.projected_revision>=current.event.revision)break;
    if(!current.builds.length&&current.event.project_after>Date.now())await pause(Math.min(10001,current.event.project_after-Date.now()+1));
    await control.phaseName('projection-cycle-'+cycle);
    const before=await control.inspect();
    for(let pass=0;pass<${projectionPasses};pass++){
      await comp('probeProjectionAdvance');current=await competition.fixtureProjection(eventId);
      if(current.event.projected_revision>=current.event.revision&&!current.builds.some(build=>build.event_id===eventId))break;
    }
    if(current.event.projected_revision<current.event.revision||current.builds.some(build=>build.event_id===eventId))throw new Error('probe_projection_pass_bound');
    const after=await control.inspect();
    const published=await env.DB.prepare('SELECT generation,previous_generation,page_count,watermark FROM arena_public_events WHERE event_id=?').bind(eventId).first();
    const pageRows=await env.DB.prepare('SELECT payload FROM arena_public_pages WHERE event_id=? AND generation=? ORDER BY page_number').bind(eventId,published.generation).all();
    const count=pageRows.results.reduce((n,row)=>n+JSON.parse(row.payload).standings.length,0);
    if(count!==2000||published.page_count!==63)throw new Error('probe_projection_incomplete');
    cycles.push({cycle,beforeEvents:before.events.length,afterEvents:after.events.length,published,rows:count,state:current});
  }
  await control.phaseName('projection-cleanup');
  for(let pass=0;pass<1500;pass++){
    await comp('probeProjectionCleanup');
    const current=await competition.fixtureProjection(eventId);
    if(current.snapshots===0&&current.versions===2000)break;
    if(pass===1499)throw new Error('probe_cleanup_pass_bound');
  }
  const final=await competition.fixtureProjection(eventId);
  await competition.fixtureStop();await env.GAME.get(env.GAME.idFromName(id)).fixtureStop();
  return Response.json({seeded,actualGame:{id,plies:terminal.result.plies,status:terminal.result.status,reason:terminal.result.outcome.reason},
    cycles,final,usage:await control.inspect()});
  } catch(error) { return Response.json({error:{message:error.message,stack:error.stack},usage:await control.inspect()}, {status:500}); }
}};`;

// Two local-only introspection operations enter the unchanged native host
// meter. The exported private candidate remains unchanged and unqualified.
const plugin = { name: 'local-capacity-feasibility-introspection', setup(builder) {
  builder.onLoad({ filter: /capacity-native\.ts$/ }, async ({ path }) => {
    const text = await readFile(path, 'utf8');
    const marker = "} else if (this.kind === 'Game' && method === 'observeQualificationGame') {";
    if (!text.includes(marker)) throw new Error('probe_native_introspection_marker_missing');
    const inserted = "} else if (this.kind === 'Competition' && method === 'probeProjectionAdvance') { "
      + "await (this.native as any).arenas.projection.advance(Date.now()); value = true as R; "
      + "} else if (this.kind === 'Competition' && method === 'probeProjectionCleanup') { "
      + "(this.native as any).arenas.projection.cleanup(); await (this.native as any).arenas.projection.cleanupPublic(Date.now()); value = true as R; "
      + marker;
    return { contents: text.replace(marker, inserted), loader: 'ts' };
  });
} };
const bundled = await build({ stdin: { contents: localSource, resolveDir: product, sourcefile: 'capacity-feasibility-local-fixture.ts' },
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
  external: ['cloudflare:*', 'node:*'], logLevel: 'silent', plugins: [plugin] });
const bundle = bundled.outputFiles[0].text;
const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle,
  compatibilityDate: '2026-10-19', compatibilityFlags: ['nodejs_compat'], cf: false,
  d1Databases: { DB: 'local-capacity-feasibility' },
  bindings: { AUTH_SECRET: 'local-feasibility-fixture-secret-at-least-32-bytes', CAPACITY_TOKEN: 'local-fixture-unused' },
  durableObjects: { GAME: { className: 'ProbeGame', useSQLite: true },
    COMPETITION: { className: 'ProbeCompetition', useSQLite: true }, CAPACITY_RUN: { className: 'ProbeRun', useSQLite: true } },
  host: '127.0.0.1', port: 0 }));
const started = performance.now(), cpuStart = process.cpuUsage();
try {
  const db = await runtime.getD1Database('DB');
  for (const migration of await readD1Migrations(new URL('../migrations/', import.meta.url).pathname)) {
    await db.batch(migration.queries.map(query => db.prepare(query)));
  }
  const response = await runtime.dispatchFetch('http://capacity-feasibility.local/exercise');
  if (!response.ok) {
    const failed=await response.json();
    await writeFile(output, JSON.stringify({failed:true,observed:failed},null,2)+'\n');
    throw new Error('local_feasibility_http_'+response.status+':'+JSON.stringify({error:failed.error,failures:failed.usage?.failures,unresolved:failed.usage?.unresolved}).slice(0,5000));
  }
  const observed = await response.json(), groups = {};
  for (const event of observed.usage.events) {
    const key = event.phase + '/' + event.operation;
    const group = groups[key] ??= { count: 0, sum: emptyMetrics(), max: emptyMetrics() };
    group.count++;
    for (const name of Object.keys(group.sum)) {
      group.sum[name] += event.actual[name];
      group.max[name] = Math.max(group.max[name], event.actual[name]);
    }
  }
  const sourceHashes = {};
  for (const name of ['src/server/capacity-run.ts','src/server/capacity-native.ts','src/server/capacity-meter.ts',
    'src/server/game.ts','src/server/competition.ts','src/server/arena.ts','src/server/arena-projection.ts',
    'src/server/capacity-fixtures.ts','scripts/probe-capacity-feasibility.mjs']) {
    sourceHashes[name] = createHash('sha256').update(await readFile(new URL('../' + name, import.meta.url))).digest('hex');
  }
  const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const checks={realFourPlyResignation:observed.actualGame.plies===4&&observed.actualGame.status==='finished'&&observed.actualGame.reason==='resignation',
    complete2000EntrantPublication:observed.cycles.length>0&&observed.cycles.every(cycle=>cycle.rows===2000&&cycle.published.page_count===63),
    nativeGameAlarmDelivery:observed.usage.events.some(event=>event.operation==='Game.alarm'&&event.mode==='automatic'),
    nativePrimaryResultValidation:observed.usage.events.some(event=>event.operation==='Game.status'&&event.phase==='resignation-and-native-delivery'),
    cleanupToLatestVersions:observed.final.snapshots===0&&observed.final.versions===2000,
    noUnresolvedNativeReply:observed.usage.unresolved.length===0,unarmed:true};
  const report = { schema: 'ejm-chess-capacity-feasibility-local-v1', at: new Date().toISOString(), node: process.version,
    runtime: { miniflare: lock.packages['node_modules/miniflare']?.version, workerd: lock.packages['node_modules/workerd']?.version },
    bundleSha256: createHash('sha256').update(bundle).digest('hex'), sourceHashes, checks, groups, observed,
    fixture: { entrants: 2_000, historyVersions, projectionPasses },
    wallMs: performance.now() - started, driverCpu: process.cpuUsage(cpuStart), driverMaxRssBytes: process.resourceUsage().maxRSS * 1024,
    activationGateReady: false,
    scope: 'One real local arena Game, primary signed fixture sessions, ready commands, four legal plies, resignation, native Game alarm result delivery, normal Competition initialization/status/settlement and 2000-entry projection publication/cleanup. Nonterminal entrants and old zero-score version metadata are direct excluded setup. Competition maintenance bodies are invoked explicitly to separate row phases; Competition native alarm cadence, 20000 real retained Games, full delivery/cold/failure bounds, provider CPU/cost and full run remain unqualified.' };
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ report: output, checks,events: observed.usage.events.length, groups,
    seeded: observed.seeded, game: observed.actualGame, cycles: observed.cycles.map(cycle => ({ cycle: cycle.cycle, rows: cycle.rows, published: cycle.published })),
    final: observed.final, wallMs: report.wallMs }) + '\n');
  if(Object.values(checks).some(value=>!value))process.exitCode=1;
} finally { await runtime.dispose(); }

function emptyMetrics() {
  return { nativeDoRequests: 0, doRowsRead: 0, doRowsWritten: 0, d1RowsRead: 0, d1RowsWritten: 0 };
}
