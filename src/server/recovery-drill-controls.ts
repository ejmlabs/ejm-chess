import type { Env } from './env';
import { ApiError } from './security';
import { isProductionResource } from './production-resources';
import { fingerprintAuthority, RECOVERY_SCHEMA, recoverySha256, recognizedRecoveryPolicies, type RecoveryKind, type RecoveryPoint } from './recovery';

export const DRILL_SCHEMA = 'ejm-chess-recovery-drill-v1';
export const DRILL_WORKER = 'ejm-chess-recovery-drill';
export interface DrillProbes {
  schema: 'ejm-chess-drill-probes-v1';
  d1: 'original' | 'changed';
  game: 'original' | 'changed';
  competition: 'original' | 'changed';
}
export interface DrillEnv extends Env {
  RECOVERY_DRILL_TOKEN: string;
  RECOVERY_DRILL_SCOPE: string;
  RECOVERY_DATABASE_ID: string;
  RECOVERY_GAME_NAMESPACE_ID: string;
  RECOVERY_COMPETITION_NAMESPACE_ID: string;
  RECOVERY_SOURCE_REVISION: string;
  RECOVERY_MANIFEST_SHA256?: string;
}
export interface DrillManifest {
  schema: typeof DRILL_SCHEMA;
  scope: string;
  sourceRevision: string;
  resources: { worker: typeof DRILL_WORKER; databaseId: string; gameNamespaceId: string; competitionNamespaceId: string };
  d1: { bookmark: string; schemaSha256: string };
  points: { game: RecoveryPoint; competition: RecoveryPoint };
  /** Absent only in historical v1 manifests, whose expected values were original. */
  probeBoundary?: DrillProbes;
}
export interface RestoreReceipt {
  schema: typeof DRILL_SCHEMA;
  scope: string;
  kind: RecoveryKind;
  objectId: string;
  manifestSha256: string;
  restoreBookmark: string;
  undoBookmark: string;
  authoritySha256: string;
  alarm: number | null;
  preparedAt: number;
}

export class UncertainDrillRestore extends ApiError {
  constructor(public undoReceipt: RestoreReceipt) {
    super(503, 'DRILL_RESTORE_UNCERTAIN', 'Restore preparation failed and cancellation is uncertain. Preserve the private undo receipt and stop the drill.');
  }
}

export function assertDrillConfiguration(env: DrillEnv): void {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const namespace = /^[0-9a-f]{32}$/;
  if (!/^ejm-chess-recovery-drill-[a-z0-9-]{1,48}$/.test(env.RECOVERY_DRILL_SCOPE ?? '')
    || !uuid.test(env.RECOVERY_DATABASE_ID ?? '') || isProductionResource(env, env.RECOVERY_DATABASE_ID)
    || env.RECOVERY_DATABASE_ID === '00000000-0000-0000-0000-000000000000'
    || !namespace.test(env.RECOVERY_GAME_NAMESPACE_ID ?? '') || !namespace.test(env.RECOVERY_COMPETITION_NAMESPACE_ID ?? '')
    || env.RECOVERY_GAME_NAMESPACE_ID === env.RECOVERY_COMPETITION_NAMESPACE_ID
    || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(env.RECOVERY_SOURCE_REVISION ?? '')
    || env.NEW_WORK_STOPPED !== 'true' || env.RANKED_ENABLED !== 'false'
    || env.TOURNAMENTS_ENABLED !== 'false' || env.ARENAS_ENABLED !== 'false' || env.ANALYSIS_ENABLED !== 'false'
    || (env.TIMEOUT_PROOF_PROFILE !== undefined && env.TIMEOUT_PROOF_PROFILE !== 'off')
    || (env.MONTHLY_PROOF_LIMIT !== undefined && env.MONTHLY_PROOF_LIMIT !== '0')
    || env.EMAIL || env.ANALYSIS_QUEUE || env.ANALYZER || env.PROVER) {
    throw new ApiError(409, 'DRILL_TARGET_UNVERIFIED', 'Configure and review fresh isolated recovery resources before using this drill.');
  }
}

export function drillResources(env: DrillEnv): DrillManifest['resources'] {
  return { worker: DRILL_WORKER, databaseId: env.RECOVERY_DATABASE_ID,
    gameNamespaceId: env.RECOVERY_GAME_NAMESPACE_ID, competitionNamespaceId: env.RECOVERY_COMPETITION_NAMESPACE_ID };
}

export async function drillD1Schema(db: D1Database): Promise<string> {
  const schema = await db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  return recoverySha256(JSON.stringify(schema.results));
}

export async function drillRestoreArmed(db: D1Database): Promise<boolean> {
  return Boolean(await db.prepare('SELECT 1 FROM recovery_drill_restores WHERE armed=1 LIMIT 1').first());
}

export function drillManifestProbes(manifest: DrillManifest): DrillProbes {
  const value = manifest.probeBoundary;
  if (value === undefined) return { schema: 'ejm-chess-drill-probes-v1', d1: 'original', game: 'original', competition: 'original' };
  if (!value || value.schema !== 'ejm-chess-drill-probes-v1'
    || Object.keys(value).length !== 4 || !['original', 'changed'].includes(value.d1)
    || !['original', 'changed'].includes(value.game) || !['original', 'changed'].includes(value.competition)) {
    throw new ApiError(409, 'DRILL_MANIFEST_UNAPPROVED', 'Use a reviewed versioned boundary for all three isolated probes.');
  }
  return value;
}

export async function verifyDrillManifest(env: DrillEnv, manifest: DrillManifest): Promise<string> {
  assertDrillConfiguration(env);
  const hash = await recoverySha256(JSON.stringify(manifest));
  if (!/^[0-9a-f]{64}$/.test(env.RECOVERY_MANIFEST_SHA256 ?? '') || hash !== env.RECOVERY_MANIFEST_SHA256
    || manifest?.schema !== DRILL_SCHEMA || manifest.scope !== env.RECOVERY_DRILL_SCOPE
    || manifest.sourceRevision !== env.RECOVERY_SOURCE_REVISION || JSON.stringify(manifest.resources) !== JSON.stringify(drillResources(env))
    || !manifest.d1 || typeof manifest.d1.bookmark !== 'string' || !manifest.d1.bookmark || manifest.d1.bookmark.length > 256
    || !/^[0-9a-f]{64}$/.test(manifest.d1.schemaSha256)) {
    throw new ApiError(409, 'DRILL_MANIFEST_UNAPPROVED', 'Use the exact reviewed manifest for these isolated resources and source.');
  }
  if (await drillD1Schema(env.DB) !== manifest.d1.schemaSha256) {
    throw new ApiError(409, 'RECOVERY_SCHEMA_MISMATCH', 'The isolated D1 schema changed after capture. Review a new recovery manifest.');
  }
  drillManifestProbes(manifest);
  return hash;
}

/** Only isolated subclasses call this. The production Worker never imports this module. */
export async function prepareDrillRestore(ctx: DurableObjectState, env: DrillEnv, kind: RecoveryKind,
  manifest: DrillManifest): Promise<RestoreReceipt> {
  const digest = await verifyDrillManifest(env, manifest);
  const point = kind === 'Game' ? manifest.points?.game : manifest.points?.competition;
  const expectedId = kind === 'Game' ? env.GAME.idFromName(point?.name ?? '') : env.COMPETITION.idFromName('global');
  if (!point || point.schema !== RECOVERY_SCHEMA || point.kind !== kind || point.objectId !== ctx.id.toString()
    || !expectedId.equals(ctx.id) || (kind === 'Competition' && point.name !== 'global')
    || !recognizedRecoveryPolicies(point.policies)
    || typeof point.bookmark !== 'string' || !point.bookmark || point.bookmark.length > 256) {
    throw new ApiError(409, 'RECOVERY_TARGET_MISMATCH', 'The recovery point does not identify this authority and policy.');
  }
  const result = await ctx.blockConcurrencyWhile(async () => {
    let undo: string | null = null;
    let privateReceipt: RestoreReceipt | null = null;
    try {
      await ctx.storage.sync();
      const current = await fingerprintAuthority(ctx.storage, true);
      const alarm = await ctx.storage.getAlarm();
      if (current.sha256 !== point.authority?.sha256 || alarm !== point.alarm) {
        throw new ApiError(409, 'RECOVERY_LATER_WORK', 'Authority state or its deadline changed after capture. Preserve current state and reject this rollback.');
      }
      undo = await ctx.storage.onNextSessionRestoreBookmark(point.bookmark);
      if (!undo || typeof undo !== 'string') throw new Error('native_undo_unavailable');
      const receipt: RestoreReceipt = { schema: DRILL_SCHEMA, scope: env.RECOVERY_DRILL_SCOPE, kind, objectId: point.objectId,
        manifestSha256: digest, restoreBookmark: point.bookmark, undoBookmark: undo, authoritySha256: point.authority.sha256,
        alarm: point.alarm, preparedAt: Date.now() };
      privateReceipt = receipt;
      // This independent store and the private response preserve undo before restart.
      // The caller must also save the response outside every rollback target.
      await env.DB.prepare(`INSERT INTO recovery_drill_restores(object_id,manifest_digest,receipt,armed) VALUES(?,?,?,1)
        ON CONFLICT(object_id) DO UPDATE SET manifest_digest=excluded.manifest_digest,receipt=excluded.receipt,armed=1`)
        .bind(point.objectId, digest, JSON.stringify(receipt)).run();
      return { receipt };
    } catch (error) {
      if (undo) {
        try { await ctx.storage.onNextSessionRestoreBookmark(undo); }
        catch { return { error: new UncertainDrillRestore(privateReceipt!) }; }
      }
      return { error: error instanceof ApiError ? error : new ApiError(503, 'DRILL_RESTORE_UNAVAILABLE', 'Native restore preparation failed. No verified restore was completed.') };
    }
  });
  if (result.error) throw result.error;
  return result.receipt!;
}

export async function restartDrillObject(ctx: DurableObjectState, env: DrillEnv, input: { manifestSha256: string; undoBookmark: string; privateReceiptSaved: boolean }): Promise<never> {
  assertDrillConfiguration(env);
  const row = await env.DB.prepare('SELECT receipt FROM recovery_drill_restores WHERE object_id=? AND manifest_digest=?')
    .bind(ctx.id.toString(), input.manifestSha256).first<{ receipt: string }>();
  const receipt = row ? JSON.parse(row.receipt) as RestoreReceipt : null;
  if (!input.privateReceiptSaved || input.manifestSha256 !== env.RECOVERY_MANIFEST_SHA256
    || receipt?.scope !== env.RECOVERY_DRILL_SCOPE || receipt.undoBookmark !== input.undoBookmark) {
    throw new ApiError(409, 'DRILL_UNDO_REQUIRED', 'Save the matching private undo receipt before restarting this isolated object.');
  }
  const changed = await ctx.blockConcurrencyWhile(async () => {
    try {
      const actual = await fingerprintAuthority(ctx.storage, true);
      return actual.sha256 !== receipt.authoritySha256 || await ctx.storage.getAlarm() !== receipt.alarm;
    } catch { return true; }
  });
  if (changed) throw new ApiError(409, 'RECOVERY_LATER_WORK', 'Authority state or its alarm changed after preparation. Preserve current state and reject this restart.');
  ctx.abort('Approved isolated recovery drill restart', { retryAlarm: false });
  throw new Error('native_restart_unavailable');
}
