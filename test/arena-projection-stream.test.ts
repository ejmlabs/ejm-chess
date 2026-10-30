import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { readArenaStandings } from '../src/server/arena-projection';
import type { ArenaProjection } from '../src/server/arena-projection';
import type { Competition } from '../src/server/competition';
import type { Env } from '../src/server/env';
import type { ArenaStanding } from '../src/shared/arenas';

type Authority = DurableObjectStub<Competition>;
type Internals = { env: Env; arenas: { projection: ArenaProjection }; schedule(): Promise<void> };
const events: string[] = [];
const user = (index: number) => `player-${String(index).padStart(3, '0')}`;

async function authority(existing?: Authority) {
  const stub = existing ?? env.COMPETITION.get(env.COMPETITION.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, async (instance, state) => {
    (instance as unknown as Internals).schedule = async () => {};
    await state.storage.deleteAlarm();
  });
  return stub;
}

async function fixture(count: number, finished = false) {
  const stub = await authority();
  const id = `arena-stream-${crypto.randomUUID()}`;
  const now = Date.now();
  events.push(id);
  await runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec(`INSERT INTO arena_events(id,cadence,pool,starts_at,closes_at,status,finished_at,revision,watermark,entrants)
      VALUES(?,'hourly','blitz',?,?,?,?,3,7,?)`, id, now - 1_000, now + 3_600_000,
    finished ? 'finished' : 'running', finished ? now : null, count);
    for (let index = 0; index < count; index++) sql.exec(`INSERT INTO arena_entry_versions
      (event_id,user_id,revision,name,points_half,games,visible) VALUES(?,?,1,?,2,1,1)`, id, user(index), `Player ${index}`);
  });
  return { stub, id, now };
}

async function advance(stub: Authority, now: number, count = 1) {
  await runInDurableObject(stub, async instance => {
    for (let pass = 0; pass < count; pass++) await (instance as unknown as Internals).arenas.projection.advance(now);
  });
}

async function standings(id: string) {
  const rows: ArenaStanding[] = [];
  let cursor: string | null = null;
  const sizes: number[] = [];
  do {
    const page = await readArenaStandings(env.DB, id, cursor);
    expect(page).not.toBeNull();
    sizes.push(page!.standings.length);
    rows.push(...page!.standings);
    cursor = page!.nextCursor;
  } while (cursor);
  return { rows, sizes };
}

afterEach(async () => {
  if (events.length) await env.DB.batch(events.splice(0).flatMap(id => [
    env.DB.prepare('DELETE FROM arena_public_pages WHERE event_id=?').bind(id),
    env.DB.prepare('DELETE FROM arena_public_events WHERE event_id=?').bind(id),
    env.DB.prepare('DELETE FROM arena_final_pages WHERE event_id=?').bind(id),
    env.DB.prepare('DELETE FROM arena_final_archives WHERE event_id=?').bind(id),
  ]));
});

describe('streamed frozen arena standings', () => {
  it('finishes an older capture build after eviction before using the new scan path', async () => {
    const { stub, id, now } = await fixture(33);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`INSERT INTO arena_projection_builds(event_id,generation,revision,watermark,generated_at,summary,phase)
        VALUES(?,1,3,7,?,?,'capture')`, id, now, JSON.stringify({ provisional: true, startsAt: now - 1_000,
        finishedAt: null, status: 'running' }));
      sql.exec('UPDATE arena_events SET generation=1 WHERE id=?', id);
    });
    await advance(stub, now);
    await evictDurableObject(stub);
    const resumed = await authority(stub);
    await advance(resumed, now, 8);
    const published = await standings(id);
    expect(published.sizes).toEqual([32, 1]);
    expect(published.rows.map(row => row.id)).toEqual(Array.from({ length: 33 }, (_unused, index) => user(index)));
  });

  it.each([0, 32, 64, 65])('terminates %i tied entrants without an empty successor page', async count => {
    const { stub, id, now } = await fixture(count);
    await advance(stub, now, 8);
    const published = await standings(id);
    expect(published.rows.map(row => row.id)).toEqual(Array.from({ length: count }, (_unused, index) => user(index)));
    expect(published.rows.every(row => row.rank === 1)).toBe(true);
    expect(published.sizes).toEqual(count === 0 ? [0] : Array.from({ length: Math.ceil(count / 32) },
      (_unused, index) => Math.min(32, count - index * 32)));
  });

  it('resumes a partial page after eviction and keeps later scores and withdrawals outside its revision', async () => {
    const { stub, id, now } = await fixture(67);
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`INSERT INTO arena_entry_versions(event_id,user_id,revision,name,points_half,games,visible)
        VALUES(?,?,3,'Leader',8,4,1),(?,?,3,'Last',0,1,1),(?,?,3,'Withdrawn',2,1,0)`,
      id, user(0), id, user(65), id, user(66));
    });
    await advance(stub, now);
    await evictDurableObject(stub);
    const resumed = await authority(stub);
    await runInDurableObject(resumed, (instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`INSERT INTO arena_entry_versions(event_id,user_id,revision,name,points_half,games,visible)
        VALUES(?,?,4,'New leader',10,5,1),(?,?,4,'Later withdrawal',2,1,0),(?,?,4,'Late entry',6,3,1)`,
      id, user(1), id, user(64), id, user(67));
      sql.exec('UPDATE arena_events SET revision=4,watermark=8 WHERE id=?', id);
      // Cleanup must retain the frozen anchor even when a later version exists.
      for (let pass = 0; pass < 8; pass++) (instance as unknown as Internals).arenas.projection.cleanup();
    });
    await advance(resumed, now, 12);
    const first = await standings(id);
    expect(first.rows).toHaveLength(66);
    expect(first.rows[0]).toMatchObject({ id: user(0), name: 'Leader', points: 4, rank: 1 });
    expect(first.rows.slice(1, 65).every(row => row.points === 1 && row.rank === 2)).toBe(true);
    expect(first.rows.at(-1)).toMatchObject({ id: user(65), points: 0, rank: 66 });
    expect(first.rows.some(row => row.id === user(64))).toBe(true);
    expect(first.rows.some(row => row.id === user(66) || row.id === user(67))).toBe(false);
    await advance(resumed, now + 11_000, 12);
    const next = await standings(id);
    expect(next.rows[0]).toMatchObject({ id: user(1), name: 'New leader', points: 5, rank: 1 });
    expect(next.rows.some(row => row.id === user(64) || row.id === user(66))).toBe(false);
    expect(next.rows.some(row => row.id === user(67) && row.points === 3)).toBe(true);
    expect((await readArenaStandings(env.DB, id, '1:1'))?.watermark).toBe(7);
  });

  it('retries a committed D1 page with identical bytes after a lost reply and an authority restart', async () => {
    const { stub, id, now } = await fixture(65, true);
    await advance(stub, now);
    const staged = await runInDurableObject(stub, async (instance, state) => {
      const internal = instance as unknown as Internals;
      const original = internal.env;
      let loseReply = true;
      internal.env = { ...original, DB: new Proxy(original.DB, { get(target, property) {
        if (property === 'batch') return async (...args: Parameters<D1Database['batch']>) => {
          const reply = await target.batch(...args);
          if (loseReply) { loseReply = false; throw new Error('lost_page_reply'); }
          return reply;
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      } }) };
      try { await expect(internal.arenas.projection.advance(now)).rejects.toThrow('lost_page_reply'); }
      finally { internal.env = original; }
      return state.storage.sql.exec<{ page_payload: string }>('SELECT page_payload FROM arena_projection_builds WHERE event_id=?', id).one().page_payload;
    });
    expect(await env.DB.prepare('SELECT payload FROM arena_public_pages WHERE event_id=? AND generation=1 AND page_number=0')
      .bind(id).first('payload')).toBe(staged);
    expect(await readArenaStandings(env.DB, id)).toBeNull();
    await evictDurableObject(stub);
    const resumed = await authority(stub);
    await advance(resumed, now, 8);
    expect((await standings(id)).sizes).toEqual([32, 32, 1]);
    expect(await env.DB.prepare('SELECT payload FROM arena_public_pages WHERE event_id=? AND generation=1 AND page_number=0')
      .bind(id).first('payload')).toBe(staged);
    expect(await env.DB.prepare('SELECT page_count FROM arena_final_archives WHERE event_id=?').bind(id).first('page_count')).toBe(3);
  });

  it('keeps a conflicting finished archive unpublished', async () => {
    const { stub, id, now } = await fixture(1, true);
    await env.DB.prepare(`INSERT INTO arena_final_pages(event_id,generation,page_number,payload) VALUES(?,1,0,'{}')`).bind(id).run();
    await runInDurableObject(stub, async instance => {
      await expect((instance as unknown as Internals).arenas.projection.advance(now)).rejects.toThrow('arena_final_projection_conflict');
    });
    expect(await readArenaStandings(env.DB, id)).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM arena_final_archives WHERE event_id=?').bind(id).first()).toBeNull();
  });
});
