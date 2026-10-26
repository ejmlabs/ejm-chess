import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Chess } from 'chess.js';
import { ENGINE_LEVELS, STOCKFISH_BUILD } from '../src/shared/engine.ts';

// Exercise the unchanged engine's supported Node CLI. Browser loading has its
// own integration check; this probe makes no browser or Elo claim.
const directory = new URL(`../public/engines/${STOCKFISH_BUILD}/`, import.meta.url);
const temporary = await mkdtemp(join(tmpdir(), 'ejm-stockfish-probe-'));
let child;
let pending;
let stderr = '';
let outputChars = 0;
function waitFor(pattern, timeoutMs) {
  if (pending) throw new Error('A UCI response is already pending.');
  outputChars = 0;
  return new Promise((resolve, reject) => {
    pending = { pattern, resolve, reject, timer: setTimeout(() => {
      pending = undefined;
      reject(new Error('Stockfish probe timed out.'));
    }, timeoutMs) };
  });
}
function command(value) { child.stdin.write(value + '\n'); }

try {
  // The product is ESM, while upstream's supported Node entry is CommonJS.
  const script = join(temporary, 'stockfish-19-lite-single.cjs');
  await copyFile(new URL('stockfish-19-lite-single.js', directory), script);
  await copyFile(new URL('stockfish-19-lite-single.wasm', directory), join(temporary, 'stockfish-19-lite-single.wasm'));
  const memoryProbe = join(temporary, 'memory.cjs');
  await writeFile(memoryProbe, 'process.on("exit", () => require("node:fs").writeSync(2, "\\nEJM_ENGINE_MEMORY " + JSON.stringify({ ...process.memoryUsage(), maxRssKiB: process.resourceUsage().maxRSS }) + "\\n"));');
  const started = performance.now();
  child = spawn(process.execPath, ['--require', memoryProbe, script], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', chunk => { if (stderr.length < 4_096) stderr += chunk; });
  child.on('error', error => {
    if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = undefined; }
  });
  child.on('exit', code => {
    if (pending) { clearTimeout(pending.timer); pending.reject(new Error(`Engine exited (${code}): ${stderr}`)); pending = undefined; }
  });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    outputChars += line.length;
    if (line.length > 8_192 || outputChars > 262_144) {
      if (pending) { clearTimeout(pending.timer); pending.reject(new Error('Engine output limit exceeded.')); pending = undefined; }
      child.kill();
    } else if (pending?.pattern.test(line)) {
      const completed = pending;
      pending = undefined;
      clearTimeout(completed.timer);
      completed.resolve(line);
    }
  });
  let reply = waitFor(/^uciok$/, 30_000);
  command('uci');
  await reply;
  for (const option of ['Threads value 1', 'Hash value 16', 'Ponder value false', 'MultiPV value 1', 'UCI_LimitStrength value false']) command(`setoption name ${option}`);
  command('ucinewgame');
  reply = waitFor(/^readyok$/, 5_000);
  command('isready');
  await reply;
  const readyMs = performance.now() - started;
  const history = ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6', 'b5a4'];
  const searches = [];
  for (const level of ENGINE_LEVELS) {
    const board = new Chess();
    for (const move of history) board.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] });
    command(`setoption name Skill Level value ${level.skill}`);
    command(`position startpos moves ${history.join(' ')}`);
    reply = waitFor(/^bestmove /, level.moveTimeMs + 5_000);
    const searchStarted = performance.now();
    command(`go movetime ${level.moveTimeMs}`);
    const result = await reply;
    const elapsedMs = performance.now() - searchStarted;
    const move = /^bestmove ([a-h][1-8][a-h][1-8][qrbn]?)(?: ponder [a-h][1-8][a-h][1-8][qrbn]?)?$/.exec(result)?.[1];
    if (!move || !board.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] })) throw new Error(`Illegal engine result: ${result}`);
    searches.push({ ...level, move, legal: true, elapsedMs: Math.round(elapsedMs * 10) / 10 });
  }
  const exited = new Promise(resolve => child.once('close', resolve));
  command('quit');
  await exited;
  const memoryLine = /EJM_ENGINE_MEMORY (.+)/.exec(stderr)?.[1];
  const nodeMemoryAtExit = memoryLine ? JSON.parse(memoryLine) : null;
  console.log(JSON.stringify({ build: STOCKFISH_BUILD, runtime: process.version,
    platform: `${process.platform}/${process.arch}`, readyMs: Math.round(readyMs * 10) / 10,
    history, searches, nodeMemoryAtExit,
    limits: 'Local Node CLI probe only. Node RSS and external memory are not browser memory. No Elo or throughput claim.' }, null, 2));
} finally {
  if (pending) clearTimeout(pending.timer);
  child?.kill();
  await rm(temporary, { recursive: true, force: true });
}
