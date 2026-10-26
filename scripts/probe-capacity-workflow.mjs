#!/usr/bin/env node
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readD1Migrations } from '@cloudflare/vitest-plugin';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { capacityFixtureManifest } from '../test/capacity-fixtures.ts';

const [flag, output] = process.argv.slice(2);
if (flag !== '--output' || !output?.startsWith('/private/tmp/')) {
  throw new Error('Usage: node scripts/probe-capacity-workflow.mjs --output /private/tmp/report.json');
}
const product = fileURLToPath(new URL('..', import.meta.url));
const manifest = capacityFixtureManifest(Math.floor(Date.now() / 60_000) * 60_000 - 600_000);
// A small mechanics fixture needs preparation while the real daily event is
// open. It is deliberately not a sealable full-workload/controller manifest.
manifest.setupEndsAt = Date.now() + 60_000;
const source = `
import { DurableObject } from 'cloudflare:workers';
import { CapacityNativeWrapper, callCapacityWorkflow } from './src/server/capacity-native';
import { CapacityTicketCodec } from './src/server/capacity-run';
import { CAPACITY_NATIVE_CANDIDATE_ENVELOPES as envelopes } from './src/server/capacity-candidate-plan';
import { CAPACITY_WORKFLOW_CANDIDATES as plans } from './src/server/capacity-work-plan';
import { capacityIntent, capacityIntentStepIndex, capacityStep } from './src/shared/capacity-corpus';
import { readCapacityBinding } from './src/server/capacity-binding';
import { authenticateCapacitySession } from './src/server/capacity-fixtures';
const manifest=${JSON.stringify(manifest)};
const workflows={Game:plans.regular,Competition:plans.competition,delayed:plans.delayed,socket:plans.socket};
const control=env=>env.CAPACITY_RUN.get(env.CAPACITY_RUN.idFromName('one-workflow-mechanics-fixture'));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export class ProbeRun extends DurableObject {
  funded=new Map();events=[];failures=[];calls={};codec=new CapacityTicketCodec('local-workflow-probe-secret-at-least-32-bytes');
  count(method){this.calls[method]=(this.calls[method]??0)+1;}
  async available(){this.count('available');return true;}
  async charge(){this.count('charge');return true;}
  async linkGame(){this.count('linkGame');return true;}
  async begin(id,objectKey,operation,_envelope,mode='workflow'){
    this.count('begin');if(this.funded.has(objectKey))return this.funded.get(objectKey);
    const ticket=await this.codec.dispatch({runId:manifest.runId,manifestDigest:manifest.digest,
      id,objectKey,generation:1,operation,mode});this.funded.set(objectKey,ticket);return ticket;
  }
  async complete(){this.count('complete');return true;}
  async note(kind,method,reply){if(this.events.length>=512)throw new Error('probe_events_exhausted');
    this.events.push({kind,method,usage:reply.usage,actual:reply.actual,workflowActual:reply.workflowActual,drained:reply.drained});}
  async failed(kind,method,code){this.failures.push({kind,method,code});}
  async inspect(){return {events:this.events,calls:this.calls,failures:this.failures};}
}
class ProbeBase extends DurableObject {
  constructor(ctx,env,kind){super(ctx,env);this.kind=kind;this.native=new CapacityNativeWrapper(ctx,env,kind,
    {manifest,envelopes,workflows,control:control(env)});}
  async invoke(method,args,ticket){try{const reply=await this.native.rpc(method,args,ticket);
    await control(this.env).note(this.kind,method,reply);return reply;}
    catch(error){await control(this.env).failed(this.kind,method,error.message);throw error;}}
  async fixtureInspect(){const sql=this.ctx.storage.sql;
    const exists=name=>sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",name).toArray().length;
    return {workflow:exists('capacity_wrapper_workflow')?sql.exec('SELECT events,unresolved,stopped,closed,profile,intent_index,recovery_attempted,observed,reserved FROM capacity_wrapper_workflow WHERE id=1').toArray()[0]:null,
      alarm:await this.ctx.storage.getAlarm(),physicalBytes:sql.databaseSize,
      pendingDelivery:exists('result_delivery')?sql.exec('SELECT COUNT(*) AS n FROM result_delivery').one().n:null};}
  async fixtureStop(){await this.ctx.storage.deleteAlarm();await this.ctx.storage.sync();}
}
export class ProbeGame extends ProbeBase {
  constructor(ctx,env){super(ctx,env,'Game');}
  async init(value,ticket){return this.invoke('init',[value],ticket);}
  async status(ticket){return this.invoke('status',[],ticket);}
  async qualificationStep(request,index,ticket){return this.invoke('qualificationStep',[request,index],ticket);}
  async enforceTournamentDeadline(id,round,ticket){return this.invoke('enforceTournamentDeadline',[id,round],ticket);}
  async alarm(){await this.native.alarm();}
}
export class ProbeCompetition extends ProbeBase {
  constructor(ctx,env){super(ctx,env,'Competition');}
  async prepareQualificationAccount(index,ticket){return this.invoke('prepareQualificationAccount',[index],ticket);}
  async qualificationStep(request,index,actor,ticket){return this.invoke('qualificationStep',[request,index,actor],ticket);}
  async maintenance(ticket){return this.invoke('maintenance',[],ticket);}
  async settle(result,ticket){return this.invoke('settle',[result],ticket);}
  // This mechanics probe names each maintenance phase explicitly. The full
  // rehearsal separately checks native Competition alarm cadence.
  async alarm(){await this.ctx.storage.deleteAlarm();}
}
export default {async fetch(request,env){
  if(new URL(request.url).pathname!=='/exercise')return new Response('Not found',{status:404});
  const run=control(env),competition=env.COMPETITION.get(env.COMPETITION.idFromName('global'));
  const ticket=await run.begin(crypto.randomUUID(),'competition','Competition.workflow',plans.competition.envelope,'workflow');
  const cookies=new Map(),intentIndex=1000,intent=capacityIntent(intentIndex),results=[];
  let gameId=null,failure=null;
  try{
    for(const index of intent.queueAccounts){const reply=await callCapacityWorkflow(env.COMPETITION,ticket,'Competition.prepareQualificationAccount',[index]);
      cookies.set(index,reply.value.cookie);}
    const req=(index,proof)=>new Request('https://'+manifest.host+'/capacity/step/'+index,
      {headers:{Cookie:cookies.get(index),...(proof?{'x-capacity-binding':proof}:{})}});
    for(const index of intent.queueAccounts){const request=req(index),actor=await authenticateCapacitySession(env.DB,env,manifest,request,index);
      const reply=await callCapacityWorkflow(env.COMPETITION,ticket,'Competition.qualificationStep',[request,index,actor]);
      results.push({index,...reply.value});if(!reply.value.accepted)throw new Error('probe_register_'+reply.value.code);}
    for(let within=0;within<2;within++){
      const index=capacityIntentStepIndex(intentIndex,within),step=capacityStep(index);
      const request=req(step.actor.accountIndex),actor=await authenticateCapacitySession(env.DB,env,manifest,request,step.actor.accountIndex);
      const reply=await callCapacityWorkflow(env.COMPETITION,ticket,'Competition.qualificationStep',[request,index,actor]);
      results.push(reply.value);if(!reply.value.accepted)throw new Error('probe_queue_'+reply.value.code);}
    for(let pass=0;pass<32;pass++){
      await callCapacityWorkflow(env.COMPETITION,ticket,'Competition.maintenance');
      if(pass>=2)break;await pause(50);
    }
    let binding=null,proof=null;
    for(let within=2;within<4;within++){
      const index=capacityIntentStepIndex(intentIndex,within),step=capacityStep(index);
      const request=req(step.actor.accountIndex),actor=await authenticateCapacitySession(env.DB,env,manifest,request,step.actor.accountIndex);
      const reply=await callCapacityWorkflow(env.COMPETITION,ticket,'Competition.qualificationStep',[request,index,actor]);
      results.push({...reply.value,bindingProof:reply.value.bindingProof?'present':undefined});
      if(!reply.value.binding||!reply.value.bindingProof)throw new Error('probe_binding_unresolved');
      binding=reply.value.binding;proof=reply.value.bindingProof;}
    gameId=binding.gameId;
    const verified=await readCapacityBinding(req(binding.whiteAccountIndex,proof),manifest,env.AUTH_SECRET,intentIndex);
    const gameTicket=await new CapacityTicketCodec(env.AUTH_SECRET).dispatch({runId:manifest.runId,manifestDigest:manifest.digest,
      id:verified.workflowNonce,objectKey:'game:'+verified.gameId,generation:verified.generation,operation:'Game.workflow',mode:'workflow'});
    for(let within=4;within<13;within++){
      // Let the actual native delivery alarm run before the fixed observation.
      // No fixture flush or product clock alteration supplies the result.
      if(within===11)await pause(500);
      const index=capacityIntentStepIndex(intentIndex,within),step=capacityStep(index);
      const actorIndex=step.actor.role==='white'?binding.whiteAccountIndex:binding.blackAccountIndex;
      const reply=await callCapacityWorkflow(env.GAME,gameTicket,'Game.qualificationStep',[req(actorIndex,proof),index]);
      results.push(reply.value);if(!reply.value.accepted)throw new Error('probe_game_'+reply.value.code);
    }
  }catch(error){failure=error.message;}
  const measured=await run.inspect(),competitionState=await competition.fixtureInspect();
  const game=gameId?env.GAME.get(env.GAME.idFromName(gameId)):null;
  const gameState=game?await game.fixtureInspect():null;
  if(game)await game.fixtureStop();await competition.fixtureStop();
  return Response.json({failure,results,measured,gameState,competitionState});
}};`;
const bundled = await build({ stdin: { contents: source, resolveDir: product, sourcefile: 'capacity-workflow-local-fixture.ts' },
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:*', 'node:*'], logLevel: 'silent' });
const bundle = bundled.outputFiles[0].text;
const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle,
  compatibilityDate: '2026-10-19', compatibilityFlags: ['nodejs_compat'], cf: false,
  bindings: { AUTH_SECRET: 'local-workflow-probe-secret-at-least-32-bytes' },
  durableObjects: { GAME: { className: 'ProbeGame', useSQLite: true }, COMPETITION: { className: 'ProbeCompetition', useSQLite: true },
    CAPACITY_RUN: { className: 'ProbeRun', useSQLite: true } }, d1Databases: ['DB'], host: '127.0.0.1', port: 0 }));
const started = performance.now();
try {
  const db = await runtime.getD1Database('DB');
  const migrations = await readD1Migrations(new URL('../migrations', import.meta.url).pathname);
  for (const migration of migrations) await db.batch(migration.queries.map(query => db.prepare(query)));
  const response = await runtime.dispatchFetch('http://capacity-workflow.local/exercise');
  if (!response.ok) throw new Error('local_workflow_http_' + response.status + ':' + (await response.text()).slice(0, 1000));
  const observed = await response.json();
  const methods = {};
  for (const event of observed.measured.events) {
    const name = event.kind + '.' + event.method, sample = methods[name] ??= { events: 0, doRowsWritten: 0, doRowsRead: 0,
      d1RowsWritten: 0, d1RowsRead: 0, maxDoRowsWritten: 0, maxDoRowsRead: 0 };
    sample.events++;
    for (const key of ['doRowsWritten', 'doRowsRead', 'd1RowsWritten', 'd1RowsRead']) sample[key] += event.actual[key];
    sample.maxDoRowsWritten = Math.max(sample.maxDoRowsWritten, event.actual.doRowsWritten);
    sample.maxDoRowsRead = Math.max(sample.maxDoRowsRead, event.actual.doRowsRead);
  }
  const checks = { exactRegularIntent: observed.results.length === 15 && observed.results.every(result => result.accepted),
    workflowClosed: observed.gameState?.workflow?.closed === 1, noDelivery: observed.gameState?.pendingDelivery === 0,
    noFailure: observed.failure === null };
  const report = { schema: 'ejm-chess-native-workflow-local-v1', at: new Date().toISOString(), checks, methods, observed,
    manifest, sourceSha256: createHash('sha256').update(source).digest('hex'), bundleSha256: createHash('sha256').update(bundle).digest('hex'),
    wallMs: performance.now() - started, activationGateReady: false,
    scope: 'One exact regular corpus intent with two primary native fixture accounts, normal native registration, queueing, pairing, binding, legal commands, delivery and closure. No SQL event, Game, clock or result seeding. Probe controller and post-reply measurement RPCs are fixture-only. Competition maintenance is explicit, not automatic. This is a measured sample, not a full workload, conservative bound, real retirement, provider CPU/cost or activation qualification.' };
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ report: output, checks, methods, failure: observed.failure,
    gameWorkflow: observed.gameState?.workflow, wallMs: report.wallMs }) + '\n');
  if (Object.values(checks).some(value => !value)) process.exitCode = 1;
} finally { await runtime.dispose(); }
