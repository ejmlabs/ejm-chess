#!/usr/bin/env node
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const [flag, output] = process.argv.slice(2);
if (flag !== '--output' || !output?.startsWith('/private/tmp/')) {
  throw new Error('Usage: node scripts/probe-capacity-ingress.mjs --output /private/tmp/report.json');
}
const product = fileURLToPath(new URL('..', import.meta.url));
const source = `
import { DurableObject } from 'cloudflare:workers';
import { CapacityIngressBudget } from './src/server/capacity-ingress';
let budget=null,retainedGrant=null,lastFailure=null;
export class IngressCounter extends DurableObject {
  constructor(ctx,env){super(ctx,env);ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS grants(id TEXT PRIMARY KEY)');}
  async reserveIngress(id){this.ctx.storage.sql.exec('INSERT INTO grants VALUES(?)',id);return true;}
  async count(){return this.ctx.storage.sql.exec('SELECT COUNT(*) AS count FROM grants').one().count;}
}
export default {async fetch(request,env){
  const control=env.COUNTER.get(env.COUNTER.idFromName('cross-request-ingress'));
  if(new URL(request.url).pathname==='/count')return Response.json({grants:await control.count()});
  budget??=new CapacityIngressBudget(Date.now()+60_000);
  const grant=async id=>{try{return await control.reserveIngress(id);}catch(error){lastFailure=error.message;throw error;}};
  if(env.RETAIN_FIRST==='true')retainedGrant??=grant;
  const accepted=await budget.consume(env.RETAIN_FIRST==='true'?retainedGrant:grant);
  return Response.json({accepted,lastFailure},{status:accepted?200:503});
}};`;
const bundle = await build({ stdin: { contents: source, resolveDir: product, sourcefile: 'capacity-ingress-probe.ts', loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022',
  external: ['cloudflare:workers', 'node:*'], conditions: ['workerd', 'worker', 'browser'], logLevel: 'silent' });
const results = [];
for (const retained of [true, false]) {
  const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: '2026-10-19', compatibilityFlags: ['nodejs_compat'], cf: false,
    bindings: { RETAIN_FIRST: String(retained) },
    durableObjects: { COUNTER: { className: 'IngressCounter', useSQLite: true } }, host: '127.0.0.1', port: 0 }));
  try {
    const origin = (await runtime.ready).origin;
    let acknowledged = 0, firstFailure = null;
    for (let index = 0; index < 257; index++) {
      const response = await fetch(origin + '/request');
      const reply = await response.json();
      if (response.ok && reply.accepted) acknowledged++;
      else { firstFailure = { index, status: response.status, ...reply }; break; }
    }
    const { grants } = await (await fetch(origin + '/count')).json();
    results.push({ adapter: retained ? 'retained-request-stub' : 'current-request-stub', acknowledged, grants, firstFailure });
  } finally { await runtime.dispose(); }
}
const passed = results[0].acknowledged === 256 && results[0].grants === 1
  && /different request|another request|previous request|I\/O/i.test(results[0].firstFailure?.lastFailure ?? '')
  && results[1].acknowledged === 257 && results[1].grants === 2 && results[1].firstFailure === null;
const report = { schema: 'ejm-chess-local-ingress-boundary-v1', localOnly: true,
  providerQualification: false, passed, results };
await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
process.stdout.write(JSON.stringify({ output, ...report }) + '\n');
if (!passed) process.exitCode = 1;
