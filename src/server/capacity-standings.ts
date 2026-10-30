import { capacityEventId, capacityStandingsPage } from '../shared/capacity-corpus';
import type { ArenaStandingsPage } from '../shared/arenas';
import { readArenaStandings } from './arena-projection';
import { CapacityNativeMeter, CAPACITY_D1_READ_ATTEMPTS, CAPACITY_WARM_D1_READ_ROWS } from './capacity-meter';
import type { CapacityManifest } from './capacity-run';

export const CAPACITY_PUBLIC_READ_ROWS = CAPACITY_WARM_D1_READ_ROWS;
const CACHE_MS = 10_000;

function readWindow(manifest: CapacityManifest): void {
  const now = Date.now();
  if (now < manifest.earliestArmAt || now >= manifest.admissionsCloseAt) throw new Error('capacity_reads_expired');
}

/** A cache miss uses the real indexed public projection through metered D1. */
export async function readCapacityStandings(db: D1Database, manifest: CapacityManifest,
  index: number): Promise<ArenaStandingsPage> {
  readWindow(manifest);
  const { eventIndex, page } = capacityStandingsPage(index);
  const id = capacityEventId(eventIndex, manifest.earliestArmAt);
  const current = await db.prepare('SELECT generation FROM arena_public_events WHERE event_id=? LIMIT 1')
    .bind(id).first<{ generation: number }>();
  if (!current || !Number.isSafeInteger(current.generation) || current.generation < 1) throw new Error('capacity_public_projection_unavailable');
  const value = await readArenaStandings(db, id, `${current.generation}:${page}`);
  if (!value || value.id !== id || value.generation !== current.generation) throw new Error('capacity_public_projection_unavailable');
  return value;
}

/** Entry must consume a permanently prepaid ingress unit before calling. */
export async function serveCapacityStandings(request: Request, env: { DB: D1Database }, manifest: CapacityManifest,
  index: number): Promise<Response> {
  readWindow(manifest);
  capacityStandingsPage(index);
  // The key contains only the frozen run and fixed page. No bearer token,
  // cookie or arbitrary query can create another public-cache variant.
  const key = new Request(new URL(`/.capacity-cache/${manifest.digest}/standings/${index}`, request.url));
  let cached: Response | undefined;
  try { cached = await caches.default.match(key); } catch { /* A miss still has its full prepaid D1 allowance. */ }
  if (cached) {
    const storedAt = Number(cached.headers.get('X-Capacity-Cached-At'));
    const elapsed = Date.now() - storedAt;
    if (Number.isSafeInteger(storedAt) && storedAt > 0 && elapsed >= 0 && elapsed < CACHE_MS) {
      const headers = new Headers(cached.headers);
      headers.set('X-Capacity-Cache', 'HIT');
      headers.set('X-Capacity-D1-Rows-Read', '0');
      headers.set('X-Capacity-D1-Retry-Read-Surcharge', '0');
      headers.set('Age', String(Math.floor(elapsed / 1_000)));
      return new Response(cached.body, { headers });
    }
  }
  const meter = new CapacityNativeMeter();
  meter.allowD1ReadRetries(CAPACITY_PUBLIC_READ_ROWS);
  const page = await readCapacityStandings(meter.d1(env.DB), manifest, index);
  const usage = meter.snapshot();
  if (usage.uncertain || usage.unresolvedD1 || usage.d1RowsWritten
    || usage.d1RowsRead + usage.d1RetryReadSurcharge > CAPACITY_D1_READ_ATTEMPTS * CAPACITY_PUBLIC_READ_ROWS) {
    throw new Error('capacity_public_read_metrics_unavailable');
  }
  readWindow(manifest);
  const response = Response.json(page, { headers: {
    'Cache-Control': 'public, max-age=10, s-maxage=10', Age: '0',
    'X-Capacity-Cache': 'MISS', 'X-Capacity-Cached-At': String(Date.now()),
    'X-Capacity-D1-Rows-Read': String(usage.d1RowsRead),
    'X-Capacity-D1-Retry-Read-Surcharge': String(usage.d1RetryReadSurcharge),
  } });
  try { await caches.default.put(key, response.clone()); } catch { /* Later misses remain fully prepaid. */ }
  return response;
}
