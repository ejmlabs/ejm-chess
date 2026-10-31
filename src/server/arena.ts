import type { Actor, GameResult, Pool } from '../shared/protocol';
import type { ArenaMe, ArenaStatus, ArenaSummary } from '../shared/arenas';
import type { TournamentCadence } from '../shared/tournaments';
import { acquireTournamentAccount, competitiveSessionEligible } from './auth';
import { ARENA_POLICY, arenaLimits } from './arena-policy';
import { ArenaProjection } from './arena-projection';
import { newWorkAllowed, reserveMonthlyWork } from './budget';
import { isolatedGameBudget } from './capacity-policy';
import type { Env } from './env';
import { assertNotClosing, gamePhase, NEW_GAMES_PAUSED, requireSession, seatPair, type EventBridge } from './events';
import { CADENCE_POOL, CADENCES, GAME_WINDOW_MS, MINUTE, occurrences } from './schedule';
import { ApiError } from './security';

/** Pairing stays open this long after the start. */
const PAIRING_MS: Record<TournamentCadence, number> = { hourly: 60 * MINUTE, daily: 120 * MINUTE, weekly: 120 * MINUTE };

type Event = {
  id: string; cadence: TournamentCadence; pool: Pool; starts_at: number; closes_at: number;
  status: ArenaStatus; finished_at: number | null; reason: string | null; next_at: number | null;
  entrants: number; unresolved: number; revision: number; watermark: number;
  generation: number; projected_revision: number; project_after: number; cleanup_after: number | null;
};
type RegistrationWork = { maintenance: boolean };
type EntryState = 'registered' | 'claiming' | 'queued' | 'playing' | 'paused' | 'releasing' | 'withdrawn';
type Entry = {
  event_id: string; user_id: string; actor: string; name: string; rating: number; state: EntryState;
  joined_at: number; queued_at: number | null; next_at: number | null; points_half: number; games: number;
  score_band: number; rating_band: number; color_balance: number; last_opponent: string | null;
  game_id: string | null; release_to: 'registered' | 'paused' | 'withdrawn'; reason: string | null;
};
type Intent = {
  game_id: string; event_id: string; reservation_id: string; white_id: string; black_id: string;
  white_actor: string; black_actor: string; status: 'allocating' | 'creating' | 'live' | 'settling' | 'finished' | 'cancelled';
  created_at: number; deadline_at: number; next_at: number | null; attempts: number; reason: string | null;
};

/** Binding-only primary observation. Absence never proves no pending work. */
export interface ArenaReservation {
  gameId: string; eventId: string; reservationId: string;
  whiteId: string; blackId: string; status: Intent['status'];
}

interface ArenaBridge extends EventBridge {
  /** Conservative count of non-arena Competition reservations and games. */
  otherGames(): number;
}

async function bounded<T>(rows: T[], concurrency: number, work: (row: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
    while (cursor < rows.length) await work(rows[cursor++]);
  }));
}

/** Product FIFO policy over SQLite, with Game retaining all move/clock authority. */
export class ArenaControl {
  private working = false;
  private registrations = 0;
  private legacyCasualGames = 0;
  private projection: ArenaProjection;

  constructor(private ctx: DurableObjectState, private getEnv: () => Env, private bridge: ArenaBridge) {
    const sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS arena_events(
      id TEXT PRIMARY KEY,cadence TEXT NOT NULL,pool TEXT NOT NULL,starts_at INTEGER NOT NULL,closes_at INTEGER NOT NULL,
      status TEXT NOT NULL,finished_at INTEGER,reason TEXT,next_at INTEGER,entrants INTEGER NOT NULL DEFAULT 0,
      unresolved INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 1,watermark INTEGER NOT NULL DEFAULT 0,
      generation INTEGER NOT NULL DEFAULT 0,projected_revision INTEGER NOT NULL DEFAULT 0,project_after INTEGER NOT NULL DEFAULT 0,cleanup_after INTEGER)`);
    sql.exec('CREATE INDEX IF NOT EXISTS arena_event_work ON arena_events(next_at,id)');
    sql.exec('CREATE INDEX IF NOT EXISTS arena_event_cleanup ON arena_events(cleanup_after,id)');
    sql.exec(`CREATE TABLE IF NOT EXISTS arena_entries(
      event_id TEXT NOT NULL,user_id TEXT NOT NULL,actor TEXT NOT NULL,name TEXT NOT NULL,rating REAL NOT NULL,state TEXT NOT NULL,
      joined_at INTEGER NOT NULL,queued_at INTEGER,next_at INTEGER,points_half INTEGER NOT NULL DEFAULT 0,games INTEGER NOT NULL DEFAULT 0,
      score_band INTEGER NOT NULL DEFAULT 0,rating_band INTEGER NOT NULL,color_balance INTEGER NOT NULL DEFAULT 0,
      last_opponent TEXT,game_id TEXT,release_to TEXT NOT NULL DEFAULT 'registered',reason TEXT,PRIMARY KEY(event_id,user_id))`);
    sql.exec('CREATE INDEX IF NOT EXISTS arena_waiting ON arena_entries(event_id,state,queued_at,user_id)');
    sql.exec('CREATE INDEX IF NOT EXISTS arena_lanes ON arena_entries(event_id,state,score_band,rating_band,queued_at,user_id)');
    sql.exec('CREATE INDEX IF NOT EXISTS arena_entry_work ON arena_entries(state,next_at,event_id,user_id)');
    sql.exec(`CREATE TABLE IF NOT EXISTS arena_intents(
      game_id TEXT PRIMARY KEY,event_id TEXT NOT NULL,reservation_id TEXT NOT NULL,white_id TEXT NOT NULL,black_id TEXT NOT NULL,
      white_actor TEXT NOT NULL,black_actor TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,deadline_at INTEGER NOT NULL,
      next_at INTEGER,attempts INTEGER NOT NULL DEFAULT 0,reason TEXT)`);
    sql.exec('CREATE INDEX IF NOT EXISTS arena_intent_work ON arena_intents(status,next_at,game_id)');
    sql.exec('CREATE INDEX IF NOT EXISTS arena_intent_event ON arena_intents(event_id,status,game_id)');
    sql.exec(`CREATE TABLE IF NOT EXISTS arena_pairs(event_id TEXT NOT NULL,first_id TEXT NOT NULL,second_id TEXT NOT NULL,
      meetings INTEGER NOT NULL,PRIMARY KEY(event_id,first_id,second_id))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS arena_receipts(game_id TEXT PRIMARY KEY,event_id TEXT NOT NULL,result_event_id TEXT NOT NULL,
      digest TEXT NOT NULL,sequence INTEGER NOT NULL,white_half INTEGER NOT NULL,black_half INTEGER NOT NULL,accepted_at INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS arena_entry_versions(event_id TEXT NOT NULL,user_id TEXT NOT NULL,revision INTEGER NOT NULL,
      name TEXT NOT NULL,points_half INTEGER NOT NULL,games INTEGER NOT NULL,visible INTEGER NOT NULL,PRIMARY KEY(event_id,user_id,revision))`);
    sql.exec('CREATE TABLE IF NOT EXISTS arena_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS arena_tokens(kind TEXT PRIMARY KEY,tokens INTEGER NOT NULL,updated_at INTEGER NOT NULL)');
    ctx.storage.transactionSync(() => {
      const exists = sql.exec("SELECT 1 FROM sqlite_master WHERE type='table' AND name='arena_entry_counts'").toArray().length > 0;
      sql.exec(`CREATE TABLE IF NOT EXISTS arena_entry_counts(
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),retained INTEGER NOT NULL CHECK(retained>=0))`);
      if (!exists) sql.exec('INSERT INTO arena_entry_counts(singleton,retained) SELECT 1,COUNT(*) FROM arena_entries');
      sql.exec(`CREATE TRIGGER IF NOT EXISTS arena_entry_count_insert AFTER INSERT ON arena_entries
        BEGIN UPDATE arena_entry_counts SET retained=retained+1 WHERE singleton=1; END`);
      sql.exec(`CREATE TRIGGER IF NOT EXISTS arena_entry_count_delete AFTER DELETE ON arena_entries
        BEGIN UPDATE arena_entry_counts SET retained=retained-1 WHERE singleton=1; END`);
    });
    this.projection = new ArenaProjection(ctx, getEnv, (id, now) => {
      const event = this.event(id);
      return event ? { summary: this.summary(event, now), revision: event.revision, watermark: event.watermark } : null;
    });
  }

  private enabled(): boolean { return this.getEnv().ARENAS_ENABLED === 'true'; }
  private event(id: string): Event | null { return this.ctx.storage.sql.exec<Event>('SELECT * FROM arena_events WHERE id=?', id).toArray()[0] ?? null; }
  private entry(id: string, userId: string): Entry | null {
    return this.ctx.storage.sql.exec<Entry>('SELECT * FROM arena_entries WHERE event_id=? AND user_id=?', id, userId).toArray()[0] ?? null;
  }
  private intent(id: string): Intent | null { return this.ctx.storage.sql.exec<Intent>('SELECT * FROM arena_intents WHERE game_id=?', id).toArray()[0] ?? null; }

  private summary(event: Event, now: number): ArenaSummary {
    return { id: event.id, format: 'arena-v1', cadence: event.cadence, pool: event.pool, rated: false,
      startsAt: event.starts_at, registrationOpensAt: event.starts_at - ARENA_POLICY.registrationMs,
      closesAt: event.closes_at, finishedAt: event.finished_at, status: event.status, reason: event.reason,
      entrants: event.entrants, unresolvedGames: event.unresolved, maxEntrants: arenaLimits(this.getEnv()).maxEntrants,
      provisional: !['finished', 'cancelled'].includes(event.status), generation: event.generation,
      watermark: event.watermark, generatedAt: now };
  }

  /** Registration/score versions keep snapshot capture consistent during new results. */
  private version(id: string, userIds: string[]): void {
    const sql = this.ctx.storage.sql;
    const revision = sql.exec<{ revision: number }>('UPDATE arena_events SET revision=revision+1 WHERE id=? RETURNING revision', id).one().revision;
    this.appendVersions(id, userIds, revision);
  }

  private appendVersions(id: string, userIds: string[], revision: number): void {
    const sql = this.ctx.storage.sql;
    const frozen = sql.exec<{ revision: number }>('SELECT revision FROM arena_projection_builds WHERE event_id=?', id).toArray()[0]?.revision;
    for (const userId of userIds) {
      sql.exec(`INSERT INTO arena_entry_versions(event_id,user_id,revision,name,points_half,games,visible)
        SELECT event_id,user_id,?,name,points_half,games,CASE WHEN state='withdrawn' THEN 0 ELSE 1 END
        FROM arena_entries WHERE event_id=? AND user_id=?`, revision, id, userId);
      // Seek the anchor independently: legacy post-freeze rows can hide it
      // below the bounded newest-candidate window, including a withdrawal.
      const anchor = frozen === undefined ? undefined : sql.exec<{ revision: number }>(`SELECT revision FROM arena_entry_versions
        WHERE event_id=? AND user_id=? AND revision<=? ORDER BY revision DESC LIMIT 1`, id, userId, frozen).toArray()[0]?.revision;
      const newest = sql.exec<{ revision: number }>(`SELECT revision FROM arena_entry_versions
        WHERE event_id=? AND user_id=? ORDER BY revision DESC LIMIT 3`, id, userId).toArray();
      const latest = newest[0]?.revision;
      for (const row of newest) if (row.revision !== latest && row.revision !== anchor) {
        sql.exec('DELETE FROM arena_entry_versions WHERE event_id=? AND user_id=? AND revision=?', id, userId, row.revision);
      }
    }
  }

  private consume(kind: 'registration' | 'start', now: number): boolean {
    const rate = kind === 'registration' ? ARENA_POLICY.registrationRate : ARENA_POLICY.startRate;
    const burst = kind === 'registration' ? ARENA_POLICY.registrationBurst : ARENA_POLICY.startRate;
    const sql = this.ctx.storage.sql;
    const before = sql.exec<{ tokens: number; updated_at: number }>('SELECT tokens,updated_at FROM arena_tokens WHERE kind=?', kind).toArray()[0];
    const tokens = Math.min(burst * 1_000, (before?.tokens ?? burst * 1_000) + Math.max(0, now - (before?.updated_at ?? now)) * rate);
    // A denial spends no credit. Refill from the last accepted timestamp.
    if (tokens < 1_000) return false;
    sql.exec(`INSERT INTO arena_tokens(kind,tokens,updated_at) VALUES(?,?,?) ON CONFLICT(kind)
      DO UPDATE SET tokens=excluded.tokens,updated_at=excluded.updated_at`, kind, tokens - 1_000, Math.max(now, before?.updated_at ?? now));
    return true;
  }

  /** Persist only current/next occurrences. Missed hours never become a catch-up loop. */
  ensure(now = Date.now()): boolean {
    if (!this.enabled()) return false;
    let created = false;
    const fixedStarts = isolatedGameBudget(this.getEnv())?.arenaStarts;
    this.ctx.storage.transactionSync(() => {
      for (const cadence of CADENCES) for (const startsAt of fixedStarts ? [fixedStarts[cadence]] : occurrences(cadence, now)) {
        if (startsAt + PAIRING_MS[cadence] <= now) continue;
        const id = `arena-${cadence}-${startsAt}`;
        if (this.event(id)) continue;
        this.ctx.storage.sql.exec(`INSERT INTO arena_events(id,cadence,pool,starts_at,closes_at,status,next_at)
          VALUES(?,?,?,?,?,'scheduled',?)`, id, cadence, CADENCE_POOL[cadence], startsAt, startsAt + PAIRING_MS[cadence], Math.max(now, startsAt));
        created = true;
      }
    });
    return created;
  }

  async getMe(actor: Actor, id: string): Promise<ArenaMe | null> {
    await requireSession(actor, this.getEnv());
    return this.me(actor, id);
  }

  private me(actor: Actor, id: string): ArenaMe | null {
    const event = this.event(id);
    if (!event || (event.finished_at !== null && event.finished_at < Date.now() - ARENA_POLICY.historyMs)) return null;
    const entry = this.entry(id, actor.id);
    const gameStatus = entry?.game_id ? this.intent(entry.game_id)?.status : undefined;
    return { id, format: 'arena-v1', serverNow: Date.now(), status: event.status,
      registered: Boolean(entry && entry.state !== 'withdrawn'), state: entry?.state === 'claiming' ? 'reserving' : entry?.state ?? null,
      gameId: entry?.game_id && gameStatus !== 'allocating' && gameStatus !== 'creating' ? entry.game_id : null,
      points: (entry?.points_half ?? 0) / 2, games: entry?.games ?? 0, queuedAt: entry?.queued_at ?? null, reason: entry?.reason ?? null };
  }

  /** No Game lookup or mutation, including while allocating or releasing. */
  async reservation(actor: Actor, id: string): Promise<ArenaReservation | null> {
    await requireSession(actor, this.getEnv());
    const entry = this.entry(id, actor.id);
    const intent = entry?.game_id ? this.intent(entry.game_id) : null;
    if (!intent) return null;
    if (intent.event_id !== id || (intent.white_id !== actor.id && intent.black_id !== actor.id)) {
      throw new Error('arena_reservation_conflict');
    }
    return { gameId: intent.game_id, eventId: intent.event_id, reservationId: intent.reservation_id,
      whiteId: intent.white_id, blackId: intent.black_id, status: intent.status };
  }

  private open(id: string, now: number): Event {
    const event = this.event(id);
    if (!event) throw new ApiError(404, 'ARENA_NOT_FOUND', 'This arena was not found.');
    if (!this.enabled()) throw new ApiError(503, 'ARENAS_CLOSED', 'Arena entry is unavailable. Existing games will finish.');
    if (!['scheduled', 'running'].includes(event.status) || now >= event.closes_at || now < event.starts_at - ARENA_POLICY.registrationMs) {
      throw new ApiError(409, 'ARENA_ENTRY_CLOSED', 'Entry opens 15 minutes before the start and closes with pairing.');
    }
    return event;
  }

  async register(actor: Actor, id: string, work: RegistrationWork = { maintenance: true }): Promise<ArenaMe> {
    // Keep scheduling conservative until a completed result proves no new work.
    work.maintenance = true;
    const env = this.getEnv();
    const existing = this.entry(id, actor.id);
    const newEntry = !existing || existing.state === 'withdrawn';
    let registrationReserved = false;
    if (newEntry) {
      if (this.registrations >= ARENA_POLICY.registrationConcurrency) {
        work.maintenance = false;
        throw new ApiError(429, 'ARENA_RETRY', 'Registration is busy. Try again in a second.');
      }
      registrationReserved = this.ctx.storage.transactionSync(() => this.consume('registration', Date.now()));
      if (!registrationReserved) {
        work.maintenance = false;
        throw new ApiError(429, 'ARENA_RETRY', 'Registration is busy. Try again in a second.');
      }
    }
    // Only admitted new-entry checks own a slot. Existing confirmations retain
    // their fresh checks even while new registrations are busy.
    if (newEntry) this.registrations++;
    try { return await this.registerAdmitted(actor, id, work, registrationReserved, env); }
    finally { if (newEntry) this.registrations--; }
  }

  private async registerAdmitted(actor: Actor, id: string, work: RegistrationWork,
    registrationReserved: boolean, env: Env): Promise<ArenaMe> {
    // Failed or racing calls keep their spent token. Never refund uncertain work.
    const validActor = actor.id.length <= 128 && actor.sessionId.length <= 128 && actor.name.length <= 120;
    // Independent primary checks share the reserved registration allowance.
    // Settle both before returning, while preserving account-error precedence.
    const [eligibility, allowance] = await Promise.allSettled([
      competitiveSessionEligible(actor, env),
      validActor ? newWorkAllowed(env, 'games') : Promise.resolve(false),
    ]);
    if (eligibility.status === 'rejected') throw eligibility.reason;
    if (!eligibility.value) {
      throw new ApiError(403, 'ARENA_INELIGIBLE', 'Arenas require an eligible account.');
    }
    if (!validActor) throw new ApiError(400, 'INVALID_ARENA_ACCOUNT', 'Use a valid player account.');
    const created = this.ensure();
    if (allowance.status === 'rejected') throw allowance.reason;
    if (!allowance.value && !this.entry(id, actor.id)) throw new ApiError(503, 'NEW_GAMES_PAUSED', NEW_GAMES_PAUSED);
    let changed = created, maintenance = created;
    try {
      this.ctx.storage.transactionSync(() => {
        assertNotClosing(this.bridge, actor.id);
        const now = Date.now();
        if (!Number.isFinite(actor.sessionExpiresAt) || actor.sessionExpiresAt <= now) {
          throw new ApiError(403, 'ARENA_INELIGIBLE', 'Arenas require an eligible account.');
        }
        const event = this.open(id, now);
        const current = this.entry(id, actor.id);
        const actorJson = JSON.stringify(actor), name = actor.name.slice(0, 40);
        if (current && current.state !== 'withdrawn') {
          const renamed = current.name !== name;
          if (!renamed && current.actor === actorJson) return;
          if (renamed && !this.authorityRoom()) throw new ApiError(503, 'ARENA_STORAGE_FULL', 'New arena updates are paused at the storage safety limit. Existing games will finish.');
          this.ctx.storage.sql.exec('UPDATE arena_entries SET actor=?,name=? WHERE event_id=? AND user_id=?', actorJson, name, id, actor.id);
          changed = true;
          if (renamed) { this.version(id, [actor.id]); maintenance = true; }
          return;
        }
        if (event.entrants >= arenaLimits(env).maxEntrants) throw new ApiError(409, 'ARENA_FULL', 'This arena is full.');
        if (!this.authorityRoom(0, current ? 0 : 1)) throw new ApiError(503, 'ARENA_STORAGE_FULL', 'New arena entries are paused at the storage safety limit. Existing games will finish.');
        // A concurrent withdrawal can turn an existing entry into a new join.
        if (!registrationReserved && !this.consume('registration', now)) throw new ApiError(429, 'ARENA_RETRY', 'Registration is busy. Try again in a second.');
        this.ctx.storage.sql.exec(`INSERT INTO arena_entries(event_id,user_id,actor,name,rating,state,joined_at,rating_band)
          VALUES(?,?,?,?,?,'registered',?,?) ON CONFLICT(event_id,user_id) DO UPDATE SET actor=excluded.actor,name=excluded.name,
          state='registered',joined_at=excluded.joined_at,reason=NULL`, id, actor.id, actorJson, name,
        this.bridge.rating(event.pool, actor.id), now, Math.floor(this.bridge.rating(event.pool, actor.id) / 200));
        this.ctx.storage.sql.exec('UPDATE arena_events SET entrants=entrants+1 WHERE id=?', id);
        this.version(id, [actor.id]);
        changed = maintenance = true;
      });
    } catch (error) {
      // The denied transaction rolled back. ensure() may still have created
      // events in its earlier transaction, and those deadlines need an alarm.
      if (error instanceof ApiError && error.status === 429 && error.code === 'ARENA_RETRY') work.maintenance = created;
      throw error;
    }
    if (changed) await this.ctx.storage.sync();
    const value = this.me(actor, id)!;
    work.maintenance = maintenance;
    return value;
  }

  async withdraw(actor: Actor, id: string): Promise<ArenaMe> {
    await requireSession(actor, this.getEnv());
    this.ctx.storage.transactionSync(() => {
      const event = this.event(id);
      if (!event) throw new ApiError(404, 'ARENA_NOT_FOUND', 'This arena was not found.');
      const entry = this.entry(id, actor.id);
      if (!entry || entry.state === 'withdrawn') return;
      if (Date.now() >= event.starts_at || !['registered', 'paused'].includes(entry.state) || entry.game_id) {
        throw new ApiError(409, 'ARENA_WITHDRAWAL_CLOSED', 'Withdraw before the start. During play, pause between games.');
      }
      this.ctx.storage.sql.exec("UPDATE arena_entries SET state='withdrawn',next_at=NULL WHERE event_id=? AND user_id=?", id, actor.id);
      this.ctx.storage.sql.exec('UPDATE arena_events SET entrants=entrants-1 WHERE id=?', id);
      this.version(id, [actor.id]);
    });
    await this.ctx.storage.sync();
    return (await this.getMe(actor, id))!;
  }

  async queue(actor: Actor, id: string): Promise<ArenaMe> {
    const env = this.getEnv();
    if (!await competitiveSessionEligible(actor, env)) {
      throw new ApiError(403, 'ARENA_INELIGIBLE', 'Arenas require an eligible account.');
    }
    if (!await newWorkAllowed(env, 'games')) throw new ApiError(503, 'NEW_GAMES_PAUSED', NEW_GAMES_PAUSED);
    this.ctx.storage.transactionSync(() => {
      assertNotClosing(this.bridge, actor.id);
      const now = Date.now();
      const event = this.open(id, now);
      const entry = this.entry(id, actor.id);
      if (!entry || entry.state === 'withdrawn') throw new ApiError(409, 'ARENA_REGISTER_FIRST', 'Register before joining the arena queue.');
      if (['queued', 'claiming', 'playing'].includes(entry.state)) return;
      if (entry.state === 'releasing') throw new ApiError(409, 'ARENA_RELEASE_PENDING', 'Your previous seat is still being released. Try again shortly.');
      if (this.bridge.busy(actor.id, id)) throw new ApiError(409, 'PLAYER_BUSY', 'Finish or leave your other game or queue first.');
      this.bridge.reserve(actor.id, id, event.pool);
      this.ctx.storage.sql.exec(`UPDATE arena_entries SET state='claiming',actor=?,queued_at=?,next_at=?,reason=NULL
        WHERE event_id=? AND user_id=?`, JSON.stringify(actor), now, now, id, actor.id);
      this.ctx.storage.sql.exec('UPDATE arena_events SET next_at=MIN(COALESCE(next_at,?),?) WHERE id=?', now, now, id);
    });
    await this.ctx.storage.sync();
    // One maintenance owner performs claims. A duplicate HTTP action must not
    // leave a second D1 acknowledgement racing a later pause/resume cycle.
    return (await this.getMe(actor, id))!;
  }

  async pause(actor: Actor, id: string): Promise<ArenaMe> {
    await requireSession(actor, this.getEnv());
    this.ctx.storage.transactionSync(() => {
      if (!this.event(id)) throw new ApiError(404, 'ARENA_NOT_FOUND', 'This arena was not found.');
      const entry = this.entry(id, actor.id);
      if (!entry || entry.state === 'withdrawn') throw new ApiError(409, 'ARENA_REGISTER_FIRST', 'Register before joining the arena.');
      if (entry.state === 'playing' || entry.state === 'claiming') throw new ApiError(409, 'ARENA_BUSY', 'Finish this game or pending reservation before pausing.');
      if (entry.state === 'queued') this.releaseEntry(entry, 'paused', 'You paused the queue.', Date.now());
      else if (entry.state !== 'releasing') this.ctx.storage.sql.exec("UPDATE arena_entries SET state='paused',reason=NULL WHERE event_id=? AND user_id=?", id, actor.id);
    });
    await this.ctx.storage.sync();
    return (await this.getMe(actor, id))!;
  }

  private releaseEntry(entry: Entry, target: Entry['release_to'], reason: string | null, now: number): void {
    this.ctx.storage.sql.exec(`UPDATE arena_entries SET state='releasing',release_to=?,queued_at=NULL,next_at=?,reason=?
      WHERE event_id=? AND user_id=?`, target, now, reason, entry.event_id, entry.user_id);
  }

  private async claim(entry: Entry, now: number): Promise<void> {
    const env = this.getEnv();
    try {
      const event = this.event(entry.event_id);
      const held = await acquireTournamentAccount(env, JSON.parse(entry.actor) as Actor, entry.event_id);
      this.ctx.storage.transactionSync(() => {
        const current = this.entry(entry.event_id, entry.user_id);
        if (current?.state !== 'claiming') return;
        if (!held || !event || !this.enabled() || Date.now() >= event.closes_at || !['scheduled', 'running'].includes(event.status)) {
          this.releaseEntry(current, 'paused', held ? 'Arena pairing has closed.' : 'Your account is unavailable for this queue.', now);
        } else this.ctx.storage.sql.exec("UPDATE arena_entries SET state='queued',next_at=?,reason=NULL WHERE event_id=? AND user_id=?", now, entry.event_id, entry.user_id);
      });
    } catch {
      this.ctx.storage.sql.exec("UPDATE arena_entries SET next_at=? WHERE event_id=? AND user_id=? AND state='claiming'", now + 1_000, entry.event_id, entry.user_id);
    }
    await this.ctx.storage.sync();
  }

  private async release(entry: Entry, now: number): Promise<void> {
    const intent = entry.game_id ? this.intent(entry.game_id) : null;
    if (intent && !['finished', 'cancelled'].includes(intent.status)) throw new Error('arena_live_reservation');
    const db = this.getEnv().DB;
    // An accepted terminal result proves the seat is finished, even if Game's
    // delivery acknowledgement was lost before its D1 seat cleanup.
    if (intent?.status === 'finished') {
      const receipt = this.ctx.storage.sql.exec<{ digest: string }>('SELECT digest FROM arena_receipts WHERE game_id=?', intent.game_id).toArray()[0];
      if (!receipt) throw new Error('arena_missing_receipt');
      await db.prepare(`UPDATE active_game_seats SET released_at=? WHERE user_id=? AND game_id=? AND released_at IS NULL
        AND EXISTS(SELECT 1 FROM games WHERE id=? AND terminal_digest=? AND status='finished')`)
        .bind(now, entry.user_id, intent.game_id, intent.game_id, receipt.digest).run();
    }
    const deleted = await db.prepare(`DELETE FROM tournament_account_locks WHERE user_id=? AND tournament_id=?
      AND NOT EXISTS(SELECT 1 FROM active_game_seats WHERE user_id=? AND released_at IS NULL) RETURNING user_id`)
      .bind(entry.user_id, entry.event_id, entry.user_id).first();
    if (!deleted && await db.prepare('SELECT 1 FROM tournament_account_locks WHERE user_id=? AND tournament_id=?').bind(entry.user_id, entry.event_id).first()) {
      this.ctx.storage.sql.exec("UPDATE arena_entries SET next_at=? WHERE event_id=? AND user_id=? AND state='releasing'", now + 1_000, entry.event_id, entry.user_id);
      return;
    }
    this.ctx.storage.transactionSync(() => {
      const current = this.entry(entry.event_id, entry.user_id);
      if (current?.state !== 'releasing' || current.game_id !== entry.game_id) return;
      this.bridge.releaseMember(entry.user_id, entry.event_id);
      this.ctx.storage.sql.exec(`UPDATE arena_entries SET state=release_to,game_id=NULL,next_at=NULL
        WHERE event_id=? AND user_id=?`, entry.event_id, entry.user_id);
    });
  }

  private active(): number {
    return this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM arena_intents WHERE status IN ('allocating','creating','live','settling')").one().count;
  }

  private authorityRoom(games = 0, entries = 0): boolean {
    const retainedEntries = this.ctx.storage.sql.exec<{ retained: number }>('SELECT retained FROM arena_entry_counts WHERE singleton=1').toArray()[0]?.retained;
    if (retainedEntries === undefined || !Number.isSafeInteger(retainedEntries) || retainedEntries < 0) return false;
    const metadata = (retainedEntries + entries) * ARENA_POLICY.entryReserveBytes;
    const accepted = (this.active() + this.bridge.otherGames() + this.legacyCasualGames + games) * ARENA_POLICY.resultReserveBytes;
    return this.ctx.storage.sql.databaseSize + metadata + accepted <= arenaLimits(this.getEnv()).authorityBytes;
  }

  /** Shared Competition-owned guard for new ranked and preview allocations. */
  canReserveGames(count = 1): boolean {
    const limits = arenaLimits(this.getEnv());
    const pending = this.active() + this.bridge.otherGames() + this.legacyCasualGames + count;
    return pending <= limits.liveGames && this.authorityRoom(count);
  }

  /** One fixed counter includes live casual work admitted by an earlier build. */
  async refreshLegacyGames(): Promise<void> {
    const row = await this.getEnv().DB.prepare("SELECT legacy_live FROM game_admission_counts WHERE kind='casual'").first<{ legacy_live: number }>();
    if (!row) throw new Error('game_admission_counts_missing');
    this.legacyCasualGames = row.legacy_live;
  }

  /** Actual initialization attempts across Competition's game modes share a bucket. */
  claimStart(now = Date.now()): boolean {
    return this.ctx.storage.transactionSync(() => this.consume('start', now));
  }

  private async storageRoom(): Promise<number> {
    const limits = arenaLimits(this.getEnv());
    const row = await this.getEnv().DB.prepare(`SELECT permanent_ids AS ids,retained_payloads AS retained
      FROM game_admission_counts WHERE kind='tournament'`).first<{ ids: number; retained: number }>();
    if (!row) return 0;
    // This conservative byte stop protects free space for accepted work. Its
    // per-game allowance still needs the published history-bound qualification.
    if (!this.authorityRoom(ARENA_POLICY.pairBatch)) return 0;
    return Math.max(0, Math.min(limits.retainedGames - row.retained, limits.permanentGameIds - row.ids,
      limits.liveGames - this.active() - this.bridge.otherGames() - this.legacyCasualGames));
  }

  private pair(id: string, now: number): boolean {
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const event = this.event(id);
      if (!event || event.status !== 'running' || now >= event.closes_at || !this.enabled()) return false;
      const anchor = sql.exec<Entry>(`SELECT * FROM arena_entries WHERE event_id=? AND state='queued' AND next_at<=?
        ORDER BY queued_at,user_id LIMIT 1`, id, now).toArray()[0];
      if (!anchor) return false;
      const limits = arenaLimits(this.getEnv());
      if (this.active() + this.bridge.otherGames() + this.legacyCasualGames >= limits.liveGames || !this.authorityRoom(1)) return false;
      const age = Math.max(0, now - anchor.queued_at!);
      const scoreWindow = age >= 60_000 ? 1_000_000 : 1 + Math.floor(age / 15_000);
      const ratingWindow = age >= 60_000 ? 1_000_000 : 2 + Math.floor(age / 10_000);
      const candidates = sql.exec<Entry & { meetings: number }>(`SELECT e.*,COALESCE(p.meetings,0) AS meetings FROM arena_entries e
        LEFT JOIN arena_pairs p ON p.event_id=e.event_id AND p.first_id=MIN(e.user_id,?) AND p.second_id=MAX(e.user_id,?)
        WHERE e.event_id=? AND e.state='queued' AND e.user_id<>? AND e.score_band BETWEEN ? AND ?
        AND e.rating_band BETWEEN ? AND ? AND e.next_at<=?
        ORDER BY e.queued_at,e.user_id LIMIT ?`, anchor.user_id, anchor.user_id, id, anchor.user_id,
      anchor.score_band - scoreWindow, anchor.score_band + scoreWindow, anchor.rating_band - ratingWindow,
      anchor.rating_band + ratingWindow, now, ARENA_POLICY.candidateWindow).toArray();
      const opponent = candidates.filter(candidate => candidate.meetings < 2
        && candidate.user_id !== anchor.last_opponent && candidate.last_opponent !== anchor.user_id)
        .sort((a, b) => Math.abs(a.points_half - anchor.points_half) - Math.abs(b.points_half - anchor.points_half)
          || Math.abs(a.rating - anchor.rating) - Math.abs(b.rating - anchor.rating)
          || a.queued_at! - b.queued_at! || (a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0))[0];
      if (!opponent) {
        sql.exec("UPDATE arena_entries SET next_at=? WHERE event_id=? AND user_id=? AND state='queued'", now + 1_000, id, anchor.user_id);
        return false;
      }
      const anchorWhite = anchor.color_balance < opponent.color_balance
        || (anchor.color_balance === opponent.color_balance && anchor.user_id < opponent.user_id);
      const [white, black] = anchorWhite ? [anchor, opponent] : [opponent, anchor];
      const gameId = crypto.randomUUID();
      sql.exec(`INSERT INTO arena_intents(game_id,event_id,reservation_id,white_id,black_id,white_actor,black_actor,status,created_at,deadline_at,next_at)
        VALUES(?,?,?,?,?,?,?,'allocating',?,?,?)`, gameId, id, crypto.randomUUID(), white.user_id, black.user_id,
      white.actor, black.actor, now, now + GAME_WINDOW_MS[event.pool], now);
      for (const [entry, delta, other] of [[white, 1, black.user_id], [black, -1, white.user_id]] as const) {
        sql.exec(`UPDATE arena_entries SET state='playing',game_id=?,queued_at=NULL,next_at=NULL,color_balance=color_balance+?,last_opponent=?,reason=NULL
          WHERE event_id=? AND user_id=? AND state='queued'`, gameId, delta, other, id, entry.user_id);
      }
      const [first, second] = [white.user_id, black.user_id].sort();
      sql.exec(`INSERT INTO arena_pairs(event_id,first_id,second_id,meetings) VALUES(?,?,?,1)
        ON CONFLICT(event_id,first_id,second_id) DO UPDATE SET meetings=meetings+1`, id, first, second);
      sql.exec('UPDATE arena_events SET unresolved=unresolved+1,revision=revision+1,next_at=? WHERE id=?', now, id);
      return true;
    });
  }

  private async allocate(intent: Intent, now: number): Promise<void> {
    const env = this.getEnv();
    const limits = arenaLimits(env);
    if (!await reserveMonthlyWork(env, 'games', `arena:${intent.game_id}`, now)) {
      this.cancelUncreated(intent, NEW_GAMES_PAUSED, now); return;
    }
    const admitted = await env.DB.prepare(`INSERT INTO tournament_game_admissions(game_id,tournament_id,created_at)
      SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM game_admission_counts WHERE kind='tournament'
        AND permanent_ids<? AND retained_payloads<?)
      ON CONFLICT(game_id) DO NOTHING RETURNING game_id`)
      .bind(intent.game_id, intent.event_id, intent.created_at, limits.permanentGameIds, limits.retainedGames).first();
    if (!admitted && !await env.DB.prepare('SELECT 1 FROM tournament_game_admissions WHERE game_id=? AND tournament_id=?').bind(intent.game_id, intent.event_id).first()) {
      this.cancelUncreated(intent, 'Arena storage admission is full.', now); return;
    }
    this.ctx.storage.sql.exec("UPDATE arena_intents SET status='creating',next_at=? WHERE game_id=? AND status='allocating'", now, intent.game_id);
    await this.ctx.storage.sync();
  }

  /** Only allocating intents can cancel: no Game.init has ever been issued. */
  private cancelUncreated(intent: Intent, reason: string, now: number): void {
    this.ctx.storage.transactionSync(() => {
      if (this.intent(intent.game_id)?.status !== 'allocating') return;
      this.ctx.storage.sql.exec("UPDATE arena_intents SET status='cancelled',next_at=NULL,reason=? WHERE game_id=?", reason, intent.game_id);
      for (const userId of [intent.white_id, intent.black_id]) {
        const entry = this.entry(intent.event_id, userId);
        if (entry?.game_id === intent.game_id) this.releaseEntry(entry, 'paused', reason, now);
      }
      this.ctx.storage.sql.exec('UPDATE arena_events SET unresolved=unresolved-1,revision=revision+1,next_at=? WHERE id=?', now, intent.event_id);
    });
  }

  private async reconcile(intent: Intent, now: number): Promise<void> {
    try {
      if (intent.status === 'allocating') {
        await this.allocate(intent, now);
        intent = this.intent(intent.game_id)!;
        if (intent.status !== 'creating') return;
      }
      const env = this.getEnv();
      const event = this.event(intent.event_id);
      if (!event) throw new Error('arena_event_missing');
      const game = env.GAME.get(env.GAME.idFromName(intent.game_id));
      let actual = await game.status();
      if (!actual) {
        const white = JSON.parse(intent.white_actor) as Actor;
        const black = JSON.parse(intent.black_actor) as Actor;
        await seatPair(env, event.id, intent.game_id, white.id, black.id);
        if (!this.claimStart(Date.now())) throw new Error('game_start_rate');
        await game.init({ id: intent.game_id, format: event.pool, rated: false, white, black, reservationId: intent.reservation_id,
          tournament: { id: event.id, format: 'arena-v1', round: 1, deadlineAt: intent.deadline_at } });
        actual = await game.status();
      }
      if (actual && actual.status !== 'finished' && now >= intent.deadline_at) {
        await game.enforceTournamentDeadline(event.id, 1);
        actual = await game.status();
      }
      if (actual?.result) await this.bridge.settle(actual.result);
      this.ctx.storage.transactionSync(() => {
        const current = this.intent(intent.game_id);
        if (!current || ['finished', 'cancelled'].includes(current.status)) return;
        this.ctx.storage.sql.exec('UPDATE arena_intents SET status=?,next_at=?,attempts=0,reason=NULL WHERE game_id=?', gamePhase(actual?.status),
          Math.min(now + 30_000, intent.deadline_at > now ? intent.deadline_at : now + 1_000), intent.game_id);
      });
    } catch {
      this.ctx.storage.sql.exec(`UPDATE arena_intents SET attempts=MIN(attempts+1,1000000),next_at=?,reason='Recovery is pending.'
        WHERE game_id=? AND status NOT IN ('finished','cancelled')`, now + 1_000, intent.game_id);
    }
    await this.ctx.storage.sync();
  }

  /** Must run synchronously inside Competition.applyFinished's transaction. */
  record(result: GameResult, sequence: number, now: number): boolean {
    const intent = this.intent(result.id);
    if (!intent) {
      if (result.tournament?.format === 'arena-v1') throw new Error('unregistered_arena_game');
      return false;
    }
    const event = this.event(intent.event_id);
    if (!event || result.status !== 'finished' || result.rated || result.ai || result.white.id !== intent.white_id
      || result.black?.id !== intent.black_id || result.reservationId !== intent.reservation_id || result.format !== event.pool
      || result.tournament?.id !== event.id || result.tournament.format !== 'arena-v1' || result.tournament.round !== 1
      || result.tournament.deadlineAt !== intent.deadline_at || intent.status === 'allocating' || intent.status === 'cancelled') {
      throw new Error('conflicting_arena_result');
    }
    const sql = this.ctx.storage.sql;
    const receipt = sql.exec<{ result_event_id: string; digest: string }>('SELECT result_event_id,digest FROM arena_receipts WHERE game_id=?', result.id).toArray()[0];
    if (receipt) {
      if (receipt.result_event_id !== result.eventId || receipt.digest !== result.terminalDigest) throw new Error('conflicting_arena_result');
      return true;
    }
    const whiteHalf = result.outcome.score === null ? 0 : result.outcome.score * 2;
    const blackHalf = result.outcome.score === null ? 0 : (1 - result.outcome.score) * 2;
    sql.exec(`INSERT INTO arena_receipts(game_id,event_id,result_event_id,digest,sequence,white_half,black_half,accepted_at)
      VALUES(?,?,?,?,?,?,?,?)`, result.id, event.id, result.eventId, result.terminalDigest, sequence, whiteHalf, blackHalf, now);
    sql.exec("UPDATE arena_intents SET status='finished',next_at=NULL,reason=? WHERE game_id=?", result.outcome.reason, result.id);
    for (const [userId, half, ready] of [[intent.white_id, whiteHalf, result.white.ready], [intent.black_id, blackHalf, result.black!.ready]] as const) {
      const noShow = result.outcome.reason === 'readiness-expired' && !ready;
      const updated = sql.exec(`UPDATE arena_entries SET points_half=points_half+?,score_band=points_half+?,games=games+1,
        state='releasing',release_to=?,queued_at=NULL,next_at=?,reason=?
        WHERE event_id=? AND user_id=? AND game_id=? RETURNING user_id`, half, half,
      noShow ? 'paused' : 'registered', now, noShow ? 'Readiness expired. Resume explicitly to queue again.' : null,
      event.id, userId, result.id).toArray();
      if (!updated.length) throw new Error('arena_reservation_conflict');
    }
    const revision = sql.exec<{ revision: number }>(`UPDATE arena_events SET unresolved=unresolved-1,watermark=MAX(watermark,?),next_at=?,revision=revision+1
      WHERE id=? RETURNING revision`, sequence, now, event.id).one().revision;
    this.appendVersions(event.id, [intent.white_id, intent.black_id], revision);
    return true;
  }

  private lifecycle(now: number): void {
    const sql = this.ctx.storage.sql;
    const due = sql.exec<Event>('SELECT * FROM arena_events WHERE next_at<=? ORDER BY next_at,id LIMIT ?', now, ARENA_POLICY.workBatch).toArray();
    for (const event of due) {
      if (event.status === 'scheduled' && now >= event.starts_at) {
        if (!this.enabled() || now >= event.closes_at) {
          sql.exec(`UPDATE arena_events SET status='cancelled',finished_at=?,reason=?,revision=revision+1,next_at=NULL,cleanup_after=? WHERE id=?`,
            now, !this.enabled() ? 'Arena entry is unavailable.' : 'The pairing window was missed.', now + ARENA_POLICY.historyMs, event.id);
        } else sql.exec("UPDATE arena_events SET status='running',revision=revision+1,next_at=? WHERE id=?", now, event.id);
      }
      const current = this.event(event.id)!;
      if (current.status === 'running' && (now >= current.closes_at || !this.enabled())) {
        sql.exec("UPDATE arena_events SET status='draining',revision=revision+1,next_at=? WHERE id=?", now, event.id);
      }
      const after = this.event(event.id)!;
      if (after.status === 'draining' && after.unresolved === 0) {
        sql.exec("UPDATE arena_events SET status='finished',finished_at=?,revision=revision+1,next_at=NULL,cleanup_after=? WHERE id=?", now, now + ARENA_POLICY.historyMs, event.id);
      } else if (after.status === 'running' || after.status === 'draining') {
        sql.exec('UPDATE arena_events SET next_at=? WHERE id=?', Math.min(after.closes_at > now ? after.closes_at : now + 1_000, now + 1_000), event.id);
      }
    }
  }

  private async cleanup(now: number): Promise<void> {
    const sql = this.ctx.storage.sql;
    const rows = sql.exec<Event>('SELECT * FROM arena_events WHERE cleanup_after<=? ORDER BY cleanup_after,id LIMIT 1', now).toArray();
    for (const event of rows) {
      if (event.unresolved || event.projected_revision < event.revision) { sql.exec('UPDATE arena_events SET cleanup_after=? WHERE id=?', now + MINUTE, event.id); continue; }
      const proof = await this.getEnv().DB.prepare(`SELECT 1 FROM arena_final_archives WHERE event_id=?
        AND NOT EXISTS(SELECT 1 FROM tournament_game_admissions WHERE tournament_id=? AND storage_state='retained')
        AND NOT EXISTS(SELECT 1 FROM tournament_account_locks WHERE tournament_id=?)`).bind(event.id, event.id, event.id).first();
      if (!proof) { sql.exec('UPDATE arena_events SET cleanup_after=? WHERE id=?', now + MINUTE, event.id); continue; }
      // Keep receipts and permanent D1 game identities. Remove temporary rows in
      // small batches so a large or held event cannot monopolize maintenance.
      for (const table of ['arena_entries', 'arena_entry_versions', 'arena_pairs', 'arena_intents', 'arena_snapshot_rows'] as const) {
        sql.exec(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE event_id=? LIMIT ?)`, event.id, ARENA_POLICY.workBatch);
      }
      const remains = sql.exec(`SELECT 1 FROM arena_entries WHERE event_id=? UNION ALL SELECT 1 FROM arena_entry_versions WHERE event_id=?
        UNION ALL SELECT 1 FROM arena_pairs WHERE event_id=? UNION ALL SELECT 1 FROM arena_intents WHERE event_id=?
        UNION ALL SELECT 1 FROM arena_snapshot_rows WHERE event_id=? LIMIT 1`, event.id, event.id, event.id, event.id, event.id).toArray().length;
      if (remains) sql.exec('UPDATE arena_events SET cleanup_after=? WHERE id=?', now + 1, event.id);
      else sql.exec('DELETE FROM arena_events WHERE id=?', event.id);
    }
  }

  nextDue(): number | null {
    const now = Date.now();
    const times = [
      this.ctx.storage.sql.exec<{ due: number | null }>('SELECT MIN(next_at) AS due FROM arena_events').one().due,
      this.ctx.storage.sql.exec<{ due: number | null }>("SELECT MIN(next_at) AS due FROM arena_entries WHERE state IN ('claiming','releasing') AND next_at IS NOT NULL").one().due,
      this.ctx.storage.sql.exec<{ due: number | null }>('SELECT MIN(next_at) AS due FROM arena_intents WHERE next_at IS NOT NULL').one().due,
      this.ctx.storage.sql.exec<{ due: number | null }>('SELECT MIN(cleanup_after) AS due FROM arena_events WHERE cleanup_after IS NOT NULL').one().due,
      this.ctx.storage.sql.exec<{ due: number | null }>('SELECT MIN(project_after) AS due FROM arena_events WHERE revision>projected_revision').one().due,
    ].filter((value): value is number => value !== null);
    if (this.ctx.storage.sql.exec('SELECT 1 FROM arena_projection_builds LIMIT 1').toArray().length) times.push(now + 1);
    const publicCleanup = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM arena_meta WHERE key='public-cleanup-at'").toArray()[0];
    if (publicCleanup) times.push(Number(publicCleanup.value));
    return times.length ? Math.min(...times) : null;
  }

  status() {
    return { enabled: this.enabled(), policy: ARENA_POLICY.version, limits: arenaLimits(this.getEnv()), measuredCapacity: null,
      unfinished: this.active(), bytes: this.ctx.storage.sql.databaseSize,
      open: this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM arena_events WHERE status IN ('running','draining')").one().count,
      projectionBuilds: this.ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM arena_projection_builds').one().count };
  }

  private async advanceEntries(now: number): Promise<void> {
    const work = this.ctx.storage.sql.exec<Entry>(`SELECT e.* FROM arena_entries e JOIN arena_events v ON v.id=e.event_id
      WHERE (e.state IN ('claiming','releasing') AND e.next_at<=?) OR
        (e.state='queued' AND (v.status NOT IN ('scheduled','running') OR v.closes_at<=? OR ?=0))
      ORDER BY COALESCE(e.next_at,0),e.event_id,e.user_id LIMIT ?`, now, now, Number(this.enabled()), ARENA_POLICY.workBatch).toArray();
    await bounded(work, ARENA_POLICY.externalConcurrency, async entry => {
      try {
        if (entry.state === 'claiming') await this.claim(entry, now);
        else {
          if (entry.state === 'queued') this.releaseEntry(entry, 'paused', 'Arena pairing has closed.', now);
          await this.release(this.entry(entry.event_id, entry.user_id)!, now);
        }
      } catch { this.ctx.storage.sql.exec('UPDATE arena_entries SET next_at=? WHERE event_id=? AND user_id=?', now + 1_000, entry.event_id, entry.user_id); }
    });
  }

  private async pairQueued(now: number): Promise<void> {
    // Retained-entry byte accounting is needed only when a queued player is due.
    const queued = this.enabled() && this.ctx.storage.sql.exec("SELECT 1 FROM arena_entries WHERE state='queued' AND next_at<=? LIMIT 1", now).toArray().length > 0;
    let room = queued ? await this.storageRoom() : 0;
    if (room <= 0) return;
    const last = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM arena_meta WHERE key='pair-cursor'").toArray()[0]?.value ?? '';
    const events = this.ctx.storage.sql.exec<{ id: string }>(`SELECT id FROM arena_events WHERE status='running'
      ORDER BY CASE WHEN id>? THEN 0 ELSE 1 END,id LIMIT ?`, last, ARENA_POLICY.workBatch).toArray();
    let paired = 0;
    for (let pass = 0; pass < ARENA_POLICY.pairBatch && room > 0 && paired < ARENA_POLICY.pairBatch; pass++) {
      const before = paired;
      for (const event of events) {
        this.ctx.storage.sql.exec("INSERT INTO arena_meta(key,value) VALUES('pair-cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", event.id);
        if (this.pair(event.id, Date.now())) { paired++; room--; }
        if (!room || paired >= ARENA_POLICY.pairBatch) break;
      }
      // No awaited work can add a queued player during this loop. Retry
      // deferred anchors on the next maintenance alarm.
      if (paired === before) break;
    }
  }

  private async advanceIntents(now: number): Promise<void> {
    const creating = this.ctx.storage.sql.exec<Intent>(`SELECT * FROM arena_intents WHERE status IN ('allocating','creating')
      AND next_at<=? ORDER BY next_at,game_id LIMIT ?`, now, ARENA_POLICY.initBatch).toArray();
    await bounded(creating, ARENA_POLICY.externalConcurrency, intent => this.reconcile(intent, now));
    const recovering = this.ctx.storage.sql.exec<Intent>(`SELECT * FROM arena_intents WHERE status IN ('live','settling')
      AND next_at<=? ORDER BY next_at,game_id LIMIT ?`, now, ARENA_POLICY.workBatch).toArray();
    await bounded(recovering, ARENA_POLICY.externalConcurrency, intent => this.reconcile(intent, now));
  }

  async maintenance(): Promise<void> {
    if (this.working) return;
    if (!this.enabled() && !this.ctx.storage.sql.exec('SELECT 1 FROM arena_events LIMIT 1').toArray().length
      && !this.ctx.storage.sql.exec("SELECT 1 FROM arena_meta WHERE key='public-cleanup-at'").toArray().length) return;
    this.working = true;
    try {
      const now = Date.now();
      await this.refreshLegacyGames();
      this.ensure(now);
      this.ctx.storage.transactionSync(() => this.lifecycle(now));
      await this.advanceEntries(now);
      await this.pairQueued(now);
      await this.ctx.storage.sync();
      await this.advanceIntents(now);
      this.ctx.storage.transactionSync(() => this.lifecycle(now));
      await this.projection.advance(now);
      this.projection.cleanup();
      await this.projection.cleanupPublic(now);
      await this.cleanup(now);
      await this.ctx.storage.sync();
    } finally { this.working = false; }
  }
}
