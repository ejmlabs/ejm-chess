import { capacityAccountId, capacityEventId, capacityIntent, CAPACITY_CORPUS,
  type CapacityIntentBinding } from '../shared/capacity-corpus';
import type { ArenaReservation } from './arena';
import type { CapacityManifest } from './capacity-run';

export interface CapacityBoundIntent extends CapacityIntentBinding {
  eventId: string;
  reservationId: string;
  whiteId: string;
  blackId: string;
}

interface IntentRow extends Record<string, SqlStorageValue> {
  intent_index: number; event_id: string; game_id: string | null; reservation_id: string | null;
  white_id: string | null; black_id: string | null;
}

interface NativeIntentRow extends Record<string, SqlStorageValue> {
  native_rowid: number; event_id: string; game_id: string; reservation_id: string;
  white_id: string; black_id: string; status: ArenaReservation['status'];
}

const DISCOVERY_BATCH = 2;

const nativeId = (value: string): boolean => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
function accountIndex(value: string): number {
  const match = /^capacity-account-([a-z0-9]{4})$/.exec(value);
  const index = match ? Number.parseInt(match[1], 36) : -1;
  if (!Number.isSafeInteger(index) || index < 0 || index >= CAPACITY_CORPUS.accounts
    || capacityAccountId(index) !== value) throw new Error('capacity_intent_account_invalid');
  return index;
}

/**
 * Sidecar in the real Competition SQLite store, reached only inside an admitted
 * native event. Pending ordinals survive unknown replies. A Game identity is
 * accepted only from the normal primary Arena intent, never from a guessed
 * namespace lookup. Queue actors do not determine native pairings. A durable
 * cursor discovers each generated Game once, using its actual seats. The
 * driver must stop when pairing stays unknown.
 */
export class CapacityIntentLedger {
  #identity: string;

  constructor(private sql: SqlStorage, private transaction: <T>(run: () => T) => T,
    private manifest: CapacityManifest) {
    this.#identity = JSON.stringify([manifest.runId, manifest.digest, manifest.sourceDigest,
      manifest.configDigest, manifest.earliestArmAt]);
    sql.exec(`CREATE TABLE IF NOT EXISTS capacity_intent_state(id INTEGER PRIMARY KEY CHECK(id=1),
      identity TEXT NOT NULL,stop_reason TEXT)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS capacity_intents(intent_index INTEGER PRIMARY KEY,event_id TEXT NOT NULL,
      game_id TEXT UNIQUE,reservation_id TEXT UNIQUE,white_id TEXT,black_id TEXT)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS capacity_intent_pending ON capacity_intents(event_id,intent_index)
      WHERE game_id IS NULL`);
    sql.exec(`CREATE TABLE IF NOT EXISTS capacity_intent_discovery(id INTEGER PRIMARY KEY CHECK(id=1),native_rowid INTEGER NOT NULL)`);
    sql.exec('INSERT OR IGNORE INTO capacity_intent_state VALUES(1,?,NULL)', this.#identity);
  }

  #ready(): void {
    const state = this.sql.exec<{ identity: string; stop_reason: string | null }>(
      'SELECT identity,stop_reason FROM capacity_intent_state WHERE id=1').one();
    if (state.identity !== this.#identity || state.stop_reason !== null) throw new Error('capacity_intent_ledger_fenced');
  }

  #row(index: number): IntentRow | null {
    capacityIntent(index);
    return this.sql.exec<IntentRow>('SELECT * FROM capacity_intents WHERE intent_index=?', index).toArray()[0] ?? null;
  }

  #bound(row: IntentRow): CapacityBoundIntent | null {
    if (row.game_id === null && row.reservation_id === null && row.white_id === null && row.black_id === null) return null;
    if (!row.game_id || !row.reservation_id || !row.white_id || !row.black_id) throw new Error('capacity_intent_ledger_invalid');
    const { eventIndex } = capacityIntent(row.intent_index);
    const whiteAccountIndex = accountIndex(row.white_id), blackAccountIndex = accountIndex(row.black_id);
    const first = eventIndex * CAPACITY_CORPUS.accountsPerEvent, last = first + CAPACITY_CORPUS.accountsPerEvent;
    if (row.event_id !== capacityEventId(eventIndex, this.manifest.earliestArmAt)
      || !nativeId(row.game_id) || !nativeId(row.reservation_id) || whiteAccountIndex === blackAccountIndex
      || whiteAccountIndex < first || whiteAccountIndex >= last || blackAccountIndex < first || blackAccountIndex >= last) {
      throw new Error('capacity_intent_ledger_invalid');
    }
    return { intentIndex: row.intent_index, eventIndex, eventId: row.event_id, gameId: row.game_id,
      reservationId: row.reservation_id, whiteId: row.white_id, blackId: row.black_id,
      whiteAccountIndex, blackAccountIndex };
  }

  reserve(index: number): { intentIndex: number; eventIndex: number; eventId: string; binding: CapacityBoundIntent | null } {
    const { eventIndex } = capacityIntent(index);
    const eventId = capacityEventId(eventIndex, this.manifest.earliestArmAt);
    return this.transaction(() => {
      this.#ready();
      let row = this.#row(index);
      if (!row) {
        this.sql.exec('INSERT INTO capacity_intents(intent_index,event_id) VALUES(?,?)', index, eventId);
        row = this.#row(index)!;
      }
      if (row.event_id !== eventId) throw new Error('capacity_intent_ledger_invalid');
      return { intentIndex: index, eventIndex, eventId, binding: this.#bound(row) };
    });
  }

  binding(index: number): CapacityBoundIntent | null {
    this.#ready();
    const row = this.#row(index);
    return row ? this.#bound(row) : null;
  }

  #candidate(index: number, reservation: ArenaReservation): CapacityBoundIntent {
    const { eventIndex } = capacityIntent(index);
    const eventId = capacityEventId(eventIndex, this.manifest.earliestArmAt);
    const value = reservation && reservation.eventId === eventId && nativeId(reservation.gameId) && nativeId(reservation.reservationId)
      ? { intent_index: index, event_id: eventId, game_id: reservation.gameId, reservation_id: reservation.reservationId,
        white_id: reservation.whiteId, black_id: reservation.blackId } : null;
    // Validate native seats before entering the durable mapping transaction.
    const candidate = value ? this.#bound(value) : null;
    if (!candidate) throw new Error('capacity_intent_observation_invalid');
    return candidate;
  }

  #record(candidate: CapacityBoundIntent): CapacityBoundIntent | null {
    const current = this.#row(candidate.intentIndex);
    if (!current) throw new Error('capacity_intent_not_reserved');
    const prior = this.#bound(current);
    if (prior) return prior.gameId === candidate.gameId && prior.reservationId === candidate.reservationId
      && prior.eventId === candidate.eventId && prior.whiteId === candidate.whiteId && prior.blackId === candidate.blackId ? prior : null;
    const occupied = this.sql.exec<{ intent_index: number }>(
      'SELECT intent_index FROM capacity_intents WHERE game_id=? OR reservation_id=? LIMIT 1',
      candidate.gameId, candidate.reservationId).toArray()[0];
    if (occupied) return null;
    this.sql.exec('UPDATE capacity_intents SET game_id=?,reservation_id=?,white_id=?,black_id=? WHERE intent_index=?',
      candidate.gameId, candidate.reservationId, candidate.whiteId, candidate.blackId, candidate.intentIndex);
    return candidate;
  }

  #conflict(): never {
    // Keep the conflict durable even though the native event will reject.
    // A consumed ordinal, Game, reservation or seat is never replaced.
    this.sql.exec("UPDATE capacity_intent_state SET stop_reason='binding-conflict' WHERE id=1 AND stop_reason IS NULL");
    throw new Error('capacity_intent_binding_conflict');
  }

  bind(index: number, reservation: ArenaReservation): CapacityBoundIntent {
    const candidate = this.#candidate(index, reservation);
    const bound = this.transaction(() => {
      this.#ready();
      return this.#record(candidate);
    });
    if (!bound) this.#conflict();
    return bound;
  }

  discover(index: number): CapacityBoundIntent | null {
    const result = this.transaction(() => {
      this.#ready();
      const current = this.#row(index);
      if (!current) throw new Error('capacity_intent_not_reserved');
      const prior = this.#bound(current);
      if (prior) return { binding: prior, conflict: false };
      const cursor = this.sql.exec<{ native_rowid: number }>(
        'SELECT native_rowid FROM capacity_intent_discovery WHERE id=1').toArray()[0]?.native_rowid ?? 0;
      // Arena intents keep their ordinary row identities throughout this run.
      // The rowid range prevents repeated scans of all retained Games. Nothing
      // in the caller can select a native Game or alter its pairing.
      const native = this.sql.exec<NativeIntentRow>(`SELECT rowid AS native_rowid,event_id,game_id,reservation_id,white_id,black_id,status
        FROM arena_intents NOT INDEXED WHERE rowid>? ORDER BY rowid LIMIT ?`, cursor, DISCOVERY_BATCH).toArray();
      let consumed = cursor;
      for (const observation of native) {
        const existing = this.sql.exec<{ intent_index: number }>(
          'SELECT intent_index FROM capacity_intents WHERE game_id=? OR reservation_id=? LIMIT 1',
          observation.game_id, observation.reservation_id).toArray()[0];
        const target = existing?.intent_index ?? this.sql.exec<{ intent_index: number }>(`SELECT intent_index FROM capacity_intents
          WHERE event_id=? AND game_id IS NULL ORDER BY intent_index LIMIT 1`, observation.event_id).toArray()[0]?.intent_index;
        if (target === undefined) break;
        const candidate = this.#candidate(target, { eventId: observation.event_id, gameId: observation.game_id, reservationId: observation.reservation_id,
          whiteId: observation.white_id, blackId: observation.black_id, status: observation.status });
        if (!this.#record(candidate)) return { binding: null, conflict: true };
        consumed = observation.native_rowid;
      }
      if (consumed !== cursor) this.sql.exec(`INSERT INTO capacity_intent_discovery(id,native_rowid) VALUES(1,?)
        ON CONFLICT(id) DO UPDATE SET native_rowid=excluded.native_rowid`, consumed);
      return { binding: this.#bound(this.#row(index)!), conflict: false };
    });
    if (result.conflict) this.#conflict();
    return result.binding;
  }
}
