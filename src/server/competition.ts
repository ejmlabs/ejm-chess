import { DurableObject } from 'cloudflare:workers';
import { Glicko2, type Player } from 'glicko2';
import { acquireSeatGuard, createAuth, currentActor, rankedEligibility, revalidateActor, type Actor as AuthActor } from './auth';
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
import { advanceFarmingChecks, farmingStatus, farmingWorkPending, initializeFarmingChecks, recordFarmingCheck } from './farming';
import { nextRetirementAt, retirementMode, retirementStatus, runScaledRetirementPass, type MaintenanceResult } from './maintenance';
import { GAME_HOT_RETENTION_MS } from './game';
import { captureNativePoint } from './recovery';
import type { Env } from './env';
import {
  FORMATS, PRIOR_RULES_VERSIONS, RATING_VERSION, RULES_VERSION,
  type Actor, type GameResult, type Pool, type QueueState, type RatingState,
} from '../shared/protocol';

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const QUEUE_LEASE_MS = 120_000;
const GENESIS_DIGEST = '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const JOURNAL_SCHEMA = 'ejm-chess-authority-v1';
const JOURNALS = {
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
  analysed: number;
  attempts: number;
  next_attempt_at: number;
};

type ReplayRun = {
  id: string; decision_id: string; pool: Pool; epoch: number; watermark: number;
  cursor: number; stage_cursor: string; game_cursor: string;
  phase: 'replay' | 'stage-ratings' | 'stage-games' | 'authority' | 'publish' | 'drain' | 'complete';
  created_at: number; next_at: number; error: string | null;
};
type RatingEvent = {
  sequence: number; game_id: string; pool: Pool; policy: string; white_id: string; black_id: string;
  score: 0 | 0.5 | 1; post_white: string;
};

/** Monday-based UTC calendar weeks, persisted so replay uses identical empty periods. */
function utcWeek(now: number): number { return Math.floor((now + 3 * DAY) / WEEK); }

export function initialRating(now: number): RatingState {
  return { rating: 1500, rd: 350, vol: 0.06, games: 0, lastPlayedAt: null, inactivityWeek: utcWeek(now), version: 0 };
}

function ratingPlayer(ranking: Glicko2, state: RatingState): Player {
  const player = ranking.makePlayer(state.rating, state.rd, state.vol);
  // The package's constructor treats zero as its default; its public setter preserves an exact zero rating.
  player.setRating(state.rating);
  return player;
}

function inactiveRating(before: RatingState, now: number): RatingState {
  const state = { ...before };
  const lastWholeWeek = utcWeek(now) - 1;
  if (state.lastPlayedAt === null || state.inactivityWeek >= lastWholeWeek) return state;
  const ranking = new Glicko2({ rating: 1500, rd: 350, vol: 0.06, tau: 0.5 });
  const player = ratingPlayer(ranking, state);
  while (state.inactivityWeek < lastWholeWeek && state.rd < 350) {
    ranking.updateRatings([]);
    state.rd = Math.min(350, player.getRd());
    state.inactivityWeek++;
  }
  state.inactivityWeek = lastWholeWeek;
  return state;
}

export function rateMatch(white: RatingState, black: RatingState, score: 0 | 0.5 | 1, now: number): [RatingState, RatingState] {
  const before = [inactiveRating(white, now), inactiveRating(black, now)];
  const ranking = new Glicko2({ rating: 1500, rd: 350, vol: 0.06, tau: 0.5 });
  const players = before.map(state => ratingPlayer(ranking, state));
  ranking.updateRatings([[players[0], players[1], score]]);
  return before.map((state, index) => {
    const next: RatingState = {
      rating: players[index].getRating(), rd: Math.min(350, players[index].getRd()), vol: players[index].getVol(),
      games: state.games + 1, lastPlayedAt: now, inactivityWeek: utcWeek(now), version: state.version + 1,
    };
    if (![next.rating, next.rd, next.vol].every(Number.isFinite) || next.rd <= 0 || next.vol <= 0) throw new Error('invalid_rating_calculation');
    return next;
  }) as [RatingState, RatingState];
}

function pairKey(a: string, b: string): string { return JSON.stringify([a, b].sort()); }

export class Competition extends DurableObject<Env> {
  private registrationAuthentication = new ArenaRegistrationAdmission();
  private pumping = false;
  private flushing = false;
  private correcting = false;
  private retiring = false;
  private scheduling: Promise<void> = Promise.resolve();
  private queuedSchedule: { completedThrough: number | null; completion: Promise<void> } | null = null;
  protected recoveryDrill = false;
  private tournaments: TournamentControl;
  private arenas: ArenaControl;
  private casuals: CasualControl;

  constructor(ctx: DurableObjectState, env: Env, internalContext?: DurableObjectState) {
    super(ctx, env);
    // The runtime always receives its real state. Only private composition can
    // supply this third argument to meter product storage and follow-on work.
    if (internalContext) { this.ctx = internalContext as typeof this.ctx; ctx = this.ctx; }
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
    sql.exec(`CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY,payload TEXT NOT NULL,projected INTEGER NOT NULL DEFAULT 0,analysed INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS incidents (id INTEGER PRIMARY KEY AUTOINCREMENT,game_id TEXT NOT NULL,kind TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT NOT NULL)`);
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
    sql.exec("INSERT OR IGNORE INTO meta(key,value) VALUES('epoch','1')");
    this.tournaments = new TournamentControl(ctx, () => this.env, {
      closing: userId => this.accountClosing(userId),
      busy: (userId, tournamentId) => {
        const slot = this.slot(userId);
        return this.accountClosing(userId) || Boolean(slot && (slot.state !== 'tournament' || slot.game_id !== tournamentId));
      },
      reserve: (userId, tournamentId, pool) => {
        if (this.accountClosing(userId)) throw new ApiError(409, 'ACCOUNT_CLOSING', 'Account closure is pending. Try again shortly.');
        sql.exec("INSERT INTO slots(user_id,state,pool,game_id) VALUES(?,'tournament',?,?) ON CONFLICT(user_id) DO NOTHING", userId, pool, tournamentId);
      },
      releaseMember: (userId, tournamentId) => { sql.exec("DELETE FROM slots WHERE user_id=? AND state='tournament' AND game_id=?", userId, tournamentId); },
      release: tournamentId => { sql.exec("DELETE FROM slots WHERE state='tournament' AND game_id=?", tournamentId); },
      rating: (pool, userId) => this.rating(pool, userId, Date.now()).rating,
      settle: result => this.settle(result),
      canReserve: count => this.arenas.canReserveGames(count),
      start: () => this.arenas.claimStart(),
    });
    this.arenas = new ArenaControl(ctx, () => this.env, {
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
      otherGames: () => this.casuals.active() + this.unsettledGames() + sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM tournament_games g
        JOIN tournaments t ON t.id=g.tournament_id WHERE t.status IN ('starting','running','intermission')`).one().count,
      settle: result => this.settle(result),
    });
    this.casuals = new CasualControl(ctx, () => this.env, {
      closing: userId => this.accountClosing(userId),
      refresh: () => this.arenas.refreshLegacyGames(),
      canReserve: () => this.arenas.canReserveGames(),
      claimStart: () => this.arenas.claimStart(),
      settle: result => this.settle(result),
    });
    if (farmingWorkPending(sql)) ctx.waitUntil(this.schedule());
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
        this.ctx.storage.sql.exec("UPDATE account_closure_fences SET expires_at=? WHERE user_id=? AND lease_id=? AND state='pending'", Date.now() + 30_000, row.user_id, row.lease_id);
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

  private poolPaused(pool: Pool): boolean {
    return Boolean(this.ctx.storage.sql.exec('SELECT 1 FROM meta WHERE key=?', `paused:${pool}`).toArray()[0]);
  }

  private admissionLimits(): { unsettledGames: number; retainedGames: number; queuedPerPool: number; hardMaximum: number } {
    return {
      unsettledGames: admissionLimit(this.env.RANKED_GAME_LIMIT, Number.MAX_SAFE_INTEGER),
      retainedGames: admissionLimit(this.env.RANKED_RETAINED_GAME_LIMIT, Number.MAX_SAFE_INTEGER),
      queuedPerPool: admissionLimit(this.env.RANKED_QUEUE_LIMIT, Number.MAX_SAFE_INTEGER),
      hardMaximum: Number.MAX_SAFE_INTEGER,
    };
  }

  private unsettledGames(): number {
    return this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM matches WHERE status IN ('creating','reserved','live','settling')").one().count;
  }

  private canCreateRankedGame(): boolean {
    const limits = this.admissionLimits();
    const retained = this.ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM matches').one().count;
    return retained < limits.retainedGames && this.unsettledGames() < limits.unsettledGames && this.arenas.canReserveGames();
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
    if (this.poolPaused(pool)) return { status: 'closed', reason: 'Rating repair is in progress.' };
    this.expireTickets(now);
    if (!this.slot(actor.id) && !await newWorkAllowed(this.env, 'games', now)) {
      return { status: 'closed', reason: 'New games are paused. Existing games will finish.' };
    }
    const admissionError = this.ctx.storage.transactionSync(() => {
      if (this.accountClosing(actor.id)) return 'Account closure is pending.';
      if (this.slot(actor.id)) return null;
      const retained = this.ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM matches').one().count;
      if (retained >= this.admissionLimits().retainedGames) return 'New ranked games are paused at the retained game limit.';
      const count = this.ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM queue WHERE pool=?', pool).one().count;
      if (count >= this.admissionLimits().queuedPerPool) return 'The ranked queue is full. Try again shortly.';
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
      if (!await revalidateActor(actor, this.env, true) || this.poolPaused(slot.pool)) return this.cancelQueue(actor);
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
    return row.count < 2;
  }

  private compatible(a: Ticket, b: Ticket, now: number): boolean {
    const waited = Math.min(now - a.joined_at, now - b.joined_at);
    const ratingWindow = Math.min(800, 100 + Math.floor(waited / 1_000) * 5);
    return a.user_id !== b.user_id && a.pool === b.pool && Math.abs(a.rating - b.rating) <= ratingWindow
      && (a.region === b.region || a.region === 'unknown' || b.region === 'unknown' || waited >= 30_000)
      && this.pairAllowed(a.user_id, b.user_id, now);
  }

  private async pair(pool: Pool): Promise<boolean> {
    const now = Date.now();
    if (this.env.RANKED_ENABLED !== 'true' || this.poolPaused(pool) || !this.canCreateRankedGame()) return false;
    const tickets = this.ctx.storage.sql.exec<Ticket>('SELECT * FROM queue WHERE pool=? AND lease_until>? ORDER BY joined_at,user_id LIMIT 128', pool, now).toArray();
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
        if (this.poolPaused(pool) || !this.canCreateRankedGame() || !this.pairAllowed(first.user_id, second.user_id, now)) return false;
        const balance = (id: string) => this.ctx.storage.sql.exec<{ balance: number }>('SELECT balance FROM colors WHERE user_id=?', id).toArray()[0]?.balance ?? 0;
        const firstWhite = balance(first.user_id) < balance(second.user_id)
          || (balance(first.user_id) === balance(second.user_id) && crypto.getRandomValues(new Uint8Array(1))[0] % 2 === 0);
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

  private async initialize(match: Match): Promise<void> {
    const now = Date.now();
    const game = this.env.GAME.get(this.env.GAME.idFromName(match.id));
    try {
      const actual = await game.status();
      if (actual) { await this.reconcile(match.id, actual); return; }
      const white = JSON.parse(match.white_actor) as Actor;
      const black = JSON.parse(match.black_actor) as Actor;
      const eligibility = await Promise.all([revalidateActor(white, this.env, true), revalidateActor(black, this.env, true)]);
      if (!eligibility.every(Boolean) || this.poolPaused(match.pool)
        || !await reserveMonthlyWork(this.env, 'games', `ranked:${match.id}`, now)) {
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec("UPDATE matches SET status='cancelled' WHERE id=? AND status='creating'", match.id);
          this.ctx.storage.sql.exec('DELETE FROM slots WHERE game_id=?', match.id);
        });
        await this.env.DB.prepare('UPDATE active_game_seats SET released_at=? WHERE game_id=? AND released_at IS NULL').bind(now, match.id).run();
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
        this.ctx.storage.sql.exec("UPDATE matches SET status='reserved',next_attempt_at=? WHERE id=? AND status='creating'", now + 30_000, match.id);
      });
    } catch {
      this.ctx.storage.sql.exec('UPDATE matches SET attempts=attempts+1,next_attempt_at=? WHERE id=? AND status=?',
        now + Math.min(300_000, 1_000 * 2 ** Math.min(match.attempts + 1, 8)), match.id, 'creating');
    }
  }

  private async reconcile(gameId: string, known?: Awaited<ReturnType<ReturnType<Env['GAME']['get']>['status']>>): Promise<void> {
    const match = this.match(gameId);
    if (!match || match.status === 'finished' || match.status === 'cancelled') return;
    const actual = known ?? await this.env.GAME.get(this.env.GAME.idFromName(gameId)).status();
    if (!actual) {
      if (match.status === 'creating') return;
      // A missing response or object must not release a reservation for a possibly live game.
      this.ctx.storage.sql.exec('UPDATE matches SET next_attempt_at=? WHERE id=?', Date.now() + 30_000, gameId);
      return;
    }
    if (actual.result) {
      const acknowledgement = await this.settle(actual.result);
      if (acknowledgement.pending) this.ctx.storage.sql.exec('UPDATE matches SET next_attempt_at=? WHERE id=?', Date.now() + 30_000, gameId);
      return;
    }
    const state = actual.status === 'active' ? 'live' : 'reserved';
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('UPDATE matches SET status=?,next_attempt_at=? WHERE id=?', state, Date.now() + 30_000, gameId);
      this.ctx.storage.sql.exec('UPDATE slots SET state=? WHERE game_id=?', state, gameId);
      if (state === 'live' && actual.startedAt !== null) this.recordStarted(match, actual.startedAt);
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      await this.arenas.refreshLegacyGames();
      this.expireTickets(Date.now());
      for (const pool of ['blitz', 'rapid'] as const) {
        for (let count = 0; count < 8 && await this.pair(pool); count++) { /* bounded admission work */ }
      }
      await this.ctx.storage.sync();
      const work = this.ctx.storage.sql.exec<Match>("SELECT * FROM matches WHERE status='creating' AND next_attempt_at<=? ORDER BY next_attempt_at,id LIMIT 8", Date.now()).toArray();
      for (const match of work) await this.initialize(match);
    } finally { this.pumping = false; await this.schedule(); }
  }

  async settle(result: GameResult): Promise<{ accepted: boolean; pending: boolean }> {
    const now = Date.now();
    if (!result || !/^[\w-]{8,100}$/.test(result.id) || ![RULES_VERSION, ...PRIOR_RULES_VERSIONS].includes(result.rulesVersion) || (result.ai && result.rated)) throw new Error('invalid_result');
    if (result.black && result.white.id === result.black.id) throw new Error('self_play_result');
    const previous = this.ctx.storage.sql.exec<{ digest: string }>('SELECT digest FROM processed_results WHERE game_id=?', result.id).toArray()[0];
    if (previous) {
      if (previous.digest === result.terminalDigest) { await this.ctx.storage.sync(); return { accepted: true, pending: false }; }
      this.incident(result, 'conflicting_final_result', now);
      throw new Error('conflicting_result');
    }
    const duplicate = this.ctx.storage.sql.exec<{ payload: string }>('SELECT payload FROM result_events WHERE event_id=?', result.eventId).toArray()[0];
    if (duplicate) {
      if (duplicate.payload === JSON.stringify(result)) {
        await this.ctx.storage.sync();
        return { accepted: true, pending: result.status === 'pending-adjudication' || this.resultPending(result.id) };
      }
      this.incident(result, 'conflicting_event', now);
      throw new Error('conflicting_result');
    }
    const actual = await this.env.GAME.get(this.env.GAME.idFromName(result.id)).status();
    if (!actual?.result || JSON.stringify(actual.result) !== JSON.stringify(result)) {
      this.incident(result, 'unverified_result', now);
      throw new Error('unverified_result');
    }
    let response: { accepted: boolean; pending: boolean };
    try {
      response = this.ctx.storage.transactionSync(() => {
      const final = this.ctx.storage.sql.exec<{ digest: string }>('SELECT digest FROM processed_results WHERE game_id=?', result.id).toArray()[0];
      if (final) {
        if (final.digest !== result.terminalDigest) throw new Error('conflicting_result');
        return { accepted: true, pending: false };
      }
      const duplicate = this.ctx.storage.sql.exec<{ payload: string }>('SELECT payload FROM result_events WHERE event_id=?', result.eventId).toArray()[0];
      if (duplicate) {
        if (duplicate.payload !== JSON.stringify(result)) throw new Error('conflicting_result');
        return { accepted: true, pending: result.status === 'pending-adjudication' || this.resultPending(result.id) };
      }
      const match = result.rated ? this.match(result.id) : null;
      if (result.rated && (!match || match.reservation_id !== result.reservationId || match.pool !== result.format
        || match.white_id !== result.white.id || match.black_id !== result.black?.id || match.status === 'cancelled')) throw new Error('unregistered_ranked_game');
      if (match && result.startedAt !== null) this.recordStarted(match, result.startedAt);
      const sequence = this.ctx.storage.sql.exec<{ sequence: number }>('INSERT INTO result_events(event_id,game_id,payload,accepted_at) VALUES(?,?,?,?) RETURNING sequence',
        result.eventId, result.id, JSON.stringify(result), now).toArray()[0].sequence;
      recordFarmingCheck(this.ctx.storage.sql, result, now);
      const epoch = Number(this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key='epoch'").toArray()[0].value);
      const deferred = result.rated && result.status === 'finished' && this.poolPaused(result.format);
      const projection: Projection = { result, epoch, version: sequence * 2, ratings: [], settlementPending: deferred };
      if (result.status === 'pending-adjudication' || deferred) {
        if (match) {
          this.ctx.storage.sql.exec("UPDATE matches SET status='settling',next_attempt_at=? WHERE id=?", now + 30_000, result.id);
          this.ctx.storage.sql.exec("UPDATE slots SET state='settling' WHERE game_id=?", result.id);
        }
        if (deferred) this.ctx.storage.sql.exec('INSERT INTO pending_results(sequence,game_id,pool,payload) VALUES(?,?,?,?)', sequence, result.id, result.format, JSON.stringify(result));
      } else {
        const finalProjection = this.applyFinished(result, sequence, epoch, now);
        this.enqueue(finalProjection, now);
        return { accepted: true, pending: false };
      }
      this.enqueue(projection, now);
      return { accepted: true, pending: true };
      });
    } catch (error) {
      if (error instanceof Error && ['conflicting_arena_result', 'unregistered_arena_game', 'arena_reservation_conflict', 'conflicting_casual_result'].includes(error.message)) {
        this.incident(result, error.message, now);
        await this.ctx.storage.sync();
      }
      throw error;
    }
    await this.ctx.storage.sync();
    await this.schedule();
    return response;
  }

  private resultPending(gameId: string): boolean {
    return Boolean(this.ctx.storage.sql.exec('SELECT 1 FROM pending_results WHERE game_id=?', gameId).toArray()[0]);
  }

  private enqueue(projection: Projection, now: number): void {
    const result = projection.result;
    const analysisNeeded = this.env.ANALYSIS_ENABLED === 'true' && result.rated && !result.ai
      && result.status === 'finished' && result.outcome.score !== null && !projection.settlementPending;
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO outbox(id,payload,analysed,next_attempt_at) VALUES(?,?,?,?)',
      `${result.eventId}:${projection.epoch}:${projection.version}`, JSON.stringify(projection), analysisNeeded ? 0 : 1, now);
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
    const committedEpoch = Number(this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM meta WHERE key=?', `published-epoch:${result.format}`).toArray()[0]?.value ?? 1);
    const gameEpoch = Math.max(epoch, committedEpoch);
    const decisionId = this.voidDecision(result.id, committedEpoch);
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
      const values = await this.leaderboardValues(result.format, rating.userId, rating.state, rating.distinctOpponents, epoch, version);
      statements.push(this.env.DB.prepare(`INSERT INTO leaderboard_entries(pool,user_id,display_name,rating,rating_display,rd,vol,games,distinct_opponents,
        account_created_at,last_played_at,eligible,epoch,version,projected_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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

  private async leaderboardValues(pool: Pool, userId: string, state: RatingState, distinct: number, epoch: number, version: number): Promise<Array<string | number>> {
    const now = Date.now();
    const user = await this.env.DB.prepare('SELECT name,createdAt FROM user WHERE id=?').bind(userId).first<{ name: string; createdAt: string }>();
    if (!user) throw new Error('rating_profile_missing');
    const createdAt = Date.parse(user.createdAt);
    if (!Number.isFinite(createdAt)) throw new Error('invalid_account_age');
    const eligible = state.games >= 20 && distinct >= 8 && now - createdAt >= 7 * DAY && state.rd <= 100
      && state.lastPlayedAt !== null && now - state.lastPlayedAt <= 30 * DAY && (await rankedEligibility(this.env, userId)).eligible;
    return [pool, userId, user.name.slice(0, 80), state.rating, Math.round(state.rating), state.rd, state.vol, state.games, distinct,
      createdAt, state.lastPlayedAt ?? 0, eligible ? 1 : 0, epoch, version, now];
  }

  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const work = this.ctx.storage.sql.exec<Outbox>('SELECT * FROM outbox WHERE next_attempt_at<=? ORDER BY next_attempt_at,id LIMIT 16', Date.now()).toArray();
      for (const row of work) {
        try {
          const projection = JSON.parse(row.payload) as Projection;
          if (!row.projected) {
            await this.project(projection);
            this.ctx.storage.sql.exec('UPDATE outbox SET projected=1 WHERE id=?', row.id);
          }
          if (!row.analysed && this.env.ANALYSIS_ENABLED === 'true') {
            if (!this.env.ANALYSIS_QUEUE) throw new Error('analysis_unavailable');
            await this.env.ANALYSIS_QUEUE.send({ gameId: projection.result.id, resultVersion: projection.result.version,
              rulesVersion: projection.result.rulesVersion, priority: 'sample', engineVersion: 'stockfish-17.1', profileVersion: 'screen-v1' });
            this.ctx.storage.sql.exec('UPDATE outbox SET analysed=1 WHERE id=?', row.id);
          }
          this.ctx.storage.sql.exec('DELETE FROM outbox WHERE id=?', row.id);
        } catch {
          this.ctx.storage.sql.exec('UPDATE outbox SET attempts=attempts+1,next_attempt_at=? WHERE id=?',
            Date.now() + Math.min(300_000, 1_000 * 2 ** Math.min(row.attempts + 1, 8)), row.id);
        }
      }
    } finally { this.flushing = false; await this.ctx.storage.sync(); await this.schedule(); }
  }

  /** Import only an immutable, human-reviewed decision already present in the private outbox. */
  async requestCorrection(decisionId: string): Promise<{ accepted: boolean; complete: boolean; reason?: string }> {
    const now = Date.now();
    if (!/^[\w-]{8,100}$/.test(decisionId)) throw new Error('invalid_decision');
    const existing = this.ctx.storage.sql.exec<{ state: string }>('SELECT state FROM correction_decisions WHERE decision_id=?', decisionId).toArray()[0];
    if (existing) {
      if (existing.state === 'complete') await this.finishCorrectionOutbox(decisionId);
      return { accepted: true, complete: existing.state === 'complete' };
    }
    const decision = await this.env.DB.prepare(`SELECT d.id,d.case_id,d.subject_id,d.outcome,d.affected_game_ids,d.created_at,o.action
      FROM fairplay_decisions d JOIN rating_correction_outbox o ON o.decision_id=d.id WHERE d.id=?`).bind(decisionId).first<{
      id: string; case_id: string; subject_id: string; outcome: string; affected_game_ids: string; created_at: number; action: 'review_replay' | 'reverse_replay';
    }>();
    if (!decision || (decision.action === 'review_replay' && decision.outcome !== 'restrict')
      || (decision.action === 'reverse_replay' && !['clear', 'overturn'].includes(decision.outcome))) throw new Error('unapproved_correction');
    let targets: Array<{ id: string; affected_game_ids: string }> = [];
    if (decision.action === 'reverse_replay') {
      const query = decision.outcome === 'overturn'
        ? this.env.DB.prepare(`SELECT d.id,d.affected_game_ids FROM fairplay_appeals a JOIN fairplay_decisions d ON d.id=a.decision_id
          WHERE a.outcome_decision_id=? AND d.outcome='restrict'`).bind(decisionId)
        : this.env.DB.prepare("SELECT id,affected_game_ids FROM fairplay_decisions WHERE case_id=? AND outcome='restrict' AND created_at<=? ORDER BY created_at,id").bind(decision.case_id, decision.created_at);
      targets = (await query.all<{ id: string; affected_game_ids: string }>()).results;
    }
    const gameIds = [...new Set((decision.action === 'review_replay' ? [decision] : targets)
      .flatMap(item => {
        const value: unknown = JSON.parse(item.affected_game_ids);
        if (!Array.isArray(value) || value.length > 20 || value.some(id => typeof id !== 'string' || !/^[\w-]{8,100}$/.test(id))) throw new Error('invalid_affected_games');
        return value as string[];
      }))];
    const pools = new Set<Pool>();
    for (const gameId of gameIds) {
      const event = this.ctx.storage.sql.exec<{ pool: Pool }>('SELECT pool FROM rating_events WHERE game_id=?', gameId).toArray()[0];
      if (event) pools.add(event.pool);
    }
    const digest = await sha256('[]');
    if (digest !== GENESIS_DIGEST) throw new Error('checkpoint_verification_failed');
    const response = this.ctx.storage.transactionSync(() => {
      const duplicate = this.ctx.storage.sql.exec<{ state: string }>('SELECT state FROM correction_decisions WHERE decision_id=?', decisionId).toArray()[0];
      if (duplicate) return { accepted: true, complete: duplicate.state === 'complete' };
      if (this.ctx.storage.sql.exec("SELECT 1 FROM correction_runs WHERE phase<>'complete' LIMIT 1").toArray()[0]) return { accepted: false, complete: false, reason: 'Earlier rating repair is in progress.' };
      const epoch = Number(this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key='epoch'").one().value) + 1;
      const watermark = this.ctx.storage.sql.exec<{ watermark: number }>('SELECT COALESCE(MAX(sequence),0) AS watermark FROM rating_events').one().watermark;
      this.ctx.storage.sql.exec('INSERT INTO correction_decisions(decision_id,payload,state) VALUES(?,?,?)', decisionId,
        JSON.stringify({ decisionId, subjectId: decision.subject_id, action: decision.action, gameIds, restores: targets.map(item => item.id), epoch, watermark }), pools.size ? 'running' : 'complete');
      if (decision.action === 'review_replay') {
        for (const id of gameIds) this.ctx.storage.sql.exec('INSERT INTO void_decisions(decision_id,game_id,epoch) VALUES(?,?,?)', decisionId, id, epoch);
      } else {
        for (const target of targets) this.ctx.storage.sql.exec('INSERT INTO restored_decisions(restoring_decision_id,original_decision_id,epoch) VALUES(?,?,?)', decisionId, target.id, epoch);
      }
      for (const pool of pools) {
        this.ctx.storage.sql.exec('INSERT OR IGNORE INTO checkpoints(pool,watermark,policy,payload,digest) VALUES(?,0,?,?,?)', pool, RATING_VERSION, '[]', digest);
        const checkpoint = this.ctx.storage.sql.exec<{ watermark: number; policy: string; payload: string; digest: string }>('SELECT * FROM checkpoints WHERE pool=?', pool).one();
        if (checkpoint.watermark !== 0 || checkpoint.policy !== RATING_VERSION || checkpoint.payload !== '[]' || checkpoint.digest !== digest) throw new Error('checkpoint_verification_failed');
        this.ctx.storage.sql.exec("INSERT INTO correction_runs(id,decision_id,pool,epoch,watermark,phase,created_at,next_at) VALUES(?,?,?,?,?,'replay',?,?)", `${decisionId}:${pool}`, decisionId, pool, epoch, watermark, now, now);
        this.ctx.storage.sql.exec('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', `paused:${pool}`, decisionId);
        this.ctx.storage.sql.exec("DELETE FROM slots WHERE pool=? AND state='queued'", pool);
        this.ctx.storage.sql.exec('DELETE FROM queue WHERE pool=?', pool);
      }
      return { accepted: true, complete: pools.size === 0 };
    });
    await this.ctx.storage.sync();
    if (response.complete) await this.finishCorrectionOutbox(decisionId);
    await this.schedule();
    return response;
  }

  private async finishCorrectionOutbox(decisionId: string): Promise<void> {
    const runs = this.ctx.storage.sql.exec<{ id: string }>("SELECT id FROM correction_runs WHERE decision_id=? AND phase='complete'", decisionId).toArray();
    await this.env.DB.batch([
      ...runs.flatMap(run => [
        this.env.DB.prepare('DELETE FROM leaderboard_rebuild WHERE run_id=?').bind(run.id),
        this.env.DB.prepare('DELETE FROM rating_rebuild_games WHERE run_id=?').bind(run.id),
      ]),
      this.env.DB.prepare('UPDATE rating_correction_outbox SET completed_at=COALESCE(completed_at,?),last_error=NULL WHERE decision_id=?').bind(Date.now(), decisionId),
    ]);
    this.ctx.storage.transactionSync(() => {
      for (const run of runs) {
        this.ctx.storage.sql.exec('DELETE FROM shadow_ratings WHERE run_id=?', run.id);
        this.ctx.storage.sql.exec('DELETE FROM shadow_opponents WHERE run_id=?', run.id);
        this.ctx.storage.sql.exec('DELETE FROM correction_game_projection WHERE run_id=?', run.id);
      }
    });
  }

  async correctionStatus(decisionId: string): Promise<{ complete: boolean; runs: Array<{ pool: Pool; phase: string; cursor: number; watermark: number; error: string | null }> }> {
    const decision = this.ctx.storage.sql.exec<{ state: string }>('SELECT state FROM correction_decisions WHERE decision_id=?', decisionId).toArray()[0];
    const runs = this.ctx.storage.sql.exec<{ pool: Pool; phase: string; cursor: number; watermark: number; error: string | null }>('SELECT pool,phase,cursor,watermark,error FROM correction_runs WHERE decision_id=? ORDER BY pool', decisionId).toArray();
    return { complete: decision?.state === 'complete', runs };
  }

  private voidDecision(gameId: string, epoch = Number.MAX_SAFE_INTEGER): string | null {
    return this.ctx.storage.sql.exec<{ decision_id: string }>(`SELECT decision_id FROM void_decisions v WHERE game_id=?
      AND v.epoch<=? AND NOT EXISTS(SELECT 1 FROM restored_decisions r WHERE r.original_decision_id=v.decision_id AND r.epoch<=?) ORDER BY decision_id LIMIT 1`, gameId, epoch, epoch).toArray()[0]?.decision_id ?? null;
  }

  private shadowRating(run: ReplayRun, userId: string, now: number): RatingState {
    const row = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM shadow_ratings WHERE run_id=? AND user_id=?', run.id, userId).toArray()[0];
    return row ? JSON.parse(row.value) as RatingState : initialRating(now);
  }

  private replay(run: ReplayRun): void {
    this.ctx.storage.transactionSync(() => {
      const events = this.ctx.storage.sql.exec<RatingEvent>('SELECT sequence,game_id,pool,policy,white_id,black_id,score,post_white FROM rating_events WHERE pool=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT 20', run.pool, run.cursor, run.watermark).toArray();
      for (const event of events) {
        if (event.policy !== RATING_VERSION) throw new Error('unsupported_rating_policy');
        const now = (JSON.parse(event.post_white) as RatingState).lastPlayedAt;
        if (now === null) throw new Error('invalid_rating_event_time');
        const white = this.shadowRating(run, event.white_id, now);
        const black = this.shadowRating(run, event.black_id, now);
        const decisionId = this.voidDecision(event.game_id);
        const [postWhite, postBlack] = decisionId ? [white, black] : rateMatch(white, black, event.score, now);
        for (const [userId, opponentId, value] of [[event.white_id, event.black_id, postWhite], [event.black_id, event.white_id, postBlack]] as const) {
          this.ctx.storage.sql.exec('INSERT INTO shadow_ratings(run_id,user_id,value) VALUES(?,?,?) ON CONFLICT(run_id,user_id) DO UPDATE SET value=excluded.value', run.id, userId, JSON.stringify(value));
          if (!decisionId) this.ctx.storage.sql.exec('INSERT OR IGNORE INTO shadow_opponents(run_id,user_id,opponent_id) VALUES(?,?,?)', run.id, userId, opponentId);
        }
        this.ctx.storage.sql.exec(`INSERT INTO corrected_events(epoch,sequence,pool,game_id,policy,pre_white,pre_black,post_white,post_black,voided,decision_id)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`, run.epoch, event.sequence, run.pool, event.game_id, event.policy,
          JSON.stringify(white), JSON.stringify(black), JSON.stringify(postWhite), JSON.stringify(postBlack), decisionId ? 1 : 0, decisionId);
        this.ctx.storage.sql.exec('INSERT INTO correction_game_projection(run_id,game_id,voided,decision_id) VALUES(?,?,?,?)', run.id, event.game_id, decisionId ? 1 : 0, decisionId);
      }
      this.ctx.storage.sql.exec('UPDATE correction_runs SET cursor=?,phase=?,next_at=?,error=NULL WHERE id=?', events.at(-1)?.sequence ?? run.cursor, events.length < 20 ? 'stage-ratings' : 'replay', Date.now(), run.id);
    });
  }

  private async stageRatings(run: ReplayRun): Promise<void> {
    const rows = this.ctx.storage.sql.exec<{ user_id: string; value: string; distinct_opponents: number }>(`SELECT s.user_id,s.value,
      (SELECT COUNT(*) FROM shadow_opponents o WHERE o.run_id=s.run_id AND o.user_id=s.user_id) AS distinct_opponents
      FROM shadow_ratings s WHERE run_id=? AND user_id>? ORDER BY user_id LIMIT 20`, run.id, run.stage_cursor).toArray();
    const statements: D1PreparedStatement[] = [];
    for (const row of rows) {
      const values = await this.leaderboardValues(run.pool, row.user_id, JSON.parse(row.value) as RatingState, row.distinct_opponents, run.epoch, run.watermark * 2 + 1);
      statements.push(this.env.DB.prepare(`INSERT INTO leaderboard_rebuild(run_id,pool,user_id,display_name,rating,rating_display,rd,vol,games,distinct_opponents,
        account_created_at,last_played_at,eligible,epoch,version,projected_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(run_id,user_id) DO NOTHING`).bind(run.id, ...values));
    }
    if (statements.length) await this.env.DB.batch(statements);
    this.ctx.storage.sql.exec('UPDATE correction_runs SET stage_cursor=?,phase=?,next_at=?,error=NULL WHERE id=?', rows.at(-1)?.user_id ?? run.stage_cursor, rows.length < 20 ? 'stage-games' : 'stage-ratings', Date.now(), run.id);
  }

  private async stageGames(run: ReplayRun): Promise<void> {
    const rows = this.ctx.storage.sql.exec<{ game_id: string; voided: number; decision_id: string | null }>('SELECT game_id,voided,decision_id FROM correction_game_projection WHERE run_id=? AND game_id>? ORDER BY game_id LIMIT 20', run.id, run.game_cursor).toArray();
    if (rows.length) await this.env.DB.batch(rows.map(row => this.env.DB.prepare('INSERT INTO rating_rebuild_games(run_id,game_id,voided,decision_id) VALUES(?,?,?,?) ON CONFLICT(run_id,game_id) DO NOTHING').bind(run.id, row.game_id, row.voided, row.decision_id)));
    this.ctx.storage.sql.exec('UPDATE correction_runs SET game_cursor=?,phase=?,next_at=?,error=NULL WHERE id=?', rows.at(-1)?.game_id ?? run.game_cursor, rows.length < 20 ? 'authority' : 'stage-games', Date.now(), run.id);
  }

  private replaceAuthority(run: ReplayRun): void {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM ratings WHERE pool=?', run.pool);
      this.ctx.storage.sql.exec('INSERT INTO ratings(pool,user_id,value) SELECT ?,user_id,value FROM shadow_ratings WHERE run_id=?', run.pool, run.id);
      this.ctx.storage.sql.exec('DELETE FROM opponents WHERE pool=?', run.pool);
      this.ctx.storage.sql.exec('INSERT INTO opponents(pool,user_id,opponent_id) SELECT ?,user_id,opponent_id FROM shadow_opponents WHERE run_id=?', run.pool, run.id);
      this.ctx.storage.sql.exec("UPDATE meta SET value=? WHERE key='epoch'", String(run.epoch));
      this.ctx.storage.sql.exec('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', `pool-epoch:${run.pool}`, String(run.epoch));
      this.ctx.storage.sql.exec("UPDATE correction_runs SET phase='publish',next_at=?,error=NULL WHERE id=?", Date.now(), run.id);
    });
  }

  private async publishCorrection(run: ReplayRun): Promise<void> {
    const runs = this.ctx.storage.sql.exec<ReplayRun>("SELECT * FROM correction_runs WHERE decision_id=? AND phase<>'complete' ORDER BY pool", run.decision_id).toArray();
    if (runs.some(item => item.phase !== 'publish')) return;
    const statements: D1PreparedStatement[] = [];
    for (const current of runs) statements.push(
      this.env.DB.prepare('DELETE FROM leaderboard_entries WHERE pool=?').bind(current.pool),
      this.env.DB.prepare(`INSERT INTO leaderboard_entries(pool,user_id,display_name,rating,rating_display,rd,vol,games,distinct_opponents,
        account_created_at,last_played_at,eligible,epoch,version,projected_at) SELECT pool,user_id,display_name,rating,rating_display,rd,vol,games,distinct_opponents,
        account_created_at,last_played_at,eligible,epoch,version,projected_at FROM leaderboard_rebuild WHERE run_id=?`).bind(current.id),
      this.env.DB.prepare(`UPDATE games SET rating_voided=(SELECT voided FROM rating_rebuild_games r WHERE r.run_id=? AND r.game_id=games.id),
        rating_decision_id=(SELECT decision_id FROM rating_rebuild_games r WHERE r.run_id=? AND r.game_id=games.id),projection_epoch=?,projection_version=MAX(projection_version,?)
        WHERE id IN (SELECT game_id FROM rating_rebuild_games WHERE run_id=?)`).bind(current.id, current.id, current.epoch, current.watermark * 2 + 1, current.id),
      this.env.DB.prepare(`INSERT INTO competition_generations(pool,epoch,watermark,updated_at) VALUES(?,?,?,?) ON CONFLICT(pool) DO UPDATE SET
        epoch=excluded.epoch,watermark=excluded.watermark,updated_at=excluded.updated_at WHERE excluded.epoch>=competition_generations.epoch`).bind(current.pool, current.epoch, current.watermark, Date.now()),
    );
    await this.env.DB.batch(statements);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("UPDATE correction_runs SET phase='drain',next_at=?,error=NULL WHERE decision_id=? AND phase='publish'", Date.now(), run.decision_id);
      for (const current of runs) this.ctx.storage.sql.exec('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', `published-epoch:${current.pool}`, String(current.epoch));
    });
  }

  private drain(run: ReplayRun): void {
    this.ctx.storage.transactionSync(() => {
      const rows = this.ctx.storage.sql.exec<{ sequence: number; payload: string }>('SELECT sequence,payload FROM pending_results WHERE pool=? ORDER BY sequence LIMIT 20', run.pool).toArray();
      for (const row of rows) {
        const result = JSON.parse(row.payload) as GameResult;
        const projection = this.applyFinished(result, row.sequence, run.epoch, Date.now());
        this.enqueue(projection, Date.now());
        this.ctx.storage.sql.exec('DELETE FROM pending_results WHERE sequence=?', row.sequence);
      }
      if (!this.ctx.storage.sql.exec('SELECT 1 FROM pending_results WHERE pool=? LIMIT 1', run.pool).toArray()[0]) {
        this.ctx.storage.sql.exec("UPDATE correction_runs SET phase='complete',error=NULL WHERE id=?", run.id);
        this.ctx.storage.sql.exec('DELETE FROM meta WHERE key=?', `paused:${run.pool}`);
        if (!this.ctx.storage.sql.exec("SELECT 1 FROM correction_runs WHERE decision_id=? AND phase<>'complete' LIMIT 1", run.decision_id).toArray()[0]) {
          this.ctx.storage.sql.exec("UPDATE correction_decisions SET state='complete' WHERE decision_id=?", run.decision_id);
        }
      } else this.ctx.storage.sql.exec('UPDATE correction_runs SET next_at=? WHERE id=?', Date.now(), run.id);
    });
  }

  async processCorrections(): Promise<void> {
    if (this.correcting) return;
    this.correcting = true;
    try {
      const run = this.ctx.storage.sql.exec<ReplayRun>("SELECT * FROM correction_runs WHERE phase<>'complete' AND next_at<=? ORDER BY CASE WHEN phase='publish' THEN 1 ELSE 0 END,created_at,id LIMIT 1", Date.now()).toArray()[0];
      if (run) {
        try {
          switch (run.phase) {
            case 'replay': this.replay(run); break;
            case 'stage-ratings': await this.stageRatings(run); break;
            case 'stage-games': await this.stageGames(run); break;
            case 'authority': this.replaceAuthority(run); break;
            case 'publish': await this.publishCorrection(run); break;
            case 'drain': this.drain(run); break;
          }
          if ((await this.correctionStatus(run.decision_id)).complete) await this.finishCorrectionOutbox(run.decision_id);
        } catch (error) {
          const reason = error instanceof Error ? error.message.slice(0, 160) : 'retry_later';
          this.ctx.storage.sql.exec('UPDATE correction_runs SET error=?,next_at=? WHERE id=?', reason, Date.now() + 30_000, run.id);
          await this.env.DB.prepare('UPDATE rating_correction_outbox SET last_error=? WHERE decision_id=?').bind(reason, run.decision_id).run();
        }
      } else if (!this.ctx.storage.sql.exec("SELECT 1 FROM correction_runs WHERE phase<>'complete' LIMIT 1").toArray()[0]) {
        const next = await this.env.DB.prepare('SELECT decision_id FROM rating_correction_outbox WHERE completed_at IS NULL ORDER BY created_at,decision_id LIMIT 1').first<{ decision_id: string }>();
        if (next) {
          try { await this.requestCorrection(next.decision_id); }
          catch (error) {
            const reason = error instanceof Error ? error.message.slice(0, 160) : 'retry_later';
            await this.env.DB.prepare('UPDATE rating_correction_outbox SET last_error=? WHERE decision_id=?').bind(reason, next.decision_id).run();
          }
        }
      }
      await this.ctx.storage.sync();
      await this.schedule();
    } finally { this.correcting = false; }
  }

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

  async captureRecoveryPoint() {
    return captureNativePoint(this.ctx, { kind: 'Competition', name: 'global', policies: { rules: RULES_VERSION, ratings: RATING_VERSION } }, () => ({
      watermarks: Object.fromEntries(Object.entries(JOURNALS).map(([kind, journal]) => [kind,
        this.ctx.storage.sql.exec<{ watermark: number }>(`SELECT COALESCE(MAX(rowid),0) AS watermark FROM ${journal.table}`).one().watermark])),
      publishedEpochs: Object.fromEntries((['blitz', 'rapid'] as const).map(pool => [pool,
        Number(this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM meta WHERE key=?', `published-epoch:${pool}`).toArray()[0]?.value ?? 1)])),
      matches: this.ctx.storage.sql.exec<{ status: string; count: number }>('SELECT status,COUNT(*) AS count FROM matches GROUP BY status ORDER BY status').toArray(),
      pending: Object.fromEntries(['queue', 'outbox', 'pending_results', 'slots'].map(table => [table,
        this.ctx.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`).one().count])),
      repairInProgress: Boolean(this.ctx.storage.sql.exec("SELECT 1 FROM correction_runs WHERE phase<>'complete' LIMIT 1").toArray()[0]),
    }), this.recoveryDrill);
  }

  /** An owner-only event export. It does not export live game, auth, or private review state. */
  async beginExport(): Promise<AuthorityExportManifest> {
    await this.ctx.storage.sync();
    return this.ctx.storage.transactionSync(() => ({
      schema: JOURNAL_SCHEMA,
      createdAt: Date.now(),
      ratingPolicy: RATING_VERSION,
      rulesPolicy: RULES_VERSION,
      watermarks: Object.fromEntries(Object.entries(JOURNALS).map(([kind, journal]) => [kind,
        this.ctx.storage.sql.exec<{ watermark: number }>(`SELECT COALESCE(MAX(rowid),0) AS watermark FROM ${journal.table}`).one().watermark,
      ])) as Record<JournalKind, number>,
      publishedEpochs: Object.fromEntries((['blitz', 'rapid'] as const).map(pool => [pool,
        Number(this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM meta WHERE key=?', `published-epoch:${pool}`).toArray()[0]?.value ?? 1),
      ])) as Record<Pool, number>,
      repairInProgress: Boolean(this.ctx.storage.sql.exec("SELECT 1 FROM correction_runs WHERE phase<>'complete' LIMIT 1").toArray()[0]),
      pendingResults: this.ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM pending_results').one().count,
    }));
  }

  async exportEvents(input: { kind: JournalKind; after?: number; watermark: number; limit?: number }): Promise<AuthorityExportPage> {
    const after = input?.after ?? 0;
    const limit = input?.limit ?? 50;
    if (!input || !Object.hasOwn(JOURNALS, input.kind) || !Number.isSafeInteger(after) || after < 0
      || !Number.isSafeInteger(input.watermark) || input.watermark < after || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('invalid_export_cursor');
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
    const count = (table: 'queue' | 'outbox' | 'incidents') => this.ctx.storage.sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`).toArray()[0].count;
    const oldestOutboxAt = this.ctx.storage.sql.exec<{ oldest: number | null }>("SELECT MIN(json_extract(payload,'$.result.endedAt')) AS oldest FROM outbox").one().oldest;
    const correction = await this.env.DB.prepare('SELECT COUNT(*) AS count,MIN(created_at) AS oldest FROM rating_correction_outbox WHERE completed_at IS NULL').first<{ count: number; oldest: number | null }>();
    const correctionError = await this.env.DB.prepare('SELECT last_error FROM rating_correction_outbox WHERE completed_at IS NULL AND last_error IS NOT NULL ORDER BY created_at,decision_id LIMIT 1').first<string>('last_error');
    const maintenance = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key='maintenance-error'").toArray()[0];
    return {
      rankedOpen: this.env.RANKED_ENABLED === 'true', queued: count('queue'),
      queuedByPool: Object.fromEntries((['blitz', 'rapid'] as const).map(pool => [pool, this.ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM queue WHERE pool=?', pool).one().count])),
      unsettled: this.unsettledGames(),
      retainedRankedGames: this.ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM matches').one().count,
      outbox: count('outbox'), incidents: count('incidents'), ratingPolicy: RATING_VERSION,
      farming: farmingStatus(this.ctx.storage.sql),
      arenas: this.arenas.status(),
      casuals: this.casuals.status(),
      retirement: await retirementStatus(this.env),
      outboxFailures: this.ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM outbox WHERE attempts>0').one().count,
      oldestOutboxAt, outboxLagMs: oldestOutboxAt === null ? 0 : Math.max(0, now - oldestOutboxAt),
      correctionPending: correction?.count ?? 0, oldestCorrectionAt: correction?.oldest ?? null,
      correctionLagMs: correction?.oldest == null ? 0 : Math.max(0, now - correction.oldest), correctionError,
      pendingResults: this.ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM pending_results').one().count,
      pausedPools: (['blitz', 'rapid'] as const).filter(pool => this.poolPaused(pool)),
      limits: { ...this.admissionLimits(), queueLeaseMs: QUEUE_LEASE_MS, pairScan: 128, pairBatchPerPool: 8, creationBatch: 8, reconciliationBatch: 16, projectionBatch: 16, replayBatch: 20, exportPage: 50, farmingCatchUpBatch: 8 },
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
      this.ctx.storage.sql.exec<{ due: number | null }>("SELECT MIN(next_at) AS due FROM correction_runs WHERE phase<>'complete'").toArray()[0].due,
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
    const due = Math.max(Date.now() + 1, Math.min(...times));
    // A full maintenance pass may advance a deadline it has consumed. Keep
    // alarms armed after that pass began, including newly earlier work.
    if (current === null || due < current || (completedThrough !== null && current <= completedThrough)) {
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
      catch { due = Date.now() + 30_000; }
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
    try { advanceFarmingChecks(this.ctx.storage.sql, Date.now(), 8); } catch { errors.push('farming'); }
    this.ctx.storage.sql.exec("DELETE FROM meta WHERE key='farming-next-at'");
    try { await this.processCorrections(); } catch { errors.push('correction'); }
    try { await this.casuals.maintenance(); } catch { errors.push('casual'); }
    try { await this.tournaments.maintenance(); } catch { errors.push('tournament'); }
    try { await this.arenas.maintenance(); } catch { errors.push('arena'); }
    const work = this.ctx.storage.sql.exec<Match>("SELECT * FROM matches WHERE status IN ('reserved','live','settling') AND next_attempt_at<=? ORDER BY next_attempt_at,id LIMIT 16", Date.now()).toArray();
    for (const match of work) {
      try { await this.reconcile(match.id); }
      catch {
        this.ctx.storage.sql.exec('UPDATE matches SET next_attempt_at=? WHERE id=?', Date.now() + 30_000, match.id);
        if (!errors.includes('reconciliation')) errors.push('reconciliation');
      }
    }
    try { await this.pump(); } catch { errors.push('admission'); }
    try { await this.flush(); } catch { errors.push('projection'); }
    if (retirementMode(this.env) === 'scaled') {
      try { await this.retirePayloads(); } catch { errors.push('retirement'); }
    }
    const completedAt = Date.now();
    if (errors.length) this.ctx.storage.sql.exec("INSERT INTO meta(key,value) VALUES('maintenance-error',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify({ at: completedAt, stages: errors }));
    else this.ctx.storage.sql.exec("DELETE FROM meta WHERE key='maintenance-error'");
    await this.ctx.storage.sync();
    await this.schedule(startedAt);
    return { completedAt, errors };
  }

  async alarm(): Promise<void> {
    await this.maintenance();
  }
}
