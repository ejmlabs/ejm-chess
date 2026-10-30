import { capacityRecoveryReleaseAt, type CapacityFault } from '../shared/capacity-corpus';
import type { GameResult } from '../shared/protocol';
import type { Competition } from './competition';
import type { CapacityManifest } from './capacity-run';

const FAULTS: readonly CapacityFault[] = ['hold-delayed-results', 'release-delayed-results',
  'projection-unavailable-once', 'competition-restart-once', 'lose-result-ack-once', 'conflicting-result-once'];
interface FaultRow extends Record<string, SqlStorageValue> {
  issued: number; projection_pending: number; ack_pending: number; restart_pending: number;
}

/** Private one-run fault transport. Every accepted fault has one durable claim. */
export class CapacityFaults {
  constructor(private sql: SqlStorage, private manifest: CapacityManifest) {
    sql.exec(`CREATE TABLE IF NOT EXISTS capacity_faults(id INTEGER PRIMARY KEY CHECK(id=1),
      issued INTEGER NOT NULL,projection_pending INTEGER NOT NULL,ack_pending INTEGER NOT NULL,restart_pending INTEGER NOT NULL)`);
    sql.exec('INSERT OR IGNORE INTO capacity_faults VALUES(1,0,0,0,0)');
  }
  private row(): FaultRow { return this.sql.exec<FaultRow>('SELECT * FROM capacity_faults WHERE id=1').one(); }

  async apply(fault: CapacityFault, authority: Competition): Promise<boolean> {
    const index = FAULTS.indexOf(fault);
    if (index < 0) throw new Error('capacity_fault_invalid');
    const row = this.row(), bit = 1 << index;
    if (row.issued & bit) return false;
    if (fault === 'release-delayed-results' && (!(row.issued & 1) || Date.now() < this.manifest.setupEndsAt)) return false;
    this.sql.exec(`UPDATE capacity_faults SET issued=issued|?,projection_pending=projection_pending|?,
      ack_pending=ack_pending|?,restart_pending=restart_pending|? WHERE id=1`, bit,
    fault === 'projection-unavailable-once' ? 1 : 0, fault === 'lose-result-ack-once' ? 1 : 0,
    fault === 'competition-restart-once' ? 1 : 0);
    if (fault === 'conflicting-result-once') {
      const saved = this.sql.exec<{ payload: string }>('SELECT payload FROM result_events ORDER BY sequence LIMIT 1').toArray()[0];
      if (!saved) throw new Error('capacity_fault_result_missing');
      const result = JSON.parse(saved.payload) as GameResult;
      const conflict = { ...result, terminalDigest: result.terminalDigest === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64) };
      let rejected = false;
      try { await authority.settle(conflict); }
      catch (error) { rejected = error instanceof Error && error.message === 'conflicting_result'; }
      const after = this.sql.exec<{ payload: string }>('SELECT payload FROM result_events WHERE event_id=?', result.eventId).one();
      if (!rejected || after.payload !== saved.payload) throw new Error('capacity_conflict_fault_unproved');
    }
    return true;
  }

  /** The approved release cadence is derived from the permanent native binding. */
  hold(result: GameResult): boolean {
    if (!(this.row().issued & 1)) return false;
    const intent = this.sql.exec<{ intent_index: number }>('SELECT intent_index FROM capacity_intents WHERE game_id=?', result.id).toArray()[0];
    return Boolean(intent && intent.intent_index < 1_000
      && Date.now() < capacityRecoveryReleaseAt(intent.intent_index, this.manifest.setupEndsAt));
  }

  projectionUnavailable(): boolean {
    if (!this.row().projection_pending) return false;
    this.sql.exec('UPDATE capacity_faults SET projection_pending=0 WHERE id=1');
    return true;
  }
  loseAcknowledgment(): boolean {
    if (!this.row().ack_pending) return false;
    this.sql.exec('UPDATE capacity_faults SET ack_pending=0 WHERE id=1');
    return true;
  }
  restart(): boolean {
    if (!this.row().restart_pending) return false;
    this.sql.exec('UPDATE capacity_faults SET restart_pending=0 WHERE id=1');
    return true;
  }
}
