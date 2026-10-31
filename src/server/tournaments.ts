import { pair as roundRobin } from '@echecs/round-robin';
import { Tournament, type Game as TournamentGame, type TournamentData } from '@echecs/tournament';
import { acquireTournamentAccount, competitiveSessionEligible } from './auth';
import { ApiError } from './security';
import { newWorkAllowed, reserveMonthlyWork } from './budget';
import type { Env } from './env';
import { assertNotClosing, NEW_GAMES_PAUSED, requireSession, seatPair, type EventBridge } from './events';
import { CADENCE_POOL, CADENCES, GAME_WINDOW_MS, HISTORY_MS, MINUTE, occurrences, REGISTRATION_MS } from './schedule';
import type { Actor, GameResult, Pool } from '../shared/protocol';
import type { TournamentCadence, TournamentList, TournamentPlayerStatus, TournamentView } from '../shared/tournaments';

export const TOURNAMENT_LIMITS = {
  minPlayers: 3, maxPlayers: 4, rounds: 3, intermissionMs: MINUTE, startGraceMs: 5 * MINUTE,
} as const;
const RECOVERY_RETRY_MS = 30_000;
const registrationOpensAt = (startsAt: number) => startsAt - REGISTRATION_MS;
const over = (event: Pick<Event, 'status'>) => event.status === 'finished' || event.status === 'cancelled';

interface Member { actor: Actor; status: TournamentPlayerStatus }
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
interface Bridge extends EventBridge {
  release(tournamentId: string): void;
  canReserve(games: number): boolean;
  start(): boolean;
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
    for (const cadence of CADENCES) {
      const pool = CADENCE_POOL[cadence];
      for (const startsAt of occurrences(cadence, now)) {
        if (startsAt < now - TOURNAMENT_LIMITS.startGraceMs) continue;
        const id = `${cadence}-${startsAt}`;
        if (this.load(id)) continue;
        this.save({ cadence, pool, roundMs: GAME_WINDOW_MS[pool], id, startsAt, status: 'scheduled', reason: null, round: 0, roundDeadlineAt: null,
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
      registrationOpensAt: registrationOpensAt(event.startsAt),
      status: event.status === 'scheduled' && now >= registrationOpensAt(event.startsAt) && now < event.startsAt ? 'registering' : event.status,
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
      WHERE status IN ('finished','cancelled') AND starts_at>=? ORDER BY starts_at DESC,id LIMIT 12`, now - HISTORY_MS).toArray();
    const result = { enabled: this.enabled(), serverNow: now,
      events: [...rows, ...recent].map(row => this.view(JSON.parse(row.value) as Event, actor, now)),
      limits: { minPlayers: TOURNAMENT_LIMITS.minPlayers, maxPlayers: TOURNAMENT_LIMITS.maxPlayers,
        registrationMinutes: REGISTRATION_MS / MINUTE } };
    await this.ctx.storage.sync();
    return result;
  }

  async get(id: string, actor?: Actor): Promise<TournamentView | null> {
    this.ensure();
    const event = this.load(id);
    await this.ctx.storage.sync();
    if (!event || (over(event) && event.startsAt < Date.now() - HISTORY_MS)) return null;
    return this.view(event, actor);
  }

  async register(actor: Actor, id: string): Promise<TournamentView> {
    if (!this.enabled()) throw new ApiError(503, 'TOURNAMENTS_CLOSED', 'Scheduled tournaments are unavailable.');
    if (!await competitiveSessionEligible(actor, this.getEnv())) throw new ApiError(403, 'TOURNAMENT_INELIGIBLE', 'Tournaments require an eligible account.');
    if (!this.load(id)?.members.some(member => member.actor.id === actor.id) && !await newWorkAllowed(this.getEnv(), 'games')) {
      throw new ApiError(503, 'NEW_GAMES_PAUSED', NEW_GAMES_PAUSED);
    }
    this.ensure();
    const event = this.ctx.storage.transactionSync(() => {
      assertNotClosing(this.bridge, actor.id);
      const value = this.load(id);
      const now = Date.now();
      if (!value) throw new ApiError(404, 'TOURNAMENT_NOT_FOUND', 'This tournament was not found.');
      if (value.status !== 'scheduled' || now >= value.startsAt || now < registrationOpensAt(value.startsAt)) {
        throw new ApiError(409, 'REGISTRATION_CLOSED', 'Registration opens 15 minutes before the start and closes at the start.');
      }
      const existing = value.members.find(item => item.actor.id === actor.id);
      if (existing) existing.actor = actor;
      else {
        if (value.members.length >= TOURNAMENT_LIMITS.maxPlayers) throw new ApiError(409, 'TOURNAMENT_FULL', 'This tournament is full.');
        value.members.push({ actor, status: 'registered' });
      }
      this.save(value);
      return value;
    });
    await this.ctx.storage.sync();
    return this.view(event, actor);
  }

  async withdraw(actor: Actor, id: string): Promise<TournamentView> {
    await requireSession(actor, this.getEnv());
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
      if (!current || !over(current)) return;
      this.bridge.release(event.id);
      current.nextAt = null;
      this.save(current);
    });
  }

  private cancel(event: Event, reason: string, now: number): void {
    event.status = 'cancelled'; event.reason = reason; event.finishedAt = now; event.nextAt = now;
    this.save(event);
  }

  private async admitted(id: string): Promise<number> {
    return await this.getEnv().DB.prepare('SELECT COUNT(*) AS count FROM tournament_game_admissions WHERE tournament_id=?').bind(id).first<number>('count') ?? 0;
  }

  private mark(id: string, memberId: string, status: Member['status']): void {
    const event = this.load(id)!;
    const member = event.members.find(item => item.actor.id === memberId)!;
    member.status = status;
    this.save(event);
  }

  /** Each step commits before the next external call, so a restart resumes from the stored status. */
  private async admit(id: string, memberId: string): Promise<void> {
    const env = this.getEnv();
    const event = this.load(id)!;
    const member = event.members.find(item => item.actor.id === memberId)!;
    if (member.status !== 'registered') return;
    const dropLock = () => env.DB.prepare('DELETE FROM tournament_account_locks WHERE user_id=? AND tournament_id=?').bind(memberId, id).run();
    if (!await competitiveSessionEligible(member.actor, env)) {
      await dropLock();
      this.mark(id, memberId, 'skipped-ineligible');
      this.bridge.releaseMember(memberId, id);
      return;
    }
    const busy = this.ctx.storage.transactionSync(() => {
      const taken = this.bridge.busy(memberId, id);
      if (taken) this.mark(id, memberId, 'skipped-busy');
      else this.bridge.reserve(memberId, id, event.pool);
      return taken;
    });
    if (busy) return;
    await this.ctx.storage.sync();
    const acquired = await acquireTournamentAccount(env, member.actor, id);
    this.mark(id, memberId, acquired ? 'admitted' : 'skipped-busy');
    if (!acquired) {
      await dropLock();
      this.bridge.releaseMember(memberId, id);
    }
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
      // A first round time is stored only with the planned IDs. If D1 accepted them before the interruption,
      // drain the original cutoff rather than abandoning retained IDs.
      const accepted = event.firstRoundAt !== null && await this.admitted(id) === event.admissionIds.length;
      event = this.load(id)!;
      if (accepted) {
        this.ctx.storage.transactionSync(() => this.startRound(event, event.firstRoundAt!));
        await this.ctx.storage.sync();
      } else this.cancel(event, 'The start could not recover within five minutes.', now);
      return;
    }
    for (const member of event.members) await this.admit(id, member.actor.id);
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
    const planned = await this.admitted(id) === event.admissionIds.length;
    if (!planned && !this.bridge.canReserve(event.admissionIds.length)) {
      this.cancel(this.load(id)!, 'The shared game admission limit was reached.', now);
      return;
    }
    if (!planned && !await reserveMonthlyWork(this.getEnv(), 'games', `tournament:${event.id}`, now, event.admissionIds.length)) {
      this.cancel(this.load(id)!, NEW_GAMES_PAUSED, now);
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
      await seatPair(env, event.id, pairing.id, white.id, black.id);
      if (!this.bridge.start()) throw new Error('game_start_rate');
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

  /** One event's recovery steps. A failure only delays the next pass. */
  private async advance(id: string, now: number): Promise<void> {
    try {
      let event = this.load(id)!;
      if (event.status === 'scheduled' || event.status === 'starting') await this.start(id, now);
      event = this.load(id)!;
      if (event.status === 'intermission' && event.nextRoundAt! <= now) {
        this.ctx.storage.transactionSync(() => this.startRound(event, now));
        await this.ctx.storage.sync();
      }
      event = this.load(id)!;
      if (event.status === 'running') await this.runRound(event, now);
      event = this.load(id)!;
      if (over(event)) await this.release(event);
    } catch {
      const event = this.load(id)!;
      event.nextAt = now + RECOVERY_RETRY_MS;
      // A finished or cancelled event keeps the reason players already see.
      if (!over(event)) event.reason = 'Recovery is pending after a service interruption.';
      this.save(event);
    }
  }

  private async runRound(event: Event, now: number): Promise<void> {
    for (const pairing of event.games.filter(item => item.round === event.round && item.status !== 'finished')) {
      await this.initialize(event, pairing);
      if (now >= event.roundDeadlineAt!) {
        const game = this.getEnv().GAME.get(this.getEnv().GAME.idFromName(pairing.id));
        await game.enforceTournamentDeadline(event.id, pairing.round);
        const actual = await game.status();
        if (actual?.result) await this.bridge.settle(actual.result);
      }
    }
    const current = this.load(event.id)!;
    if (current.status === 'running') { current.nextAt = now + RECOVERY_RETRY_MS; current.reason = null; this.save(current); }
  }

  /** Drop events past the history window once no retained Game payload refers to them. */
  private async prune(now: number): Promise<void> {
    const old = this.ctx.storage.sql.exec<{ id: string }>(`SELECT id FROM tournaments WHERE status IN ('finished','cancelled')
      AND next_at IS NULL AND starts_at<? ORDER BY starts_at,id LIMIT 4`, now - HISTORY_MS).toArray();
    for (const event of old) {
      const retained = await this.getEnv().DB.prepare("SELECT 1 FROM tournament_game_admissions WHERE tournament_id=? AND storage_state='retained' LIMIT 1").bind(event.id).first();
      if (retained) continue;
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec('DELETE FROM tournament_games WHERE tournament_id=?', event.id);
        this.ctx.storage.sql.exec('DELETE FROM tournaments WHERE id=?', event.id);
      });
    }
  }

  async maintenance(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      const now = Date.now();
      this.ensure(now);
      const work = this.ctx.storage.sql.exec<{ id: string }>('SELECT id FROM tournaments WHERE next_at<=? ORDER BY next_at,id LIMIT 4', now).toArray();
      for (const row of work) await this.advance(row.id, now);
      await this.prune(now);
      await this.ctx.storage.sync();
    } finally { this.working = false; }
  }
}
