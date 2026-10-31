#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { cpus, platform, release, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.some(value => !['--quick', '--sustained', '--three-events'].includes(value)) || (args.includes('--sustained') && args.includes('--three-events')))
  throw new Error('Usage: npm run qualify:local -- [--quick] [--sustained | --three-events]');
const root = fileURLToPath(new URL('../', import.meta.url));
const entrants = args.includes('--quick') ? 128 : 2_000;
const phase = args.includes('--sustained') ? 'sustained' : args.includes('--three-events') ? 'three-events' : 'arena';
const durationMs = args.includes('--quick') ? 10_000 : 900_000;
const startedAt = new Date().toISOString();
const path = resolve(root, '.qualification', startedAt.replaceAll(/[:.]/g, '-'));
await mkdir(path, { recursive: true });
const packageInfo = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const sourceFiles = ['package-lock.json', 'wrangler.jsonc', 'vitest.config.ts', 'vitest.qualification.config.ts',
  'src/server/competition.ts', 'src/server/game.ts', 'src/server/arena.ts', 'src/server/arena-policy.ts',
  'src/server/maintenance.ts', 'migrations/0011_retirement_work.sql', `qualification/${phase}.qualify.ts`];
const sources = Object.fromEntries(await Promise.all(sourceFiles.map(async file =>
  [file, createHash('sha256').update(await readFile(resolve(root, file))).digest('hex')])));
// mergeConfig concatenates `include`, so the config also lists every test/**/*.test.ts. Name the phase file to run only it.
const command = [process.execPath, resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.qualification.config.ts',
  `qualification/${phase}.qualify.ts`];
const wrapped = platform() === 'darwin' ? ['/usr/bin/time', '-l', ...command] : command;
const child = spawn(wrapped[0], wrapped.slice(1), { cwd: root, env: { ...process.env, CHESS_QUALIFICATION_ENTRANTS: String(entrants),
  CHESS_QUALIFICATION_PHASE: phase, CHESS_QUALIFICATION_DURATION_MS: String(durationMs),
  CHESS_QUALIFICATION_REPORT: resolve(path, 'measurements.json'),
  WRANGLER_LOG_PATH: resolve(path, 'wrangler.log') }, stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '';
let stderr = '';
child.stdout.on('data', chunk => { stdout += chunk; process.stdout.write(chunk); });
child.stderr.on('data', chunk => { stderr += chunk; process.stderr.write(chunk); });
const exitCode = await new Promise((resolveCode, reject) => {
  child.on('error', reject); child.on('close', resolveCode);
});
await Promise.all([writeFile(resolve(path, 'stdout.log'), stdout), writeFile(resolve(path, 'stderr.log'), stderr)]);
let measurements = [];
try { measurements = JSON.parse(await readFile(resolve(path, 'measurements.json'), 'utf8')); }
catch { /* A missing reporter output must fail qualification below. */ }
const rss = stderr.match(/(\d+)\s+maximum resident set size/);
const sourceAtFinish = Object.fromEntries(await Promise.all(sourceFiles.map(async file =>
  [file, createHash('sha256').update(await readFile(resolve(root, file))).digest('hex')])));
const report = { startedAt, finishedAt: new Date().toISOString(), exitCode, phase, entrants, requestedDurationMs: durationMs, command, sources,
  sourceChangedDuringRun: sourceFiles.filter(file => sources[file] !== sourceAtFinish[file]), sourceAtFinish,
  host: { platform: platform(), release: release(), node: process.version, cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem() },
  packages: { vitest: packageInfo.devDependencies.vitest, cloudflareVitest: packageInfo.devDependencies['@cloudflare/vitest-plugin'],
    wrangler: packageInfo.devDependencies.wrangler, chessJs: packageInfo.dependencies['chess.js'] },
  maxResidentSetBytes: rss ? Number(rss[1]) : null,
  memoryScope: 'macOS time reports the local test command maximum resident set; this is not per-game or deployed Durable Object memory.',
  measurements };
await writeFile(resolve(path, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log('Qualification report: ' + resolve(path, 'report.json'));
if (exitCode !== 0 || !measurements.length) process.exitCode = 1;
