import type { Actor, GameResult, GameSnapshot, InitGame } from '../shared/protocol';
import { FORMATS } from '../shared/protocol';
import { getEngineLevel, STOCKFISH_BUILD } from '../shared/engine';
import { isGameId } from '../shared/gamePath';
import { acquireSeatGuard, getActorBySessionId, knownGame } from './auth';
import { newWorkAllowed } from './budget';
import { aiEnabled, type Env } from './env';
import { ApiError } from './security';

export type CasualGameInput = Pick<InitGame, 'id' | 'format' | 'ai'>;
export type CasualGameResult = { ok: true; snapshot: GameSnapshot; created: boolean }
  | { ok: false; error: { status: number; code: string; message: string } };
type Intent = {
  game_id: string; creator_id: string; reservation_id: string; payload: string;
  state: 'admitting' | 'creating' | 'live' | 'settling' | 'finished';
  created_at: number; next_at: number | null; attempts: number; error: string | null;
};
interface Bridge {
  closing(userId: string): boolean;
  refresh(): Promise<void>;
  canReserve(): boolean;
  claimStart(): boolean;
  settle(result: GameResult): Promise<{ accepted: boolean; pending: boolean }>;
}

/** Casual admission shares Competition's durable count, bytes and start gate. */
export class CasualControl {
  private running = new Map<string, Promise<GameSnapshot | null>>();

  constructor(private ctx: DurableObjectState, private getEnv: () => Env, private bridge: Bridge) {
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS casual_intents(game_id TEXT PRIMARY KEY,creator_id TEXT NOT NULL,
      reservation_id TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,created_at INTEGER NOT NULL,
      next_at INTEGER,attempts INTEGER NOT NULL DEFAULT 0,error TEXT)`);
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS casual_intent_work ON casual_intents(state,next_at,game_id)');
  }

  private intent(id: string): Intent | null {
    return this.ctx.storage.sql.exec<Intent>('SELECT * FROM casual_intents WHERE game_id=?', id).toArray()[0] ?? null;
  }

  active(): number {
    return this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM casual_intents WHERE state IN ('admitting','creating','live','settling')").one().count;
  }

  async create(claim: Actor, input: CasualGameInput): Promise<CasualGameResult> {
    try {
      const env = this.getEnv();
      if (!input || !isGameId(input.id) || !Object.hasOwn(FORMATS, input.format)
        || (input.ai && (input.ai.modelId !== STOCKFISH_BUILD || !getEngineLevel(input.ai.level)))) {
        throw new ApiError(400, 'INVALID_GAME_REQUEST', 'Choose an available format and game mode.');
      }
      const current = await getActorBySessionId(env, claim.sessionId);
      if (!current || current.id !== claim.id) throw new ApiError(401, 'SIGN_IN_REQUIRED', 'Sign in again.');
      const { id, name, isAnonymous, sessionId, sessionExpiresAt } = current;
      const actor: Actor = { id, name, isAnonymous, sessionId, sessionExpiresAt };
      const admitted = await env.DB.prepare('SELECT creator_id,storage_state,reservation_id FROM casual_game_admissions WHERE game_id=?')
        .bind(input.id).first<{ creator_id: string; storage_state: string; reservation_id: string | null }>();
      if ((admitted && admitted.creator_id !== actor.id) || (!admitted && await knownGame(env, input.id))) {
        throw new ApiError(404, 'GAME_NOT_FOUND', 'This game was not found for your session.');
      }
      if (admitted?.storage_state === 'archived') throw new ApiError(410, 'GAME_ARCHIVED', 'Open this game from your completed history.');
      // Legacy games remain accessible through new-work stops or changed limits.
      if (admitted) {
        const found = await env.GAME.get(env.GAME.idFromName(input.id)).lookup(actor);
        if (found) return { ok: true, snapshot: found, created: false };
      }
      const existing = this.intent(input.id);
      if (!existing && !admitted && !current.accountReady) throw new ApiError(403, 'ACCOUNT_REQUIRED', 'Create or complete your account to play a new game.');
      await this.bridge.refresh();
      if (existing?.state === 'finished') {
        const found = await env.GAME.get(env.GAME.idFromName(input.id)).lookup(actor);
        if (found) return { ok: true, snapshot: found, created: false };
        throw new ApiError(410, 'GAME_ARCHIVED', 'Open this game from your completed history.');
      }
      if (!existing && !admitted && !await newWorkAllowed(env, 'games')) throw new ApiError(409, 'SEAT_UNAVAILABLE', 'New games are paused. Existing games will finish.');
      if (!existing && !admitted && input.ai && !aiEnabled(env)) throw new ApiError(503, 'AI_UNAVAILABLE', 'Computer practice is unavailable. Try a casual invitation.');
      this.ctx.storage.transactionSync(() => {
        if (this.bridge.closing(actor.id)) throw new ApiError(409, 'ACCOUNT_CLOSING', 'Account closure is pending. Try again shortly.');
        const before = this.intent(input.id);
        if (before) {
          const previous = JSON.parse(before.payload) as InitGame;
          if (before.creator_id !== actor.id) throw new ApiError(404, 'GAME_NOT_FOUND', 'This game was not found for your session.');
          if (before.state !== 'finished' && (previous.format !== input.format || JSON.stringify(previous.ai ?? null) !== JSON.stringify(input.ai ?? null))) {
            throw new ApiError(409, 'GAME_INITIALIZATION_CONFLICT', 'Reopen the original game request.');
          }
          return;
        }
        if (!admitted && !this.bridge.canReserve()) throw new ApiError(409, 'SEAT_UNAVAILABLE', 'New game admission is at its safety limit. Try later.');
        const reservationId = admitted ? admitted.reservation_id ?? '' : crypto.randomUUID();
        const payload: InitGame = { ...input, white: actor, rated: false, ...(reservationId ? { reservationId } : {}) };
        this.ctx.storage.sql.exec(`INSERT INTO casual_intents(game_id,creator_id,reservation_id,payload,state,created_at,next_at)
          VALUES(?,?,?,?,'admitting',?,?)`, input.id, actor.id, reservationId, JSON.stringify(payload), Date.now(), Date.now());
      });
      await this.ctx.storage.sync();
      const initialized = await this.reconcile(input.id);
      const after = this.intent(input.id);
      const snapshot = initialized ?? (after && after.state !== 'admitting' ? await env.GAME.get(env.GAME.idFromName(input.id)).lookup(actor) : null);
      if (!snapshot) throw new ApiError(503, 'GAME_INITIALIZATION_PENDING', 'Your game request is saved. Reopen it shortly.');
      return { ok: true, snapshot, created: !admitted };
    } catch (error) {
      if (error instanceof ApiError) return { ok: false, error: { status: error.status, code: error.code, message: error.message } };
      const saved = input && isGameId(input.id) && this.intent(input.id)?.creator_id === claim.id;
      return { ok: false, error: { status: 503, code: saved ? 'GAME_INITIALIZATION_PENDING' : 'GAME_ADMISSION_UNAVAILABLE',
        message: saved ? 'Your game request is saved. Reopen it shortly.' : 'Game requests are unavailable. Try again shortly.' } };
    }
  }

  private reconcile(id: string): Promise<GameSnapshot | null> {
    const running = this.running.get(id);
    if (running) return running;
    const task = this.advance(id).finally(() => this.running.delete(id));
    this.running.set(id, task);
    return task;
  }

  private async advance(id: string): Promise<GameSnapshot | null> {
    let intent = this.intent(id);
    if (!intent) return null;
    const env = this.getEnv();
    try {
      if (intent.state === 'admitting') {
        const input = JSON.parse(intent.payload) as InitGame;
        const accepted = await acquireSeatGuard(env, input.white, id, false, true, intent.reservation_id || undefined);
        const stamp = await env.DB.prepare('SELECT reservation_id,creator_id FROM casual_game_admissions WHERE game_id=?')
          .bind(id).first<{ reservation_id: string | null; creator_id: string }>();
        if (!stamp || (stamp.reservation_id ?? '') !== intent.reservation_id || stamp.creator_id !== intent.creator_id) {
          if (!accepted && !stamp) {
            // No init was issued and its required D1 fence was never accepted.
            this.ctx.storage.sql.exec("DELETE FROM casual_intents WHERE game_id=? AND reservation_id=? AND state='admitting'", id, intent.reservation_id);
            await this.ctx.storage.sync();
            throw new ApiError(409, 'SEAT_UNAVAILABLE', 'This account cannot take another game now. Finish your unfinished game or reservation, or sign in again.');
          }
          throw new Error('casual_admission_fence');
        }
        this.ctx.storage.sql.exec("UPDATE casual_intents SET state='creating',next_at=? WHERE game_id=? AND state='admitting'", Date.now(), id);
        await this.ctx.storage.sync();
        intent = this.intent(id)!;
      }
      // A Game binding is used only after permanent D1 admission has committed.
      const game = env.GAME.get(env.GAME.idFromName(id));
      let actual = await game.status();
      let initialized: GameSnapshot | null = null;
      if (!actual && intent.state !== 'finished') {
        if (!this.bridge.claimStart()) throw new Error('game_start_rate');
        initialized = await game.init(JSON.parse(intent.payload) as InitGame);
        actual = await game.status();
      }
      if (actual?.result) await this.bridge.settle(actual.result);
      const observed = actual?.status ?? initialized?.status;
      this.ctx.storage.sql.exec(`UPDATE casual_intents SET state=?,next_at=?,attempts=0,error=NULL
        WHERE game_id=? AND state<>'finished'`, observed === 'pending-adjudication' || observed === 'finished' ? 'settling' : observed ? 'live' : 'creating', Date.now() + 30_000, id);
      await this.ctx.storage.sync();
      if (actual) return game.lookup((JSON.parse(intent.payload) as InitGame).white);
      return initialized;
    } catch (error) {
      this.ctx.storage.sql.exec(`UPDATE casual_intents SET attempts=MIN(attempts+1,1000000),next_at=?,error='Recovery is pending.'
        WHERE game_id=? AND state<>'finished'`, Date.now() + 1_000, id);
      await this.ctx.storage.sync();
      if (error instanceof ApiError) throw error;
      return null;
    }
  }

  /** Runs in the same transaction as the unique verified terminal result. */
  record(result: GameResult): void {
    const intent = this.intent(result.id);
    if (!intent || result.status !== 'finished') return;
    const input = JSON.parse(intent.payload) as InitGame;
    if (intent.state !== 'finished' && (result.rated || result.tournament || result.white.id !== intent.creator_id
      || (result.reservationId ?? '') !== intent.reservation_id || result.format !== input.format
      || (result.ai?.modelId ?? null) !== (input.ai?.modelId ?? null) || (result.ai?.level ?? null) !== (input.ai?.level ?? null))) {
      throw new Error('conflicting_casual_result');
    }
    this.ctx.storage.sql.exec("UPDATE casual_intents SET state='finished',payload='{}',next_at=NULL,error=NULL WHERE game_id=?", result.id);
  }

  async maintenance(): Promise<void> {
    const work = this.ctx.storage.sql.exec<{ game_id: string }>(`SELECT game_id FROM casual_intents
      WHERE state IN ('admitting','creating','live','settling') AND next_at<=? ORDER BY next_at,game_id LIMIT 16`, Date.now()).toArray();
    for (const row of work) { try { await this.reconcile(row.game_id); } catch { /* Definite refusal already removed its unaccepted intent. */ } }
  }

  nextDue(): number | null {
    return this.ctx.storage.sql.exec<{ due: number | null }>("SELECT MIN(next_at) AS due FROM casual_intents WHERE state IN ('admitting','creating','live','settling')").one().due;
  }

  status() {
    const row = this.ctx.storage.sql.exec<{ count: number; oldest: number | null; retrying: number }>(`SELECT COUNT(*) AS count,
      MIN(created_at) AS oldest,COALESCE(SUM(attempts>0),0) AS retrying FROM casual_intents WHERE state IN ('admitting','creating','live','settling')`).one();
    return { unfinished: row.count, oldestIntentAt: row.oldest, oldestAgeMs: row.oldest === null ? 0 : Math.max(0, Date.now() - row.oldest), retrying: row.retrying };
  }
}
