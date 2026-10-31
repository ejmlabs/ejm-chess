import type { Env } from './env';
import { knownGame } from './auth';
import { isGameId } from '../shared/gamePath';
import { ApiError } from './security';
import { PRIOR_RULES_VERSIONS, RULES_VERSION, RATING_VERSION } from '../shared/protocol';

export const RECOVERY_SCHEMA = 'ejm-chess-native-recovery-v1';
/** Tables and schema entries are whole-object limits. Rows and bytes bound one page of a paged capture. */
export const RECOVERY_SCAN_LIMIT = { tables: 128, rows: 4096, bytes: 2_097_152 } as const;
export type RecoveryKind = 'Game' | 'Competition';
export interface RecoveryPoint {
  schema: typeof RECOVERY_SCHEMA;
  kind: RecoveryKind;
  objectId: string;
  name: string;
  bookmark: string;
  capturedAt: number;
  alarm: number | null;
  policies: { rules: string; ratings: string };
  /** `next` is set only while a paged capture is incomplete. Such a point has no bookmark or digest and is never a recovery point. */
  authority: { sha256: string; rows: number; bytes: number; next?: string };
  metadata: {
    status?: string; version?: number | null; rules?: string; deadline?: number | null; readinessDeadline?: number | null;
    moves?: number; receipts?: number; latestReceiptAt?: number | null; pendingDelivery?: boolean; archived?: boolean;
    watermarks?: Record<string, number>; publishedEpochs?: Record<string, number>; matches?: Array<{ status: string; count: number }>;
    pending?: Record<string, number>; repairInProgress?: boolean;
  };
}

/** Recognition is additive. The stored policy and authority hash remain exact. */
export function recognizedRecoveryPolicies(policies: RecoveryPoint['policies'] | undefined): boolean {
  return Boolean(policies && [RULES_VERSION, PRIOR_RULES_VERSIONS[1]].includes(policies.rules) && policies.ratings === RATING_VERSION);
}

export async function recoverySha256(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

const HEX = /^[0-9a-f]{64}$/;
const onePageOnly = () => new ApiError(409, 'RECOVERY_CAPTURE_LIMIT',
  'The authority exceeds one capture page. Only the Competition capture pages; a Game or drill object must fit one page. Keep admission closed and review a larger recovery plan.');
const invalidCursor = () => new ApiError(400, 'INVALID_RECOVERY_CURSOR', 'Send the cursor from the previous capture page, or an empty object to start.');

/** Where one page stopped. The digests are enough to resume, so no scan state lives in the object. */
interface ScanCursor { schema: string; table: number; after: number | null; chain: string | null; digests: string[]; rows: number; bytes: number }
export type AuthorityScan =
  | { done: true; authority: { sha256: string; rows: number; bytes: number } }
  | { done: false; next: string; rows: number; bytes: number };

function encodeCursor(cursor: ScanCursor): string {
  return btoa(JSON.stringify(cursor)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function decodeCursor(token: string, schema: string, tables: number): ScanCursor {
  let value: Partial<ScanCursor>;
  try { value = JSON.parse(atob(token.replaceAll('-', '+').replaceAll('_', '/'))); } catch { throw invalidCursor(); }
  const count = (item: unknown) => Number.isSafeInteger(item) && (item as number) >= 0;
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 7 || typeof value.schema !== 'string' || !HEX.test(value.schema)
    || !count(value.table) || value.table! >= tables || (value.after !== null && !Number.isSafeInteger(value.after))
    || (value.chain !== null && !HEX.test(String(value.chain))) || !Array.isArray(value.digests) || value.digests.length !== value.table
    || !value.digests.every(digest => typeof digest === 'string' && HEX.test(digest)) || !count(value.rows) || !count(value.bytes)) throw invalidCursor();
  if (value.schema !== schema) throw new ApiError(409, 'RECOVERY_SCAN_STALE', 'The authority schema changed during capture. Start again without a cursor.');
  return value as ScanCursor;
}

/**
 * Hash private rows in bounded pages. Raw rows never leave this object. An authority that fits one page
 * hashes each table's rows exactly as before. A table split across pages hashes as a chain of its page
 * digests. Pages read at different times, so a paged result is exact only while no row changes.
 */
export async function scanAuthority(storage: DurableObjectStorage, omitDrillProbe = false, token?: string): Promise<AuthorityScan> {
  const schema = storage.sql.exec<{ type: string; name: string; tbl_name: string; sql: string }>(
    "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND substr(name,1,4)<>'_cf_' AND substr(tbl_name,1,4)<>'_cf_' ORDER BY type,name LIMIT 513")
    .toArray().filter(row => !omitDrillProbe || row.tbl_name !== 'recovery_drill_probe');
  if (schema.length > 512) throw new ApiError(409, 'RECOVERY_CAPTURE_LIMIT', 'The authority exceeds the bounded capture schema limit.');
  const tables = schema.filter(row => row.type === 'table').sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  if (tables.length > RECOVERY_SCAN_LIMIT.tables) throw new ApiError(409, 'RECOVERY_CAPTURE_LIMIT', 'The authority exceeds the bounded capture schema limit.');
  const schemaJson = JSON.stringify(schema);
  const schemaBytes = new TextEncoder().encode(schemaJson).byteLength;
  if (schemaBytes > RECOVERY_SCAN_LIMIT.bytes) throw new ApiError(409, 'RECOVERY_CAPTURE_LIMIT', 'The authority exceeds the bounded capture schema limit.');
  const schemaDigest = await recoverySha256(schemaJson);
  const resumed = token === undefined ? null : decodeCursor(token, schemaDigest, tables.length);
  const digests = resumed ? [...resumed.digests] : [];
  let chain = resumed?.chain ?? null;
  let after = resumed?.after ?? null;
  let pageRows = 0;
  let pageBytes = schemaBytes;
  const pause = (): AuthorityScan => {
    const rows = (resumed?.rows ?? 0) + pageRows;
    const rowBytes = (resumed?.bytes ?? 0) + pageBytes - schemaBytes;
    return { done: false, rows, bytes: schemaBytes + rowBytes,
      next: encodeCursor({ schema: schemaDigest, table: digests.length, after, chain, digests, rows, bytes: rowBytes }) };
  };
  for (let index = digests.length; index < tables.length; index++) {
    const table = tables[index];
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table.name)) throw new ApiError(409, 'RECOVERY_SCHEMA_UNKNOWN', 'The authority schema needs a reviewed recovery plan.');
    if (pageRows >= RECOVERY_SCAN_LIMIT.rows || pageBytes + 2 > RECOVERY_SCAN_LIMIT.bytes) return pause();
    // `__rowid` is the keyset cursor. It is dropped before hashing so the row text is the table's own columns.
    const records = storage.sql.exec<Record<string, SqlStorageValue>>(`SELECT *, rowid AS __rowid FROM "${table.name}" WHERE rowid>? ORDER BY rowid LIMIT ?`,
      after ?? Number.MIN_SAFE_INTEGER, RECOVERY_SCAN_LIMIT.rows - pageRows + 1);
    const encoded: string[] = [];
    let segmentBytes = 2;
    let last = after;
    let more = false;
    for (const { __rowid, ...record } of records) {
      const value = JSON.stringify(record, (_key, item) => {
        if (item instanceof ArrayBuffer) throw new ApiError(409, 'RECOVERY_SCHEMA_UNKNOWN', 'Binary authority rows need a reviewed recovery capture format.');
        return item;
      });
      const size = new TextEncoder().encode(value).byteLength + (encoded.length > 0 ? 1 : 0);
      if (pageRows + encoded.length >= RECOVERY_SCAN_LIMIT.rows || pageBytes + segmentBytes + size > RECOVERY_SCAN_LIMIT.bytes) { more = true; break; }
      segmentBytes += size;
      encoded.push(value);
      last = Number(__rowid);
    }
    if (more && encoded.length === 0) {
      // On an unused page this means one row is larger than a whole page.
      if (pageRows === 0) throw new ApiError(409, 'RECOVERY_CAPTURE_LIMIT', 'One authority row exceeds the bounded capture page.');
      return pause();
    }
    pageRows += encoded.length;
    pageBytes += segmentBytes;
    const part = await recoverySha256(`[${encoded.join(',')}]`);
    chain = chain === null ? part : await recoverySha256(chain + part);
    if (more) { after = last; return pause(); }
    digests.push(chain);
    chain = null;
    after = null;
  }
  const tableDigests = tables.map((table, index) => ({ table: table.name, schema: table.sql, digest: digests[index] }));
  return { done: true, authority: { sha256: await recoverySha256(JSON.stringify({ schema, tables: tableDigests })),
    rows: (resumed?.rows ?? 0) + pageRows, bytes: pageBytes + (resumed?.bytes ?? 0) } };
}

/** One barrier, one page. Only the Competition can page; a Game that outgrows one page fails closed. */
export async function fingerprintAuthority(storage: DurableObjectStorage, omitDrillProbe = false): Promise<RecoveryPoint['authority']> {
  const scan = await scanAuthority(storage, omitDrillProbe);
  if (!scan.done) throw onePageOnly();
  return scan.authority;
}

/**
 * Catch inside the barrier so a missing provider API does not reset a live object.
 * With `paging`, an authority larger than one page returns an incomplete point whose `authority.next`
 * resumes the scan; the bookmark and metadata are read only with the last page. Without it, that fails closed.
 */
export async function captureNativePoint(ctx: DurableObjectState, input: Pick<RecoveryPoint, 'kind' | 'name' | 'policies'>,
  inspect: () => RecoveryPoint['metadata'], omitDrillProbe = false, paging?: { cursor?: string }): Promise<RecoveryPoint> {
  const result = await ctx.blockConcurrencyWhile(async () => {
    try {
      await ctx.storage.sync();
      const scan = await scanAuthority(ctx.storage, omitDrillProbe, paging?.cursor);
      const base = { schema: RECOVERY_SCHEMA, ...input, objectId: ctx.id.toString() } as const;
      if (!scan.done) {
        if (!paging) throw onePageOnly();
        return { point: { ...base, bookmark: '', capturedAt: Date.now(), alarm: null, metadata: {},
          authority: { sha256: '', rows: scan.rows, bytes: scan.bytes, next: scan.next } } satisfies RecoveryPoint };
      }
      const metadata = inspect();
      const alarm = await ctx.storage.getAlarm();
      const bookmark = await ctx.storage.getCurrentBookmark();
      if (!bookmark || typeof bookmark !== 'string') throw new Error('native_bookmark_unavailable');
      return { point: { ...base, bookmark, capturedAt: Date.now(), alarm, authority: scan.authority, metadata } satisfies RecoveryPoint };
    } catch (error) {
      return { error: error instanceof ApiError ? error : new ApiError(503, 'RECOVERY_CAPTURE_UNAVAILABLE', 'Native recovery capture is unavailable. No recovery point was created.') };
    }
  });
  if (result.error) throw result.error;
  return result.point!;
}

/** An incomplete page returns only its cursor and progress, so it can never be mistaken for a recovery point. */
export function recoveryCaptureBody(point: RecoveryPoint) {
  const { next, rows, bytes } = point.authority;
  return next === undefined ? point : { schema: RECOVERY_SCHEMA, complete: false as const, cursor: next, scanned: { rows, bytes } };
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
