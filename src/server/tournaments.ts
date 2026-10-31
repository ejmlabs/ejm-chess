import { pair as roundRobin } from '@echecs/round-robin';
import { Tournament, type Game as TournamentGame, type TournamentData } from '@echecs/tournament';
import { acquireTournamentAccount, acquireTournamentSeat, revalidateActor, competitiveAccountEligibility } from './auth';
import { ApiError } from './security';
import { newWorkAllowed, reserveMonthlyWork } from './budget';
import type { Env } from './env';
import type { Actor, GameResult, Pool } from '../shared/protocol';
import type { TournamentCadence, TournamentList, TournamentPlayerStatus, TournamentView } from '../shared/tournaments';

const MINUTE = 60_000;
const DAY = 86_400_000;
export const TOURNAMENT_LIMITS = {
  minPlayers: 3, maxPlayers: 4, registrationMinutes: 15, historyDays: 7, rounds: 3, intermissionMs: MINUTE, startGraceMs: 5 * MINUTE,
} as const;
const SERIES: readonly { cadence: TournamentCadence; pool: Pool; roundMs: number }[] = [
  { cadence: 'hourly', pool: 'blitz', roundMs: 18 * MINUTE },
  { cadence: 'daily', pool: 'rapid', roundMs: 40 * MINUTE },
  { cadence: 'weekly', pool: 'rapid', roundMs: 40 * MINUTE },
];

interface Member { actor: Actor; joinedAt: number; status: TournamentPlayerStatus; lock: 'pending' | 'held' | 'released' }
interface Pairing {
  id: string; reservationId: string; round: number; deadlineAt: number; whiteId: string; blackId: string;
  status: 'creating' | 'ready' | 'active' | 'pending-adjudication' | 'finished';
  whitePoints: number | null; blackPoints: number | null; reason: string | null;
  eventId?: string; digest?: string;
}
interface Event {
  id: string; cadence: TournamentCadence; pool: Pool; startsAt: number; roundMs: number;
  status: 'scheduled' | 'starting' | 'running' | 'intermission' | 'finished' | 'cancelled';
  reason: string | null; round: number; roundDeadlineAt: number | null; nextRoundAt: number | null;
  finishedAt: number | null; nextAt: number | null; members: Member[]; games: Pairing[]; engine: TournamentData | null;
  admissionIds: string[];
  firstRoundAt: number | null;
}
interface Bridge {
  closing(userId: string): boolean;
  busy(userId: string, tournamentId: string): boolean;
  reserve(userId: string, tournamentId: string, pool: Pool): void;
  releaseMember(userId: string, tournamentId: string): void;
  release(tournamentId: string): void;
  rating(pool: Pool, userId: string): number;
  settle(result: GameResult): Promise<{ accepted: boolean; pending: boolean }>;
  canReserve?(games: number): boolean;
  start?(): boolean;
}

/** Fixed UTC cadences use platform dates; delayed maintenance never enumerates missed periods. */
function occurrences(cadence: TournamentCadence, now: number): [number, number] {
  if (cadence === 'hourly') { const start = Math.floor(now / (60 * MINUTE)) * 60 * MINUTE; return [start, start + 60 * MINUTE]; }
  const date = new Date(now);
  let start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), cadence === 'daily' ? 18 : 16);
  if (cadence === 'weekly') start -= date.getUTCDay() * DAY;
  const interval = cadence === 'daily' ? DAY : 7 * DAY;
  if (start > now) return [start - interval, start];
  return [start, start + interval];
}

export class TournamentControl {
  private working = false;
  constructor(private ctx: DurableObjectState, private getEnv: () => Env, private bridge: Bridge) {
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS tournaments
      (id TEXT PRIMARY KEY,starts_at INTEGER NOT NULL,status TEXT NOT NULL,next_at INTEGER,value TEXT NOT NULL)`);
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS tournament_work ON tournaments(next_at,id)');
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS tournament_history ON tournaments(starts_at,id)');
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS tournament_games
      (game_id TEXT PRIMARY KEY,tournament_id TEXT NOT NULL,round INTEGER NOT NULL)`);
  }

  private enabled(): boolean { return this.getEnv().TOURNAMENTS_ENABLED === 'true'; }
  private load(id: string): Event | null {
    const row = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM tournaments WHERE id=?', id).toArray()[0];
    return row ? JSON.parse(row.value) as Event : null;
  }
  private save(event: Event): void {
    this.ctx.storage.sql.exec(`INSERT INTO tournaments(id,starts_at,status,next_at,value) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,next_at=excluded.next_at,value=excluded.value`,
    event.id, event.startsAt, event.status, event.nextAt, JSON.stringify(event));
  }
  private engine(event: Event): Tournament {
    if (!event.engine) throw new Error('tournament_not_started');
    return new Tournament(event.engine, { pairingSystem: roundRobin });
  }
  private ensure(now = Date.now()): void {
    if (!this.enabled()) return;
    for (const series of SERIES) {
      for (const startsAt of occurrences(series.cadence, now)) {
        if (startsAt < now - TOURNAMENT_LIMITS.startGraceMs) continue;
        const id = `${series.cadence}-${startsAt}`;
        if (this.load(id)) continue;
        this.save({ ...series, id, startsAt, status: 'scheduled', reason: null, round: 0, roundDeadlineAt: null,
          nextRoundAt: null, finishedAt: null, nextAt: startsAt, members: [], games: [], engine: null, admissionIds: [], firstRoundAt: null });
      }
    }
  }

  private view(event: Event, actor?: Actor, now = Date.now()): TournamentView {
    const member = actor && event.members.find(item => item.actor.id === actor.id);
    const names = new Map(event.members.map(item => [item.actor.id, item.actor.name]));
    const standings = event.engine ? this.engine(event).standings().map(row => ({ id: row.player,
      name: names.get(row.player) ?? 'Player', rank: row.rank, points: row.score })).sort((a, b) => b.points - a.points || a.id.localeCompare(b.id)) : [];
    return {
      id: event.id, cadence: event.cadence, pool: event.pool, startsAt: event.startsAt,
      registrationOpensAt: event.startsAt - TOURNAMENT_LIMITS.registrationMinutes * MINUTE,
      status: event.status === 'scheduled' && now >= event.startsAt - TOURNAMENT_LIMITS.registrationMinutes * MINUTE && now < event.startsAt ? 'registering' : event.status,
      reason: event.reason, rated: false, round: event.round, rounds: TOURNAMENT_LIMITS.rounds,
      roundDeadlineAt: event.roundDeadlineAt, nextRoundAt: event.nextRoundAt, finishedAt: event.finishedAt,
      maxPlayers: TOURNAMENT_LIMITS.maxPlayers,
      players: event.members.map(item => ({ id: item.actor.id, name: item.actor.name,
        status: item.status === 'registered' || item.status === 'admitted' ? item.status : 'not-admitted' })), standings,
      games: event.games.map(({ id, round, whiteId, blackId, status, whitePoints, blackPoints, reason }) => ({ id, round, whiteId, blackId, status, whitePoints, blackPoints,
        reason: reason === 'eligibility-revoked' ? 'technical-void' : reason })),
      myStatus: member?.status ?? null,
      myGameId: member ? event.games.find(game => game.round === event.round && ['ready', 'active', 'pending-adjudication'].includes(game.status)
        && [game.whiteId, game.blackId].includes(member.actor.id))?.id ?? null : null,
    };
  }

  async list(actor?: Actor): Promise<TournamentList> {
    const now = Date.now();
    this.ensure(now);
    const rows = this.ctx.storage.sql.exec<{ value: string }>(`SELECT value FROM tournaments
      WHERE status NOT IN ('finished','cancelled') ORDER BY starts_at,id LIMIT 9`).toArray();
    const recent = this.ctx.storage.sql.exec<{ value: string }>(`SELECT value FROM tournaments
      WHERE status IN ('finished','cancelled') AND starts_at>=? ORDER BY starts_at DESC,id LIMIT 12`, now - TOURNAMENT_LIMITS.historyDays * DAY).toArray();
    const result = { enabled: this.enabled(), serverNow: now,
      events: [...rows, ...recent].map(row => this.view(JSON.parse(row.value) as Event, actor, now)),
      limits: { minPlayers: TOURNAMENT_LIMITS.minPlayers, maxPlayers: TOURNAMENT_LIMITS.maxPlayers,
        registrationMinutes: TOURNAMENT_LIMITS.registrationMinutes } };
    await this.ctx.storage.sync();
    return result;
  }

  async get(id: string, actor?: Actor): Promise<TournamentView | null> {
    this.ensure();
    const event = this.load(id);
    await this.ctx.storage.sync();
    if (!event || (['finished', 'cancelled'].includes(event.status) && event.startsAt < Date.now() - TOURNAMENT_LIMITS.historyDays * DAY)) return null;
    return this.view(event, actor);
  }

  private async eligible(actor: Actor): Promise<boolean> {
    return await revalidateActor(actor, this.getEnv()) && (await competitiveAccountEligibility(this.getEnv(), actor.id)).eligible;
  }

  async register(actor: Actor, id: string): Promise<TournamentView> {
    if (!this.enabled()) throw new ApiError(503, 'TOURNAMENTS_CLOSED', 'Scheduled tournaments are unavailable.');
    if (!await this.eligible(actor)) throw new ApiError(403, 'TOURNAMENT_INELIGIBLE', 'Tournaments require an eligible account.');
    if (!this.load(id)?.members.some(member => member.actor.id === actor.id) && !await newWorkAllowed(this.getEnv(), 'games')) {
      throw new ApiError(503, 'NEW_GAMES_PAUSED', 'New games are paused. Existing games will finish.');
    }
    this.ensure();
    const event = this.ctx.storage.transactionSync(() => {
      if (this.bridge.closing(actor.id)) throw new ApiError(409, 'ACCOUNT_CLOSING', 'Account closure is pending. Try again shortly.');
      const value = this.load(id);
      const now = Date.now();
      if (!value) throw new ApiError(404, 'TOURNAMENT_NOT_FOUND', 'This tournament was not found.');
      if (value.status !== 'scheduled' || now >= value.startsAt || now < value.startsAt - TOURNAMENT_LIMITS.registrationMinutes * MINUTE) {
        throw new ApiError(409, 'REGISTRATION_CLOSED', 'Registration opens 15 minutes before the start and closes at the start.');
      }
      const existing = value.members.find(item => item.actor.id === actor.id);
      if (existing) existing.actor = actor;
      else {
        if (value.members.length >= TOURNAMENT_LIMITS.maxPlayers) throw new ApiError(409, 'TOURNAMENT_FULL', 'This tournament is full.');
        value.members.push({ actor, joinedAt: now, status: 'registered', lock: 'pending' });
      }
      this.save(value);
      return value;
    });
    await this.ctx.storage.sync();
    return this.view(event, actor);
  }

  async withdraw(actor: Actor, id: string): Promise<TournamentView> {
    if (!await revalidateActor(actor, this.getEnv())) throw new ApiError(401, 'SIGN_IN_REQUIRED', 'Sign in again.');
    const event = this.ctx.storage.transactionSync(() => {
      const value = this.load(id);
      if (!value) throw new ApiError(404, 'TOURNAMENT_NOT_FOUND', 'This tournament was not found.');
      if (value.status !== 'scheduled' || Date.now() >= value.startsAt) throw new ApiError(409, 'TOURNAMENT_STARTED', 'Registration has closed. Your reserved rounds will finish automatically.');
      value.members = value.members.filter(item => item.actor.id !== actor.id);
      this.save(value);
      return value;
    });
    await this.ctx.storage.sync();
    return this.view(event, actor);
  }

  private async release(event: Event): Promise<void> {
    await this.getEnv().DB.prepare('DELETE FROM tournament_account_locks WHERE tournament_id=?').bind(event.id).run();
    this.ctx.storage.transactionSync(() => {
      const current = this.load(event.id);
      if (!current || !['finished', 'cancelled'].includes(current.status)) return;
      this.bridge.release(event.id);
      current.members.forEach(item => { item.lock = 'released'; });
      current.nextAt = null;
      this.save(current);
    });
  }

  private cancel(event: Event, reason: string, now: number): void {
    event.status = 'cancelled'; event.reason = reason; event.finishedAt = now; event.nextAt = now;
    this.save(event);
  }

  private async start(id: string, now: number): Promise<void> {
    let event = this.load(id)!;
    if (event.status === 'scheduled') {
      if (!this.enabled()) { this.cancel(event, 'Tournaments are unavailable.', now); return; }
      if (now - event.startsAt > TOURNAMENT_LIMITS.startGraceMs) { this.cancel(event, 'The start was missed during a service interruption.', now); return; }
      event.status = 'starting'; event.nextAt = now;
      this.save(event);
      await this.ctx.storage.sync();
    }
    event = this.load(id)!;
    if (now - event.startsAt > TOURNAMENT_LIMITS.startGraceMs) {
      const count = event.admissionIds.length && event.engine && event.firstRoundAt !== null
        ? await this.getEnv().DB.prepare('SELECT COUNT(*) FROM tournament_game_admissions WHERE tournament_id=?').bind(event.id).first<number>('COUNT(*)') : 0;
      event = this.load(id)!;
      if (count && count === event.admissionIds.length) {
        // D1 accepted the event before the interruption. Drain its original cutoff rather than abandoning retained IDs.
        this.ctx.storage.transactionSync(() => this.startRound(event, event.firstRoundAt!));
        await this.ctx.storage.sync();
      } else this.cancel(event, 'The start could not recover within five minutes.', now);
      return;
    }
    for (const memberId of event.members.map(item => item.actor.id)) {
      event = this.load(id)!;
      const member = event.members.find(item => item.actor.id === memberId)!;
      if (member.status !== 'registered') continue;
      const eligible = await this.eligible(member.actor);
      event = this.load(id)!;
      const checked = event.members.find(item => item.actor.id === memberId)!;
      if (!eligible) {
        await this.getEnv().DB.prepare('DELETE FROM tournament_account_locks WHERE user_id=? AND tournament_id=?').bind(memberId, event.id).run();
        event = this.load(id)!;
        const skipped = event.members.find(item => item.actor.id === memberId)!;
        skipped.status = 'skipped-ineligible'; skipped.lock = 'released';
        this.bridge.releaseMember(memberId, event.id); this.save(event); continue;
      }
      this.ctx.storage.transactionSync(() => {
        if (this.bridge.busy(memberId, event.id)) { checked.status = 'skipped-busy'; checked.lock = 'released'; }
        else this.bridge.reserve(memberId, event.id, event.pool);
        this.save(event);
      });
      if (checked.status !== 'registered') continue;
      await this.ctx.storage.sync();
      const acquired = await acquireTournamentAccount(this.getEnv(), checked.actor, event.id);
      event = this.load(id)!;
      const current = event.members.find(item => item.actor.id === memberId)!;
      current.status = acquired ? 'admitted' : 'skipped-busy';
      current.lock = acquired ? 'held' : 'released';
      this.save(event);
      if (!acquired) {
        await this.getEnv().DB.prepare('DELETE FROM tournament_account_locks WHERE user_id=? AND tournament_id=?').bind(memberId, event.id).run();
        this.bridge.releaseMember(memberId, event.id);
      }
    }
    event = this.load(id)!;
    const players = event.members.filter(item => item.status === 'admitted').map(item => ({ id: item.actor.id, points: 0, rank: 0,
      rating: this.bridge.rating(event.pool, item.actor.id) })).sort((a, b) => b.rating - a.rating || a.id.localeCompare(b.id));
    players.forEach((player, index) => { player.rank = index + 1; });
    if (players.length < TOURNAMENT_LIMITS.minPlayers) { this.cancel(event, 'Fewer than three eligible available players remained at the start.', now); return; }
    if (!event.engine) {
      const firstRoundAt = Date.now();
      if (firstRoundAt - event.startsAt > TOURNAMENT_LIMITS.startGraceMs) { this.cancel(event, 'The start could not recover within five minutes.', firstRoundAt); return; }
      event.engine = new Tournament({ players, completedRounds: [], totalRounds: TOURNAMENT_LIMITS.rounds }, { pairingSystem: roundRobin }).toJSON();
      event.admissionIds = Array.from({ length: Math.floor(players.length / 2) * TOURNAMENT_LIMITS.rounds }, () => crypto.randomUUID());
      event.firstRoundAt = firstRoundAt;
      this.save(event);
      await this.ctx.storage.sync();
    }
    // Admit the full fixed event atomically before creating its first game. Stable IDs survive retries.
    const priorAdmissions = await this.getEnv().DB.prepare('SELECT COUNT(*) AS count FROM tournament_game_admissions WHERE tournament_id=?')
      .bind(event.id).first<number>('count');
    if (priorAdmissions !== event.admissionIds.length && this.bridge.canReserve && !this.bridge.canReserve(event.admissionIds.length)) {
      this.cancel(this.load(id)!, 'The shared game admission limit was reached.', now);
      return;
    }
    if (priorAdmissions !== event.admissionIds.length
      && !await reserveMonthlyWork(this.getEnv(), 'games', `tournament:${event.id}`, now, event.admissionIds.length)) {
      this.cancel(this.load(id)!, 'New games are paused. Existing games will finish.', now);
      return;
    }
    // SQLite needs a WHERE clause to parse INSERT ... SELECT ... ON CONFLICT.
    await this.getEnv().DB.prepare(`INSERT INTO tournament_game_admissions(game_id,tournament_id,created_at)
      SELECT value,?,? FROM json_each(?) WHERE true ON CONFLICT(game_id) DO NOTHING`)
      .bind(event.id, now, JSON.stringify(event.admissionIds)).run();
    event = this.load(id)!;
    this.ctx.storage.transactionSync(() => this.startRound(event, event.firstRoundAt!));
    await this.ctx.storage.sync();
  }

  private startRound(event: Event, now: number): void {
    const tournament = this.engine(event);
    const pairs = tournament.pair();
    event.round++;
    event.status = 'running'; event.nextRoundAt = null; event.roundDeadlineAt = now + event.roundMs; event.nextAt = now;
    event.reason = null;
    event.engine = tournament.toJSON();
    for (const [index, pairing] of pairs.games.entries()) {
      const id = event.admissionIds[(event.round - 1) * pairs.games.length + index];
      event.games.push({ id, reservationId: crypto.randomUUID(), round: event.round, deadlineAt: event.roundDeadlineAt, whiteId: pairing.white, blackId: pairing.black,
        status: 'creating', whitePoints: null, blackPoints: null, reason: null });
      this.ctx.storage.sql.exec('INSERT INTO tournament_games(game_id,tournament_id,round) VALUES(?,?,?)', id, event.id, event.round);
    }
    this.save(event);
  }

  private async initialize(event: Event, pairing: Pairing): Promise<void> {
    const env = this.getEnv();
    const game = env.GAME.get(env.GAME.idFromName(pairing.id));
    let actual = await game.status();
    if (!actual) {
      const admitted = await env.DB.prepare('SELECT 1 FROM tournament_game_admissions WHERE game_id=? AND tournament_id=?').bind(pairing.id, event.id).first();
      if (!admitted) throw new Error('tournament_admission_missing');
      const white = event.members.find(item => item.actor.id === pairing.whiteId)!.actor;
      const black = event.members.find(item => item.actor.id === pairing.blackId)!.actor;
      const checks = await Promise.all([competitiveAccountEligibility(env, white.id), competitiveAccountEligibility(env, black.id)]);
      if (checks.every(check => check.eligible)) {
        const whiteSeat = await acquireTournamentSeat(env, white.id, pairing.id, event.id);
        const blackSeat = await acquireTournamentSeat(env, black.id, pairing.id, event.id);
        if (!whiteSeat || !blackSeat) {
          const current = await Promise.all([competitiveAccountEligibility(env, white.id), competitiveAccountEligibility(env, black.id)]);
          if (current.every(check => check.eligible)) throw new Error('tournament_seat_unavailable');
        }
      }
      if (this.bridge.start && !this.bridge.start()) throw new Error('game_start_rate');
      // Game independently rechecks eligibility and writes an immediate zero-score terminal record if revoked.
      await game.init({ id: pairing.id, format: event.pool, rated: false, reservationId: pairing.reservationId,
        white, black, tournament: { id: event.id, round: pairing.round, deadlineAt: pairing.deadlineAt } });
      actual = await game.status();
    }
    if (actual?.result) await this.bridge.settle(actual.result);
    if (actual) {
      const current = this.load(event.id)!;
      const pair = current.games.find(item => item.id === pairing.id)!;
      if (pair.status !== 'finished') pair.status = actual.status === 'active' ? 'active' : actual.status === 'pending-adjudication' ? 'pending-adjudication' : 'ready';
      this.save(current);
    }
  }

  /** Called in the same authoritative transaction as accepted game settlement. */
  record(result: GameResult): void {
    if (result.tournament?.format === 'arena-v1') throw new Error('arena_result_dispatch');
    const mapping = this.ctx.storage.sql.exec<{ tournament_id: string; round: number }>('SELECT tournament_id,round FROM tournament_games WHERE game_id=?', result.id).toArray()[0];
    if (!mapping) {
      if (result.tournament) throw new Error('unregistered_tournament_game');
      return;
    }
    const event = this.load(mapping.tournament_id)!;
    const pairing = event.games.find(item => item.id === result.id)!;
    if (result.rated || result.ai || result.white.id !== pairing.whiteId || result.black?.id !== pairing.blackId
      || result.reservationId !== pairing.reservationId || result.tournament?.id !== event.id || result.tournament.round !== pairing.round
      || result.tournament.deadlineAt !== pairing.deadlineAt || result.format !== event.pool) throw new Error('conflicting_tournament_result');
    if (pairing.status === 'finished') {
      if (pairing.eventId !== result.eventId || pairing.digest !== result.terminalDigest) throw new Error('conflicting_tournament_result');
      return;
    }
    if (result.status !== 'finished') return;
    let recorded: TournamentGame;
    if (result.outcome.score !== null) {
      recorded = { white: pairing.whiteId, black: pairing.blackId, rated: false, result: result.outcome.score === 1 ? 'white' : result.outcome.score === 0 ? 'black' : 'draw' };
      pairing.whitePoints = result.outcome.score; pairing.blackPoints = 1 - result.outcome.score;
    } else if (result.outcome.reason === 'readiness-expired' && result.white.ready !== result.black!.ready) {
      recorded = result.white.ready ? { white: pairing.whiteId, black: pairing.blackId, result: 'white', forfeit: 'black' }
        : { white: pairing.whiteId, black: pairing.blackId, result: 'black', forfeit: 'white' };
      pairing.whitePoints = result.white.ready ? 1 : 0; pairing.blackPoints = result.black!.ready ? 1 : 0;
    } else {
      recorded = { white: pairing.whiteId, black: pairing.blackId, result: 'none', forfeit: 'both' };
      pairing.whitePoints = 0; pairing.blackPoints = 0;
    }
    const tournament = this.engine(event);
    tournament.record(recorded);
    event.engine = tournament.toJSON();
    pairing.status = 'finished'; pairing.reason = result.outcome.reason; pairing.eventId = result.eventId; pairing.digest = result.terminalDigest;
    event.reason = null;
    if (event.games.filter(item => item.round === event.round).every(item => item.status === 'finished')) {
      if (event.round >= TOURNAMENT_LIMITS.rounds) { event.status = 'finished'; event.finishedAt = Date.now(); event.nextAt = Date.now(); }
      else { event.status = 'intermission'; event.nextRoundAt = Date.now() + TOURNAMENT_LIMITS.intermissionMs; event.nextAt = event.nextRoundAt; }
    }
    this.save(event);
  }

  nextDue(): number | null {
    return this.ctx.storage.sql.exec<{ due: number | null }>('SELECT MIN(next_at) AS due FROM tournaments').one().due;
  }

  async maintenance(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      const now = Date.now();
      this.ensure(now);
      const work = this.ctx.storage.sql.exec<{ id: string }>('SELECT id FROM tournaments WHERE next_at<=? ORDER BY next_at,id LIMIT 4', now).toArray();
      for (const row of work) {
        try {
          let event = this.load(row.id)!;
          if (event.status === 'scheduled' || event.status === 'starting') await this.start(event.id, now);
          event = this.load(row.id)!;
          if (event.status === 'intermission' && event.nextRoundAt! <= now) {
            this.ctx.storage.transactionSync(() => this.startRound(event, now));
            await this.ctx.storage.sync();
          }
          event = this.load(row.id)!;
          if (event.status === 'running') {
            for (const pairing of event.games.filter(item => item.round === event.round && item.status !== 'finished')) {
              await this.initialize(event, pairing);
              if (now >= event.roundDeadlineAt!) {
                const game = this.getEnv().GAME.get(this.getEnv().GAME.idFromName(pairing.id));
                await game.enforceTournamentDeadline(event.id, pairing.round);
                const actual = await game.status();
                if (actual?.result) await this.bridge.settle(actual.result);
              }
            }
            event = this.load(row.id)!;
            if (event.status === 'running') { event.nextAt = now + 30_000; event.reason = null; this.save(event); }
          }
          event = this.load(row.id)!;
          if (event.status === 'finished' || event.status === 'cancelled') await this.release(event);
        } catch {
          const event = this.load(row.id)!;
          event.nextAt = now + 30_000;
          event.reason = 'Recovery is pending after a service interruption.';
          this.save(event);
        }
      }
      const old = this.ctx.storage.sql.exec<{ id: string }>(`SELECT id FROM tournaments WHERE status IN ('finished','cancelled')
        AND next_at IS NULL AND starts_at<? ORDER BY starts_at,id LIMIT 4`, now - TOURNAMENT_LIMITS.historyDays * DAY).toArray();
      for (const event of old) {
        const retained = await this.getEnv().DB.prepare("SELECT 1 FROM tournament_game_admissions WHERE tournament_id=? AND storage_state='retained' LIMIT 1").bind(event.id).first();
        if (retained) continue;
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec('DELETE FROM tournament_games WHERE tournament_id=?', event.id);
          this.ctx.storage.sql.exec('DELETE FROM tournaments WHERE id=?', event.id);
        });
      }
      await this.ctx.storage.sync();
    } finally { this.working = false; }
  }
}
