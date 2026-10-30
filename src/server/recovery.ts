import type { Env } from './env';
import { knownGame } from './auth';
import { isGameId } from '../shared/gamePath';
import { ApiError } from './security';
import { PRIOR_RULES_VERSIONS, RULES_VERSION, RATING_VERSION } from '../shared/protocol';
import { PROOF_RULES_VERSION } from './proof-contract';

export const RECOVERY_SCHEMA = 'ejm-chess-native-recovery-v1';
export const RECOVERY_SCAN_LIMIT = { tables: 128, rows: 4096, bytes: 2_097_152 } as const;
export type RecoveryKind = 'Game' | 'Competition';
export type RecoveryAuthorityKind = RecoveryKind | 'TimeoutProver';
export interface RecoveryPoint {
  schema: typeof RECOVERY_SCHEMA;
  kind: RecoveryAuthorityKind;
  objectId: string;
  name: string;
  bookmark: string;
  capturedAt: number;
  alarm: number | null;
  policies: { rules: string; ratings: string };
  authority: { sha256: string; rows: number; bytes: number };
  metadata: {
    status?: string; version?: number | null; rules?: string; deadline?: number | null; readinessDeadline?: number | null;
    moves?: number; receipts?: number; latestReceiptAt?: number | null; pendingDelivery?: boolean; archived?: boolean;
    watermarks?: Record<string, number>; publishedEpochs?: Record<string, number>; matches?: Array<{ status: string; count: number }>;
    pending?: Record<string, number>; repairInProgress?: boolean;
    timeoutProof?: { profileVersion: string; pendingVersion?: number; attempt?: number; done?: boolean };
    proofReservations?: { profileVersion: string; reserved: number; retained: number };
    proofLifecycle?: { profileVersion: string; generation: number; attempts: number; stopDebt: boolean; pendingStops: number };
  };
}

/** Recognition is additive. The stored policy and authority hash remain exact. */
export function recognizedRecoveryPolicies(policies: RecoveryPoint['policies'] | undefined): boolean {
  return Boolean(policies && [RULES_VERSION, PRIOR_RULES_VERSIONS[1], PROOF_RULES_VERSION].includes(policies.rules) && policies.ratings === RATING_VERSION);
}

export async function recoverySha256(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Hash private rows in bounded batches. Raw rows never leave this object. */
export async function fingerprintAuthority(storage: DurableObjectStorage, omitDrillProbe = false): Promise<RecoveryPoint['authority']> {
  const schema = storage.sql.exec<{ type: string; name: string; tbl_name: string; sql: string }>(
    "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND substr(name,1,4)<>'_cf_' AND substr(tbl_name,1,4)<>'_cf_' ORDER BY type,name LIMIT 513")
    .toArray().filter(row => !omitDrillProbe || row.tbl_name !== 'recovery_drill_probe');
  if (schema.length > 512) throw new ApiError(409, 'RECOVERY_CAPTURE_LIMIT', 'The authority exceeds the bounded capture schema limit.');
  const tables = schema.filter(row => row.type === 'table').sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  if (tables.length > RECOVERY_SCAN_LIMIT.tables) throw new ApiError(409, 'RECOVERY_CAPTURE_LIMIT', 'The authority exceeds the bounded capture schema limit.');
  let rows = 0;
  let bytes = new TextEncoder().encode(JSON.stringify(schema)).byteLength;
  if (bytes > RECOVERY_SCAN_LIMIT.bytes) throw new ApiError(409, 'RECOVERY_CAPTURE_LIMIT', 'The authority exceeds the bounded capture schema limit.');
  const digests: Array<{ table: string; schema: string; digest: string }> = [];
  for (const table of tables) {
    if (omitDrillProbe && table.name === 'recovery_drill_probe') continue;
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table.name)) throw new ApiError(409, 'RECOVERY_SCHEMA_UNKNOWN', 'The authority schema needs a reviewed recovery plan.');
    const records = storage.sql.exec<Record<string, SqlStorageValue>>(`SELECT * FROM "${table.name}" ORDER BY rowid LIMIT ?`, RECOVERY_SCAN_LIMIT.rows - rows + 1);
    const encoded: string[] = [];
    bytes += 2;
    for (const record of records) {
      const value = JSON.stringify(record, (_key, item) => {
        if (item instanceof ArrayBuffer) throw new ApiError(409, 'RECOVERY_SCHEMA_UNKNOWN', 'Binary authority rows need a reviewed recovery capture format.');
        return item;
      });
      rows++;
      bytes += new TextEncoder().encode(value).byteLength + (encoded.length > 0 ? 1 : 0);
      if (rows > RECOVERY_SCAN_LIMIT.rows || bytes > RECOVERY_SCAN_LIMIT.bytes) {
        throw new ApiError(409, 'RECOVERY_CAPTURE_LIMIT', 'The authority exceeds the bounded capture limit. Keep admission closed and review a larger recovery plan.');
      }
      encoded.push(value);
    }
    if (bytes > RECOVERY_SCAN_LIMIT.bytes) throw new ApiError(409, 'RECOVERY_CAPTURE_LIMIT', 'The authority exceeds the bounded capture limit.');
    digests.push({ table: table.name, schema: table.sql, digest: await recoverySha256(`[${encoded.join(',')}]`) });
  }
  return { sha256: await recoverySha256(JSON.stringify({ schema, tables: digests })), rows, bytes };
}

/** Catch inside the barrier so a missing provider API does not reset a live object. */
export async function captureNativePoint(ctx: DurableObjectState, input: Pick<RecoveryPoint, 'kind' | 'name' | 'policies'>,
  inspect: () => RecoveryPoint['metadata'], omitDrillProbe = false): Promise<RecoveryPoint> {
  const result = await ctx.blockConcurrencyWhile(async () => {
    try {
      await ctx.storage.sync();
      const metadata = inspect();
      const authority = await fingerprintAuthority(ctx.storage, omitDrillProbe);
      const alarm = await ctx.storage.getAlarm();
      const bookmark = await ctx.storage.getCurrentBookmark();
      if (!bookmark || typeof bookmark !== 'string') throw new Error('native_bookmark_unavailable');
      return { point: { schema: RECOVERY_SCHEMA, ...input, objectId: ctx.id.toString(), bookmark,
        capturedAt: Date.now(), alarm, authority, metadata } satisfies RecoveryPoint };
    } catch (error) {
      return { error: error instanceof ApiError ? error : new ApiError(503, 'RECOVERY_CAPTURE_UNAVAILABLE', 'Native recovery capture is unavailable. No recovery point was created.') };
    }
  });
  if (result.error) throw result.error;
  return result.point!;
}

export async function admittedRecoveryGame(env: Pick<Env, 'DB' | 'COMPETITION'>, id: string): Promise<boolean> {
  if (!isGameId(id)) return false;
  return await knownGame(env, id) || await env.COMPETITION.get(env.COMPETITION.idFromName('global')).hasRecoveryGameId(id);
}

/** Keyset pages merge bounded source pages, including pre-projection ranked matches. */
export async function recoveryInventory(env: Pick<Env, 'DB' | 'COMPETITION'>, after = '', limit = 50) {
  if ((after !== '' && !isGameId(after)) || !Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new ApiError(400, 'INVALID_RECOVERY_CURSOR', 'Use the prior recovery page cursor and a limit from 1 to 50.');
  }
  const sources = [
    ['casual_game_admissions', 'game_id'], ['tournament_game_admissions', 'game_id'],
    ['active_game_seats', 'game_id'], ['games', 'id'],
  ] as const;
  const pages = await Promise.all(sources.map(async ([table, column]) => {
    const page = await env.DB.prepare(`SELECT DISTINCT ${column} AS id FROM ${table} WHERE ${column}>? ORDER BY ${column} LIMIT ?`)
      .bind(after, limit + 1).all<{ id: string }>();
    return page.results.map(row => row.id);
  }));
  pages.push(await env.COMPETITION.get(env.COMPETITION.idFromName('global')).recoveryGameIds(after, limit + 1));
  const ids = [...new Set(pages.flat())].sort().slice(0, limit + 1);
  return { schema: RECOVERY_SCHEMA, ids: ids.slice(0, limit), nextCursor: ids.length > limit ? ids[limit - 1] : null,
    consistency: 'non-atomic-inventory' as const };
}
