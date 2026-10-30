import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// This helper only sends reviewed requests. Provisioning and native D1 restore
// remain separate, explicit provider operations.
process.umask(0o077);
const [inputPath, outputName] = process.argv.slice(2);
const privateDir = process.env.CHESS_RECOVERY_PRIVATE_DIR;
const token = process.env.CHESS_RECOVERY_DRILL_TOKEN;
const origin = new URL(process.env.CHESS_RECOVERY_DRILL_URL ?? 'https://invalid.invalid');
const productRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const privateRelative = privateDir ? relative(productRoot, resolve(privateDir)) : '';
if (!inputPath || !outputName || !privateDir || !/^[A-Za-z0-9_.-]+\.json$/.test(outputName)
  || !token || !/^[A-Za-z0-9_-]{32,128}$/.test(token)
  || origin.protocol !== 'https:' || !/^ejm-chess-recovery-drill\.[a-z0-9-]+\.workers\.dev$/.test(origin.hostname)
  || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password
  || !(privateRelative === '..' || privateRelative.startsWith('../'))) {
  throw new Error('Use a private directory outside the product, an isolated workers.dev origin, a private token, an input JSON path and an output JSON filename.');
}
if ((await stat(inputPath)).size > 32_768) throw new Error('The drill request exceeds 32768 bytes.');
const body = JSON.parse(await readFile(inputPath, 'utf8'));
const response = await fetch(new URL('/drill', origin), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const result = await response.json();
await mkdir(privateDir, { recursive: true, mode: 0o700 });
const outputPath = resolve(privateDir, outputName);
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
console.log(JSON.stringify({ status: response.status, outputPath, error: result.error ?? null }));
if (!response.ok) process.exitCode = 1;
