import { env } from 'cloudflare:workers';
import { createExecutionContext, runInDurableObject } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import worker from '../src/server/index';
import drillWorker from '../src/server/recovery-drill';
import { admittedRecoveryGame, captureNativePoint, fingerprintAuthority, RECOVERY_SCAN_LIMIT, recoveryCaptureBody, recoveryInventory, recoverySha256, recognizedRecoveryPolicies, scanAuthority } from '../src/server/recovery';
import { assertDrillConfiguration, DRILL_SCHEMA, drillD1Schema, drillManifestProbes, drillResources, prepareDrillRestore, verifyDrillManifest,
  restartDrillObject, type DrillEnv, type DrillManifest } from '../src/server/recovery-drill-controls';
import { PRIOR_RULES_VERSIONS, RULES_VERSION, RATING_VERSION } from '../src/shared/protocol';
import { activeGame, player } from './authority-helpers';
import { ownerFixture } from './owner-fixture';

function isolatedConfig(): DrillEnv {
  return { ...env, PRODUCTION_RESOURCE_IDS: '99999999-9999-9999-9999-999999999999', RECOVERY_DRILL_TOKEN: 'test-private-recovery-drill-token-with-32-bytes',
    RECOVERY_DRILL_SCOPE: 'ejm-chess-recovery-drill-local-test', RECOVERY_DATABASE_ID: '11111111-1111-1111-1111-111111111111',
    RECOVERY_GAME_NAMESPACE_ID: '1'.repeat(32), RECOVERY_COMPETITION_NAMESPACE_ID: '2'.repeat(32), RECOVERY_SOURCE_REVISION: 'a'.repeat(40),
    NEW_WORK_STOPPED: 'true', RANKED_ENABLED: 'false', TOURNAMENTS_ENABLED: 'false', ARENAS_ENABLED: 'false', EMAIL: undefined };
}

/** Native bookmark calls are deliberately fake here. These tests prove guards, not provider restoration. */
function shim(ctx: DurableObjectState, overrides: { bookmark?: () => Promise<string>; restore?: (bookmark: string) => Promise<string>; abort?: () => void } = {}): DurableObjectState {
  return { id: ctx.id, blockConcurrencyWhile: callback => ctx.blockConcurrencyWhile(callback),
    storage: { sql: ctx.storage.sql, sync: () => ctx.storage.sync(), getAlarm: () => ctx.storage.getAlarm(),
      getCurrentBookmark: overrides.bookmark ?? (async () => 'test-native-bookmark'),
      onNextSessionRestoreBookmark: overrides.restore ?? (async () => 'test-native-undo') },
    abort: overrides.abort ?? (() => { throw new Error('test native restart'); }),
  } as DurableObjectState;
}

describe('private capture preserves authority', () => {
  it('captures metadata and bounded digests without changing a live clock, accepted command, receipt or alarm', async () => {
    const { game, white, snapshot } = await activeGame();
    const command = { id: crypto.randomUUID(), type: 'move' as const, from: 'e2', to: 'e4', expectedVersion: snapshot.version };
    const accepted = await game.command(white, command);
    expect(accepted.ok).toBe(true);
    await runInDurableObject(game, async (_instance, ctx) => {
      const before = await fingerprintAuthority(ctx.storage);
      const alarm = await ctx.storage.getAlarm();
      const point = await captureNativePoint(shim(ctx), { kind: 'Game', name: snapshot.id, policies: { rules: RULES_VERSION, ratings: RATING_VERSION } }, () => ({ status: 'active' }));
      expect(point.authority).toEqual(before);
      expect(point.alarm).toBe(alarm);
      expect(await fingerprintAuthority(ctx.storage)).toEqual(before);
      expect(JSON.stringify(point)).not.toContain(white.sessionId);
      expect(JSON.stringify(point)).not.toContain(white.id);
      await expect(captureNativePoint(shim(ctx, { bookmark: async () => { throw new Error('provider unavailable'); } }),
        { kind: 'Game', name: snapshot.id, policies: point.policies }, () => ({}))).rejects.toMatchObject({ code: 'RECOVERY_CAPTURE_UNAVAILABLE' });
      expect(await fingerprintAuthority(ctx.storage)).toEqual(before);
      expect(await ctx.storage.getAlarm()).toBe(alarm);
    });
    const retry = await game.command(white, command);
    if (!accepted.ok || !retry.ok) throw new Error('accepted command retry failed');
    expect(retry.receipt).toEqual(accepted.receipt);
    expect(retry.snapshot.version).toBe(accepted.snapshot.version);
    expect(retry.snapshot.moves).toEqual(accepted.snapshot.moves);
    expect(retry.snapshot.clocks.deadline).toBe(accepted.snapshot.clocks.deadline);
  });

  it('uses the provider API or reports it unavailable without inventing a bookmark or resetting the game', async () => {
    const { game, snapshot } = await activeGame();
    const before = await runInDurableObject(game, async (_instance, ctx) => fingerprintAuthority(ctx.storage));
    try {
      const point = await game.captureRecoveryPoint(snapshot.id);
      expect(point.bookmark.length).toBeGreaterThan(0);
      expect(point.objectId).toBe(game.id.toString());
    } catch (error) {
      expect(String(error)).toContain('Native recovery capture is unavailable');
    }
    expect(await runInDurableObject(game, async (_instance, ctx) => fingerprintAuthority(ctx.storage))).toEqual(before);
  });

  it('bounds capture work and refuses an authority too large for this recovery format', async () => {
    const { game } = await activeGame();
    await runInDurableObject(game, async (_instance, ctx) => {
      ctx.storage.sql.exec('CREATE TABLE capture_size_fixture(value TEXT NOT NULL)');
      ctx.storage.sql.exec('INSERT INTO capture_size_fixture(value) VALUES(?)', 'x'.repeat(2_097_153));
      await expect(fingerprintAuthority(ctx.storage)).rejects.toMatchObject({ code: 'RECOVERY_CAPTURE_LIMIT' });
      expect(ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM game_state').one().count).toBe(1);
    });
  });
});

describe('complete admitted-ID inventory and production boundary', () => {
  it('pages permanent D1 IDs and pending ranked matches together without allocating an unknown Game', async () => {
    const actor = await player();
    const d1Id = crypto.randomUUID();
    const rankedId = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO casual_game_admissions(game_id,creator_id,created_at) VALUES(?,?,?)').bind(d1Id, actor.id, Date.now()).run();
    const competition = env.COMPETITION.get(env.COMPETITION.idFromName('global'));
    await runInDurableObject(competition, (_instance, ctx) => {
      ctx.storage.sql.exec(`INSERT INTO matches(id,reservation_id,pool,white_id,black_id,white_actor,black_actor,status,created_at,next_attempt_at)
        VALUES(?,?,'blitz',?,?,?,?,'creating',?,?)`, rankedId, crypto.randomUUID(), actor.id, crypto.randomUUID(), JSON.stringify(actor), '{}', Date.now(), Date.now() + 60_000);
    });
    expect(await admittedRecoveryGame(env, rankedId)).toBe(true);
    expect(await admittedRecoveryGame(env, crypto.randomUUID())).toBe(false);
    const found: string[] = [];
    let after = '';
    for (let page = 0; page < 100; page++) {
      const result = await recoveryInventory(env, after, 1);
      expect(result.ids.length).toBeLessThanOrEqual(1);
      found.push(...result.ids);
      if (!result.nextCursor) break;
      after = result.nextCursor;
    }
    expect(found).toContain(d1Id);
    expect(found).toContain(rankedId);
    expect(found).toEqual([...new Set(found)].sort());
    await expect(recoveryInventory(env, '', 51)).rejects.toMatchObject({ code: 'INVALID_RECOVERY_CURSOR' });
  });

  it('denies public capture and has no production restore or restart RPC method', async () => {
    const response = await worker.fetch(new Request('http://localhost:8787/api/admin/operations/recovery/competition', {
      method: 'POST', headers: { Origin: 'http://localhost:8787', 'Content-Type': 'application/json' }, body: '{}',
    }), env, createExecutionContext());
    expect([401, 403]).toContain(response.status);
    const { game } = await activeGame();
    await runInDurableObject(game, instance => {
      const production = instance as unknown as Record<string, unknown>;
      expect(typeof production.prepareRecoveryRestore).toBe('undefined');
      expect(typeof production.restartRecovery).toBe('undefined');
    });
  });
});

describe('isolated native restore controls', () => {
  it('rejects public invocation and production or incomplete resource configurations before binding work', async () => {
    const config = isolatedConfig();
    const response = await drillWorker.fetch(new Request('https://isolated.example/drill', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"operation":"inspect"}',
    }), config);
    expect(response.status).toBe(403);
    expect(() => assertDrillConfiguration({ ...config, RECOVERY_DATABASE_ID: '99999999-9999-9999-9999-999999999999' })).toThrow();
    expect(() => assertDrillConfiguration({ ...config, RECOVERY_GAME_NAMESPACE_ID: '' })).toThrow();
    expect(() => assertDrillConfiguration({ ...config, NEW_WORK_STOPPED: 'false' })).toThrow();
  });

  it('rejects later accepted work and mismatched manifests before restore, then records undo before restart', async () => {
    const { game, snapshot } = await activeGame();
    const config = isolatedConfig();
    await config.DB.prepare('CREATE TABLE IF NOT EXISTS recovery_drill_restores(object_id TEXT PRIMARY KEY,manifest_digest TEXT NOT NULL,receipt TEXT NOT NULL,armed INTEGER NOT NULL DEFAULT 0)').run();
    await runInDurableObject(game, async (_instance, ctx) => {
      const point = await captureNativePoint(shim(ctx), { kind: 'Game', name: snapshot.id, policies: { rules: RULES_VERSION, ratings: RATING_VERSION } }, () => ({ status: 'active' }));
      const manifest: DrillManifest = { schema: DRILL_SCHEMA, scope: config.RECOVERY_DRILL_SCOPE, sourceRevision: config.RECOVERY_SOURCE_REVISION,
        resources: drillResources(config), d1: { bookmark: 'test-d1-bookmark', schemaSha256: await drillD1Schema(config.DB) },
        points: { game: point, competition: { ...point, kind: 'Competition', name: 'global' } } };
      const approved = { ...config, RECOVERY_MANIFEST_SHA256: await recoverySha256(JSON.stringify(manifest)) };
      expect(drillManifestProbes(manifest)).toEqual({ schema: 'ejm-chess-drill-probes-v1', d1: 'original', game: 'original', competition: 'original' });
      const undoBoundary: DrillManifest = { ...manifest, probeBoundary: { schema: 'ejm-chess-drill-probes-v1', d1: 'changed', game: 'changed', competition: 'changed' } };
      await expect(verifyDrillManifest(approved, undoBoundary)).rejects.toMatchObject({ code: 'DRILL_MANIFEST_UNAPPROVED' });
      await expect(verifyDrillManifest({ ...config, RECOVERY_MANIFEST_SHA256: await recoverySha256(JSON.stringify(undoBoundary)) }, undoBoundary)).resolves.toBeTruthy();
      const invalidBoundary = { ...undoBoundary, probeBoundary: { ...undoBoundary.probeBoundary!, schema: 'unknown' } } as unknown as DrillManifest;
      await expect(verifyDrillManifest({ ...config, RECOVERY_MANIFEST_SHA256: await recoverySha256(JSON.stringify(invalidBoundary)) }, invalidBoundary))
        .rejects.toMatchObject({ code: 'DRILL_MANIFEST_UNAPPROVED' });
      const restore = vi.fn(async () => 'test-native-undo');
      await expect(prepareDrillRestore(shim(ctx, { restore }), approved, 'Game', { ...manifest, scope: 'another-scope' })).rejects.toMatchObject({ code: 'DRILL_MANIFEST_UNAPPROVED' });
      const badTarget = { ...manifest, points: { ...manifest.points, game: { ...point, objectId: 'another-object' } } };
      await expect(prepareDrillRestore(shim(ctx, { restore }), { ...config, RECOVERY_MANIFEST_SHA256: await recoverySha256(JSON.stringify(badTarget)) }, 'Game', badTarget))
        .rejects.toMatchObject({ code: 'RECOVERY_TARGET_MISMATCH' });
      const badPolicy = { ...manifest, points: { ...manifest.points, game: { ...point, policies: { ...point.policies, rules: 'unknown-rules-policy' } } } };
      await expect(prepareDrillRestore(shim(ctx, { restore }), { ...config, RECOVERY_MANIFEST_SHA256: await recoverySha256(JSON.stringify(badPolicy)) }, 'Game', badPolicy))
        .rejects.toMatchObject({ code: 'RECOVERY_TARGET_MISMATCH' });
      const badSchema = { ...manifest, d1: { ...manifest.d1, schemaSha256: '0'.repeat(64) } };
      await expect(prepareDrillRestore(shim(ctx, { restore }), { ...config, RECOVERY_MANIFEST_SHA256: await recoverySha256(JSON.stringify(badSchema)) }, 'Game', badSchema))
        .rejects.toMatchObject({ code: 'RECOVERY_SCHEMA_MISMATCH' });
      ctx.storage.sql.exec("INSERT INTO connections(user_id,connection_id) VALUES('later-accepted-owner','later-accepted-connection')");
      await expect(prepareDrillRestore(shim(ctx, { restore }), approved, 'Game', manifest)).rejects.toMatchObject({ code: 'RECOVERY_LATER_WORK' });
      expect(restore).not.toHaveBeenCalled();
      ctx.storage.sql.exec("DELETE FROM connections WHERE user_id='later-accepted-owner'");
      expect(recognizedRecoveryPolicies(point.policies)).toBe(true);
      const priorPolicy = { ...manifest, points: { ...manifest.points, game: { ...point, policies: { ...point.policies, rules: PRIOR_RULES_VERSIONS[1] } } } };
      const priorRestore = vi.fn(async () => 'test-prior-native-undo');
      const priorReceipt = await prepareDrillRestore(shim(ctx, { restore: priorRestore }),
        { ...config, RECOVERY_MANIFEST_SHA256: await recoverySha256(JSON.stringify(priorPolicy)) }, 'Game', priorPolicy);
      expect(priorReceipt.authoritySha256).toBe(point.authority.sha256);
      expect(await fingerprintAuthority(ctx.storage)).toEqual(point.authority);
      expect(priorRestore).toHaveBeenCalledWith(point.bookmark);
      const failedDb = { prepare: (sql: string) => sql.startsWith('INSERT INTO recovery_drill_restores')
        ? { bind: () => ({ run: async () => { throw new Error('isolated audit store unavailable'); } }) }
        : config.DB.prepare(sql) } as D1Database;
      const failedCancellation = vi.fn(async (bookmark: string) => {
        if (bookmark === point.bookmark) return 'test-native-undo';
        throw new Error('native cancellation unavailable');
      });
      await expect(prepareDrillRestore(shim(ctx, { restore: failedCancellation }), { ...approved, DB: failedDb }, 'Game', manifest))
        .rejects.toMatchObject({ code: 'DRILL_RESTORE_UNCERTAIN', undoReceipt: { objectId: point.objectId,
          restoreBookmark: point.bookmark, undoBookmark: 'test-native-undo' } });
      expect(failedCancellation.mock.calls.map(call => call[0])).toEqual([point.bookmark, 'test-native-undo']);
      const receipt = await prepareDrillRestore(shim(ctx, { restore }), approved, 'Game', manifest);
      expect(receipt.undoBookmark).toBe('test-native-undo');
      expect(restore).toHaveBeenCalledWith(point.bookmark);
      const saved = await config.DB.prepare('SELECT receipt,armed FROM recovery_drill_restores WHERE object_id=?').bind(ctx.id.toString()).first<{ receipt: string; armed: number }>();
      expect(JSON.parse(saved!.receipt)).toEqual(receipt);
      expect(saved?.armed).toBe(1);
      const abort = vi.fn(() => { throw new Error('test native restart'); });
      await expect(restartDrillObject(shim(ctx, { abort }), approved, { manifestSha256: receipt.manifestSha256, undoBookmark: receipt.undoBookmark, privateReceiptSaved: false }))
        .rejects.toMatchObject({ code: 'DRILL_UNDO_REQUIRED' });
      expect(abort).not.toHaveBeenCalled();
      await expect(restartDrillObject(shim(ctx, { abort }), approved, { manifestSha256: receipt.manifestSha256, undoBookmark: receipt.undoBookmark, privateReceiptSaved: true })).rejects.toThrow('test native restart');
      expect(abort).toHaveBeenCalledOnce();
    });
  });
});

/** The single-page algorithm as it ran before capture paged. Recovery evidence already saved with this format must keep matching. */
async function singlePageFingerprint(storage: DurableObjectStorage): Promise<string> {
  const schema = storage.sql.exec<{ type: string; name: string; sql: string }>(
    "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND substr(name,1,4)<>'_cf_' AND substr(tbl_name,1,4)<>'_cf_' ORDER BY type,name LIMIT 513").toArray();
  const tables = schema.filter(row => row.type === 'table').sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const digests = [];
  for (const table of tables) {
    const rows = storage.sql.exec(`SELECT * FROM "${table.name}" ORDER BY rowid`).toArray().map(row => JSON.stringify(row));
    digests.push({ table: table.name, schema: table.sql, digest: await recoverySha256(`[${rows.join(',')}]`) });
  }
  return recoverySha256(JSON.stringify({ schema, tables: digests }));
}

function addRows(storage: DurableObjectStorage, count: number): void {
  storage.sql.exec('CREATE TABLE IF NOT EXISTS paging_fixture(id INTEGER PRIMARY KEY,value TEXT NOT NULL)');
  storage.sql.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?)
    INSERT INTO paging_fixture(value) SELECT 'row-'||i FROM n`, count);
}

async function scanPages(storage: DurableObjectStorage) {
  const pages = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const scan = await scanAuthority(storage, false, cursor);
    pages.push(scan);
    if (scan.done) return pages;
    cursor = scan.next;
  }
  throw new Error('paged scan did not finish');
}

const finalDigest = (pages: Awaited<ReturnType<typeof scanPages>>) => {
  const last = pages.at(-1)!;
  if (!last.done) throw new Error('scan incomplete');
  return last.authority;
};

describe('paged authority capture', () => {
  it('hashes an authority that fits one page exactly as the single-page format did', async () => {
    const { game, white, snapshot } = await activeGame();
    await game.command(white, { id: crypto.randomUUID(), type: 'move', from: 'e2', to: 'e4', expectedVersion: snapshot.version });
    await runInDurableObject(game, async (_instance, ctx) => {
      const scan = await scanAuthority(ctx.storage);
      expect(scan.done).toBe(true);
      expect((await fingerprintAuthority(ctx.storage)).sha256).toBe(await singlePageFingerprint(ctx.storage));
    });
  });

  it('pages rows past one page, hashes every row and notices a change on any page', async () => {
    const { game } = await activeGame();
    await runInDurableObject(game, async (_instance, ctx) => {
      const extra = RECOVERY_SCAN_LIMIT.rows * 2 + 100;
      addRows(ctx.storage, extra);
      const pages = await scanPages(ctx.storage);
      expect(pages).toHaveLength(3);
      const incomplete = pages.slice(0, -1);
      expect(incomplete.every(page => !page.done && page.rows <= RECOVERY_SCAN_LIMIT.rows * (incomplete.indexOf(page) + 1))).toBe(true);
      const authority = finalDigest(pages);
      const stored = ctx.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").toArray();
      const total = stored.reduce((sum, table) => sum + ctx.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM "${table.name}"`).one().n, 0);
      expect(authority.rows).toBe(total);
      expect(finalDigest(await scanPages(ctx.storage))).toEqual(authority);
      for (const row of [1, extra]) {
        ctx.storage.sql.exec('UPDATE paging_fixture SET value=? WHERE id=?', 'changed', row);
        expect(finalDigest(await scanPages(ctx.storage)).sha256, `row ${row}`).not.toBe(authority.sha256);
        ctx.storage.sql.exec('UPDATE paging_fixture SET value=? WHERE id=?', `row-${row}`, row);
        expect(finalDigest(await scanPages(ctx.storage))).toEqual(authority);
      }
      await expect(fingerprintAuthority(ctx.storage)).rejects.toMatchObject({ code: 'RECOVERY_CAPTURE_LIMIT', message: expect.stringContaining('Only the Competition capture pages') });
    });
  });

  it('splits a page by bytes and rejects only a row larger than a whole page', async () => {
    const { game } = await activeGame();
    await runInDurableObject(game, async (_instance, ctx) => {
      ctx.storage.sql.exec('CREATE TABLE paging_fixture(value TEXT NOT NULL)');
      const large = 'x'.repeat(900_000);
      for (let row = 0; row < 3; row++) ctx.storage.sql.exec('INSERT INTO paging_fixture(value) VALUES(?)', large);
      const pages = await scanPages(ctx.storage);
      expect(pages).toHaveLength(2);
      expect(finalDigest(pages).bytes).toBeGreaterThan(2_700_000);
      ctx.storage.sql.exec('INSERT INTO paging_fixture(value) VALUES(?)', 'x'.repeat(RECOVERY_SCAN_LIMIT.bytes));
      await expect(scanPages(ctx.storage)).rejects.toMatchObject({ code: 'RECOVERY_CAPTURE_LIMIT' });
    });
  });

  it('rejects a forged or stale cursor instead of hashing from a wrong position', async () => {
    const { game } = await activeGame();
    await runInDurableObject(game, async (_instance, ctx) => {
      addRows(ctx.storage, RECOVERY_SCAN_LIMIT.rows + 1);
      const first = await scanAuthority(ctx.storage);
      if (first.done) throw new Error('fixture fits one page');
      const decoded = JSON.parse(atob(first.next.replaceAll('-', '+').replaceAll('_', '/')));
      const forge = (change: object) => btoa(JSON.stringify({ ...decoded, ...change })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
      for (const token of ['not a cursor', forge({ table: 9999 }), forge({ digests: [] }), forge({ chain: 'abc' }), forge({ after: 1.5 }), forge({ rows: -1 })]) {
        await expect(scanAuthority(ctx.storage, false, token), token.slice(0, 20)).rejects.toMatchObject({ code: 'INVALID_RECOVERY_CURSOR' });
      }
      await expect(scanAuthority(ctx.storage, false, forge({ schema: '0'.repeat(64) }))).rejects.toMatchObject({ code: 'RECOVERY_SCAN_STALE' });
      ctx.storage.sql.exec('CREATE TABLE added_after_first_page(value TEXT)');
      await expect(scanAuthority(ctx.storage, false, first.next)).rejects.toMatchObject({ code: 'RECOVERY_SCAN_STALE' });
    });
  });

  it('reads the bookmark and metadata only with the last page and fails closed where paging is not offered', async () => {
    const { game, snapshot } = await activeGame();
    await runInDurableObject(game, async (_instance, ctx) => {
      addRows(ctx.storage, RECOVERY_SCAN_LIMIT.rows + 1);
      const bookmark = vi.fn(async () => 'test-native-bookmark');
      const inspect = vi.fn(() => ({ status: 'active' }));
      const input = { kind: 'Game' as const, name: snapshot.id, policies: { rules: RULES_VERSION, ratings: RATING_VERSION } };
      await expect(captureNativePoint(shim(ctx, { bookmark }), input, inspect)).rejects.toMatchObject({ code: 'RECOVERY_CAPTURE_LIMIT' });
      const first = await captureNativePoint(shim(ctx, { bookmark }), input, inspect, false, {});
      expect(first.authority).toMatchObject({ sha256: '', next: expect.any(String) });
      expect(first).toMatchObject({ bookmark: '', metadata: {} });
      expect(bookmark).not.toHaveBeenCalled();
      expect(inspect).not.toHaveBeenCalled();
      expect(recoveryCaptureBody(first)).toEqual({ schema: first.schema, complete: false, cursor: first.authority.next, scanned: { rows: first.authority.rows, bytes: first.authority.bytes } });
      const last = await captureNativePoint(shim(ctx, { bookmark }), input, inspect, false, { cursor: first.authority.next });
      expect(last).toMatchObject({ bookmark: 'test-native-bookmark', metadata: { status: 'active' } });
      expect(last.authority.next).toBeUndefined();
      expect(last.authority.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(recoveryCaptureBody(last)).toBe(last);
    });
  });
});

describe('owner capture routes page a large Competition and say when a Game cannot', () => {
  let admin: Awaited<ReturnType<typeof ownerFixture>>;
  beforeAll(async () => { admin = await ownerFixture(); });

  it('returns a cursor for each page, then the complete private envelope', async () => {
    const competition = env.COMPETITION.get(env.COMPETITION.idFromName('global'));
    await runInDurableObject(competition, (_instance, ctx) => addRows(ctx.storage, RECOVERY_SCAN_LIMIT.rows * 2));
    try {
      let response = await admin('/api/admin/operations/recovery/competition', {});
      let pages = 1;
      let body = await response.json() as { complete?: boolean; cursor?: string; scanned?: { rows: number }; bookmark?: string; authority?: { sha256: string; next?: string } };
      expect(response.status).toBe(200);
      expect(body).toMatchObject({ complete: false, scanned: { rows: expect.any(Number) } });
      expect(body).not.toHaveProperty('bookmark');
      while (body.complete === false) {
        response = await admin('/api/admin/operations/recovery/competition', { cursor: body.cursor });
        expect(response.status).toBe(200);
        body = await response.json();
        pages++;
      }
      expect(pages).toBe(3);
      expect(body.bookmark).toBeTruthy();
      expect(body.authority?.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(body.authority).not.toHaveProperty('next');
      const forged = await admin('/api/admin/operations/recovery/competition', { cursor: 'forged' });
      expect(forged.status).toBe(400);
      expect(await forged.json()).toMatchObject({ error: 'INVALID_RECOVERY_CURSOR' });
      expect((await admin('/api/admin/operations/recovery/competition', { cursor: 7 })).status).toBe(400);
    } finally { await runInDurableObject(competition, (_instance, ctx) => { ctx.storage.sql.exec('DROP TABLE IF EXISTS paging_fixture'); }); }
  });

  it('keeps a small Competition and a Game one request, and names the limit for a Game beyond one page', async () => {
    const small = await admin('/api/admin/operations/recovery/competition', {});
    expect(small.status).toBe(200);
    expect(await small.json()).toMatchObject({ kind: 'Competition', authority: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    const { game, snapshot } = await activeGame();
    const captured = await admin(`/api/admin/operations/recovery/games/${snapshot.id}`, {});
    expect(captured.status).toBe(200);
    expect(await captured.json()).toMatchObject({ kind: 'Game', name: snapshot.id });
    await runInDurableObject(game, (_instance, ctx) => addRows(ctx.storage, RECOVERY_SCAN_LIMIT.rows + 1));
    const refused = await admin(`/api/admin/operations/recovery/games/${snapshot.id}`, {});
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'RECOVERY_CAPTURE_LIMIT', message: expect.stringContaining('Only the Competition capture pages') });
  });
});
