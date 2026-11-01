import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, rename, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const directory = new URL('../public/engines/stockfish-19.0.1-lite-single/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('PROVENANCE.json', directory), 'utf8'));
const acquire = process.argv.length === 3 && process.argv[2] === '--fetch';
if (process.argv.length > 2 && !acquire) throw new Error('Use no argument to check assets or --fetch to restore pinned inputs.');
const runtimeBytes = manifest.files.filter(file => file.runtime).reduce((sum, file) => sum + file.bytes, 0);
if (runtimeBytes > 3 * 1024 * 1024) throw new Error('Stockfish exceeds its 3 MiB raw runtime budget.');

for (const file of manifest.files) {
  if (!/^[a-zA-Z0-9._-]+$/.test(file.name) || !/^[a-f0-9]{64}$/.test(file.sha256)
    || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > 3 * 1024 * 1024
    || !file.url.startsWith('https://')) throw new Error('Invalid Stockfish asset manifest.');
  const target = new URL(file.name, directory);
  if (acquire) {
    const temporary = fileURLToPath(target) + `.pending-${process.pid}`;
    const response = await fetch(file.url, { signal: AbortSignal.timeout(45_000) });
    if (!response.ok || !response.body) throw new Error(`Could not fetch ${file.name}: HTTP ${response.status}`);
    let handle;
    try {
      handle = await open(temporary, 'wx');
      const hash = createHash('sha256');
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > file.bytes) throw new Error(`Oversized Stockfish input: ${file.name}`);
        hash.update(chunk);
        await handle.write(chunk);
      }
      await handle.close();
      handle = undefined;
      if (bytes !== file.bytes || hash.digest('hex') !== file.sha256) throw new Error(`Stockfish integrity mismatch: ${file.name}`);
      await rename(temporary, target);
    } finally {
      await handle?.close();
      await rm(temporary, { force: true });
    }
  }
  const info = await stat(target).catch(() => null);
  const hash = createHash('sha256');
  if (info?.isFile()) for await (const chunk of createReadStream(target)) hash.update(chunk);
  if (!info?.isFile() || info.size !== file.bytes || hash.digest('hex') !== file.sha256) {
    throw new Error(`Stockfish integrity mismatch: ${file.name}. Restore with npm run engine:fetch.`);
  }
}
console.log(`Stockfish ${manifest.version}: ${manifest.files.length} pinned inputs verified; runtime ${runtimeBytes} raw bytes.`);
