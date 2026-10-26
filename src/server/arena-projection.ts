import type { ArenaList, ArenaStandingsPage, ArenaSummary } from '../shared/arenas';
import { ARENA_POLICY, arenaLimits } from './arena-policy';
import type { Env } from './env';
import { ApiError } from './security';

type Build = {
  event_id: string; generation: number; revision: number; watermark: number;
  generated_at: number; summary: string; phase: 'capture' | 'pages' | 'direct';
  after_user: string; page_number: number; row_count: number; ordinal: number;
  last_points: number | null; last_rank: number; last_user: string;
  scan_state: string; page_payload: string | null;
};
type EntryVersion = { user_id: string; name: string; points_half: number; games: number };
type ScanVersion = EntryVersion & { projection_order: number; revision: number; visible: number };
type ScanState = { after: [number, string, number] | null; rows: EntryVersion[]; complete: boolean };
type SnapshotKey = { event_id: string; generation: number; user_id: string };
type VersionKey = { event_id: string; user_id: string; revision: number };
type PublicPageKey = { event_id: string; generation: number; page_number: number };
type CleanupCursor<K> = { after: K; epoch: number };
type CleanupKind = 'snapshot' | 'version' | 'public';
interface Snapshot { summary: ArenaSummary; revision: number; watermark: number }

function visible(now: number): number { return now - ARENA_POLICY.historyMs; }

/** Spectator reads deliberately depend on D1 alone. They never resolve a session. */
export async function readArenaList(env: Pick<Env, 'DB' | 'ARENAS_ENABLED' | 'ARENA_ENTRANT_LIMIT'>, now = Date.now()): Promise<ArenaList> {
  const result = await env.DB.prepare(`SELECT summary FROM arena_public_events
    WHERE finished_at IS NULL OR finished_at>=? ORDER BY starts_at DESC,event_id LIMIT 21`).bind(visible(now)).all<{ summary: string }>();
  return { enabled: env.ARENAS_ENABLED === 'true', serverNow: now,
    events: result.results.map(row => JSON.parse(row.summary) as ArenaSummary),
    limits: { maxEntrants: arenaLimits(env).maxEntrants, maxOpen: ARENA_POLICY.maxOpen, measuredCapacity: null } };
}

export async function readArenaSummary(db: D1Database, id: string): Promise<ArenaSummary | null> {
  const row = await db.prepare(`SELECT summary FROM arena_public_events WHERE event_id=?
    AND (finished_at IS NULL OR finished_at>=?)`).bind(id, visible(Date.now())).first<{ summary: string }>();
  return row ? JSON.parse(row.summary) as ArenaSummary : null;
}

export async function readArenaStandings(db: D1Database, id: string, cursor: string | null = null): Promise<ArenaStandingsPage | null> {
  let generation: number | null = null;
  let page = 0;
  if (cursor !== null) {
    const match = /^(\d{1,10}):(\d{1,5})$/.exec(cursor);
    if (!match) throw new ApiError(400, 'INVALID_ARENA_CURSOR', 'Start again from the current standings.');
    generation = Number(match[1]); page = Number(match[2]);
  }
  // One indexed read binds the cursor to either of the two published generations.
  const row = await db.prepare(`SELECT p.payload FROM arena_public_events e JOIN arena_public_pages p ON p.event_id=e.event_id
    AND p.generation=COALESCE(?,e.generation) AND p.page_number=? WHERE e.event_id=?
    AND (e.finished_at IS NULL OR e.finished_at>=?) AND p.generation IN (e.generation,e.previous_generation)`)
    .bind(generation, page, id, visible(Date.now())).first<{ payload: string }>();
  if (row) return JSON.parse(row.payload) as ArenaStandingsPage;
  if (cursor && await readArenaSummary(db, id)) throw new ApiError(409, 'ARENA_CURSOR_EXPIRED', 'Standings changed. Start again from the current page.');
  return null;
}

/** Bounded version scans publish immutable standings at one frozen revision. */
export class ArenaProjection {
  constructor(private ctx: DurableObjectState, private getEnv: () => Env, private source: (id: string, now: number) => Snapshot | null) {
    const sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS arena_projection_builds(
      event_id TEXT PRIMARY KEY,generation INTEGER NOT NULL,revision INTEGER NOT NULL,watermark INTEGER NOT NULL,
      generated_at INTEGER NOT NULL,summary TEXT NOT NULL,phase TEXT NOT NULL,after_user TEXT NOT NULL DEFAULT '',
      page_number INTEGER NOT NULL DEFAULT 0,row_count INTEGER NOT NULL DEFAULT 0,ordinal INTEGER NOT NULL DEFAULT 0,
      last_points INTEGER,last_rank INTEGER NOT NULL DEFAULT 0,last_user TEXT NOT NULL DEFAULT '')`);
    const buildColumns = sql.exec<{ name: string }>('PRAGMA table_info(arena_projection_builds)').toArray();
    if (!buildColumns.some(column => column.name === 'scan_state')) sql.exec(`ALTER TABLE arena_projection_builds
      ADD COLUMN scan_state TEXT NOT NULL DEFAULT '{"after":null,"rows":[],"complete":false}'`);
    if (!buildColumns.some(column => column.name === 'page_payload')) sql.exec('ALTER TABLE arena_projection_builds ADD COLUMN page_payload TEXT');
    const versionColumns = sql.exec<{ name: string }>('PRAGMA table_xinfo(arena_entry_versions)').toArray();
    if (!versionColumns.some(column => column.name === 'projection_order')) sql.exec(`ALTER TABLE arena_entry_versions
      ADD COLUMN projection_order INTEGER GENERATED ALWAYS AS (-points_half) VIRTUAL`);
    // Matching ascending keys make the tuple cursor an index seek. LIMIT then
    // bounds candidates, including obsolete and post-freeze versions.
    sql.exec(`CREATE INDEX IF NOT EXISTS arena_version_order
      ON arena_entry_versions(event_id,projection_order,user_id,revision)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS arena_snapshot_rows(
      event_id TEXT NOT NULL,generation INTEGER NOT NULL,user_id TEXT NOT NULL,name TEXT NOT NULL,
      points_half INTEGER NOT NULL,games INTEGER NOT NULL,PRIMARY KEY(event_id,generation,user_id))`);
    sql.exec('CREATE INDEX IF NOT EXISTS arena_snapshot_order ON arena_snapshot_rows(event_id,generation,points_half DESC,user_id)');
    // One initial sweep also recovers obsolete pages left by an older build.
    sql.exec("INSERT OR IGNORE INTO arena_meta(key,value) VALUES('public-cleanup-epoch','1')");
    this.wakeCleanup(Date.now(), true);
  }

  private build(id: string): Build | null {
    return this.ctx.storage.sql.exec<Build>('SELECT * FROM arena_projection_builds WHERE event_id=?', id).toArray()[0] ?? null;
  }

  private cleanupCursor<T>(key: string): T | null {
    const row = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM arena_meta WHERE key=?', key).toArray()[0];
    return row ? JSON.parse(row.value) as T : null;
  }

  private saveCleanupCursor(key: string, value: unknown | null): void {
    if (value === null) this.ctx.storage.sql.exec('DELETE FROM arena_meta WHERE key=?', key);
    else this.ctx.storage.sql.exec(`INSERT INTO arena_meta(key,value) VALUES(?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, JSON.stringify(value));
  }

  private cleanupEpochs(): { requested: number; completed: Record<CleanupKind, number> } {
    const rows = this.ctx.storage.sql.exec<{ key: string; value: string }>(`SELECT key,value FROM arena_meta
      WHERE key IN ('public-cleanup-epoch','public-cleanup-completed','snapshot-cleanup-completed','version-cleanup-completed')`).toArray();
    return { requested: Number(rows.find(row => row.key === 'public-cleanup-epoch')?.value ?? 0),
      completed: {
        snapshot: Number(rows.find(row => row.key === 'snapshot-cleanup-completed')?.value ?? 0),
        version: Number(rows.find(row => row.key === 'version-cleanup-completed')?.value ?? 0),
        public: Number(rows.find(row => row.key === 'public-cleanup-completed')?.value ?? 0),
      } };
  }

  private finishCleanup<K>(kind: CleanupKind, cursor: CleanupCursor<K>, after: K | null): void {
    this.saveCleanupCursor(`${kind}-cleanup-cursor`, after === null ? null : { after, epoch: cursor.epoch });
    if (after === null) this.ctx.storage.sql.exec(`INSERT INTO arena_meta(key,value) VALUES(?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`, `${kind}-cleanup-completed`, String(cursor.epoch));
  }

  /** ArenaControl.nextDue reads this marker even after all events have ended. */
  private wakeCleanup(due: number, preserveEarlier = false): void {
    const sql = this.ctx.storage.sql;
    const epochs = this.cleanupEpochs();
    if (Object.values(epochs.completed).some(completed => epochs.requested > completed)) {
      sql.exec(`INSERT INTO arena_meta(key,value) VALUES('public-cleanup-at',?)
        ON CONFLICT(key) DO UPDATE SET value=${preserveEarlier
    ? 'MIN(CAST(arena_meta.value AS INTEGER),CAST(excluded.value AS INTEGER))' : 'excluded.value'}`, String(due));
    } else sql.exec("DELETE FROM arena_meta WHERE key='public-cleanup-at'");
  }

  private page(build: Build, rows: EntryVersion[], complete: boolean): ArenaStandingsPage {
    let ordinal = build.ordinal;
    let lastPoints = build.last_points;
    let lastRank = build.last_rank;
    const standings = rows.map(row => {
      ordinal++;
      if (lastPoints !== row.points_half) lastRank = ordinal;
      lastPoints = row.points_half;
      return { id: row.user_id, name: row.name, points: row.points_half / 2, games: row.games, rank: lastRank };
    });
    const summary = JSON.parse(build.summary) as ArenaSummary;
    return { id: build.event_id, format: 'arena-v1', generation: build.generation,
      watermark: build.watermark, generatedAt: build.generated_at, provisional: summary.provisional, standings,
      nextCursor: complete ? null : `${build.generation}:${build.page_number + 1}` };
  }

  /** Persist one page before D1 so a lost reply retries the exact same bytes. */
  private directPage(build: Build): ArenaStandingsPage | null {
    if (build.page_payload !== null) return JSON.parse(build.page_payload) as ArenaStandingsPage;
    const sql = this.ctx.storage.sql;
    return this.ctx.storage.transactionSync(() => {
      const scan = JSON.parse(build.scan_state) as ScanState;
      if (!scan.complete) {
        const candidates = scan.after === null
          ? sql.exec<ScanVersion>(`SELECT user_id,name,points_half,games,revision,visible,projection_order
            FROM arena_entry_versions INDEXED BY arena_version_order WHERE event_id=?
            ORDER BY projection_order,user_id,revision LIMIT ?`, build.event_id, ARENA_POLICY.workBatch).toArray()
          : sql.exec<ScanVersion>(`SELECT user_id,name,points_half,games,revision,visible,projection_order
            FROM arena_entry_versions INDEXED BY arena_version_order WHERE event_id=?
            AND (projection_order,user_id,revision)>(?,?,?) ORDER BY projection_order,user_id,revision LIMIT ?`,
          build.event_id, ...scan.after, ARENA_POLICY.workBatch).toArray();
        for (const row of candidates) {
          if (row.revision > build.revision) continue;
          const newest = sql.exec<{ revision: number }>(`SELECT revision FROM arena_entry_versions
            WHERE event_id=? AND user_id=? AND revision<=? ORDER BY revision DESC LIMIT 1`,
          build.event_id, row.user_id, build.revision).toArray()[0];
          // Check visibility only after choosing the latest version. Otherwise
          // an earlier visible row could resurrect a withdrawn entrant.
          if (newest?.revision === row.revision && row.visible === 1) scan.rows.push({
            user_id: row.user_id, name: row.name, points_half: row.points_half, games: row.games });
        }
        const last = candidates.at(-1);
        if (last) scan.after = [last.projection_order, last.user_id, last.revision];
        scan.complete = candidates.length < ARENA_POLICY.workBatch;
      }
      // One row of lookahead proves whether a full page has a successor. The
      // durable buffer never exceeds one page after this step.
      const complete = scan.complete && scan.rows.length <= ARENA_POLICY.pageRows;
      const page = scan.rows.length > ARENA_POLICY.pageRows || scan.complete
        ? this.page(build, scan.rows.splice(0, ARENA_POLICY.pageRows), complete)
        : null;
      sql.exec('UPDATE arena_projection_builds SET scan_state=?,page_payload=? WHERE event_id=? AND generation=?',
        JSON.stringify(scan), page ? JSON.stringify(page) : null, build.event_id, build.generation);
      return page;
    });
  }

  /** Advance one event and at most 32 version candidates. Publication is retryable. */
  async advance(now: number): Promise<void> {
    const sql = this.ctx.storage.sql;
    const last = sql.exec<{ value: string }>("SELECT value FROM arena_meta WHERE key='projection-cursor'").toArray()[0]?.value ?? '';
    const work = sql.exec<{ id: string }>(`SELECT e.id FROM arena_events e LEFT JOIN arena_projection_builds b ON b.event_id=e.id
      WHERE b.event_id IS NOT NULL OR (e.revision>e.projected_revision AND e.project_after<=?)
      ORDER BY CASE WHEN e.id>? THEN 0 ELSE 1 END,e.id LIMIT 1`, now, last).toArray()[0];
    if (!work) return;
    this.ctx.storage.transactionSync(() => {
      sql.exec("INSERT INTO arena_meta(key,value) VALUES('projection-cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", work.id);
      if (this.build(work.id)) return;
      const snapshot = this.source(work.id, now);
      if (!snapshot) return;
      const generation = sql.exec<{ generation: number }>('UPDATE arena_events SET generation=generation+1 WHERE id=? RETURNING generation', work.id).one().generation;
      const summary = { ...snapshot.summary, generation, watermark: snapshot.watermark, generatedAt: now };
      sql.exec(`INSERT INTO arena_projection_builds(event_id,generation,revision,watermark,generated_at,summary,phase)
        VALUES(?,?,?,?,?,?,'direct')`, work.id, generation, snapshot.revision, snapshot.watermark, now, JSON.stringify(summary));
    });
    const build = this.build(work.id);
    if (!build) return;
    if (build.phase === 'capture') {
      this.ctx.storage.transactionSync(() => {
        const rows = sql.exec<EntryVersion>(`SELECT v.user_id,v.name,v.points_half,v.games FROM arena_entry_versions v
          WHERE v.event_id=? AND v.user_id>? AND v.revision=(SELECT MAX(n.revision) FROM arena_entry_versions n
            WHERE n.event_id=v.event_id AND n.user_id=v.user_id AND n.revision<=?) AND v.visible=1
          ORDER BY v.user_id LIMIT ?`, build.event_id, build.after_user, build.revision, ARENA_POLICY.workBatch).toArray();
        for (const row of rows) sql.exec(`INSERT OR IGNORE INTO arena_snapshot_rows(event_id,generation,user_id,name,points_half,games)
          VALUES(?,?,?,?,?,?)`, build.event_id, build.generation, row.user_id, row.name, row.points_half, row.games);
        sql.exec(`UPDATE arena_projection_builds SET after_user=?,row_count=row_count+?,phase=? WHERE event_id=?`,
          rows.at(-1)?.user_id ?? build.after_user, rows.length, rows.length < ARENA_POLICY.workBatch ? 'pages' : 'capture', build.event_id);
      });
      return;
    }
    const rows = build.phase === 'direct' ? [] : sql.exec<EntryVersion>(`SELECT user_id,name,points_half,games FROM arena_snapshot_rows
      WHERE event_id=? AND generation=? AND (? IS NULL OR points_half<? OR (points_half=? AND user_id>?))
      ORDER BY points_half DESC,user_id LIMIT ?`, build.event_id, build.generation, build.last_points,
    build.last_points, build.last_points, build.last_user, ARENA_POLICY.pageRows).toArray();
    const page = build.phase === 'direct' ? this.directPage(build) : this.page(build, rows, build.ordinal + rows.length >= build.row_count);
    if (!page) return;
    const ordinal = build.ordinal + page.standings.length;
    const finalRow = page.standings.at(-1);
    const lastPoints = finalRow ? finalRow.points * 2 : build.last_points;
    const lastRank = finalRow?.rank ?? build.last_rank;
    const complete = page.nextCursor === null;
    const summary = JSON.parse(build.summary) as ArenaSummary;
    const payload = JSON.stringify(page);
    if (new TextEncoder().encode(payload).byteLength > ARENA_POLICY.pageBytes) throw new Error('arena_projection_page_limit');
    if (build.phase === 'direct') await this.ctx.storage.sync();
    const db = this.getEnv().DB;
    const statements = [db.prepare('INSERT OR IGNORE INTO arena_public_pages(event_id,generation,page_number,payload) VALUES(?,?,?,?)')
      .bind(build.event_id, build.generation, build.page_number, payload)];
    if (summary.finishedAt !== null) statements.push(db.prepare('INSERT OR IGNORE INTO arena_final_pages(event_id,generation,page_number,payload) VALUES(?,?,?,?)')
      .bind(build.event_id, build.generation, build.page_number, payload));
    await db.batch(statements);
    const stored = await db.prepare('SELECT payload FROM arena_public_pages WHERE event_id=? AND generation=? AND page_number=?')
      .bind(build.event_id, build.generation, build.page_number).first<{ payload: string }>();
    if (stored?.payload !== payload) throw new Error('arena_projection_conflict');
    if (summary.finishedAt !== null) {
      const archived = await db.prepare('SELECT payload FROM arena_final_pages WHERE event_id=? AND generation=? AND page_number=?')
        .bind(build.event_id, build.generation, build.page_number).first<{ payload: string }>();
      if (archived?.payload !== payload) throw new Error('arena_final_projection_conflict');
    }
    if (!complete) {
      sql.exec(`UPDATE arena_projection_builds SET page_number=?,ordinal=?,last_points=?,last_rank=?,last_user=?,page_payload=NULL
        WHERE event_id=? AND generation=? AND page_number=?`, build.page_number + 1, ordinal, lastPoints, lastRank,
      finalRow?.id ?? build.last_user, build.event_id, build.generation, build.page_number);
      await this.ctx.storage.sync();
      return;
    }
    const pageCount = build.page_number + 1;
    const publish = [db.prepare(`INSERT INTO arena_public_events(event_id,starts_at,finished_at,status,generation,watermark,generated_at,page_count,summary)
      SELECT ?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM arena_public_pages WHERE event_id=? AND generation=?)=?
      ON CONFLICT(event_id) DO UPDATE SET starts_at=excluded.starts_at,finished_at=excluded.finished_at,status=excluded.status,
      previous_generation=arena_public_events.generation,generation=excluded.generation,watermark=excluded.watermark,
      generated_at=excluded.generated_at,page_count=excluded.page_count,summary=excluded.summary
      WHERE excluded.generation>arena_public_events.generation`)
      .bind(build.event_id, summary.startsAt, summary.finishedAt, summary.status, build.generation, build.watermark,
        build.generated_at, pageCount, build.summary, build.event_id, build.generation, pageCount)];
    if (summary.finishedAt !== null) publish.push(db.prepare(`INSERT OR IGNORE INTO arena_final_archives(event_id,finished_at,generation,watermark,page_count,summary)
      SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM arena_final_pages WHERE event_id=? AND generation=?)=?`)
      .bind(build.event_id, summary.finishedAt, build.generation, build.watermark, pageCount, build.summary, build.event_id, build.generation, pageCount));
    await db.batch(publish);
    const accepted = await db.prepare('SELECT 1 FROM arena_public_events WHERE event_id=? AND generation=?').bind(build.event_id, build.generation).first();
    if (!accepted) throw new Error('arena_projection_not_published');
    this.ctx.storage.transactionSync(() => {
      sql.exec('UPDATE arena_events SET projected_revision=?,project_after=? WHERE id=?', build.revision,
        Math.max(now, build.generated_at + ARENA_POLICY.snapshotIntervalMs), build.event_id);
      sql.exec('DELETE FROM arena_projection_builds WHERE event_id=? AND generation=?', build.event_id, build.generation);
      sql.exec("UPDATE arena_meta SET value=CAST(value AS INTEGER)+1 WHERE key='public-cleanup-epoch'");
      this.wakeCleanup(now, true);
    });
  }

  /** Visit bounded candidate keys, including protected rows, before eligibility. */
  cleanup(): void {
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      const epochs = this.cleanupEpochs();
      if (epochs.requested > epochs.completed.snapshot) {
        const cursor = this.cleanupCursor<CleanupCursor<[string, number, string]>>('snapshot-cleanup-cursor')
          ?? { after: ['', -1, ''], epoch: epochs.requested };
        const snapshots = sql.exec<SnapshotKey>(`SELECT event_id,generation,user_id FROM arena_snapshot_rows
          WHERE (event_id,generation,user_id)>(?,?,?) ORDER BY event_id,generation,user_id LIMIT ?`,
        ...cursor.after, ARENA_POLICY.workBatch).toArray();
        for (const row of snapshots) sql.exec(`DELETE FROM arena_snapshot_rows WHERE event_id=? AND generation=? AND user_id=?
          AND NOT EXISTS(SELECT 1 FROM arena_projection_builds b
            WHERE b.event_id=arena_snapshot_rows.event_id AND b.generation=arena_snapshot_rows.generation)`,
        row.event_id, row.generation, row.user_id);
        const last = snapshots.at(-1);
        this.finishCleanup('snapshot', cursor, snapshots.length === ARENA_POLICY.workBatch && last
          ? [last.event_id, last.generation, last.user_id] : null);
      }

      if (epochs.requested > epochs.completed.version) {
        const cursor = this.cleanupCursor<CleanupCursor<[string, string, number]>>('version-cleanup-cursor')
          ?? { after: ['', '', -1], epoch: epochs.requested };
        const versions = sql.exec<VersionKey>(`SELECT event_id,user_id,revision FROM arena_entry_versions
          WHERE (event_id,user_id,revision)>(?,?,?) ORDER BY event_id,user_id,revision LIMIT ?`,
        ...cursor.after, ARENA_POLICY.workBatch).toArray();
        for (const row of versions) sql.exec(`DELETE FROM arena_entry_versions WHERE event_id=? AND user_id=? AND revision=?
          AND revision<(SELECT MAX(n.revision) FROM arena_entry_versions n
            WHERE n.event_id=arena_entry_versions.event_id AND n.user_id=arena_entry_versions.user_id
            AND n.revision<=COALESCE((SELECT b.revision FROM arena_projection_builds b
              WHERE b.event_id=arena_entry_versions.event_id),9223372036854775807))`, row.event_id, row.user_id, row.revision);
        const last = versions.at(-1);
        this.finishCleanup('version', cursor, versions.length === ARENA_POLICY.workBatch && last
          ? [last.event_id, last.user_id, last.revision] : null);
      }
      this.wakeCleanup(Date.now() + 1_000, true);
    });
  }

  async cleanupPublic(now: number): Promise<void> {
    const sql = this.ctx.storage.sql;
    const epochs = this.cleanupEpochs();
    if (epochs.requested <= epochs.completed.public) { this.wakeCleanup(now + 1_000); return; }
    const due = sql.exec<{ value: string }>("SELECT value FROM arena_meta WHERE key='public-cleanup-at'").toArray()[0];
    if (due && Number(due.value) > now) return;
    const cursor = this.cleanupCursor<CleanupCursor<[string, number, number]>>('public-cleanup-cursor')
      ?? { after: ['', -1, -1], epoch: epochs.requested };
    const db = this.getEnv().DB;
    const result = await db.prepare(`SELECT event_id,generation,page_number FROM arena_public_pages
      WHERE (event_id,generation,page_number)>(?,?,?) ORDER BY event_id,generation,page_number LIMIT ?`)
      .bind(...cursor.after, ARENA_POLICY.workBatch).all<PublicPageKey>();
    const rows = result.results;
    if (rows.length) await db.batch(rows.map(row => db.prepare(`DELETE FROM arena_public_pages
      WHERE event_id=? AND generation=? AND page_number=? AND EXISTS(SELECT 1 FROM arena_public_events e
        WHERE e.event_id=arena_public_pages.event_id AND arena_public_pages.generation<e.generation
          AND arena_public_pages.generation<>COALESCE(e.previous_generation,-1))`)
      .bind(row.event_id, row.generation, row.page_number)));
    this.ctx.storage.transactionSync(() => {
      const last = rows.at(-1);
      this.finishCleanup('public', cursor, rows.length === ARENA_POLICY.workBatch && last
        ? [last.event_id, last.generation, last.page_number] : null);
      // A publication during the sweep changes the epoch. Revisit earlier keys
      // in another sweep without repeatedly restarting at a protected prefix.
      this.wakeCleanup(now + 1_000);
    });
  }
}
