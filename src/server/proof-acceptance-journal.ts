import manifest from '../../proof/acceptance-manifest.json';
import { proofHash } from './proof-contract';

/** Control intents only. This journal cannot run a scenario or start a Container. */
export const PROOF_ACCEPTANCE_SCHEMA = manifest.schema;
export const PROOF_ACCEPTANCE_SCOPE = manifest.scope;
export const PROOF_ACCEPTANCE_LIMITS = Object.freeze({ ...manifest.limits });
const commands = new Set(manifest.commands);
const faults = new Map(manifest.faults.map(fault => [fault.id, Object.freeze({ ...fault })]));
const maximumFaultReceipts = manifest.faults.reduce((total, fault) => total + fault.maximum, 0);
let digest: Promise<string> | undefined;
// The seal names this digest. Exclude that seal to avoid a self-referential hash.
export function proofAcceptanceManifestDigest(): Promise<string> {
  return digest ??= proofHash([{ ...manifest, sealedRuntimeIdentity: null }]);
}

export interface ProofAcceptanceReviewDigests {
  costReviewSha256: string;
  sourcePermitReviewSha256: string;
  ownerResidualCostAcceptanceSha256: string;
}

export interface ProofAcceptanceIdentity extends ProofAcceptanceReviewDigests {
  scope: string;
  manifestDigest: string;
  sourceDigest: string;
  accountId: string;
  controlNamespaceId: string;
  databaseId: string;
  gameNamespaceId: string;
  competitionNamespaceId: string;
  liteProverNamespaceId: string;
  basicProverNamespaceId: string;
  privateCaller: string;
  expiresAt: number;
}

const identityFields: (keyof ProofAcceptanceIdentity)[] = ['scope', 'manifestDigest', 'sourceDigest',
  'costReviewSha256', 'sourcePermitReviewSha256', 'ownerResidualCostAcceptanceSha256', 'accountId',
  'controlNamespaceId', 'databaseId', 'gameNamespaceId', 'competitionNamespaceId', 'liteProverNamespaceId',
  'basicProverNamespaceId', 'privateCaller', 'expiresAt'];
const namespaceFields = ['controlNamespaceId', 'gameNamespaceId', 'competitionNamespaceId',
  'liteProverNamespaceId', 'basicProverNamespaceId'] as const;
const sha256 = /^[a-f0-9]{64}$/;
const reviewSha256 = /^(?!0{64}$)[a-f0-9]{64}$/;

function reviewDigest(value: { status: string; sha256: unknown } | null | undefined, status: string): string | null {
  return value?.status === status && typeof value.sha256 === 'string' && reviewSha256.test(value.sha256)
    ? value.sha256 : null;
}

/** Three prerequisite reviews gate the finite measurement run. */
export function proofAcceptanceReviewDigests(): ProofAcceptanceReviewDigests | null {
  const gates = manifest.reviewGates;
  const costReviewSha256 = reviewDigest(gates?.costReview, 'reviewed');
  const sourcePermitReviewSha256 = reviewDigest(gates?.sourcePermitReview, 'reviewed');
  const ownerResidualCostAcceptanceSha256 = reviewDigest(gates?.ownerResidualCostAcceptance, 'accepted');
  return costReviewSha256 && sourcePermitReviewSha256 && ownerResidualCostAcceptanceSha256
    ? { costReviewSha256, sourcePermitReviewSha256, ownerResidualCostAcceptanceSha256 } : null;
}

/** Provider resource evidence is collected by this finite run and reviewed before production. */
export function proofAcceptanceExecutionAvailable(): boolean {
  return manifest.executionAvailable && manifest.adaptersAvailable
    && proofAcceptanceReviewDigests() !== null && manifest.sealedRuntimeIdentity !== null;
}
const resourceId = /^(?!0{32}$)[a-f0-9]{32}$/;
const databaseId = /^(?!00000000-0000-0000-0000-000000000000$)[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function identityText(value: ProofAcceptanceIdentity | null, manifestDigest: string): string | null {
  if (value === null) return null;
  const namespaces = namespaceFields.map(field => value[field]);
  if (Object.keys(value).length !== identityFields.length || !identityFields.every(field => Object.hasOwn(value, field))
    || value.scope !== PROOF_ACCEPTANCE_SCOPE || value.manifestDigest !== manifestDigest
    || !sha256.test(value.sourceDigest) || !reviewSha256.test(value.costReviewSha256)
    || !reviewSha256.test(value.sourcePermitReviewSha256) || !reviewSha256.test(value.ownerResidualCostAcceptanceSha256)
    || !resourceId.test(value.accountId) || !databaseId.test(value.databaseId)
    || !namespaces.every(id => resourceId.test(id)) || new Set(namespaces).size !== namespaces.length
    || value.privateCaller !== manifest.privateCaller || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0) {
    throw new Error('proof_acceptance_identity_invalid');
  }
  return JSON.stringify(Object.fromEntries(identityFields.map(field => [field, value[field]])));
}

type CloseReason = 'stopped' | 'expired' | 'alarm-limit';
type Control = { manifest: string; identity: string | null; armed_at: number | null; expires_at: number | null;
  last_now: number; closed_at: number | null; close_reason: CloseReason | null; commands: number; alarms: number };
export type ProofAcceptanceCommandReceipt = { id: string; sequence: number; recordedAt: number; expiresAt?: number };
export type ProofAcceptanceFaultReceipt = { id: string; command: string; fault: string; ordinal: number; recordedAt: number };
type Transaction = <T>(run: () => T) => T;

export function parseProofAcceptanceCommand(value: unknown):
  { operation: 'inspect' | 'stop' | 'arm' } | { operation: 'advance'; id: string } |
  { operation: 'fault'; id: string; ordinal: number } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item);
  if (!Object.hasOwn(item, 'operation')) return null;
  if (keys.length === 1 && typeof item.operation === 'string' && ['inspect', 'stop', 'arm'].includes(item.operation)) {
    return item as { operation: 'inspect' | 'stop' | 'arm' };
  }
  if (keys.length === 2 && Object.hasOwn(item, 'id') && item.operation === 'advance' && typeof item.id === 'string'
    && item.id !== 'arm-v1' && commands.has(item.id)) return item as { operation: 'advance'; id: string };
  const fault = typeof item.id === 'string' ? faults.get(item.id) : undefined;
  return keys.length === 3 && Object.hasOwn(item, 'id') && Object.hasOwn(item, 'ordinal')
    && item.operation === 'fault' && fault && Number.isSafeInteger(item.ordinal)
    && Number(item.ordinal) >= 1 && Number(item.ordinal) <= fault.maximum
    ? item as { operation: 'fault'; id: string; ordinal: number } : null;
}

export class ProofAcceptanceJournal {
  private readonly identity: string | null;
  constructor(private readonly sql: SqlStorage, private readonly transaction: Transaction,
    private readonly manifestDigest: string, identity: ProofAcceptanceIdentity | null,
    private readonly clock: () => number = Date.now) {
    if (!sha256.test(manifestDigest)) throw new Error('proof_acceptance_manifest_invalid');
    this.identity = identityText(identity, manifestDigest);
    sql.exec(`CREATE TABLE IF NOT EXISTS proof_acceptance_control(id INTEGER PRIMARY KEY CHECK(id=1),
      manifest TEXT NOT NULL,identity TEXT,armed_at INTEGER,expires_at INTEGER,last_now INTEGER NOT NULL,
      closed_at INTEGER,close_reason TEXT,commands INTEGER NOT NULL DEFAULT 0,alarms INTEGER NOT NULL DEFAULT 0)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS proof_acceptance_commands(id TEXT PRIMARY KEY,sequence INTEGER NOT NULL,
      receipt TEXT NOT NULL) WITHOUT ROWID`);
    sql.exec(`CREATE TABLE IF NOT EXISTS proof_acceptance_faults(id TEXT PRIMARY KEY,fault TEXT NOT NULL,
      ordinal INTEGER NOT NULL,receipt TEXT NOT NULL) WITHOUT ROWID`);
    transaction(() => {
      const now = clock();
      if (!Number.isSafeInteger(now) || now <= 0) throw new Error('proof_acceptance_clock_invalid');
      sql.exec('INSERT OR IGNORE INTO proof_acceptance_control(id,manifest,last_now) VALUES(1,?,?)', manifestDigest, now);
    });
  }

  private observe(): Control {
    const row = this.sql.exec<Control>('SELECT * FROM proof_acceptance_control WHERE id=1').one();
    const observed = this.clock();
    if (!Number.isSafeInteger(observed) || observed <= 0) throw new Error('proof_acceptance_clock_invalid');
    const now = Math.max(row.last_now, observed);
    let changed = row.last_now !== now;
    if (row.closed_at === null && row.expires_at !== null && now >= row.expires_at) {
      row.closed_at = now; row.close_reason = 'expired'; changed = true;
    }
    if (changed) {
      this.sql.exec('UPDATE proof_acceptance_control SET last_now=?,closed_at=?,close_reason=? WHERE id=1',
        now, row.closed_at, row.close_reason);
    }
    row.last_now = now;
    return row;
  }

  private change<T>(run: (row: Control) => T): T {
    let outcome!: { value: T } | { error: unknown };
    this.transaction(() => {
      const row = this.observe();
      // Keep monotone time/expiry even when a denied operation rolls back.
      try { outcome = { value: this.transaction(() => run(row)) }; }
      catch (error) { outcome = { error }; }
    });
    if ('error' in outcome) throw outcome.error;
    return outcome.value;
  }

  private requireIdentity(row: Control): void {
    if (row.manifest !== this.manifestDigest || this.identity === null || row.identity !== this.identity) {
      throw new Error('proof_acceptance_identity_mismatch');
    }
  }
  private requireActive(row: Control): void {
    this.requireIdentity(row);
    if (row.armed_at === null || row.closed_at !== null) throw new Error('proof_acceptance_closed');
  }
  private receipt(id: string): ProofAcceptanceCommandReceipt | null {
    const row = this.sql.exec<{ receipt: string }>('SELECT receipt FROM proof_acceptance_commands WHERE id=?', id).toArray()[0];
    return row ? JSON.parse(row.receipt) as ProofAcceptanceCommandReceipt : null;
  }

  /** Only a future compiled seal may call this. The unarmed entry never does. */
  arm(): ProofAcceptanceCommandReceipt {
    return this.change(row => {
      if (this.identity === null || row.manifest !== this.manifestDigest) throw new Error('proof_acceptance_unsealed');
      if (row.identity !== null) {
        this.requireIdentity(row);
        const receipt = this.receipt('arm-v1');
        if (!receipt) throw new Error('proof_acceptance_arm_receipt_missing');
        return receipt;
      }
      const identity = JSON.parse(this.identity) as ProofAcceptanceIdentity;
      if (row.closed_at !== null || identity.expiresAt <= row.last_now
        || identity.expiresAt > row.last_now + PROOF_ACCEPTANCE_LIMITS.candidateLifetimeSeconds * 1_000) {
        throw new Error('proof_acceptance_closed');
      }
      const receipt = { id: 'arm-v1', sequence: 1, recordedAt: row.last_now, expiresAt: identity.expiresAt };
      this.sql.exec(`UPDATE proof_acceptance_control SET identity=?,armed_at=?,expires_at=?,commands=1 WHERE id=1`,
        this.identity, row.last_now, identity.expiresAt);
      this.sql.exec('INSERT INTO proof_acceptance_commands(id,sequence,receipt) VALUES(?,?,?)', 'arm-v1', 1, JSON.stringify(receipt));
      return receipt;
    });
  }

  /** Saves a bounded intent only; callers must sync it before any later side effect. */
  claimCommand(id: string): ProofAcceptanceCommandReceipt {
    if (id === 'arm-v1' || !commands.has(id)) throw new Error('proof_acceptance_command_invalid');
    return this.change(row => {
      this.requireIdentity(row);
      const saved = this.receipt(id);
      if (saved) return saved;
      this.requireActive(row);
      if (row.commands >= PROOF_ACCEPTANCE_LIMITS.advancingCommands) throw new Error('proof_acceptance_command_limit');
      const receipt = { id, sequence: row.commands + 1, recordedAt: row.last_now };
      this.sql.exec('INSERT INTO proof_acceptance_commands(id,sequence,receipt) VALUES(?,?,?)', id, receipt.sequence, JSON.stringify(receipt));
      this.sql.exec('UPDATE proof_acceptance_control SET commands=commands+1 WHERE id=1');
      return receipt;
    });
  }

  /** A repeated lost reply returns its saved receipt with fresh=false, never another fault. */
  consumeFault(command: string, id: string, ordinal: number): { receipt: ProofAcceptanceFaultReceipt; fresh: boolean } {
    const fault = faults.get(id);
    if (!fault || fault.command !== command || !Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > fault.maximum) {
      throw new Error('proof_acceptance_fault_invalid');
    }
    return this.change(row => {
      this.requireIdentity(row);
      const key = `${id}:${ordinal}`;
      const saved = this.sql.exec<{ receipt: string }>('SELECT receipt FROM proof_acceptance_faults WHERE id=?', key).toArray()[0];
      if (saved) return { receipt: JSON.parse(saved.receipt) as ProofAcceptanceFaultReceipt, fresh: false };
      this.requireActive(row);
      if (!this.receipt(command)) throw new Error('proof_acceptance_intent_missing');
      const used = this.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM proof_acceptance_faults WHERE fault=?', id).one().count;
      if (ordinal !== used + 1) throw new Error('proof_acceptance_fault_order');
      const receipt = { id: key, command, fault: id, ordinal, recordedAt: row.last_now };
      this.sql.exec('INSERT INTO proof_acceptance_faults(id,fault,ordinal,receipt) VALUES(?,?,?,?)', key, id, ordinal, JSON.stringify(receipt));
      return { receipt, fresh: true };
    });
  }

  noteAlarm(): boolean {
    return this.change(row => {
      this.requireIdentity(row);
      if (row.closed_at !== null) return false;
      if (row.alarms >= PROOF_ACCEPTANCE_LIMITS.controlAlarmEntries) {
        this.sql.exec("UPDATE proof_acceptance_control SET closed_at=?,close_reason='alarm-limit' WHERE id=1", row.last_now);
        return false;
      }
      this.sql.exec('UPDATE proof_acceptance_control SET alarms=alarms+1 WHERE id=1');
      return true;
    });
  }

  stop() {
    return this.change(row => {
      if (row.closed_at === null) {
        row.closed_at = row.last_now; row.close_reason = 'stopped';
        this.sql.exec("UPDATE proof_acceptance_control SET closed_at=?,close_reason='stopped' WHERE id=1", row.closed_at);
      }
      return { operation: 'stop' as const, closedAt: row.closed_at, reason: row.close_reason };
    });
  }

  inspect() {
    return this.change(row => {
      return { schema: PROOF_ACCEPTANCE_SCHEMA, scope: PROOF_ACCEPTANCE_SCOPE, runnable: false as const,
        executionAvailable: false as const, invoiceHardCap: false as const,
        manifestMatches: row.manifest === this.manifestDigest, identityMatches: this.identity !== null && row.identity === this.identity,
        armed: row.armed_at !== null, armedAt: row.armed_at, expiresAt: row.expires_at,
        lastNow: row.last_now, closed: row.closed_at !== null, closedAt: row.closed_at, closeReason: row.close_reason,
        commands: row.commands, alarms: row.alarms,
        commandReceipts: this.sql.exec<{ receipt: string }>('SELECT receipt FROM proof_acceptance_commands ORDER BY sequence LIMIT ?',
          PROOF_ACCEPTANCE_LIMITS.advancingCommands).toArray().map(row => JSON.parse(row.receipt) as ProofAcceptanceCommandReceipt),
        faultReceipts: this.sql.exec<{ receipt: string }>('SELECT receipt FROM proof_acceptance_faults ORDER BY id LIMIT ?',
          maximumFaultReceipts).toArray().map(row => JSON.parse(row.receipt) as ProofAcceptanceFaultReceipt) };
    });
  }
}
