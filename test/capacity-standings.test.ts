import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { capacityAccountId, capacityEventId } from '../src/shared/capacity-corpus';
import type { ArenaStandingsPage } from '../src/shared/arenas';
import { CAPACITY_PUBLIC_READ_ROWS, serveCapacityStandings } from '../src/server/capacity-standings';
import { capacityFixtureManifest } from './capacity-fixtures';
import { capacityReadEvidence, explainCapacityReads } from './capacity-read-evidence';

const anchor = Date.parse('2026-10-25T17:50:00Z');
afterEach(() => vi.restoreAllMocks());

async function standingsFixture(start = anchor) {
  vi.spyOn(Date, 'now').mockReturnValue(start);
  const manifest = { ...capacityFixtureManifest(start), digest: crypto.randomUUID().replaceAll('-', '').repeat(2) };
  const statements: D1PreparedStatement[] = [];
  for (let event = 0; event < 3; event++) {
    const id = capacityEventId(event, start);
    statements.push(env.DB.prepare(`INSERT INTO arena_public_events
      (event_id,starts_at,status,generation,previous_generation,watermark,generated_at,page_count,summary)
      VALUES(?,?,'running',3,2,10,?,63,'{}')`).bind(id, start, start));
    for (const generation of [2, 3]) for (let page = 0; page < 63; page++) {
      const value: ArenaStandingsPage = { id, format: 'arena-v1', generation, watermark: 10,
        generatedAt: start, provisional: false, nextCursor: page === 62 ? null : `${generation}:${page + 1}`,
        standings: Array.from({ length: page === 62 ? 16 : 32 }, (_, offset) => {
          const index = page * 32 + offset;
          return { id: capacityAccountId(event * 2_000 + index), name: `Capacity ${index}`, points: 0, games: 0, rank: 1 };
        }) };
      statements.push(env.DB.prepare('INSERT INTO arena_public_pages VALUES(?,?,?,?)').bind(id, generation, page, JSON.stringify(value)));
    }
  }
  for (let start = 0; start < statements.length; start += 64) await env.DB.batch(statements.slice(start, start + 64));
  const request = (index: number) => new Request(`https://${manifest.host}/capacity/standings/${index}`);
  return { manifest, request };
}

describe('private capacity public cache', () => {
  it('bounds native D1 work across complete indexed pages and shares warm reads without identity variants', async ({ task }) => {
    const { manifest, request } = await standingsFixture();
    const evidence = capacityReadEvidence(env.DB), measured = [];
    for (const index of [0, 31, 62, 63, 94, 125, 126, 157, 188]) {
      const start = evidence.reads.length;
      const cold = await serveCapacityStandings(request(index), { DB: evidence.db }, manifest, index);
      expect(cold.status).toBe(200);
      expect(cold.headers.get('X-Capacity-Cache')).toBe('MISS');
      const rows = Number(cold.headers.get('X-Capacity-D1-Rows-Read'));
      expect(rows).toBeGreaterThan(0);
      expect(rows).toBeLessThanOrEqual(CAPACITY_PUBLIC_READ_ROWS);
      expect(rows).toBeLessThanOrEqual(8);
      measured.push({ index, rowsRead: rows, queries: await explainCapacityReads(evidence.reads.slice(start)) });
      expect((await cold.json() as ArenaStandingsPage).generation).toBe(3);
    }
    const prepare = vi.fn(() => { throw new Error('warm read queried D1'); });
    const variant = new Request(request(0).url + '?ignored=private', {
      headers: { Cookie: 'fixture=private', Authorization: 'Bearer private' },
    });
    const warm = await serveCapacityStandings(variant, { DB: { prepare } as unknown as D1Database }, manifest, 0);
    expect(warm.headers.get('X-Capacity-Cache')).toBe('HIT');
    expect(warm.headers.get('X-Capacity-D1-Rows-Read')).toBe('0');
    expect(warm.headers.has('Set-Cookie')).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
    const otherRun = await serveCapacityStandings(request(0), env, { ...manifest, digest: 'f'.repeat(64) }, 0);
    expect(otherRun.headers.get('X-Capacity-Cache')).toBe('MISS');
    (task.meta as Record<string, unknown>).qualification = { kind: 'indexed-standings-read-bound', measured };
  });

  it('expires after ten seconds, leaves failed reads uncached and checks the deadline before warm reads', async () => {
    const start = anchor + 7 * 86_400_000;
    const { manifest, request } = await standingsFixture(start);
    await serveCapacityStandings(request(0), env, manifest, 0);
    const unavailable = { DB: { prepare() { throw new Error('native read unavailable'); } } as unknown as D1Database };
    vi.mocked(Date.now).mockReturnValue(start + 9_999);
    const warm = await serveCapacityStandings(request(0), unavailable, manifest, 0);
    expect(warm.headers.get('X-Capacity-Cache')).toBe('HIT');
    expect(warm.headers.get('Age')).toBe('9');
    vi.mocked(Date.now).mockReturnValue(start + 10_000);
    await expect(serveCapacityStandings(request(0), unavailable, manifest, 0)).rejects.toThrow('native read unavailable');
    const recovered = await serveCapacityStandings(request(0), env, manifest, 0);
    expect(recovered.headers.get('X-Capacity-Cache')).toBe('MISS');
    expect(recovered.headers.get('Age')).toBe('0');
    vi.mocked(Date.now).mockReturnValue(manifest.admissionsCloseAt);
    await expect(serveCapacityStandings(request(0), unavailable, manifest, 0)).rejects.toThrow('capacity_reads_expired');
  });
});
