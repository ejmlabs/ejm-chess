import { DurableObject } from 'cloudflare:workers';
import { acquireSeatGuard, createAuth, currentActor, revalidateActor, type Actor as AuthActor } from './auth';
import { consumeAccountRequest } from './abuse';
import { ArenaRegistrationAdmission } from './arena-registration-admission';
import { TournamentControl } from './tournaments';
import { ArenaControl, type ArenaReservation } from './arena';
import { CasualControl, type CasualGameInput, type CasualGameResult } from './casual';
import { readArenaList, readArenaSummary } from './arena-projection';
import type { ArenaActionResult, ArenaList, ArenaMe, ArenaSummary } from '../shared/arenas';
import type { TournamentActionResult, TournamentList, TournamentView } from '../shared/tournaments';
import { ApiError } from './security';
import { newWorkAllowed, reserveMonthlyWork } from './budget';
import { advanceFarmingChecks, CATCHUP_LIMIT, farmingStatus, farmingWorkPending, initializeFarmingChecks, recordFarmingCheck } from './farming';
import { nextRetirementAt, retirementMode, retirementStatus, runScaledRetirementPass, type MaintenanceResult } from './maintenance';
import { GAME_HOT_RETENTION_MS } from './game';
import { captureNativePoint } from './recovery';
import { LEADERBOARD_COLUMNS, LEADERBOARD_VALUES, leaderboardRow } from './leaderboard';
import { initialRating, rateMatch } from './rating';
import { RatingRepair, RECORD_ID, REPAIR_BATCH } from './rating-repair';
import { nextReconcileAt, type EventBridge } from './events';
import { retryDelayMs } from './retry';
import type { Env } from './env';
import {
  FORMATS, PRIOR_RULES_VERSIONS, RATING_VERSION, RULES_VERSION,
  type Actor, type GameResult, type Pool, type QueueState, type RatingState,
} from '../shared/protocol';

const DAY = 86_400_000;
const QUEUE_LEASE_MS = 120_000;
const RETRY_MS = 30_000;
/** A pairing whose Game still does not exist after this long is cancelled, so both players can queue again. */
export const CREATION_LIFETIME_MS = 600_000;
/** After this wait a ticket also matches across regions. */
const REGION_WIDENS_MS = 30_000;
/** Ranked pairs may start at most this many games in a rolling day. */
const PAIR_GAMES_PER_DAY = 2;
const POOLS = Object.keys(FORMATS) as Pool[];
/** Per-request and per-alarm work bounds, reported by health. */
const WORK_BOUNDS = { pairScan: 128, pairBatchPerPool: 8, creationBatch: 8, reconciliationBatch: 16, projectionBatch: 16, exportPage: 50 } as const;
const JOURNAL_SCHEMA = 'ejm-chess-authority-v1';
export const JOURNALS = {
  results: { table: 'result_events', columns: 'sequence,event_id,game_id,payload,accepted_at' },
  ratings: { table: 'rating_events', columns: 'sequence,game_id,pool,policy,epoch,white_id,black_id,score,pre_white,pre_black,post_white,post_black,accepted_at' },
  correctedRatings: { table: 'corrected_events', columns: 'epoch,sequence,pool,game_id,policy,pre_white,pre_black,post_white,post_black,voided,decision_id' },
  corrections: { table: 'correction_decisions', columns: 'decision_id,payload' },
  voids: { table: 'void_decisions', columns: 'decision_id,game_id,epoch' },
  restorations: { table: 'restored_decisions', columns: 'restoring_decision_id,original_decision_id,epoch' },
  checkpoints: { table: 'checkpoints', columns: 'pool,watermark,policy,payload,digest' },
  arenaScores: { table: 'arena_receipts', columns: 'game_id,event_id,result_event_id,digest,sequence,white_half,black_half,accepted_at' },
} as const;

export type JournalKind = keyof typeof JOURNALS;
export interface AuthorityExportManifest {
  schema: typeof JOURNAL_SCHEMA;
  createdAt: number;
  ratingPolicy: string;
  rulesPolicy: string;
  watermarks: Record<JournalKind, number>;
  publishedEpochs: Record<Pool, number>;
  repairInProgress: boolean;
  pendingResults: number;
}
export interface AuthorityExportPage {
  schema: typeof JOURNAL_SCHEMA;
  kind: JournalKind;
  watermark: number;
  after: number;
  rows: Array<{ cursor: number; record: Record<string, string | number | null> }>;
  nextCursor: number | null;
  sha256: string;
}

function admissionLimit(value: string | undefined, fallback: number): number {
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit > 0 ? limit : fallback;
}

async function sha256(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

type Ticket = {
  user_id: string;
  pool: Pool;
  actor: string;
  region: string;
  joined_at: number;
  lease_until: number;
  rating: number;
};

type Match = {
  id: string;
  reservation_id: string;
  pool: Pool;
  white_id: string;
  black_id: string;
  white_actor: string;
  black_actor: string;
  status: 'creating' | 'reserved' | 'live' | 'settling' | 'finished' | 'cancelled';
  created_at: number;
  next_attempt_at: number;
  attempts: number;
};

type Acknowledgement = { accepted: boolean; pending: boolean };
type Slot = { state: 'queued' | 'reserved' | 'live' | 'settling' | 'tournament'; pool: Pool; game_id: string | null };
interface Projection {
  result: GameResult;
  epoch: number;
  version: number;
  ratings: Array<{ userId: string; state: RatingState; distinctOpponents: number }>;
  settlementPending?: boolean;
}
type Outbox = {
  id: string;
  payload: string;
  projected: number;
  attempts: number;
  next_attempt_at: number;
};

function pairKey(a: string, b: string): string { return JSON.stringify([a, b].sort()); }

/** Published matching policy: 100 rating points at join, 5 more each second of the shorter wait, up to 800. */
function ratingWindow(waitedMs: number): number { return Math.min(800, 100 + Math.floor(waitedMs / 1_000) * 5); }

export class Competition extends DurableObject<Env> {
  private registrationAuthentication = new ArenaRegistrationAdmission();
  private pumping = false;
  private flushing = false;
  private retiring = false;
  private scheduling: Promise<void> = Promise.resolve();
  /** The alarm never fires before this after a failed pass. A restart begins the count again. */
  private passRetryAt = 0;
  private failedPasses = 0;
  private queuedSchedule: { completedThrough: number | null; completion: Promise<void> } | null = null;
  protected recoveryDrill = false;
  private tournaments: TournamentControl;
  private arenas: ArenaControl;
  private casuals: CasualControl;
  private repair: RatingRepair;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS slots (user_id TEXT PRIMARY KEY,state TEXT NOT NULL,pool TEXT NOT NULL,game_id TEXT)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS queue
      (user_id TEXT PRIMARY KEY,pool TEXT NOT NULL,actor TEXT NOT NULL,region TEXT NOT NULL,joined_at INTEGER NOT NULL,lease_until INTEGER NOT NULL,rating REAL NOT NULL)`);
    sql.exec('CREATE INDEX IF NOT EXISTS queue_order ON queue(pool,joined_at,user_id)');
    sql.exec(`CREATE TABLE IF NOT EXISTS account_closure_fences
      (user_id TEXT PRIMARY KEY,request_id TEXT NOT NULL,lease_id TEXT NOT NULL,expires_at INTEGER NOT NULL,state TEXT NOT NULL)`);
    sql.exec('CREATE INDEX IF NOT EXISTS account_closure_work ON account_closure_fences(state,expires_at,user_id)');
    sql.exec(`CREATE TABLE IF NOT EXISTS matches
      (id TEXT PRIMARY KEY,reservation_id TEXT NOT NULL,pool TEXT NOT NULL,white_id TEXT NOT NULL,black_id TEXT NOT NULL,
      white_actor TEXT NOT NULL,black_actor TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,next_attempt_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0)`);
    sql.exec('CREATE INDEX IF NOT EXISTS match_work ON matches(status,next_attempt_at)');
    sql.exec(`CREATE TABLE IF NOT EXISTS ratings (pool TEXT NOT NULL,user_id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(pool,user_id))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS opponents (pool TEXT NOT NULL,user_id TEXT NOT NULL,opponent_id TEXT NOT NULL,PRIMARY KEY(pool,user_id,opponent_id))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS pair_games (game_id TEXT PRIMARY KEY,pair_key TEXT NOT NULL,started_at INTEGER NOT NULL)`);
    sql.exec('CREATE INDEX IF NOT EXISTS pair_window ON pair_games(pair_key,started_at)');
    initializeFarmingChecks(sql);
    sql.exec(`CREATE TABLE IF NOT EXISTS colors (user_id TEXT PRIMARY KEY,balance INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS result_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,game_id TEXT NOT NULL,payload TEXT NOT NULL,accepted_at INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS processed_results (game_id TEXT PRIMARY KEY,event_id TEXT NOT NULL,digest TEXT NOT NULL,sequence INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS rating_events (sequence INTEGER PRIMARY KEY,game_id TEXT NOT NULL UNIQUE,pool TEXT NOT NULL,policy TEXT NOT NULL,epoch INTEGER NOT NULL,
      white_id TEXT NOT NULL,black_id TEXT NOT NULL,score REAL NOT NULL,pre_white TEXT NOT NULL,pre_black TEXT NOT NULL,post_white TEXT NOT NULL,post_black TEXT NOT NULL,accepted_at INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY,payload TEXT NOT NULL,projected INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS incidents (id INTEGER PRIMARY KEY AUTOINCREMENT,game_id TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)`);
    sql.exec("INSERT OR IGNORE INTO meta(key,value) VALUES('epoch','1')");
    this.tournaments = new TournamentControl(ctx, () => this.env, {
      ...this.eventBridge(),
      release: tournamentId => { sql.exec("DELETE FROM slots WHERE state='tournament' AND game_id=?", tournamentId); },
      canReserve: count => this.arenas.canReserveGames(count),
      start: () => this.arenas.claimStart(),
    });
    this.arenas = new ArenaControl(ctx, () => this.env, {
      ...this.eventBridge(),
      otherGames: () => this.casuals.active() + this.unsettledGames() + sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM tournament_games g
        JOIN tournaments t ON t.id=g.tournament_id WHERE t.status IN ('starting','running','intermission')`).one().count,
    });
    this.casuals = new CasualControl(ctx, () => this.env, {
      closing: userId => this.accountClosing(userId),
      refresh: () => this.arenas.refreshLegacyGames(),
      canReserve: () => this.arenas.canReserveGames(),
      claimStart: () => this.arenas.claimStart(),
      settle: result => this.settle(result),
    });
    this.repair = new RatingRepair(ctx, () => this.env, {
      schedule: () => this.schedule(),
      release: (result, sequence, epoch) => {
        const now = Date.now();
        this.enqueue(this.applyFinished(result, sequence, epoch, now), now);
      },
    });
    if (farmingWorkPending(sql)) ctx.waitUntil(this.schedule());
  }

  /** Slots, closure fences and ratings are Competition's; tournaments and arenas reach them only through this bridge. */
  private eventBridge(): EventBridge {
    const sql = this.ctx.storage.sql;
    return {
      closing: userId => this.accountClosing(userId),
      busy: (userId, eventId) => {
        const slot = this.slot(userId);
        return this.accountClosing(userId) || Boolean(slot && (slot.state !== 'tournament' || slot.game_id !== eventId));
      },
      reserve: (userId, eventId, pool) => {
        if (this.accountClosing(userId)) throw new ApiError(409, 'ACCOUNT_CLOSING', 'Account closure is pending. Try again shortly.');
        sql.exec("INSERT INTO slots(user_id,state,pool,game_id) VALUES(?,'tournament',?,?) ON CONFLICT(user_id) DO NOTHING", userId, pool, eventId);
      },
      releaseMember: (userId, eventId) => { sql.exec("DELETE FROM slots WHERE user_id=? AND state='tournament' AND game_id=?", userId, eventId); },
      rating: (pool, userId) => this.rating(pool, userId, Date.now()).rating,
      settle: result => this.settle(result),
    };
  }

  async createCasualGame(actor: Actor, input: CasualGameInput): Promise<CasualGameResult> {
    const result = await this.casuals.create(actor, input);
    await this.schedule();
    return result;
  }

  private slot(userId: string): Slot | null {
    return this.ctx.storage.sql.exec<Slot>('SELECT state,pool,game_id FROM slots WHERE user_id=?', userId).toArray()[0] ?? null;
  }

  private accountClosing(userId: string): boolean {
    return Boolean(this.ctx.storage.sql.exec('SELECT 1 FROM account_closure_fences WHERE user_id=?', userId).toArray()[0]);
  }

  /** D1 blocks seat claims; this fence covers intents before those claims exist. */
  async reserveAccountClosure(userId: string, requestId: string, leaseId: string): Promise<boolean> {
    const lease = await this.env.DB.prepare('SELECT expires_at FROM identity_change_leases WHERE user_id=? AND lease_id=?')
      .bind(userId, leaseId).first<{ expires_at: number }>();
    if (!lease || lease.expires_at <= Date.now()) return false;
    const reserved = this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const previous = sql.exec<{ lease_id: string; expires_at: number; state: string }>('SELECT lease_id,expires_at,state FROM account_closure_fences WHERE user_id=?', userId).toArray()[0];
      if (previous && (previous.state === 'closed' || (previous.lease_id !== leaseId && previous.expires_at > Date.now()))) return false;
      const slot = this.slot(userId);
      if (slot && slot.state !== 'queued') return false;
      if (sql.exec(`SELECT 1 FROM matches WHERE (white_id=? OR black_id=?) AND status NOT IN ('finished','cancelled')
        UNION ALL SELECT 1 FROM casual_intents WHERE creator_id=? AND state<>'finished'
        UNION ALL SELECT 1 FROM arena_intents WHERE (white_id=? OR black_id=?) AND status NOT IN ('finished','cancelled')
        UNION ALL SELECT 1 FROM arena_entries WHERE user_id=? AND state IN ('claiming','queued','playing','releasing') LIMIT 1`,
      userId, userId, userId, userId, userId, userId).toArray()[0]) return false;
      sql.exec(`INSERT INTO account_closure_fences(user_id,request_id,lease_id,expires_at,state) VALUES(?,?,?,?,'pending')
        ON CONFLICT(user_id) DO UPDATE SET request_id=excluded.request_id,lease_id=excluded.lease_id,expires_at=excluded.expires_at`,
      userId, requestId, leaseId, lease.expires_at);
      sql.exec('DELETE FROM queue WHERE user_id=?', userId);
      sql.exec("DELETE FROM slots WHERE user_id=? AND state='queued'", userId);
      return true;
    });
    await this.ctx.storage.sync();
    await this.schedule();
    return reserved;
  }

  /** Called only after the D1 lease is removed, so a late batch cannot commit. */
  async settleAccountClosure(userId: string, leaseId: string): Promise<void> {
    const receipt = await this.env.DB.prepare('SELECT 1 FROM account_closure_receipts WHERE user_id=?').bind(userId).first();
    if (receipt) this.ctx.storage.sql.exec("UPDATE account_closure_fences SET state='closed' WHERE user_id=? AND lease_id=?", userId, leaseId);
    else this.ctx.storage.sql.exec("DELETE FROM account_closure_fences WHERE user_id=? AND lease_id=? AND state='pending'", userId, leaseId);
    await this.ctx.storage.sync();
    await this.schedule();
  }

  private async recoverAccountClosures(): Promise<void> {
    const rows = this.ctx.storage.sql.exec<{ user_id: string; lease_id: string }>(
      "SELECT user_id,lease_id FROM account_closure_fences WHERE state='pending' AND expires_at<=? ORDER BY expires_at,user_id LIMIT 32", Date.now()).toArray();
    let failed = false;
    for (const row of rows) {
      try {
        await this.env.DB.prepare('DELETE FROM identity_change_leases WHERE user_id=? AND lease_id=? AND expires_at<=?')
          .bind(row.user_id, row.lease_id, Date.now()).run();
        await this.settleAccountClosure(row.user_id, row.lease_id);
      } catch {
        failed = true;
        this.ctx.storage.sql.exec("UPDATE account_closure_fences SET expires_at=? WHERE user_id=? AND lease_id=? AND state='pending'", Date.now() + RETRY_MS, row.user_id, row.lease_id);
      }
    }
    if (failed) throw new Error('account_closure_recovery_unavailable');
  }

  private rating(pool: Pool, userId: string, now: number): RatingState {
    const row = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM ratings WHERE pool=? AND user_id=?', pool, userId).toArray()[0];
    return row ? JSON.parse(row.value) as RatingState : initialRating(now);
  }

  private queueView(userId: string): QueueState {
    const slot = this.slot(userId);
    if (!slot) return { status: 'idle' };
    if (slot.state === 'tournament') return { status: 'tournament', pool: slot.pool, tournamentId: slot.game_id! };
    if (slot.state === 'queued') {
      const row = this.ctx.storage.sql.exec<{ joined_at: number }>('SELECT joined_at FROM queue WHERE user_id=?', userId).toArray()[0];
      return { status: 'queued', pool: slot.pool, joinedAt: row.joined_at };
    }
    return { status: slot.state, pool: slot.pool, gameId: slot.game_id! };
  }

  async listTournaments(actor?: Actor): Promise<TournamentList> {
    const result = await this.tournaments.list(actor);
    await this.schedule();
    return result;
  }

  async getTournament(id: string, actor?: Actor): Promise<TournamentView | null> {
    const result = await this.tournaments.get(id, actor);
    await this.schedule();
    return result;
  }

  async registerTournament(actor: Actor, id: string): Promise<TournamentActionResult> {
    try {
      const value = await this.tournaments.register(actor, id);
      await this.schedule();
      return { ok: true, value };
    } catch (error) {
      if (error instanceof ApiError) return { ok: false, error: { status: error.status, code: error.code, message: error.message } };
      throw error;
    }
  }

  async withdrawTournament(actor: Actor, id: string): Promise<TournamentActionResult> {
    try { return { ok: true, value: await this.tournaments.withdraw(actor, id) }; }
    catch (error) {
      if (error instanceof ApiError) return { ok: false, error: { status: error.status, code: error.code, message: error.message } };
      throw error;
    }
  }

  async listArenas(): Promise<ArenaList> { return readArenaList(this.env); }
  async getArena(id: string): Promise<ArenaSummary | null> { return readArenaSummary(this.env.DB, id); }
  async getArenaMe(actor: Actor, id: string): Promise<ArenaMe | null> { return this.arenas.getMe(actor, id); }
  async observeArenaReservation(actor: Actor, id: string): Promise<ArenaReservation | null> { return this.arenas.reservation(actor, id); }

  private async arenaAction(actor: Actor, id: string, action: 'register' | 'withdraw' | 'queue' | 'pause'): Promise<ArenaActionResult> {
    const work = { maintenance: true };
    try {
      const value = action === 'register' ? await this.arenas.register(actor, id, work) : await this.arenas[action](actor, id);
      return { ok: true, value };
    } catch (error) {
      if (error instanceof ApiError) return { ok: false, error: { status: error.status, code: error.code, message: error.message } };
      throw error;
    } finally { if (action !== 'register' || work.maintenance) await this.schedule(); }
  }

  async registerArena(actor: Actor, id: string): Promise<ArenaActionResult> { return this.arenaAction(actor, id, 'register'); }

  /** Global auth slots end before the separate fresh arena eligibility checks. */
  async authenticateArenaRegistration(request: Request): Promise<AuthActor> {
    return this.registrationAuthentication.run(async () => {
      // Better Auth starts schema discovery in the background. Keep its first
      // query inside this admitted event, including in the native load meter.
      await (await createAuth(this.env).$context).checkSchema?.();
      const actor = await currentActor(request, this.env);
      if (!actor) throw new ApiError(401, 'SIGN_IN_REQUIRED', 'Sign in to your chess account.');
      await consumeAccountRequest(this.env.DB, actor.id, 'write');
      return actor;
    });
  }

  async registerArenaRequest(request: Request, id: string): Promise<ArenaActionResult> {
    try {
      const { id: userId, name, isAnonymous, sessionId, sessionExpiresAt } = await this.authenticateArenaRegistration(request);
      return this.registerArena({ id: userId, name, isAnonymous, sessionId, sessionExpiresAt }, id);
    } catch (error) {
      if (error instanceof ApiError) return { ok: false, error: { status: error.status, code: error.code, message: error.message } };
      throw error;
    }
  }

  async withdrawArena(actor: Actor, id: string): Promise<ArenaActionResult> { return this.arenaAction(actor, id, 'withdraw'); }
  async queueArena(actor: Actor, id: string): Promise<ArenaActionResult> { return this.arenaAction(actor, id, 'queue'); }
  async pauseArena(actor: Actor, id: string): Promise<ArenaActionResult> { return this.arenaAction(actor, id, 'pause'); }
  async resumeArena(actor: Actor, id: string): Promise<ArenaActionResult> { return this.arenaAction(actor, id, 'queue'); }

  /** Optional owner ceilings. None applies by default. */
  private admissionLimits(): { unsettledGames: number; retainedGames: number; queuedPerPool: number } {
    return {
      unsettledGames: admissionLimit(this.env.RANKED_GAME_LIMIT, Number.MAX_SAFE_INTEGER),
      retainedGames: admissionLimit(this.env.RANKED_RETAINED_GAME_LIMIT, Number.MAX_SAFE_INTEGER),
      queuedPerPool: admissionLimit(this.env.RANKED_QUEUE_LIMIT, Number.MAX_SAFE_INTEGER),
    };
  }

  private count(table: 'queue' | 'outbox' | 'incidents' | 'matches' | 'slots' | 'pending_results'): number {
    return this.ctx.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`).one().count;
  }

  private unsettledGames(): number {
    return this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM matches WHERE status IN ('creating','reserved','live','settling')").one().count;
  }

  /** The retained count grows with every ranked game, so an unset ceiling is never counted against. */
  private retainedFull(): boolean {
    const limit = this.admissionLimits().retainedGames;
    return limit < Number.MAX_SAFE_INTEGER && this.count('matches') >= limit;
  }

  private canCreateRankedGame(): boolean {
    return !this.retainedFull() && this.unsettledGames() < this.admissionLimits().unsettledGames && this.arenas.canReserveGames();
  }

  /** Private Game initialization check. A ranked Game exists only for an open reservation. */
  async hasRankedReservation(gameId: string, reservationId: string): Promise<boolean> {
    const match = this.match(gameId);
    return Boolean(match && match.reservation_id === reservationId && !['finished', 'cancelled'].includes(match.status));
  }

  async joinQueue(actor: Actor, pool: Pool, region = 'unknown'): Promise<QueueState> {
    const now = Date.now();
    if (this.env.RANKED_ENABLED !== 'true') return { status: 'closed', reason: 'Ranked play is closed.' };
    if (!Object.hasOwn(FORMATS, pool)) throw new Error('invalid_format');
    if (!await revalidateActor(actor, this.env, true)) throw new Error('ranked_ineligible');
    if (this.accountClosing(actor.id)) return { status: 'closed', reason: 'Account closure is pending.' };
    if (this.slot(actor.id)?.state === 'tournament') return this.queueView(actor.id);
    if (this.repair.paused(pool)) return { status: 'closed', reason: 'Rating repair is in progress.' };
    this.expireTickets(now);
    if (!this.slot(actor.id) && !await newWorkAllowed(this.env, 'games')) {
      return { status: 'closed', reason: 'New games are paused. Existing games will finish.' };
    }
    const admissionError = this.ctx.storage.transactionSync(() => {
      if (this.accountClosing(actor.id)) return 'Account closure is pending.';
      if (this.slot(actor.id)) return null;
      if (this.retainedFull()) return 'New ranked games are paused at the retained game limit.';
      const queued = this.ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM queue WHERE pool=?', pool).one().count;
      if (queued >= this.admissionLimits().queuedPerPool) return 'The ranked queue is full. Try again shortly.';
      const rating = this.rating(pool, actor.id, now);
      this.ctx.storage.sql.exec('INSERT INTO slots(user_id,state,pool,game_id) VALUES(?,?,?,NULL)', actor.id, 'queued', pool);
      this.ctx.storage.sql.exec('INSERT INTO queue(user_id,pool,actor,region,joined_at,lease_until,rating) VALUES(?,?,?,?,?,?,?)',
        actor.id, pool, JSON.stringify(actor), region.slice(0, 32), now, now + QUEUE_LEASE_MS, rating.rating);
      return null;
    });
    await this.ctx.storage.sync();
    if (admissionError) { await this.schedule(); return { status: 'closed', reason: admissionError }; }
    await this.pump();
    return this.queueView(actor.id);
  }

  async cancelQueue(actor: Actor): Promise<QueueState> {
    if (!await revalidateActor(actor, this.env)) throw new Error('session_invalid');
    this.ctx.storage.transactionSync(() => {
      if (this.slot(actor.id)?.state !== 'queued') return;
      this.ctx.storage.sql.exec('DELETE FROM queue WHERE user_id=?', actor.id);
      this.ctx.storage.sql.exec('DELETE FROM slots WHERE user_id=? AND state=?', actor.id, 'queued');
    });
    await this.ctx.storage.sync();
    await this.schedule();
    return this.queueView(actor.id);
  }

  async queueStatus(actor: Actor): Promise<QueueState> {
    const now = Date.now();
    if (!await revalidateActor(actor, this.env)) throw new Error('session_invalid');
    const slot = this.slot(actor.id);
    if (slot?.state === 'queued') {
      if (!await revalidateActor(actor, this.env, true) || this.repair.paused(slot.pool)) return this.cancelQueue(actor);
      this.ctx.storage.sql.exec('UPDATE queue SET lease_until=?,actor=? WHERE user_id=?', now + QUEUE_LEASE_MS, JSON.stringify(actor), actor.id);
    } else if (slot?.game_id) {
      await this.reconcile(slot.game_id);
    }
    await this.pump();
    return this.queueView(actor.id);
  }

  private expireTickets(now: number): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM slots WHERE state='queued' AND user_id IN (SELECT user_id FROM queue WHERE lease_until<=?)", now);
      this.ctx.storage.sql.exec('DELETE FROM queue WHERE lease_until<=?', now);
    });
  }

  private pairAllowed(a: string, b: string, now: number): boolean {
    const row = this.ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM pair_games WHERE pair_key=? AND started_at>?', pairKey(a, b), now - DAY).toArray()[0];
    return row.count < PAIR_GAMES_PER_DAY;
  }

  private compatible(a: Ticket, b: Ticket, now: number): boolean {
    const waited = Math.min(now - a.joined_at, now - b.joined_at);
    return a.user_id !== b.user_id && a.pool === b.pool && Math.abs(a.rating - b.rating) <= ratingWindow(waited)
      && (a.region === b.region || a.region === 'unknown' || b.region === 'unknown' || waited >= REGION_WIDENS_MS)
      && this.pairAllowed(a.user_id, b.user_id, now);
  }

  private async pair(pool: Pool): Promise<boolean> {
    const now = Date.now();
    if (this.env.RANKED_ENABLED !== 'true' || this.repair.paused(pool) || !this.canCreateRankedGame()) return false;
    const tickets = this.ctx.storage.sql.exec<Ticket>('SELECT * FROM queue WHERE pool=? AND lease_until>? ORDER BY joined_at,user_id LIMIT ?', pool, now, WORK_BOUNDS.pairScan).toArray();
    for (let i = 0; i < tickets.length; i++) {
      const first = tickets[i];
      const second = tickets.slice(i + 1).find(ticket => this.compatible(first, ticket, now));
      if (!second) continue;
      const eligibility = await Promise.all([
        revalidateActor(JSON.parse(first.actor) as Actor, this.env, true),
        revalidateActor(JSON.parse(second.actor) as Actor, this.env, true),
      ]);
      const gameId = crypto.randomUUID();
      const reserved = this.ctx.storage.transactionSync(() => {
        if (this.accountClosing(first.user_id) || this.accountClosing(second.user_id)) return false;
        if (this.slot(first.user_id)?.state !== 'queued' || this.slot(second.user_id)?.state !== 'queued') return false;
        if (!eligibility.every(Boolean)) {
          [first, second].forEach((ticket, index) => {
            if (eligibility[index]) return;
            this.ctx.storage.sql.exec('DELETE FROM queue WHERE user_id=?', ticket.user_id);
            this.ctx.storage.sql.exec("DELETE FROM slots WHERE user_id=? AND state='queued'", ticket.user_id);
          });
          return false;
        }
        if (this.repair.paused(pool) || !this.canCreateRankedGame() || !this.pairAllowed(first.user_id, second.user_id, now)) return false;
        // Fewer White games earns White. Equal balances are a coin flip.
        const [firstBalance, secondBalance] = [first, second].map(ticket =>
          this.ctx.storage.sql.exec<{ balance: number }>('SELECT balance FROM colors WHERE user_id=?', ticket.user_id).toArray()[0]?.balance ?? 0);
        const firstWhite = firstBalance < secondBalance || (firstBalance === secondBalance && crypto.getRandomValues(new Uint8Array(1))[0] % 2 === 0);
        const [white, black] = firstWhite ? [first, second] : [second, first];
        const reservationId = crypto.randomUUID();
        this.ctx.storage.sql.exec(`INSERT INTO matches(id,reservation_id,pool,white_id,black_id,white_actor,black_actor,status,created_at,next_attempt_at)
          VALUES(?,?,?,?,?,?,?,'creating',?,?)`, gameId, reservationId, pool, white.user_id, black.user_id, white.actor, black.actor, now, now);
        for (const ticket of [white, black]) {
          this.ctx.storage.sql.exec("UPDATE slots SET state='reserved',game_id=? WHERE user_id=?", gameId, ticket.user_id);
          this.ctx.storage.sql.exec('DELETE FROM queue WHERE user_id=?', ticket.user_id);
        }
        return true;
      });
      if (reserved) return true;
    }
    return false;
  }

  private match(gameId: string): Match | null {
    return this.ctx.storage.sql.exec<Match>('SELECT * FROM matches WHERE id=?', gameId).toArray()[0] ?? null;
  }

  private recordStarted(match: Match, startedAt: number): void {
    const inserted = this.ctx.storage.sql.exec<{ game_id: string }>('INSERT OR IGNORE INTO pair_games(game_id,pair_key,started_at) VALUES(?,?,?) RETURNING game_id',
      match.id, pairKey(match.white_id, match.black_id), startedAt).toArray();
    if (!inserted.length) return;
    for (const [userId, delta] of [[match.white_id, 1], [match.black_id, -1]] as const) {
      this.ctx.storage.sql.exec('INSERT INTO colors(user_id,balance) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET balance=balance+excluded.balance', userId, delta);
    }
  }

  /**
   * Frees both players and their seats. D1 goes first, so a failed release leaves the match
   * creating and the retry repeats it. Only a creating match is cancelled, never a Game that exists.
   */
  private async cancelCreating(match: Match, now: number): Promise<void> {
    await this.env.DB.prepare('UPDATE active_game_seats SET released_at=? WHERE game_id=? AND released_at IS NULL').bind(now, match.id).run();
    this.ctx.storage.transactionSync(() => {
      const cancelled = this.ctx.storage.sql.exec("UPDATE matches SET status='cancelled' WHERE id=? AND status='creating' RETURNING id", match.id).toArray();
      if (cancelled.length) this.ctx.storage.sql.exec('DELETE FROM slots WHERE game_id=?', match.id);
    });
  }

  private async initialize(match: Match): Promise<void> {
    const now = Date.now();
    const game = this.env.GAME.get(this.env.GAME.idFromName(match.id));
    try {
      const actual = await game.status();
      if (actual) { await this.reconcile(match.id, actual); return; }
      // Only an answered status call proves the Game is absent. A failed call retries and never cancels.
      if (now - match.created_at >= CREATION_LIFETIME_MS) { await this.cancelCreating(match, now); return; }
      const white = JSON.parse(match.white_actor) as Actor;
      const black = JSON.parse(match.black_actor) as Actor;
      const eligibility = await Promise.all([revalidateActor(white, this.env, true), revalidateActor(black, this.env, true)]);
      if (!eligibility.every(Boolean) || this.repair.paused(match.pool)
        || !await reserveMonthlyWork(this.env, 'games', `ranked:${match.id}`, now)) {
        await this.cancelCreating(match, now);
        return;
      }
      if (!await acquireSeatGuard(this.env, white, match.id, true)) throw new Error('ranked_admission_denied');
      try {
        if (!await acquireSeatGuard(this.env, black, match.id, true)) throw new Error('ranked_admission_denied');
      }
      catch (error) {
        await this.env.DB.prepare('UPDATE active_game_seats SET released_at=? WHERE user_id=? AND game_id=? AND released_at IS NULL').bind(now, white.id, match.id).run();
        throw error;
      }
      if (!this.arenas.claimStart()) throw new Error('game_start_rate');
      await game.init({ id: match.id, reservationId: match.reservation_id, format: match.pool, rated: true, white, black });
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec("UPDATE matches SET status='reserved',next_attempt_at=? WHERE id=? AND status='creating'", now + RETRY_MS, match.id);
      });
    } catch {
      // The attempt count includes this failure, so the first retry waits two seconds.
      this.ctx.storage.sql.exec('UPDATE matches SET attempts=attempts+1,next_attempt_at=? WHERE id=? AND status=?',
        now + retryDelayMs(match.attempts + 1), match.id, 'creating');
    }
  }

  private async reconcile(gameId: string, known?: Awaited<ReturnType<ReturnType<Env['GAME']['get']>['status']>>): Promise<void> {
    const match = this.match(gameId);
    if (!match || match.status === 'finished' || match.status === 'cancelled') return;
    const actual = known ?? await this.env.GAME.get(this.env.GAME.idFromName(gameId)).status();
    if (!actual) {
      if (match.status === 'creating') return;
      // A missing response or object must not release a reservation for a possibly live game.
      this.ctx.storage.sql.exec('UPDATE matches SET next_attempt_at=? WHERE id=?', Date.now() + RETRY_MS, gameId);
      return;
    }
    if (actual.result) {
      const acknowledgement = await this.settle(actual.result);
      if (acknowledgement.pending) this.ctx.storage.sql.exec('UPDATE matches SET next_attempt_at=? WHERE id=?', Date.now() + RETRY_MS, gameId);
      return;
    }
    const state = actual.status === 'active' ? 'live' : 'reserved';
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('UPDATE matches SET status=?,next_attempt_at=? WHERE id=?', state, nextReconcileAt(Date.now(), actual.dueAt), gameId);
      this.ctx.storage.sql.exec('UPDATE slots SET state=? WHERE game_id=?', state, gameId);
      if (state === 'live' && actual.startedAt !== null) this.recordStarted(match, actual.startedAt);
    });
  }

  /** `legacyFresh` skips the legacy count read when this maintenance pass already refreshed it. */
  private async pump(legacyFresh = false): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      if (!legacyFresh) await this.arenas.refreshLegacyGames();
      this.expireTickets(Date.now());
      for (const pool of POOLS) {
        for (let count = 0; count < WORK_BOUNDS.pairBatchPerPool && await this.pair(pool); count++) { /* bounded admission work */ }
      }
      await this.ctx.storage.sync();
      const work = this.ctx.storage.sql.exec<Match>("SELECT * FROM matches WHERE status='creating' AND next_attempt_at<=? ORDER BY next_attempt_at,id LIMIT ?", Date.now(), WORK_BOUNDS.creationBatch).toArray();
      for (const match of work) await this.initialize(match);
    } finally { this.pumping = false; await this.schedule(); }
  }

  /** The reply for a result already accepted, a conflict for a different record under its identity, or null when it is new. */
  private known(result: GameResult): Acknowledgement | { conflict: string } | null {
    const sql = this.ctx.storage.sql;
    const final = sql.exec<{ digest: string }>('SELECT digest FROM processed_results WHERE game_id=?', result.id).toArray()[0];
    if (final) return final.digest === result.terminalDigest ? { accepted: true, pending: false } : { conflict: 'conflicting_final_result' };
    const duplicate = sql.exec<{ payload: string }>('SELECT payload FROM result_events WHERE event_id=?', result.eventId).toArray()[0];
    if (!duplicate) return null;
    return duplicate.payload === JSON.stringify(result)
      ? { accepted: true, pending: result.status === 'pending-adjudication' || this.repair.holds(result.id) }
      : { conflict: 'conflicting_event' };
  }

  /** Answers a duplicate delivery, or records the conflict and refuses it. */
  private async answerKnown(result: GameResult, prior: Acknowledgement | { conflict: string }, now: number): Promise<Acknowledgement> {
    if ('conflict' in prior) {
      this.incident(result, prior.conflict, now);
      await this.ctx.storage.sync();
      throw new Error('conflicting_result');
    }
    await this.ctx.storage.sync();
    return prior;
  }

  async settle(result: GameResult): Promise<Acknowledgement> {
    const now = Date.now();
    if (!result || !RECORD_ID.test(result.id) || ![RULES_VERSION, ...PRIOR_RULES_VERSIONS].includes(result.rulesVersion) || (result.ai && result.rated)) throw new Error('invalid_result');
    if (result.black && result.white.id === result.black.id) throw new Error('self_play_result');
    const prior = this.known(result);
    if (prior) return this.answerKnown(result, prior, now);
    const actual = await this.env.GAME.get(this.env.GAME.idFromName(result.id)).status();
    if (!actual?.result || JSON.stringify(actual.result) !== JSON.stringify(result)) {
      this.incident(result, 'unverified_result', now);
      throw new Error('unverified_result');
    }
    let response: Acknowledgement | { conflict: string };
    try {
      response = this.ctx.storage.transactionSync(() => {
        // Another delivery may have committed while the Game was being asked. A thrown error rolls the
        // transaction back, so a conflict returns here and its incident is recorded after it.
        const prior = this.known(result);
        if (prior) return prior;
        const match = result.rated ? this.match(result.id) : null;
        if (result.rated && (!match || match.reservation_id !== result.reservationId || match.pool !== result.format
          || match.white_id !== result.white.id || match.black_id !== result.black?.id || match.status === 'cancelled')) throw new Error('unregistered_ranked_game');
        if (match && result.startedAt !== null) this.recordStarted(match, result.startedAt);
        const sequence = this.ctx.storage.sql.exec<{ sequence: number }>('INSERT INTO result_events(event_id,game_id,payload,accepted_at) VALUES(?,?,?,?) RETURNING sequence',
          result.eventId, result.id, JSON.stringify(result), now).toArray()[0].sequence;
        recordFarmingCheck(this.ctx.storage.sql, result, now);
        const epoch = Number(this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key='epoch'").toArray()[0].value);
        const deferred = result.rated && result.status === 'finished' && this.repair.paused(result.format);
        if (result.status === 'pending-adjudication' || deferred) {
          if (match) {
            this.ctx.storage.sql.exec("UPDATE matches SET status='settling',next_attempt_at=? WHERE id=?", now + RETRY_MS, result.id);
            this.ctx.storage.sql.exec("UPDATE slots SET state='settling' WHERE game_id=?", result.id);
          }
          if (deferred) this.repair.hold(sequence, result);
          this.enqueue({ result, epoch, version: sequence * 2, ratings: [], settlementPending: deferred }, now);
          return { accepted: true, pending: true };
        }
        this.enqueue(this.applyFinished(result, sequence, epoch, now), now);
        return { accepted: true, pending: false };
      });
    } catch (error) {
      if (error instanceof Error && ['conflicting_arena_result', 'unregistered_arena_game', 'arena_reservation_conflict', 'conflicting_casual_result', 'unregistered_ranked_game'].includes(error.message)) {
        this.incident(result, error.message, now);
        await this.ctx.storage.sync();
      }
      throw error;
    }
    if ('conflict' in response) return this.answerKnown(result, response, now);
    await this.ctx.storage.sync();
    await this.schedule();
    return response;
  }

  private enqueue(projection: Projection, now: number): void {
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO outbox(id,payload,next_attempt_at) VALUES(?,?,?)',
      `${projection.result.eventId}:${projection.epoch}:${projection.version}`, JSON.stringify(projection), now);
  }

  private applyFinished(result: GameResult, sequence: number, epoch: number, now: number): Projection {
    const projection: Projection = { result, epoch, version: sequence * 2 + 1, ratings: [] };
    this.casuals.record(result);
    if (!this.arenas.record(result, sequence, now)) this.tournaments.record(result);
    if (result.rated && !result.ai && result.outcome.score !== null && result.black && result.startedAt !== null) {
      const white = this.rating(result.format, result.white.id, result.endedAt);
      const black = this.rating(result.format, result.black.id, result.endedAt);
      const [postWhite, postBlack] = rateMatch(white, black, result.outcome.score, result.endedAt);
      this.ctx.storage.sql.exec(`INSERT INTO rating_events(sequence,game_id,pool,policy,epoch,white_id,black_id,score,pre_white,pre_black,post_white,post_black,accepted_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, sequence, result.id, result.format, RATING_VERSION, epoch,
        result.white.id, result.black.id, result.outcome.score, JSON.stringify(white), JSON.stringify(black), JSON.stringify(postWhite), JSON.stringify(postBlack), now);
      for (const [userId, opponentId, state] of [[result.white.id, result.black.id, postWhite], [result.black.id, result.white.id, postBlack]] as const) {
        this.ctx.storage.sql.exec('INSERT INTO ratings(pool,user_id,value) VALUES(?,?,?) ON CONFLICT(pool,user_id) DO UPDATE SET value=excluded.value', result.format, userId, JSON.stringify(state));
        this.ctx.storage.sql.exec('INSERT OR IGNORE INTO opponents(pool,user_id,opponent_id) VALUES(?,?,?)', result.format, userId, opponentId);
        const distinct = this.ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM opponents WHERE pool=? AND user_id=?', result.format, userId).toArray()[0].count;
        projection.ratings.push({ userId, state, distinctOpponents: distinct });
      }
    }
    this.ctx.storage.sql.exec('INSERT INTO processed_results(game_id,event_id,digest,sequence) VALUES(?,?,?,?)', result.id, result.eventId, result.terminalDigest, sequence);
    if (result.rated) {
      this.ctx.storage.sql.exec("UPDATE matches SET status='finished' WHERE id=?", result.id);
      this.ctx.storage.sql.exec('DELETE FROM slots WHERE game_id=?', result.id);
    }
    return projection;
  }

  private incident(result: GameResult, kind: string, now: number): void {
    this.ctx.storage.sql.exec('INSERT INTO incidents(game_id,kind,payload,created_at) VALUES(?,?,?,?)', result.id, kind, JSON.stringify({ eventId: result.eventId, digest: result.terminalDigest }).slice(0, 4096), now);
  }

  private async project(projection: Projection): Promise<void> {
    const { result, epoch, version } = projection;
    const now = Date.now();
    const committedEpoch = this.repair.publishedEpoch(result.format);
    const gameEpoch = Math.max(epoch, committedEpoch);
    const decisionId = this.repair.voidDecision(result.id, committedEpoch);
    const statements = [this.env.DB.prepare(`INSERT INTO games(id,pool,rated,white_id,black_id,white_name,black_name,status,reason,winner,score,
      started_at,ended_at,created_at,pgn,plies,rules_version,result_version,projection_epoch,projection_version,projected_at,settlement,rating_voided,rating_decision_id,ai_model_id,ai_actual_model,terminal_digest)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      status=excluded.status,reason=excluded.reason,winner=excluded.winner,score=excluded.score,ended_at=excluded.ended_at,pgn=excluded.pgn,
      result_version=excluded.result_version,projection_epoch=excluded.projection_epoch,projection_version=excluded.projection_version,
      projected_at=excluded.projected_at,settlement=excluded.settlement,rating_voided=excluded.rating_voided,rating_decision_id=excluded.rating_decision_id,
      ai_model_id=excluded.ai_model_id,ai_actual_model=excluded.ai_actual_model,terminal_digest=excluded.terminal_digest
      WHERE excluded.projection_epoch>games.projection_epoch OR (excluded.projection_epoch=games.projection_epoch AND excluded.projection_version>games.projection_version)`)
      .bind(result.id, result.format, result.rated ? 1 : 0, result.white.id, result.black?.id ?? null, result.white.name, result.black?.name ?? null,
        result.status, result.outcome.reason, result.outcome.winner, result.outcome.score, result.startedAt, result.endedAt, result.createdAt,
        result.pgn, result.plies, result.rulesVersion, result.version, gameEpoch, version, now,
        result.rated ? result.status === 'pending-adjudication' || projection.settlementPending ? 'pending' : 'settled' : 'unrated', decisionId ? 1 : 0, decisionId,
        result.ai?.modelId ?? null, result.ai?.actualModel ?? null, result.terminalDigest)];
    for (const rating of projection.ratings) {
      const values = await leaderboardRow(this.env.DB, result.format, rating.userId, rating.state, rating.distinctOpponents, epoch, version);
      statements.push(this.env.DB.prepare(`INSERT INTO leaderboard_entries(${LEADERBOARD_COLUMNS}) VALUES(${LEADERBOARD_VALUES})
        ON CONFLICT(pool,user_id) DO UPDATE SET display_name=excluded.display_name,rating=excluded.rating,rating_display=excluded.rating_display,
        rd=excluded.rd,vol=excluded.vol,games=excluded.games,distinct_opponents=excluded.distinct_opponents,
        last_played_at=excluded.last_played_at,eligible=excluded.eligible,epoch=excluded.epoch,version=excluded.version,projected_at=excluded.projected_at
        WHERE excluded.epoch>leaderboard_entries.epoch OR (excluded.epoch=leaderboard_entries.epoch AND excluded.version>leaderboard_entries.version)`)
        .bind(...values));
    }
    await this.env.DB.batch(statements);
    if (retirementMode(this.env) === 'scaled' && !result.rated && result.status === 'finished') {
      this.ctx.storage.sql.exec(`INSERT INTO meta(key,value) VALUES('retirement-next-at',?)
        ON CONFLICT(key) DO UPDATE SET value=CAST(MIN(CAST(meta.value AS INTEGER),CAST(excluded.value AS INTEGER)) AS TEXT)`,
      String(result.endedAt + GAME_HOT_RETENTION_MS));
    }
  }

  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const work = this.ctx.storage.sql.exec<Outbox>('SELECT * FROM outbox WHERE next_attempt_at<=? ORDER BY next_attempt_at,id LIMIT ?', Date.now(), WORK_BOUNDS.projectionBatch).toArray();
      for (const row of work) {
        try {
          const projection = JSON.parse(row.payload) as Projection;
          if (!row.projected) {
            await this.project(projection);
            this.ctx.storage.sql.exec('UPDATE outbox SET projected=1 WHERE id=?', row.id);
          }
          this.ctx.storage.sql.exec('DELETE FROM outbox WHERE id=?', row.id);
        } catch {
          // Counts this failure too, as match creation does.
          this.ctx.storage.sql.exec('UPDATE outbox SET attempts=attempts+1,next_attempt_at=? WHERE id=?',
            Date.now() + retryDelayMs(row.attempts + 1), row.id);
        }
      }
    } finally { this.flushing = false; await this.ctx.storage.sync(); await this.schedule(); }
  }

  requestCorrection(decisionId: string): Promise<{ accepted: boolean; complete: boolean; reason?: string }> { return this.repair.request(decisionId); }
  correctionStatus(decisionId: string) { return this.repair.status(decisionId); }
  processCorrections(): Promise<void> { return this.repair.process(); }

  /** Includes reserved matches before any D1 game or seat projection exists. */
  async recoveryGameIds(after = '', limit = 51): Promise<string[]> {
    if (typeof after !== 'string' || after.length > 80 || !Number.isInteger(limit) || limit < 1 || limit > 51) throw new Error('invalid_recovery_cursor');
    const sources = [['matches', 'id'], ['casual_intents', 'game_id'], ['tournament_games', 'game_id'], ['arena_intents', 'game_id']] as const;
    const pages = sources.map(([table, column]) => this.ctx.storage.sql.exec<{ id: string }>(
      `SELECT ${column} AS id FROM ${table} WHERE ${column}>? ORDER BY ${column} LIMIT ?`, after, limit).toArray().map(row => row.id));
    return [...new Set(pages.flat())].sort().slice(0, limit);
  }

  async hasRecoveryGameId(id: string): Promise<boolean> {
    return Boolean(this.ctx.storage.sql.exec(`SELECT 1 FROM matches WHERE id=? UNION ALL SELECT 1 FROM casual_intents WHERE game_id=?
      UNION ALL SELECT 1 FROM tournament_games WHERE game_id=? UNION ALL SELECT 1 FROM arena_intents WHERE game_id=? LIMIT 1`, id, id, id, id).toArray()[0]);
  }

  private journalWatermarks(): Record<JournalKind, number> {
    return Object.fromEntries(Object.entries(JOURNALS).map(([kind, journal]) => [kind,
      this.ctx.storage.sql.exec<{ watermark: number }>(`SELECT COALESCE(MAX(rowid),0) AS watermark FROM ${journal.table}`).one().watermark])) as Record<JournalKind, number>;
  }

  private publishedEpochs(): Record<Pool, number> {
    return Object.fromEntries(POOLS.map(pool => [pool, this.repair.publishedEpoch(pool)])) as Record<Pool, number>;
  }

  /** The cursor resumes a paged capture of a Competition larger than one page. See recovery.ts. */
  async captureRecoveryPoint(cursor?: string) {
    return captureNativePoint(this.ctx, { kind: 'Competition', name: 'global', policies: { rules: RULES_VERSION, ratings: RATING_VERSION } }, () => ({
      watermarks: this.journalWatermarks(),
      publishedEpochs: this.publishedEpochs(),
      matches: this.ctx.storage.sql.exec<{ status: string; count: number }>('SELECT status,COUNT(*) AS count FROM matches GROUP BY status ORDER BY status').toArray(),
      pending: Object.fromEntries((['queue', 'outbox', 'pending_results', 'slots'] as const).map(table => [table, this.count(table)])),
      repairInProgress: this.repair.active(),
    }), this.recoveryDrill, { cursor });
  }

  /** An owner-only event export. It does not export live game, auth, or private review state. */
  async beginExport(): Promise<AuthorityExportManifest> {
    await this.ctx.storage.sync();
    return this.ctx.storage.transactionSync(() => ({
      schema: JOURNAL_SCHEMA,
      createdAt: Date.now(),
      ratingPolicy: RATING_VERSION,
      rulesPolicy: RULES_VERSION,
      watermarks: this.journalWatermarks(),
      publishedEpochs: this.publishedEpochs(),
      repairInProgress: this.repair.active(),
      pendingResults: this.count('pending_results'),
    }));
  }

  async exportEvents(input: { kind: JournalKind; after?: number; watermark: number; limit?: number }): Promise<AuthorityExportPage> {
    const after = input?.after ?? 0;
    const limit = input?.limit ?? WORK_BOUNDS.exportPage;
    if (!input || !Object.hasOwn(JOURNALS, input.kind) || !Number.isSafeInteger(after) || after < 0
      || !Number.isSafeInteger(input.watermark) || input.watermark < after || !Number.isSafeInteger(limit) || limit < 1 || limit > WORK_BOUNDS.exportPage) throw new Error('invalid_export_cursor');
    const journal = JOURNALS[input.kind];
    const records = this.ctx.storage.sql.exec<Record<string, string | number | null>>(
      `SELECT rowid AS journal_cursor,${journal.columns} FROM ${journal.table} WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT ?`, after, input.watermark, limit + 1).toArray();
    const hasMore = records.length > limit;
    const rows = records.slice(0, limit).map(({ journal_cursor, ...record }) => ({ cursor: Number(journal_cursor), record }));
    const page = { schema: JOURNAL_SCHEMA, kind: input.kind, watermark: input.watermark, after, rows, nextCursor: hasMore ? rows.at(-1)!.cursor : null } as const;
    return { ...page, sha256: await sha256(JSON.stringify(page)) };
  }

  async health() {
    const now = Date.now();
    const oldestOutboxAt = this.ctx.storage.sql.exec<{ oldest: number | null }>("SELECT MIN(json_extract(payload,'$.result.endedAt')) AS oldest FROM outbox").one().oldest;
    const correction = await this.repair.backlog();
    const maintenance = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key='maintenance-error'").toArray()[0];
    return {
      rankedOpen: this.env.RANKED_ENABLED === 'true', queued: this.count('queue'),
      queuedByPool: Object.fromEntries(POOLS.map(pool => [pool, this.ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM queue WHERE pool=?', pool).one().count])),
      unsettled: this.unsettledGames(),
      retainedRankedGames: this.count('matches'),
      outbox: this.count('outbox'), incidents: this.count('incidents'), ratingPolicy: RATING_VERSION,
      farming: farmingStatus(this.ctx.storage.sql),
      arenas: this.arenas.status(),
      casuals: this.casuals.status(),
      retirement: await retirementStatus(this.env),
      outboxFailures: this.ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM outbox WHERE attempts>0').one().count,
      oldestOutboxAt, outboxLagMs: oldestOutboxAt === null ? 0 : Math.max(0, now - oldestOutboxAt),
      correctionPending: correction.pending, oldestCorrectionAt: correction.oldestAt,
      correctionLagMs: correction.oldestAt === null ? 0 : Math.max(0, now - correction.oldestAt), correctionError: correction.error,
      pendingResults: this.count('pending_results'),
      pausedPools: POOLS.filter(pool => this.repair.paused(pool)),
      limits: { ...this.admissionLimits(), queueLeaseMs: QUEUE_LEASE_MS, creationLifetimeMs: CREATION_LIFETIME_MS, ...WORK_BOUNDS, replayBatch: REPAIR_BATCH, farmingCatchUpBatch: CATCHUP_LIMIT },
      lastMaintenanceError: maintenance ? JSON.parse(maintenance.value) as { at: number; stages: string[] } : null,
    };
  }

  private schedule(completedThrough: number | null = null): Promise<void> {
    // Share only the queued pass. A running pass may already have read its
    // deadlines, so later mutations still require a fresh trailing snapshot.
    if (this.queuedSchedule) {
      if (completedThrough !== null) this.queuedSchedule.completedThrough = Math.max(
        this.queuedSchedule.completedThrough ?? completedThrough, completedThrough);
      return this.queuedSchedule.completion;
    }
    const pending: Promise<void> = this.scheduling.then(() => {
      this.queuedSchedule = null;
      return this.updateAlarm(batch.completedThrough);
    });
    const batch = { completedThrough, completion: pending };
    this.queuedSchedule = batch;
    this.scheduling = pending.catch(() => {});
    return pending;
  }

  private async updateAlarm(completedThrough: number | null): Promise<void> {
    const now = Date.now();
    let farmingDue: number | null = null;
    if (farmingWorkPending(this.ctx.storage.sql)) {
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO meta(key,value) VALUES('farming-next-at',?)", String(now + 1_000));
      farmingDue = Number(this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key='farming-next-at'").one().value);
    } else this.ctx.storage.sql.exec("DELETE FROM meta WHERE key='farming-next-at'");
    const times = [
      this.ctx.storage.sql.exec<{ due: number | null }>("SELECT MIN(expires_at) AS due FROM account_closure_fences WHERE state='pending'").toArray()[0].due,
      this.ctx.storage.sql.exec<{ due: number | null }>('SELECT MIN(lease_until) AS due FROM queue').toArray()[0].due,
      this.ctx.storage.sql.exec<{ due: number | null }>("SELECT MIN(next_attempt_at) AS due FROM matches WHERE status IN ('creating','reserved','live','settling')").toArray()[0].due,
      this.ctx.storage.sql.exec<{ due: number | null }>('SELECT MIN(next_attempt_at) AS due FROM outbox').toArray()[0].due,
      this.repair.nextDue(),
      this.tournaments.nextDue(),
      this.arenas.nextDue(),
      this.casuals.nextDue(),
      retirementMode(this.env) === 'scaled'
        ? Number(this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key='retirement-next-at'").toArray()[0]?.value) || null : null,
      farmingDue,
    ].filter((time): time is number => time !== null);
    const current = await this.ctx.storage.getAlarm();
    if (!times.length) {
      if (current !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    const due = Math.max(Date.now() + 1, this.passRetryAt, Math.min(...times));
    // A full maintenance pass may advance a deadline it has consumed. Keep
    // alarms armed after that pass began, including newly earlier work.
    if (current === null || due < current || current < this.passRetryAt || (completedThrough !== null && current <= completedThrough)) {
      await this.ctx.storage.setAlarm(due);
    }
  }

  /** Cron, manual maintenance and alarms all enter this one single-flight pass. */
  async retirePayloads(): Promise<MaintenanceResult> {
    if (retirementMode(this.env) !== 'scaled' || this.retiring) return { attempted: 0, completed: 0, failed: 0 };
    this.retiring = true;
    try { return await runScaledRetirementPass(this.env); }
    finally {
      this.retiring = false;
      let due: number | null;
      try { due = await nextRetirementAt(this.env); }
      catch { due = Date.now() + RETRY_MS; }
      if (due === null) this.ctx.storage.sql.exec("DELETE FROM meta WHERE key='retirement-next-at'");
      else this.ctx.storage.sql.exec(`INSERT INTO meta(key,value) VALUES('retirement-next-at',?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`, String(due));
      await this.ctx.storage.sync();
      await this.schedule();
    }
  }

  async maintenance(): Promise<{ completedAt: number; errors: string[] }> {
    const startedAt = Date.now();
    const errors: string[] = [];
    try { await this.recoverAccountClosures(); } catch { errors.push('account-closure'); }
    try { await this.arenas.refreshLegacyGames(); } catch { errors.push('capacity'); }
    try { advanceFarmingChecks(this.ctx.storage.sql, Date.now()); } catch { errors.push('farming'); }
    this.ctx.storage.sql.exec("DELETE FROM meta WHERE key='farming-next-at'");
    try { await this.processCorrections(); } catch { errors.push('correction'); }
    try { await this.casuals.maintenance(); } catch { errors.push('casual'); }
    try { await this.tournaments.maintenance(); } catch { errors.push('tournament'); }
    try { await this.arenas.maintenance(); } catch { errors.push('arena'); }
    const work = this.ctx.storage.sql.exec<Match>("SELECT * FROM matches WHERE status IN ('reserved','live','settling') AND next_attempt_at<=? ORDER BY next_attempt_at,id LIMIT ?", Date.now(), WORK_BOUNDS.reconciliationBatch).toArray();
    for (const match of work) {
      try { await this.reconcile(match.id); }
      catch {
        this.ctx.storage.sql.exec('UPDATE matches SET next_attempt_at=? WHERE id=?', Date.now() + RETRY_MS, match.id);
        if (!errors.includes('reconciliation')) errors.push('reconciliation');
      }
    }
    try { await this.pump(!errors.includes('capacity')); } catch { errors.push('admission'); }
    try { await this.flush(); } catch { errors.push('projection'); }
    if (retirementMode(this.env) === 'scaled') {
      try { await this.retirePayloads(); } catch { errors.push('retirement'); }
    }
    const completedAt = Date.now();
    if (errors.length) this.ctx.storage.sql.exec("INSERT INTO meta(key,value) VALUES('maintenance-error',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify({ at: completedAt, stages: errors }));
    else this.ctx.storage.sql.exec("DELETE FROM meta WHERE key='maintenance-error'");
    // A failed stage leaves its work due and skips the stages after it, so the alarm would fire again at once.
    // Isolating stages would not help, since the failed stage's own due time stays past. A floor on the alarm
    // covers every stage without per-stage bookkeeping, and a pass without a failure starts the count over.
    if (errors.length) this.passRetryAt = completedAt + retryDelayMs(this.failedPasses++);
    else this.passRetryAt = this.failedPasses = 0;
    await this.ctx.storage.sync();
    await this.schedule(startedAt);
    return { completedAt, errors };
  }

  async alarm(): Promise<void> {
    await this.maintenance();
  }
}
