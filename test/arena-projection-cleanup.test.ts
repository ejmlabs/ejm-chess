import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { ARENA_POLICY } from '../src/server/arena-policy';
import type { ArenaProjection } from '../src/server/arena-projection';
import type { Competition } from '../src/server/competition';

type Authority = DurableObjectStub<Competition>;
type Internals = { arenas: { projection: ArenaProjection; nextDue(): number | null }; schedule(): Promise<void> };
const batch = ARENA_POLICY.workBatch;
const publicEvents: string[] = [];

async function authority(existing?: Authority): Promise<Authority> {
  const stub = existing ?? env.COMPETITION.get(env.COMPETITION.idFromName(crypto.randomUUID()));
  await runInDurableObject(stub, async (instance, state) => {
    (instance as unknown as Internals).schedule = async () => {};
    await state.storage.deleteAlarm();
  });
  return stub;
}

function pages(id: string, generation: number, count: number) {
  return env.DB.prepare(`WITH RECURSIVE pages(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM pages WHERE n+1<?)
    INSERT INTO arena_public_pages(event_id,generation,page_number,payload) SELECT ?,?,n,'{}' FROM pages`)
    .bind(count, id, generation);
}

function head(id: string, generation: number, previous: number, now: number) {
  publicEvents.push(id);
  return env.DB.prepare(`INSERT INTO arena_public_events(event_id,starts_at,finished_at,status,generation,previous_generation,
    watermark,generated_at,page_count,summary) VALUES(?,?,?,'finished',?,?,0,?,?,'{}')`)
    .bind(id, now - 3_600_000, now, generation, previous, now, batch);
}

async function countPages(id: string, generation?: number) {
  return env.DB.prepare(`SELECT COUNT(*) AS count FROM arena_public_pages WHERE event_id=?${generation === undefined ? '' : ' AND generation=?'}`)
    .bind(...(generation === undefined ? [id] : [id, generation])).first<number>('count');
}

afterEach(async () => {
  if (publicEvents.length) await env.DB.batch(publicEvents.splice(0).flatMap(id => [
    env.DB.prepare('DELETE FROM arena_public_pages WHERE event_id=?').bind(id),
    env.DB.prepare('DELETE FROM arena_public_events WHERE event_id=?').bind(id),
    env.DB.prepare('DELETE FROM arena_final_pages WHERE event_id=?').bind(id),
    env.DB.prepare('DELETE FROM arena_final_archives WHERE event_id=?').bind(id),
  ]));
});

describe('bounded arena projection cleanup', () => {
  it('advances beyond protected local rows across eviction without discarding a build snapshot', async () => {
    const original = await authority();
    const first = await runInDurableObject(original, (instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`INSERT INTO arena_projection_builds(event_id,generation,revision,watermark,generated_at,summary,phase)
        VALUES('a-build',2,3,0,0,'{}','capture')`);
      for (let index = 0; index < batch * 2; index++) {
        const user = `player-${String(index).padStart(3, '0')}`;
        sql.exec(`INSERT INTO arena_snapshot_rows(event_id,generation,user_id,name,points_half,games)
          VALUES('a-build',2,?,'Player',0,0),('z-old',1,?,'Player',0,0)`, user, user);
      }
      for (let index = 0; index < batch; index++) {
        const user = `player-${String(index).padStart(3, '0')}`;
        for (const revision of [2, 4]) sql.exec(`INSERT INTO arena_entry_versions(event_id,user_id,revision,name,points_half,games,visible)
          VALUES('a-build',?,?,'Player',0,0,1)`, user, revision);
      }
      for (let revision = 1; revision <= batch * 2 + 1; revision++) sql.exec(`INSERT INTO arena_entry_versions
        (event_id,user_id,revision,name,points_half,games,visible) VALUES('z-old','player',?,'Player',0,0,1)`, revision);
      (instance as unknown as Internals).arenas.projection.cleanup();
      return {
        snapshots: sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM arena_snapshot_rows').one().count,
        versions: sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM arena_entry_versions').one().count,
      };
    });
    // A pass may visit only the first batch of protected candidates, rather
    // than scanning past them to find a full batch of deletions.
    expect(first).toEqual({ snapshots: batch * 4, versions: batch * 4 + 1 });
    await evictDurableObject(original);
    const resumed = await authority(original);
    const remaining = await runInDurableObject(resumed, (instance, state) => {
      const projection = (instance as unknown as Internals).arenas.projection;
      const sql = state.storage.sql;
      for (let pass = 0; pass < 3; pass++) projection.cleanup();
      const protectedRows = {
        snapshots: sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM arena_snapshot_rows').one().count,
        versions: sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM arena_entry_versions').one().count,
      };
      sql.exec("DELETE FROM arena_projection_builds WHERE event_id='a-build'");
      // Model publication here. The real publication path is exercised below.
      sql.exec("UPDATE arena_meta SET value=CAST(value AS INTEGER)+1 WHERE key='public-cleanup-epoch'");
      for (let pass = 0; pass < 3; pass++) projection.cleanup();
      return { protectedRows,
        snapshotsAfterBuild: sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM arena_snapshot_rows').one().count,
        versionsAfterBuild: sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM arena_entry_versions').one().count };
    });
    expect(remaining).toEqual({ protectedRows: { snapshots: batch * 2, versions: batch * 2 + 1 },
      snapshotsAfterBuild: 0, versionsAfterBuild: batch + 1 });
  });

  it('drains pages behind retained and building generations after all local events end', async () => {
    const original = await authority();
    const suffix = crypto.randomUUID();
    const retained = `a-pages-${suffix}`;
    const building = `b-pages-${suffix}`;
    const ended = `z-pages-${suffix}`;
    const now = Date.now();
    publicEvents.push(building);
    await env.DB.batch([head(retained, 3, 2, now), pages(retained, 2, batch), pages(retained, 3, batch),
      pages(building, 1, batch), head(ended, 4, 3, now), pages(ended, 1, batch), pages(ended, 2, batch),
      pages(ended, 3, 1), pages(ended, 4, 1)]);
    const due = await runInDurableObject(original, async instance => {
      const arenas = (instance as unknown as Internals).arenas;
      await arenas.projection.cleanupPublic(now);
      return arenas.nextDue();
    });
    expect(await countPages(ended, 1)).toBe(batch);
    expect(await countPages(ended, 2)).toBe(batch);
    expect(due).toBe(now + 1_000);
    await evictDurableObject(original);
    const resumed = await authority(original);
    await runInDurableObject(resumed, async instance => {
      const projection = (instance as unknown as Internals).arenas.projection;
      for (let pass = 1; pass <= 5; pass++) {
        projection.cleanup();
        await projection.cleanupPublic(now + pass * 1_000);
      }
    });
    expect(await countPages(ended, 1)).toBe(0);
    expect(await countPages(ended, 2)).toBe(0);
    expect(await countPages(retained)).toBe(batch * 2);
    expect(await countPages(building)).toBe(batch);
    expect(await countPages(ended)).toBe(2);
    expect(await runInDurableObject(resumed, instance => (instance as unknown as Internals).arenas.nextDue())).toBeNull();
  });

  it('revisits protected local and public keys after publication changes their eligibility', async () => {
    const competition = await authority();
    const id = `arena-hourly-${Date.now()}`;
    const now = Date.now();
    await env.DB.batch([head(id, 4, 3, now), pages(id, 3, batch), pages(id, 4, batch)]);
    await runInDurableObject(competition, async (instance, state) => {
      const projection = (instance as unknown as Internals).arenas.projection;
      const sql = state.storage.sql;
      sql.exec(`INSERT INTO arena_events(id,cadence,pool,starts_at,closes_at,status,finished_at,generation,entrants)
        VALUES(?,'hourly','blitz',?,?,'finished',?,4,?)`, id, now - 3_600_000, now, now, batch * 2);
      for (let index = 0; index < batch * 2; index++) sql.exec(`INSERT INTO arena_entry_versions
        (event_id,user_id,revision,name,points_half,games,visible) VALUES(?,?,1,'Player',0,0,1)`,
      id, `player-${String(index).padStart(3, '0')}`);
      await projection.cleanupPublic(now);
      await projection.advance(now);
      await projection.advance(now);
      projection.cleanup();
      // A staged first page must not replace a complete published generation.
      expect(await env.DB.prepare('SELECT generation FROM arena_public_events WHERE event_id=?').bind(id).first('generation')).toBe(4);
      expect(sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM arena_entry_versions').one().count).toBe(batch * 2);
      await projection.advance(now);
      projection.cleanup();
      for (let pass = 1; pass <= 5; pass++) {
        projection.cleanup();
        await projection.cleanupPublic(now + pass * 1_000);
      }
      expect(sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM arena_entry_versions').one().count).toBe(batch * 2);
    });
    expect(await countPages(id, 3)).toBe(0);
    expect(await countPages(id, 4)).toBe(batch);
    expect(await countPages(id, 5)).toBe(2);
    expect(await env.DB.prepare('SELECT generation,previous_generation FROM arena_public_events WHERE event_id=?')
      .bind(id).first()).toEqual({ generation: 5, previous_generation: 4 });
    expect(await runInDurableObject(competition, (_instance, state) => state.storage.sql.exec(
      "SELECT 1 FROM arena_meta WHERE key='public-cleanup-at'").toArray())).toEqual([]);
  });
});
