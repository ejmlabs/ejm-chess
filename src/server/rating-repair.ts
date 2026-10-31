import type { Env } from './env';
import { LEADERBOARD_COLUMNS, LEADERBOARD_VALUES, leaderboardRow } from './leaderboard';
import { initialRating, rateMatch } from './rating';
import { RATING_VERSION, type GameResult, type Pool, type RatingState } from '../shared/protocol';

const GENESIS_DIGEST = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
export const REPAIR_BATCH = 20;
const RETRY_MS = 30_000;
/** Decision and game identifiers read from stored records. */
export const RECORD_ID = /^[\w-]{8,100}$/;

type Phase = 'replay' | 'stage-ratings' | 'stage-games' | 'authority' | 'publish' | 'drain' | 'complete';
type Run = {
  id: string; decision_id: string; pool: Pool; epoch: number; watermark: number;
  cursor: number; stage_cursor: string; game_cursor: string; phase: Phase;
  created_at: number; next_at: number; error: string | null;
};
type RatingEvent = {
  sequence: number; game_id: string; pool: Pool; policy: string; white_id: string; black_id: string;
  score: 0 | 0.5 | 1; post_white: string;
};
type Decision = {
  id: string; case_id: string; subject_id: string; outcome: string; affected_game_ids: string; created_at: number;
  action: 'review_replay' | 'reverse_replay';
};
type RequestResult = { accepted: boolean; complete: boolean; reason?: string };

export interface RepairBridge {
  schedule(): Promise<void>;
  /** Settles a result that waited out a repair, then queues its projection. */
  release(result: GameResult, sequence: number, epoch: number): void;
}

/**
 * Replays a pool's accepted rating events without voided games into shadow tables,
 * then publishes one corrected generation for every affected pool together. Results
 * that finish while a pool is paused wait in `pending_results` and settle after it.
 */
export class RatingRepair {
  private running = false;

  constructor(private ctx: DurableObjectState, private getEnv: () => Env, private bridge: RepairBridge) {
    const sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS pending_results (sequence INTEGER PRIMARY KEY,game_id TEXT NOT NULL UNIQUE,pool TEXT NOT NULL,payload TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS correction_decisions (decision_id TEXT PRIMARY KEY,payload TEXT NOT NULL,state TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS void_decisions (decision_id TEXT NOT NULL,game_id TEXT NOT NULL,epoch INTEGER NOT NULL,PRIMARY KEY(decision_id,game_id))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS restored_decisions (restoring_decision_id TEXT NOT NULL,original_decision_id TEXT NOT NULL,epoch INTEGER NOT NULL,PRIMARY KEY(restoring_decision_id,original_decision_id))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS checkpoints (pool TEXT PRIMARY KEY,watermark INTEGER NOT NULL,policy TEXT NOT NULL,payload TEXT NOT NULL,digest TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS correction_runs (id TEXT PRIMARY KEY,decision_id TEXT NOT NULL,pool TEXT NOT NULL,epoch INTEGER NOT NULL,watermark INTEGER NOT NULL,
      cursor INTEGER NOT NULL DEFAULT 0,stage_cursor TEXT NOT NULL DEFAULT '',game_cursor TEXT NOT NULL DEFAULT '',phase TEXT NOT NULL,
      created_at INTEGER NOT NULL,next_at INTEGER NOT NULL,error TEXT,UNIQUE(decision_id,pool))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS shadow_ratings (run_id TEXT NOT NULL,user_id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(run_id,user_id))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS shadow_opponents (run_id TEXT NOT NULL,user_id TEXT NOT NULL,opponent_id TEXT NOT NULL,PRIMARY KEY(run_id,user_id,opponent_id))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS corrected_events (epoch INTEGER NOT NULL,sequence INTEGER NOT NULL,pool TEXT NOT NULL,game_id TEXT NOT NULL,policy TEXT NOT NULL,
      pre_white TEXT NOT NULL,pre_black TEXT NOT NULL,post_white TEXT NOT NULL,post_black TEXT NOT NULL,voided INTEGER NOT NULL,decision_id TEXT,PRIMARY KEY(epoch,sequence))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS correction_game_projection (run_id TEXT NOT NULL,game_id TEXT NOT NULL,voided INTEGER NOT NULL,decision_id TEXT,PRIMARY KEY(run_id,game_id))`);
  }

  private get sql(): SqlStorage { return this.ctx.storage.sql; }

  paused(pool: Pool): boolean {
    return Boolean(this.sql.exec('SELECT 1 FROM meta WHERE key=?', `paused:${pool}`).toArray()[0]);
  }

  /** Epoch of the corrected generation visible in D1. */
  publishedEpoch(pool: Pool): number {
    return Number(this.sql.exec<{ value: string }>('SELECT value FROM meta WHERE key=?', `published-epoch:${pool}`).toArray()[0]?.value ?? 1);
  }

  active(): boolean {
    return Boolean(this.sql.exec("SELECT 1 FROM correction_runs WHERE phase<>'complete' LIMIT 1").toArray()[0]);
  }

  nextDue(): number | null {
    return this.sql.exec<{ due: number | null }>("SELECT MIN(next_at) AS due FROM correction_runs WHERE phase<>'complete'").one().due;
  }

  /** The decision that voided this game as of `epoch`, unless a later reviewed decision restored it. */
  voidDecision(gameId: string, epoch = Number.MAX_SAFE_INTEGER): string | null {
    return this.sql.exec<{ decision_id: string }>(`SELECT decision_id FROM void_decisions v WHERE game_id=?
      AND v.epoch<=? AND NOT EXISTS(SELECT 1 FROM restored_decisions r WHERE r.original_decision_id=v.decision_id AND r.epoch<=?) ORDER BY decision_id LIMIT 1`, gameId, epoch, epoch).toArray()[0]?.decision_id ?? null;
  }

  hold(sequence: number, result: GameResult): void {
    this.sql.exec('INSERT INTO pending_results(sequence,game_id,pool,payload) VALUES(?,?,?,?)', sequence, result.id, result.format, JSON.stringify(result));
  }

  holds(gameId: string): boolean {
    return Boolean(this.sql.exec('SELECT 1 FROM pending_results WHERE game_id=?', gameId).toArray()[0]);
  }

  async backlog(): Promise<{ pending: number; oldestAt: number | null; error: string | null }> {
    const db = this.getEnv().DB;
    const queue = await db.prepare('SELECT COUNT(*) AS count,MIN(created_at) AS oldest FROM rating_correction_outbox WHERE completed_at IS NULL').first<{ count: number; oldest: number | null }>();
    const error = await db.prepare('SELECT last_error FROM rating_correction_outbox WHERE completed_at IS NULL AND last_error IS NOT NULL ORDER BY created_at,decision_id LIMIT 1').first<string>('last_error');
    return { pending: queue?.count ?? 0, oldestAt: queue?.oldest ?? null, error };
  }

  /** Imports only an immutable, human-reviewed decision already present in the private outbox. */
  async request(decisionId: string): Promise<RequestResult> {
    const now = Date.now();
    if (!RECORD_ID.test(decisionId)) throw new Error('invalid_decision');
    const existing = this.sql.exec<{ state: string }>('SELECT state FROM correction_decisions WHERE decision_id=?', decisionId).toArray()[0];
    if (existing) {
      if (existing.state === 'complete') await this.finishOutbox(decisionId);
      return { accepted: true, complete: existing.state === 'complete' };
    }
    const { decision, targets, gameIds } = await this.approved(decisionId);
    const pools = new Set<Pool>();
    for (const gameId of gameIds) {
      const event = this.sql.exec<{ pool: Pool }>('SELECT pool FROM rating_events WHERE game_id=?', gameId).toArray()[0];
      if (event) pools.add(event.pool);
    }
    const response = this.ctx.storage.transactionSync((): RequestResult => {
      const duplicate = this.sql.exec<{ state: string }>('SELECT state FROM correction_decisions WHERE decision_id=?', decisionId).toArray()[0];
      if (duplicate) return { accepted: true, complete: duplicate.state === 'complete' };
      if (this.active()) return { accepted: false, complete: false, reason: 'Earlier rating repair is in progress.' };
      const epoch = Number(this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key='epoch'").one().value) + 1;
      const watermark = this.sql.exec<{ watermark: number }>('SELECT COALESCE(MAX(sequence),0) AS watermark FROM rating_events').one().watermark;
      this.sql.exec('INSERT INTO correction_decisions(decision_id,payload,state) VALUES(?,?,?)', decisionId,
        JSON.stringify({ decisionId, subjectId: decision.subject_id, action: decision.action, gameIds, restores: targets.map(item => item.id), epoch, watermark }), pools.size ? 'running' : 'complete');
      if (decision.action === 'review_replay') {
        for (const id of gameIds) this.sql.exec('INSERT INTO void_decisions(decision_id,game_id,epoch) VALUES(?,?,?)', decisionId, id, epoch);
      } else {
        for (const target of targets) this.sql.exec('INSERT INTO restored_decisions(restoring_decision_id,original_decision_id,epoch) VALUES(?,?,?)', decisionId, target.id, epoch);
      }
      for (const pool of pools) {
        this.sql.exec('INSERT OR IGNORE INTO checkpoints(pool,watermark,policy,payload,digest) VALUES(?,0,?,?,?)', pool, RATING_VERSION, '[]', GENESIS_DIGEST);
        const checkpoint = this.sql.exec<{ watermark: number; policy: string; payload: string; digest: string }>('SELECT * FROM checkpoints WHERE pool=?', pool).one();
        if (checkpoint.watermark !== 0 || checkpoint.policy !== RATING_VERSION || checkpoint.payload !== '[]' || checkpoint.digest !== GENESIS_DIGEST) throw new Error('checkpoint_verification_failed');
        this.sql.exec("INSERT INTO correction_runs(id,decision_id,pool,epoch,watermark,phase,created_at,next_at) VALUES(?,?,?,?,?,'replay',?,?)", `${decisionId}:${pool}`, decisionId, pool, epoch, watermark, now, now);
        this.sql.exec('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', `paused:${pool}`, decisionId);
        this.sql.exec("DELETE FROM slots WHERE pool=? AND state='queued'", pool);
        this.sql.exec('DELETE FROM queue WHERE pool=?', pool);
      }
      return { accepted: true, complete: pools.size === 0 };
    });
    await this.ctx.storage.sync();
    if (response.complete) await this.finishOutbox(decisionId);
    await this.bridge.schedule();
    return response;
  }

  private async approved(decisionId: string): Promise<{ decision: Decision; targets: Array<{ id: string; affected_game_ids: string }>; gameIds: string[] }> {
    const db = this.getEnv().DB;
    const decision = await db.prepare(`SELECT d.id,d.case_id,d.subject_id,d.outcome,d.affected_game_ids,d.created_at,o.action
      FROM fairplay_decisions d JOIN rating_correction_outbox o ON o.decision_id=d.id WHERE d.id=?`).bind(decisionId).first<Decision>();
    if (!decision || (decision.action === 'review_replay' && decision.outcome !== 'restrict')
      || (decision.action === 'reverse_replay' && !['clear', 'overturn'].includes(decision.outcome))) throw new Error('unapproved_correction');
    let targets: Array<{ id: string; affected_game_ids: string }> = [];
    if (decision.action === 'reverse_replay') {
      const query = decision.outcome === 'overturn'
        ? db.prepare(`SELECT d.id,d.affected_game_ids FROM fairplay_appeals a JOIN fairplay_decisions d ON d.id=a.decision_id
          WHERE a.outcome_decision_id=? AND d.outcome='restrict'`).bind(decisionId)
        : db.prepare("SELECT id,affected_game_ids FROM fairplay_decisions WHERE case_id=? AND outcome='restrict' AND created_at<=? ORDER BY created_at,id").bind(decision.case_id, decision.created_at);
      targets = (await query.all<{ id: string; affected_game_ids: string }>()).results;
    }
    const gameIds = [...new Set((decision.action === 'review_replay' ? [decision] : targets)
      .flatMap(item => {
        const value: unknown = JSON.parse(item.affected_game_ids);
        if (!Array.isArray(value) || value.length > 20 || value.some(id => typeof id !== 'string' || !RECORD_ID.test(id))) throw new Error('invalid_affected_games');
        return value as string[];
      }))];
    return { decision, targets, gameIds };
  }

  private async finishOutbox(decisionId: string): Promise<void> {
    const runs = this.sql.exec<{ id: string }>("SELECT id FROM correction_runs WHERE decision_id=? AND phase='complete'", decisionId).toArray();
    const db = this.getEnv().DB;
    await db.batch([
      ...runs.flatMap(run => [
        db.prepare('DELETE FROM leaderboard_rebuild WHERE run_id=?').bind(run.id),
        db.prepare('DELETE FROM rating_rebuild_games WHERE run_id=?').bind(run.id),
      ]),
      db.prepare('UPDATE rating_correction_outbox SET completed_at=COALESCE(completed_at,?),last_error=NULL WHERE decision_id=?').bind(Date.now(), decisionId),
    ]);
    this.ctx.storage.transactionSync(() => {
      for (const run of runs) {
        this.sql.exec('DELETE FROM shadow_ratings WHERE run_id=?', run.id);
        this.sql.exec('DELETE FROM shadow_opponents WHERE run_id=?', run.id);
        this.sql.exec('DELETE FROM correction_game_projection WHERE run_id=?', run.id);
      }
    });
  }

  async status(decisionId: string): Promise<{ complete: boolean; runs: Array<{ pool: Pool; phase: string; cursor: number; watermark: number; error: string | null }> }> {
    const decision = this.sql.exec<{ state: string }>('SELECT state FROM correction_decisions WHERE decision_id=?', decisionId).toArray()[0];
    const runs = this.sql.exec<{ pool: Pool; phase: string; cursor: number; watermark: number; error: string | null }>('SELECT pool,phase,cursor,watermark,error FROM correction_runs WHERE decision_id=? ORDER BY pool', decisionId).toArray();
    return { complete: decision?.state === 'complete', runs };
  }

  private shadowRating(run: Run, userId: string, now: number): RatingState {
    const row = this.sql.exec<{ value: string }>('SELECT value FROM shadow_ratings WHERE run_id=? AND user_id=?', run.id, userId).toArray()[0];
    return row ? JSON.parse(row.value) as RatingState : initialRating(now);
  }

  private replay(run: Run): void {
    this.ctx.storage.transactionSync(() => {
      const events = this.sql.exec<RatingEvent>('SELECT sequence,game_id,pool,policy,white_id,black_id,score,post_white FROM rating_events WHERE pool=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?', run.pool, run.cursor, run.watermark, REPAIR_BATCH).toArray();
      for (const event of events) {
        if (event.policy !== RATING_VERSION) throw new Error('unsupported_rating_policy');
        const now = (JSON.parse(event.post_white) as RatingState).lastPlayedAt;
        if (now === null) throw new Error('invalid_rating_event_time');
        const white = this.shadowRating(run, event.white_id, now);
        const black = this.shadowRating(run, event.black_id, now);
        const decisionId = this.voidDecision(event.game_id);
        const [postWhite, postBlack] = decisionId ? [white, black] : rateMatch(white, black, event.score, now);
        for (const [userId, opponentId, value] of [[event.white_id, event.black_id, postWhite], [event.black_id, event.white_id, postBlack]] as const) {
          this.sql.exec('INSERT INTO shadow_ratings(run_id,user_id,value) VALUES(?,?,?) ON CONFLICT(run_id,user_id) DO UPDATE SET value=excluded.value', run.id, userId, JSON.stringify(value));
          if (!decisionId) this.sql.exec('INSERT OR IGNORE INTO shadow_opponents(run_id,user_id,opponent_id) VALUES(?,?,?)', run.id, userId, opponentId);
        }
        this.sql.exec(`INSERT INTO corrected_events(epoch,sequence,pool,game_id,policy,pre_white,pre_black,post_white,post_black,voided,decision_id)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`, run.epoch, event.sequence, run.pool, event.game_id, event.policy,
        JSON.stringify(white), JSON.stringify(black), JSON.stringify(postWhite), JSON.stringify(postBlack), decisionId ? 1 : 0, decisionId);
        this.sql.exec('INSERT INTO correction_game_projection(run_id,game_id,voided,decision_id) VALUES(?,?,?,?)', run.id, event.game_id, decisionId ? 1 : 0, decisionId);
      }
      this.sql.exec('UPDATE correction_runs SET cursor=?,phase=?,next_at=?,error=NULL WHERE id=?', events.at(-1)?.sequence ?? run.cursor, events.length < REPAIR_BATCH ? 'stage-ratings' : 'replay', Date.now(), run.id);
    });
  }

  private async stageRatings(run: Run): Promise<void> {
    const db = this.getEnv().DB;
    const rows = this.sql.exec<{ user_id: string; value: string; distinct_opponents: number }>(`SELECT s.user_id,s.value,
      (SELECT COUNT(*) FROM shadow_opponents o WHERE o.run_id=s.run_id AND o.user_id=s.user_id) AS distinct_opponents
      FROM shadow_ratings s WHERE run_id=? AND user_id>? ORDER BY user_id LIMIT ?`, run.id, run.stage_cursor, REPAIR_BATCH).toArray();
    const statements: D1PreparedStatement[] = [];
    for (const row of rows) {
      const values = await leaderboardRow(db, run.pool, row.user_id, JSON.parse(row.value) as RatingState, row.distinct_opponents, run.epoch, run.watermark * 2 + 1);
      statements.push(db.prepare(`INSERT INTO leaderboard_rebuild(run_id,${LEADERBOARD_COLUMNS}) VALUES(?,${LEADERBOARD_VALUES})
        ON CONFLICT(run_id,user_id) DO NOTHING`).bind(run.id, ...values));
    }
    if (statements.length) await db.batch(statements);
    this.sql.exec('UPDATE correction_runs SET stage_cursor=?,phase=?,next_at=?,error=NULL WHERE id=?', rows.at(-1)?.user_id ?? run.stage_cursor, rows.length < REPAIR_BATCH ? 'stage-games' : 'stage-ratings', Date.now(), run.id);
  }

  private async stageGames(run: Run): Promise<void> {
    const db = this.getEnv().DB;
    const rows = this.sql.exec<{ game_id: string; voided: number; decision_id: string | null }>('SELECT game_id,voided,decision_id FROM correction_game_projection WHERE run_id=? AND game_id>? ORDER BY game_id LIMIT ?', run.id, run.game_cursor, REPAIR_BATCH).toArray();
    if (rows.length) await db.batch(rows.map(row => db.prepare('INSERT INTO rating_rebuild_games(run_id,game_id,voided,decision_id) VALUES(?,?,?,?) ON CONFLICT(run_id,game_id) DO NOTHING').bind(run.id, row.game_id, row.voided, row.decision_id)));
    this.sql.exec('UPDATE correction_runs SET game_cursor=?,phase=?,next_at=?,error=NULL WHERE id=?', rows.at(-1)?.game_id ?? run.game_cursor, rows.length < REPAIR_BATCH ? 'authority' : 'stage-games', Date.now(), run.id);
  }

  private replaceAuthority(run: Run): void {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM ratings WHERE pool=?', run.pool);
      this.sql.exec('INSERT INTO ratings(pool,user_id,value) SELECT ?,user_id,value FROM shadow_ratings WHERE run_id=?', run.pool, run.id);
      this.sql.exec('DELETE FROM opponents WHERE pool=?', run.pool);
      this.sql.exec('INSERT INTO opponents(pool,user_id,opponent_id) SELECT ?,user_id,opponent_id FROM shadow_opponents WHERE run_id=?', run.pool, run.id);
      this.sql.exec("UPDATE meta SET value=? WHERE key='epoch'", String(run.epoch));
      this.sql.exec('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', `pool-epoch:${run.pool}`, String(run.epoch));
      this.sql.exec("UPDATE correction_runs SET phase='publish',next_at=?,error=NULL WHERE id=?", Date.now(), run.id);
    });
  }

  /** Publishes every affected pool in one D1 batch, so readers never mix correction generations. */
  private async publish(run: Run): Promise<void> {
    const runs = this.sql.exec<Run>("SELECT * FROM correction_runs WHERE decision_id=? AND phase<>'complete' ORDER BY pool", run.decision_id).toArray();
    if (runs.some(item => item.phase !== 'publish')) {
      // Stay quiet until a sibling pool is due. Left due now, this run would keep the alarm firing.
      this.sql.exec(`UPDATE correction_runs SET next_at=(SELECT MIN(next_at) FROM correction_runs
        WHERE decision_id=? AND phase NOT IN ('publish','complete')) WHERE id=?`, run.decision_id, run.id);
      return;
    }
    const db = this.getEnv().DB;
    const statements: D1PreparedStatement[] = [];
    for (const current of runs) statements.push(
      db.prepare('DELETE FROM leaderboard_entries WHERE pool=?').bind(current.pool),
      db.prepare(`INSERT INTO leaderboard_entries(${LEADERBOARD_COLUMNS}) SELECT ${LEADERBOARD_COLUMNS} FROM leaderboard_rebuild WHERE run_id=?`).bind(current.id),
      db.prepare(`UPDATE games SET rating_voided=(SELECT voided FROM rating_rebuild_games r WHERE r.run_id=? AND r.game_id=games.id),
        rating_decision_id=(SELECT decision_id FROM rating_rebuild_games r WHERE r.run_id=? AND r.game_id=games.id),projection_epoch=?,projection_version=MAX(projection_version,?)
        WHERE id IN (SELECT game_id FROM rating_rebuild_games WHERE run_id=?)`).bind(current.id, current.id, current.epoch, current.watermark * 2 + 1, current.id),
      db.prepare(`INSERT INTO competition_generations(pool,epoch,watermark,updated_at) VALUES(?,?,?,?) ON CONFLICT(pool) DO UPDATE SET
        epoch=excluded.epoch,watermark=excluded.watermark,updated_at=excluded.updated_at WHERE excluded.epoch>=competition_generations.epoch`).bind(current.pool, current.epoch, current.watermark, Date.now()),
    );
    await db.batch(statements);
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("UPDATE correction_runs SET phase='drain',next_at=?,error=NULL WHERE decision_id=? AND phase='publish'", Date.now(), run.decision_id);
      for (const current of runs) this.sql.exec('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', `published-epoch:${current.pool}`, String(current.epoch));
    });
  }

  private drain(run: Run): void {
    this.ctx.storage.transactionSync(() => {
      const rows = this.sql.exec<{ sequence: number; payload: string }>('SELECT sequence,payload FROM pending_results WHERE pool=? ORDER BY sequence LIMIT ?', run.pool, REPAIR_BATCH).toArray();
      for (const row of rows) {
        this.bridge.release(JSON.parse(row.payload) as GameResult, row.sequence, run.epoch);
        this.sql.exec('DELETE FROM pending_results WHERE sequence=?', row.sequence);
      }
      if (!this.sql.exec('SELECT 1 FROM pending_results WHERE pool=? LIMIT 1', run.pool).toArray()[0]) {
        this.sql.exec("UPDATE correction_runs SET phase='complete',error=NULL WHERE id=?", run.id);
        this.sql.exec('DELETE FROM meta WHERE key=?', `paused:${run.pool}`);
        if (!this.sql.exec("SELECT 1 FROM correction_runs WHERE decision_id=? AND phase<>'complete' LIMIT 1", run.decision_id).toArray()[0]) {
          this.sql.exec("UPDATE correction_decisions SET state='complete' WHERE decision_id=?", run.decision_id);
        }
      } else this.sql.exec('UPDATE correction_runs SET next_at=? WHERE id=?', Date.now(), run.id);
    });
  }

  /** Advances one bounded step of the oldest due run, or imports the next reviewed decision. */
  async process(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const run = this.sql.exec<Run>("SELECT * FROM correction_runs WHERE phase<>'complete' AND next_at<=? ORDER BY CASE WHEN phase='publish' THEN 1 ELSE 0 END,created_at,id LIMIT 1", Date.now()).toArray()[0];
      if (run) {
        try {
          switch (run.phase) {
            case 'replay': this.replay(run); break;
            case 'stage-ratings': await this.stageRatings(run); break;
            case 'stage-games': await this.stageGames(run); break;
            case 'authority': this.replaceAuthority(run); break;
            case 'publish': await this.publish(run); break;
            case 'drain': this.drain(run); break;
          }
          if ((await this.status(run.decision_id)).complete) await this.finishOutbox(run.decision_id);
        } catch (error) {
          const reason = error instanceof Error ? error.message.slice(0, 160) : 'retry_later';
          this.sql.exec('UPDATE correction_runs SET error=?,next_at=? WHERE id=?', reason, Date.now() + RETRY_MS, run.id);
          await this.getEnv().DB.prepare('UPDATE rating_correction_outbox SET last_error=? WHERE decision_id=?').bind(reason, run.decision_id).run();
        }
      } else if (!this.active()) {
        const db = this.getEnv().DB;
        const next = await db.prepare('SELECT decision_id FROM rating_correction_outbox WHERE completed_at IS NULL ORDER BY created_at,decision_id LIMIT 1').first<{ decision_id: string }>();
        if (next) {
          try { await this.request(next.decision_id); }
          catch (error) {
            const reason = error instanceof Error ? error.message.slice(0, 160) : 'retry_later';
            await db.prepare('UPDATE rating_correction_outbox SET last_error=? WHERE decision_id=?').bind(reason, next.decision_id).run();
          }
        }
      }
      await this.ctx.storage.sync();
      await this.bridge.schedule();
    } finally { this.running = false; }
  }
}
