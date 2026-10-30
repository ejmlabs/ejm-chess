// One process per invocation lets the caller impose a real wall deadline.
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const [path, fixture, color, fast = '0'] = process.argv.slice(2);
const bytes = readFileSync(path);
const started = performance.now();
const { instance } = await WebAssembly.instantiate(bytes, {});
const instantiated = performance.now();
const cpu = process.cpuUsage();
const verdict = instance.exports.classify_fixture(Number(fixture), Number(color), Number(fast));
const after = process.cpuUsage(cpu);
console.log(JSON.stringify({ fixtureIndex: Number(fixture), black: Number(color), fast: Number(fast), verdict,
  instantiateMs: instantiated - started, callMs: performance.now() - instantiated,
  callCpuMs: (after.user + after.system) / 1000,
  linearMemoryBytes: instance.exports.memory.buffer.byteLength, maxRssKiB: process.resourceUsage().maxRSS,
  wasmBytes: bytes.length }));
