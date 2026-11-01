// Per-route JS and CSS each prerendered page references, raw and gzip level 9, in KiB. Usage: node scripts/route-bytes.mjs dist
// The route size budget left ejm-ui, so this keeps the numbers it tracked visible beside the load-time check.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
const dist = process.argv.at(-1);
const walk = d => readdirSync(d).flatMap(n => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const sum = files => files.map(f => readFileSync(join(dist, f))).reduce(([r, g], b) => [r + b.length, g + gzipSync(b, { level: 9 }).length], [0, 0]);
const kib = n => (n / 1024).toFixed(1).padStart(6);
console.log('route'.padEnd(24), 'JS raw   JS gz CSS raw  CSS gz  (KiB)');
for (const page of walk(dist).filter(f => f.endsWith('.html')).map(f => f.slice(dist.length + 1)).sort()) {
  const refs = [...readFileSync(join(dist, page), 'utf8').matchAll(/(?:src|href)="\/(assets\/[^"?]+\.(js|css))"/g)];
  const of = ext => [...new Set(refs.filter(m => m[2] === ext).map(m => m[1]))];
  const [js, css] = [sum(of('js')), sum(of('css'))];
  console.log(('/' + page.replace(/index\.html$/, '')).padEnd(24), kib(js[0]), kib(js[1]), kib(css[0]), kib(css[1]));
}
