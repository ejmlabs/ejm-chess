import { DurableObject } from 'cloudflare:workers';
import { Chess } from 'chess.js';
import { passwordAccountReady, rankedEligibility, revalidateActor, competitiveAccountEligibility } from './auth';
import { positionOutcome, timeoutOutcome, provedTimeoutOutcome } from './adjudication';
import { aiEnabled, type Env } from './env';
import { consumeGameProtocol, countProtocolEvent, gameProtocolStatus, initializeProtocolLimits } from './abuse';
import { getEngineLevel, STOCKFISH_BUILD } from '../shared/engine';
import { captureNativePoint } from './recovery';
import { ApiError, readJson } from './security';
import { hasProofAdmission } from './proof-budget';
import { parseProofResult, proofDigests, transientProof, PROOF_PROFILE, PROOF_RULES_VERSION, PROOF_INSTANCE, PROOF_RESULT_BYTES,
  type TimeoutProofRequest } from './proof-contract';
import {
  FORMATS, RULES_VERSION, RATING_VERSION,
  type Actor, type AiOpponent, type Color, type CommandReceipt, type CommandReply, type GameCommand,
  type GameOutcome, type GameResult, type GameSnapshot, type InitGame, type MoveEvent,
  type Seat, type ServerMessage,
} from '../shared/protocol';

const READY_WINDOW_MS = 120_000;
const INVITE_WINDOW_MS = 600_000;
const MAX_FRAME_BYTES = 2_048;
export const ADJUDICATION_WAIT_MS = 30_000;
export const GAME_HOT_RETENTION_MS = 3_600_000;

export interface GameArchiveReceipt {
  gameId: string;
  terminalVersion: number;
  terminalDigest: string;
  archivedAt: number;
}

interface ArchivedGame extends GameArchiveReceipt { rulesVersion: string }

interface State {
  id: string;
  format: InitGame['format'];
  rated: boolean;
  reservationId: string | null;
  rulesVersion: string;
  status: GameSnapshot['status'];
  version: number;
  white: Seat;
  black: Seat | null;
  initialFen: string;
  /** Absent on retained terminal games so their exports stay byte stable. */
  pgnHeaderVersion?: 1;
  moves: MoveEvent[];
  remaining: { w: number; b: number };
  turnStartedAt: number | null;
  deadline: number | null;
  readinessDeadline: number | null;
  drawOfferedBy: Color | null;
  outcome: GameOutcome | null;
  settlement: GameSnapshot['settlement'];
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  /** Retained only to retire unfinished provider-era work safely. */
  ai?: AiOpponent & { turn?: unknown };
  tournament?: InitGame['tournament'];
  timeoutProof?: InitGame['timeoutProof'];
}

interface Attachment {
  actor: Actor;
  connectionId: string;
}

interface Delivery {
  result: GameResult;
  attempts: number;
  nextAttemptAt: number;
}

interface ProofWork {
  pendingVersion: number;
  attempt: 1 | 2;
  deliveries: number;
  nextAttemptAt: number;
  done: boolean;
  request: TimeoutProofRequest | null;
}

function seat(actor: Actor): Seat {
  return { id: actor.id, name: actor.name.slice(0, 80), isAnonymous: actor.isAnonymous, ready: false };
}

/** chess.js 1.4 writes raw tags and cannot parse escaped quotes. Only normalize export labels. */
function pgnPlayerName(name: string): string {
  return name.replace(/["\\\u0000-\u001f\u007f-\u009f\u2028\u2029]/g,
    character => character === '"' ? "'" : character === '\\' ? '/' : ' ').trim() || '?';
}

function colorOf(state: State, id: string): Color | null {
  return state.white.id === id ? 'w' : state.black?.id === id ? 'b' : null;
}

function commandPayload(command: GameCommand): string {
  return JSON.stringify(command.type === 'move' || command.type === 'engine-move'
    ? [command.type, command.expectedVersion, command.from, command.to, command.promotion ?? null]
    : [command.type, command.expectedVersion]);
}

export function parseCommand(value: unknown): GameCommand | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== 'string' || !/^[\w-]{8,80}$/.test(item.id)
    || !Number.isSafeInteger(item.expectedVersion) || Number(item.expectedVersion) < 0) return null;
  if (item.type === 'move' || item.type === 'engine-move') {
    if (Object.keys(item).some(key => !['id', 'expectedVersion', 'type', 'from', 'to', 'promotion'].includes(key))
      || typeof item.from !== 'string' || !/^[a-h][1-8]$/.test(item.from)
      || typeof item.to !== 'string' || !/^[a-h][1-8]$/.test(item.to)
      || (item.promotion !== undefined && !['q', 'r', 'b', 'n'].includes(String(item.promotion)))) return null;
  } else if (!['ready', 'resign', 'offer-draw', 'accept-draw', 'decline-draw'].includes(String(item.type))
    || Object.keys(item).some(key => !['id', 'expectedVersion', 'type'].includes(key))) return null;
  return item as GameCommand;
}

export class Game extends DurableObject<Env> {
  private chess: Chess | null = null;
  private chessVersion = -1;
  private proving = false;
  protected recoveryDrill = false;

  constructor(ctx: DurableObjectState, env: Env, internalContext?: DurableObjectState) {
    super(ctx, env);
    // The private capacity composition passes the real native state to super.
    // Its internal adapter meters the same product storage and scheduling.
    if (internalContext) { this.ctx = internalContext as typeof this.ctx; ctx = this.ctx; }
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS game_state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS command_receipts
      (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, payload TEXT NOT NULL, version INTEGER NOT NULL, accepted_at INTEGER NOT NULL)`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS connections (user_id TEXT PRIMARY KEY, connection_id TEXT NOT NULL)`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS result_delivery (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS archived_game (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS timeout_proof_work (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)`);
    initializeProtocolLimits(ctx.storage.sql);
    const work = this.proofWork();
    if (work?.request && !work.done) {
      // A restarted delivery reconciles its saved pool receipt, within the
      // original deadline and the same two-delivery ceiling per attempt.
      work.done = work.deliveries >= 2;
      work.nextAttemptAt = Math.min(work.nextAttemptAt, Date.now());
      this.saveProofWork(work);
      ctx.blockConcurrencyWhile(() => this.committed());
    }
  }

  private load(): State | null {
    const row = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM game_state WHERE id=1').toArray()[0];
    return row ? JSON.parse(row.value) as State : null;
  }

  private archived(): ArchivedGame | null {
    const row = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM archived_game WHERE id=1').toArray()[0];
    return row ? JSON.parse(row.value) as ArchivedGame : null;
  }

  /** Private metadata only. No snapshot, command, clock, or alarm is changed. */
  async captureRecoveryPoint(gameId?: string) {
    const name = gameId ?? this.load()?.id ?? this.archived()?.gameId ?? this.ctx.id.name;
    if (!name || !this.env.GAME.idFromName(name).equals(this.ctx.id)) {
      throw new ApiError(409, 'RECOVERY_TARGET_MISMATCH', 'The game name does not identify this object.');
    }
    const savedRules = this.load()?.rulesVersion ?? this.archived()?.rulesVersion;
    const rules = savedRules === PROOF_RULES_VERSION ? PROOF_RULES_VERSION : RULES_VERSION;
    return captureNativePoint(this.ctx, { kind: 'Game', name, policies: { rules, ratings: RATING_VERSION } }, () => {
      const state = this.load();
      const archived = this.archived();
      const work = this.proofWork();
      return { status: state?.status ?? (archived ? 'archived' : 'uninitialized'), version: state?.version ?? archived?.terminalVersion ?? null,
        rules: state?.rulesVersion ?? archived?.rulesVersion ?? RULES_VERSION, deadline: state?.deadline ?? null,
        readinessDeadline: state?.readinessDeadline ?? null, moves: state?.moves.length ?? 0,
        receipts: this.ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM command_receipts').one().count,
        latestReceiptAt: this.ctx.storage.sql.exec<{ at: number | null }>('SELECT MAX(accepted_at) AS at FROM command_receipts').one().at,
        pendingDelivery: Boolean(this.ctx.storage.sql.exec('SELECT 1 FROM result_delivery WHERE id=1').toArray()[0]), archived: Boolean(archived),
        ...(state?.timeoutProof ? { timeoutProof: { profileVersion: state.timeoutProof.profileVersion,
          ...(work ? { pendingVersion: work.pendingVersion, attempt: work.attempt, done: work.done } : {}) } } : {}) };
    }, this.recoveryDrill);
  }

  private save(state: State): void {
    this.ctx.storage.sql.exec('INSERT INTO game_state(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value', JSON.stringify(state));
  }

  private proofWork(): ProofWork | null {
    const row = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM timeout_proof_work WHERE id=1').toArray()[0];
    return row ? JSON.parse(row.value) as ProofWork : null;
  }

  private saveProofWork(work: ProofWork): void {
    this.ctx.storage.sql.exec('INSERT INTO timeout_proof_work(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value', JSON.stringify(work));
  }

  private engine(state: State): Chess {
    if (!this.chess || this.chessVersion !== state.version) {
      const chess = new Chess(state.initialFen);
      for (const move of state.moves) chess.move({ from: move.from, to: move.to, promotion: move.promotion });
      this.chess = chess;
      this.chessVersion = state.version;
    }
    return this.chess;
  }

  private view(state: State, now: number): GameSnapshot {
    const chess = this.engine(state);
    return {
      id: state.id, format: state.format, rated: state.rated, rulesVersion: state.rulesVersion,
      status: state.status, version: state.version, white: state.white, black: state.black,
      fen: chess.fen(), turn: chess.turn(), moves: state.moves,
      clocks: {
        w: state.status === 'active' && chess.turn() === 'w' ? Math.max(0, (state.deadline ?? now) - now) : state.remaining.w,
        b: state.status === 'active' && chess.turn() === 'b' ? Math.max(0, (state.deadline ?? now) - now) : state.remaining.b,
        running: state.status === 'active' ? chess.turn() : null, deadline: state.deadline,
      },
      serverNow: now, readinessDeadline: state.readinessDeadline, drawOfferedBy: state.drawOfferedBy,
      outcome: state.outcome, settlement: state.settlement, startedAt: state.startedAt, endedAt: state.endedAt,
      ...(state.ai ? { ai: { modelId: state.ai.modelId, name: state.ai.name, actualModel: state.ai.actualModel,
        ...(state.ai.level ? { level: state.ai.level } : {}), thinking: state.status === 'active' && chess.turn() === 'b' } } : {}),
      ...(state.tournament ? { tournament: state.tournament } : {}),
    };
  }

  private result(state: State): GameResult {
    if (!state.outcome || state.endedAt === null || (state.status !== 'finished' && state.status !== 'pending-adjudication')) throw new Error('game_not_terminal');
    const chess = this.engine(state);
    chess.setHeader('White', state.pgnHeaderVersion === 1 ? pgnPlayerName(state.white.name) : state.white.name);
    chess.setHeader('Black', state.pgnHeaderVersion === 1 ? pgnPlayerName(state.black?.name ?? '?') : state.black?.name ?? '?');
    chess.setHeader('TimeControl', `${FORMATS[state.format].initialMs / 1000}+${FORMATS[state.format].incrementMs / 1000}`);
    chess.setHeader('Result', state.outcome.score === 1 ? '1-0' : state.outcome.score === 0 ? '0-1' : state.outcome.score === 0.5 ? '1/2-1/2' : '*');
    if (state.ai) {
      chess.setHeader('Mode', 'AI');
      chess.setHeader('AIModel', state.ai.modelId);
      if (state.ai.actualModel) chess.setHeader('AIActualModel', state.ai.actualModel);
      if (state.ai.level) chess.setHeader('AILevel', state.ai.level);
    }
    if (state.tournament) {
      chess.setHeader('Event', `ejm chess ${state.tournament.id}`);
      chess.setHeader('Round', String(state.tournament.round));
    }
    if (state.rulesVersion !== 'online-2026-10-v1') chess.setHeader('Termination', state.outcome.reason);
    const digestFields: unknown[] = [state.rulesVersion, state.id, state.version, state.white.id,
      state.black?.id ?? null, state.format, state.rated, state.outcome, state.endedAt, chess.fen(), state.moves.length,
      state.ai ? [state.ai.modelId, state.ai.name, state.ai.actualModel, ...(state.ai.level ? [state.ai.level] : [])] : null];
    // Preserve the old receipt wire shape while its durable outbox drains after an upgrade.
    if (state.rulesVersion !== 'online-2026-10-v1') digestFields.push(state.tournament ?? null);
    const terminalDigest = JSON.stringify(digestFields);
    return {
      eventId: `${state.id}:${state.version}`, id: state.id, format: state.format, rated: state.rated,
      reservationId: state.reservationId, white: state.white, black: state.black,
      status: state.status, version: state.version, rulesVersion: state.rulesVersion, terminalDigest,
      outcome: state.outcome, startedAt: state.startedAt, endedAt: state.endedAt,
      createdAt: state.createdAt, pgn: chess.pgn(), plies: state.moves.length,
      ...(state.ai ? { ai: { modelId: state.ai.modelId, name: state.ai.name, actualModel: state.ai.actualModel,
        ...(state.ai.level ? { level: state.ai.level } : {}) } } : {}),
      ...(state.tournament ? { tournament: state.tournament } : {}),
    };
  }

  private finish(state: State, outcome: GameOutcome, now: number): void {
    const turn = this.engine(state).turn();
    if (state.status === 'active' && state.deadline !== null) state.remaining[turn] = Math.max(0, state.deadline - now);
    state.pgnHeaderVersion = 1;
    state.status = outcome.reason === 'timeout-needs-review' ? 'pending-adjudication' : 'finished';
    state.outcome = outcome;
    state.endedAt = now;
    state.deadline = null;
    state.turnStartedAt = null;
    state.readinessDeadline = null;
    state.drawOfferedBy = null;
    if (state.ai?.turn) state.ai.turn = null;
    state.settlement = state.rated ? 'pending' : 'unrated';
    this.save(state);
    if (state.status === 'pending-adjudication' && state.rulesVersion === PROOF_RULES_VERSION && state.timeoutProof) {
      this.saveProofWork({ pendingVersion: state.version, attempt: 1, deliveries: 0, nextAttemptAt: now, done: false, request: null });
    } else this.ctx.storage.sql.exec('DELETE FROM timeout_proof_work WHERE id=1');
    const delivery: Delivery = { result: this.result(state), attempts: 0, nextAttemptAt: now };
    this.ctx.storage.sql.exec('INSERT INTO result_delivery(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value', JSON.stringify(delivery));
  }

  private expire(state: State, now: number): boolean {
    let changed = false;
    const roundDeadline = state.tournament?.deadlineAt ?? Number.POSITIVE_INFINITY;
    if (state.status === 'active' && state.deadline !== null && now >= state.deadline && state.deadline <= roundDeadline) {
      state.version++;
      this.finish(state, timeoutOutcome(this.engine(state), this.engine(state).turn()), state.deadline);
      changed = true;
    }
    if ((state.status === 'waiting' || state.status === 'ready') && state.readinessDeadline !== null && now >= state.readinessDeadline && state.readinessDeadline <= roundDeadline) {
      state.version++;
      this.finish(state, { winner: null, score: null, reason: 'readiness-expired' }, state.readinessDeadline);
      return true;
    }
    if (state.ai && ['waiting', 'ready', 'active'].includes(state.status)
      && (!aiEnabled(this.env) || state.ai.modelId !== STOCKFISH_BUILD || !getEngineLevel(state.ai.level))) {
      state.version++;
      this.finish(state, { winner: null, score: null, reason: 'ai-unavailable', aiError: 'AI_UNAVAILABLE' }, now);
      return true;
    }
    const adjudicationDeadline = state.status === 'pending-adjudication' && state.endedAt !== null ? state.endedAt + ADJUDICATION_WAIT_MS : null;
    if (adjudicationDeadline !== null && now >= adjudicationDeadline && adjudicationDeadline <= roundDeadline) {
      state.version++;
      const policy = state.rulesVersion === PROOF_RULES_VERSION ? PROOF_RULES_VERSION : RULES_VERSION;
      this.finish(state, { winner: null, score: null, reason: 'technical-void', decisionId: `automatic:${policy}:adjudication:${state.id}:${state.version}` }, adjudicationDeadline);
      return true;
    }
    if (state.tournament && state.status !== 'finished' && now >= roundDeadline) {
      state.version++;
      this.finish(state, { winner: null, score: null, reason: 'technical-void', decisionId: `tournament:${state.tournament.id}:round:${state.tournament.round}:deadline` }, roundDeadline);
      return true;
    }
    return changed;
  }

  private async schedule(): Promise<void> {
    const state = this.load();
    if (!state && this.archived()) { await this.ctx.storage.deleteAlarm(); return; }
    const delivery = this.delivery();
    const due = [state?.deadline, state?.readinessDeadline, delivery?.nextAttemptAt].filter((time): time is number => typeof time === 'number');
    if (state?.status === 'pending-adjudication' && state.endedAt !== null) due.push(state.endedAt + ADJUDICATION_WAIT_MS);
    const proof = this.proofWork();
    if (state?.status === 'pending-adjudication' && proof && !proof.done) due.push(proof.nextAttemptAt);
    if (state?.tournament && state.status !== 'finished') due.push(state.tournament.deadlineAt);
    const socketExpiry = this.ctx.getWebSockets().map(socket => {
      try { return (socket.deserializeAttachment() as Attachment).actor.sessionExpiresAt; } catch { return null; }
    }).filter((time): time is number => typeof time === 'number');
    due.push(...socketExpiry);
    if (!due.length) { await this.ctx.storage.deleteAlarm(); return; }
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, Math.min(...due)));
  }

  private async committed(): Promise<void> {
    await this.ctx.storage.sync();
    await this.schedule();
  }

  async init(input: InitGame): Promise<GameSnapshot> {
    const now = Date.now();
    if (this.archived()) throw new Error('game_archived');
    const level = getEngineLevel(input?.ai?.level);
    if (!input || !/^[\w-]{8,100}$/.test(input.id) || !Object.hasOwn(FORMATS, input.format)
      || !input.white?.id || input.white.id === input.black?.id
      || (input.ai !== undefined && (!input.ai || input.rated || input.black || input.ai.modelId !== STOCKFISH_BUILD || !level))
      || (input.rated && (!input.black || !input.reservationId || input.white.isAnonymous || input.black.isAnonymous))
      || (input.tournament && (input.rated || input.ai || !input.black || !input.reservationId || input.white.isAnonymous || input.black.isAnonymous
        || typeof input.tournament.id !== 'string' || input.tournament.id.length > 128 || !/^[a-zA-Z0-9_.:-]+$/.test(input.tournament.id)
        || (input.tournament.format !== undefined && !['round-robin-v1', 'arena-v1'].includes(input.tournament.format))
        || !Number.isSafeInteger(input.tournament.round) || input.tournament.round < 1 || input.tournament.round > 3
        || (input.tournament.format === 'arena-v1' && input.tournament.round !== 1)
        || !Number.isSafeInteger(input.tournament.deadlineAt) || input.tournament.deadlineAt < 1))) throw new Error('invalid_game');
    const existingBeforeAdmission = this.load();
    if (!existingBeforeAdmission && input.rated) {
      if (!input.timeoutProof || input.timeoutProof.reservationId !== input.id || input.timeoutProof.profileVersion !== PROOF_PROFILE
        || !await hasProofAdmission(this.env, input.id)
        || !await this.env.COMPETITION.get(this.env.COMPETITION.idFromName('global')).hasTimeoutProofReservation(input.id, input.reservationId!)) {
        throw new Error('ranked_proof_admission_required');
      }
    }
    if (input.timeoutProof && (!input.rated || input.ai || input.tournament)) throw new Error('invalid_proof_game');
    let admittedAt = now;
    let acceptedCasual = false;
    if (!existingBeforeAdmission && !input.rated && !input.tournament) {
      const admission = await this.env.DB.prepare('SELECT creator_id,storage_state,reservation_id,created_at FROM casual_game_admissions WHERE game_id=?')
        .bind(input.id).first<{ creator_id: string; storage_state: string; reservation_id: string | null; created_at: number }>();
      if (!admission || admission.storage_state !== 'retained' || admission.creator_id !== input.white.id
        || admission.reservation_id !== (input.reservationId ?? null)) throw new Error('casual_admission_required');
      admittedAt = Math.min(now, admission.created_at);
      acceptedCasual = true;
    }
    let ai: AiOpponent | undefined;
    if (input.ai) {
      if (!aiEnabled(this.env) && !existingBeforeAdmission && !acceptedCasual) throw new Error('engine_unavailable');
      ai = { modelId: STOCKFISH_BUILD, name: `Stockfish 19.0.1 · ${level!.name}`, actualModel: STOCKFISH_BUILD, level: level!.id };
    }
    const tournamentEligible = input.tournament && !this.load()
      ? (await Promise.all([competitiveAccountEligibility(this.env, input.white.id), competitiveAccountEligibility(this.env, input.black!.id)])).every(item => item.eligible)
      : true;
    const state = this.ctx.storage.transactionSync(() => {
      const existing = this.load();
      if (existing) {
        if (existing.id !== input.id || existing.format !== input.format || existing.rated !== input.rated
          || existing.white.id !== input.white.id || (input.black && existing.black?.id !== input.black.id)
          || existing.ai?.modelId !== input.ai?.modelId
          || existing.ai?.level !== input.ai?.level
          || JSON.stringify(existing.tournament ?? null) !== JSON.stringify(input.tournament ?? null)
          || JSON.stringify(existing.timeoutProof ?? null) !== JSON.stringify(input.timeoutProof ?? null)
          || existing.reservationId !== (input.reservationId ?? null)) throw new Error('initialization_conflict');
        this.expire(existing, now);
        return existing;
      }
      const chess = new Chess();
      const value: State = {
        id: input.id, format: input.format, rated: input.rated, reservationId: input.reservationId ?? null,
        rulesVersion: input.timeoutProof ? PROOF_RULES_VERSION : RULES_VERSION, status: input.black || ai ? 'ready' : 'waiting', version: 0,
        white: seat(input.white), black: ai ? { id: `ai:${input.id}`, name: `${ai.name} (AI)`.slice(0, 120), isAnonymous: false, ready: true } : input.black ? seat(input.black) : null, initialFen: chess.fen(), pgnHeaderVersion: 1, moves: [],
        remaining: { w: FORMATS[input.format].initialMs, b: FORMATS[input.format].initialMs },
        turnStartedAt: null, deadline: null, readinessDeadline: Math.min(admittedAt + (input.black || ai ? READY_WINDOW_MS : INVITE_WINDOW_MS), input.tournament?.deadlineAt ?? Number.POSITIVE_INFINITY),
        drawOfferedBy: null, outcome: null, settlement: input.rated ? 'pending' : 'unrated',
        createdAt: admittedAt, startedAt: null, endedAt: null,
        ...(ai ? { ai } : {}),
        ...(input.tournament ? { tournament: { ...input.tournament } } : {}),
        ...(input.timeoutProof ? { timeoutProof: { ...input.timeoutProof } } : {}),
      };
      this.save(value);
      if (!tournamentEligible) {
        value.version++;
        this.finish(value, { winner: null, score: null, reason: 'eligibility-revoked' }, now);
      } else this.expire(value, now);
      return value;
    });
    await this.committed();
    return this.view(state, now);
  }

  async join(actor: Actor): Promise<GameSnapshot> {
    const now = Date.now();
    if (!await revalidateActor(actor, this.env)) throw new Error('session_invalid');
    const accountReady = await passwordAccountReady(this.env, actor.id);
    const admission = this.ctx.storage.transactionSync(() => {
      const state = this.load();
      if (!state) throw new Error('game_not_found');
      this.expire(state, now);
      if (colorOf(state, actor.id)) return { state, available: true };
      if (!accountReady) throw new Error('seat_unavailable');
      if (state.rated || state.status !== 'waiting' || state.black) return { state, available: false };
      state.black = seat(actor);
      state.status = 'ready';
      state.readinessDeadline = now + READY_WINDOW_MS;
      state.version++;
      this.save(state);
      return { state, available: true };
    });
    await this.committed();
    this.broadcast(admission.state, now);
    if (!admission.available) throw new Error('seat_unavailable');
    return this.view(admission.state, now);
  }

  async claimSeat(actor: Actor): Promise<{ ok: true; snapshot: GameSnapshot } | { ok: false; code: 'seat_unavailable' | 'game_not_found' | 'session_invalid' }> {
    try { return { ok: true, snapshot: await this.join(actor) }; }
    catch (error) {
      if (error instanceof Error && ['seat_unavailable', 'game_not_found', 'session_invalid'].includes(error.message)) {
        return { ok: false, code: error.message as 'seat_unavailable' | 'game_not_found' | 'session_invalid' };
      }
      throw error;
    }
  }

  async snapshot(actor: Actor): Promise<GameSnapshot> {
    const snapshot = await this.lookup(actor);
    if (!snapshot) throw new Error('not_a_player');
    return snapshot;
  }

  async lookup(actor: Actor): Promise<GameSnapshot | null> {
    const now = Date.now();
    const state = this.ctx.storage.transactionSync(() => {
      const state = this.load();
      if (!state || !colorOf(state, actor.id)) return null;
      this.expire(state, now);
      return state;
    });
    if (!state) return null;
    await this.committed();
    return this.view(state, now);
  }

  async status(): Promise<{ id: string; status: GameSnapshot['status']; version: number; startedAt: number | null; result: GameResult | null } | null> {
    const now = Date.now();
    const state = this.ctx.storage.transactionSync(() => {
      const state = this.load();
      if (state) this.expire(state, now);
      return state;
    });
    if (!state) return null;
    await this.committed();
    return { id: state.id, status: state.status, version: state.version, startedAt: state.startedAt, result: state.outcome ? this.result(state) : null };
  }

  async command(actor: Actor, input: GameCommand): Promise<CommandReply> {
    return this.applyCommand(actor, input, Date.now());
  }

  private async applyCommand(actor: Actor, input: GameCommand, now: number, protocolChecked = false): Promise<CommandReply> {
    if (!await revalidateActor(actor, this.env)) throw new Error('session_invalid');
    const before = this.load();
    if (!before) throw new Error('game_not_found');
    if (!colorOf(before, actor.id)) throw new Error('not_a_player');
    if (!protocolChecked && !this.ctx.storage.transactionSync(() => consumeGameProtocol(this.ctx.storage.sql, actor.id, 'command', now)).allowed) {
      await this.ctx.storage.sync();
      return { ok: false, code: 'command_rate_limited', snapshot: this.view(before, now) };
    }
    const command = parseCommand(input);
    let canStart = true;
    if (command?.type === 'ready' && before && (before.rated || before.tournament) && before.status === 'ready' && before.black) {
      const eligibilityCheck = before.tournament ? competitiveAccountEligibility : rankedEligibility;
      const eligibility = await Promise.all([
        eligibilityCheck(this.env, before.white.id), eligibilityCheck(this.env, before.black.id),
      ]);
      canStart = eligibility.every(item => item.eligible);
    }
    const reply = this.ctx.storage.transactionSync((): CommandReply => {
      const state = this.load();
      if (!state) throw new Error('game_not_found');
      const color = colorOf(state, actor.id);
      if (!color) throw new Error('not_a_player');
      const error = (code: string): CommandReply => ({ ok: false, code, snapshot: this.view(state, now) });
      if (!command) return error('invalid_command');
      const receipt = this.ctx.storage.sql.exec<{ user_id: string; payload: string; version: number; accepted_at: number }>(
        'SELECT user_id,payload,version,accepted_at FROM command_receipts WHERE id=?', command.id).toArray()[0];
      if (receipt) {
        if (receipt.user_id !== actor.id || receipt.payload !== commandPayload(command)) return error('command_id_conflict');
        this.expire(state, now);
        return { ok: true, receipt: { id: command.id, version: receipt.version, acceptedAt: receipt.accepted_at }, snapshot: this.view(state, now) };
      }
      if (this.expire(state, now) || state.status === 'finished' || state.status === 'pending-adjudication') return error('game_over');
      if (command.expectedVersion !== state.version) return error('stale_version');
      const chess = this.engine(state);
      if (command.type === 'ready') {
        if (state.status !== 'ready' || !state.black) return error('waiting_for_opponent');
        if (!canStart) {
          state.version++;
          this.finish(state, { winner: null, score: null, reason: 'eligibility-revoked' }, now);
          return error('ranked_eligibility_changed');
        }
        const player = color === 'w' ? state.white : state.black;
        if (player.ready) return error('already_ready');
        player.ready = true;
        if (state.white.ready && state.black.ready) {
          state.status = 'active';
          state.startedAt = now;
          state.turnStartedAt = now;
          state.deadline = now + state.remaining.w;
          state.readinessDeadline = null;
        }
      } else {
        if (state.status !== 'active') return error('game_not_started');
        if (state.ai && ['offer-draw', 'accept-draw', 'decline-draw'].includes(command.type)) return error('draw_unavailable_in_ai');
        if (command.type === 'move' || command.type === 'engine-move') {
          const movingColor = command.type === 'engine-move' ? 'b' : color;
          if (command.type === 'engine-move' && (color !== 'w' || state.rated || state.tournament
            || state.ai?.modelId !== STOCKFISH_BUILD || !getEngineLevel(state.ai.level))) return error('engine_move_unavailable');
          if (chess.turn() !== movingColor) return error('not_your_turn');
          let move;
          try { move = chess.move({ from: command.from, to: command.to, promotion: command.promotion }); }
          catch { return error('illegal_move'); }
          state.remaining[movingColor] = Math.max(0, (state.deadline ?? now) - now) + FORMATS[state.format].incrementMs;
          state.moves.push({ version: state.version + 1, ply: state.moves.length + 1, by: movingColor,
            from: move.from, to: move.to, ...(move.promotion ? { promotion: move.promotion } : {}),
            san: move.san, fen: chess.fen(), acceptedAt: now });
          state.turnStartedAt = now;
          state.deadline = now + state.remaining[chess.turn()];
          state.drawOfferedBy = null;
        } else if (command.type === 'offer-draw') {
          if (state.drawOfferedBy !== null) return error('draw_offer_pending');
          state.drawOfferedBy = color;
        } else if (command.type === 'accept-draw' || command.type === 'decline-draw') {
          if (state.drawOfferedBy === null || state.drawOfferedBy === color) return error('no_opponent_draw_offer');
          state.drawOfferedBy = null;
        }
      }
      state.version++;
      this.chessVersion = state.version;
      let outcome: GameOutcome | null = null;
      if (command.type === 'move' || command.type === 'engine-move') outcome = positionOutcome(chess);
      if (command.type === 'resign') outcome = { winner: color === 'w' ? 'b' : 'w', score: color === 'w' ? 0 : 1, reason: 'resignation' };
      if (command.type === 'accept-draw') outcome = { winner: null, score: 0.5, reason: 'draw-agreement' };
      if (outcome) this.finish(state, outcome, now); else this.save(state);
      this.ctx.storage.sql.exec('INSERT INTO command_receipts(id,user_id,payload,version,accepted_at) VALUES(?,?,?,?,?)',
        command.id, actor.id, commandPayload(command), state.version, now);
      const accepted: CommandReceipt = { id: command.id, version: state.version, acceptedAt: now };
      return { ok: true, receipt: accepted, snapshot: this.view(state, now) };
    });
    await this.committed();
    const state = this.load();
    if (state) this.broadcast(state, now);
    return reply;
  }

  /** Called only by the owner-authorized Worker route. A technical void never guesses a winner. */
  async technicalVoid(decisionId: string): Promise<GameSnapshot> {
    const now = Date.now();
    if (!/^[\w-]{8,100}$/.test(decisionId)) throw new Error('invalid_decision');
    const state = this.ctx.storage.transactionSync(() => {
      const state = this.load();
      if (!state) throw new Error('game_not_found');
      if (state.outcome?.decisionId === decisionId) return state;
      if (state.status !== 'pending-adjudication') throw new Error('not_pending_adjudication');
      state.version++;
      this.finish(state, { winner: null, score: null, reason: 'technical-void', decisionId }, now);
      return state;
    });
    await this.committed();
    this.broadcast(state, now);
    return this.view(state, now);
  }

  /** The stored round cutoff is authoritative. A caller cannot extend or shorten it. */
  async enforceTournamentDeadline(tournamentId: string, round: number): Promise<GameSnapshot | null> {
    const now = Date.now();
    const state = this.ctx.storage.transactionSync(() => {
      const state = this.load();
      if (!state) return null;
      if (state.tournament?.id !== tournamentId || state.tournament.round !== round) throw new Error('tournament_context_mismatch');
      this.expire(state, now);
      return state;
    });
    if (!state) return null;
    await this.committed();
    this.broadcast(state, now);
    return this.view(state, now);
  }

  /** Retire only a proved terminal payload. The permanent receipt prevents ID reuse. */
  async archive(input: { gameId: string; expectedVersion: number; terminalDigest: string }): Promise<GameArchiveReceipt> {
    const prior = this.archived();
    if (prior) {
      if (prior.gameId !== input.gameId || prior.terminalVersion !== input.expectedVersion || prior.terminalDigest !== input.terminalDigest) throw new Error('archive_conflict');
      return { gameId: prior.gameId, terminalVersion: prior.terminalVersion, terminalDigest: prior.terminalDigest, archivedAt: prior.archivedAt };
    }
    const now = Date.now();
    const state = this.load();
    if (!state || state.id !== input.gameId || state.status !== 'finished' || state.rated || state.settlement === 'pending'
      || state.version !== input.expectedVersion || state.endedAt === null || state.endedAt > now - GAME_HOT_RETENTION_MS
      || state.ai?.turn || this.delivery()) throw new Error('archive_not_ready');
    const result = this.result(state);
    if (result.terminalDigest !== input.terminalDigest) throw new Error('archive_conflict');
    const table = state.tournament ? 'tournament_game_admissions' : 'casual_game_admissions';
    const claim = `retiring:${crypto.randomUUID()}`;
    // This D1 lease also blocks new evidence attachment until the local transaction commits.
    const proof = await this.env.DB.prepare(`UPDATE ${table} SET archive_error=?,archive_retry_at=?
      WHERE game_id=? AND storage_state='retained'
        AND NOT (COALESCE(archive_error,'') LIKE 'retiring:%' AND archive_retry_at>?)
        AND EXISTS(SELECT 1 FROM games g WHERE g.id=${table}.game_id AND g.status='finished' AND g.rated=0
          AND g.settlement<>'pending' AND g.result_version=? AND g.rules_version=? AND g.terminal_digest=? AND g.ended_at<=?)
        AND NOT EXISTS(SELECT 1 FROM active_game_seats s WHERE s.game_id=${table}.game_id AND s.released_at IS NULL)
        AND NOT EXISTS(SELECT 1 FROM fairplay_evidence e WHERE e.game_id=${table}.game_id AND (e.expires_at>? OR e.hold_until>?))
        AND NOT EXISTS(SELECT 1 FROM fairplay_appeals a JOIN fairplay_cases c ON c.id=a.case_id
          WHERE a.status='pending' AND a.automatic_closed_at IS NULL AND (c.game_id=${table}.game_id
            OR EXISTS(SELECT 1 FROM fairplay_evidence e WHERE e.case_id=a.case_id AND e.game_id=${table}.game_id)))
      RETURNING game_id`).bind(claim, now + 300_000, state.id, now, state.version, state.rulesVersion,
      result.terminalDigest, now - GAME_HOT_RETENTION_MS, now, now).first();
    if (!proof) throw new Error('archive_not_proved');
    const archived = this.ctx.storage.transactionSync(() => {
      const current = this.load();
      if (!current || current.version !== state.version || current.status !== 'finished' || current.rated
        || current.settlement === 'pending' || current.ai?.turn || this.delivery()
        || this.result(current).terminalDigest !== result.terminalDigest) throw new Error('archive_state_changed');
      const receipt: ArchivedGame = { gameId: state.id, terminalVersion: state.version,
        terminalDigest: result.terminalDigest, rulesVersion: state.rulesVersion, archivedAt: now };
      this.ctx.storage.sql.exec('INSERT INTO archived_game(id,value) VALUES(1,?)', JSON.stringify(receipt));
      this.ctx.storage.sql.exec('DELETE FROM game_state');
      this.ctx.storage.sql.exec('DELETE FROM command_receipts');
      this.ctx.storage.sql.exec('DELETE FROM connections');
      this.ctx.storage.sql.exec('DELETE FROM result_delivery');
      this.ctx.storage.sql.exec('DELETE FROM protocol_limits');
      this.ctx.storage.sql.exec('DELETE FROM protocol_counters');
      return receipt;
    });
    this.chess = null;
    this.chessVersion = -1;
    for (const socket of this.ctx.getWebSockets()) socket.close(4004, 'Game archived. Open its replay.');
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.sync();
    return { gameId: archived.gameId, terminalVersion: archived.terminalVersion,
      terminalDigest: archived.terminalDigest, archivedAt: archived.archivedAt };
  }

  async fetch(request: Request): Promise<Response> {
    const now = Date.now();
    if (new URL(request.url).pathname !== '/connect' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Not found', { status: 404 });
    let actor: Actor;
    try { actor = JSON.parse(request.headers.get('x-chess-actor') ?? 'null') as Actor; }
    catch { return new Response('Unauthorized', { status: 401 }); }
    if (!actor?.id || !await revalidateActor(actor, this.env)) return new Response('Unauthorized', { status: 401 });
    const admission = this.ctx.storage.transactionSync(() => {
      const state = this.load();
      if (!state || !colorOf(state, actor.id)) return null;
      const limit = consumeGameProtocol(this.ctx.storage.sql, actor.id, 'connect', now);
      if (!limit.allowed) return { state: null, retryAfterSeconds: limit.retryAfterSeconds };
      this.expire(state, now);
      return { state, retryAfterSeconds: null };
    });
    if (!admission) return new Response('Not found', { status: 404 });
    if (!admission.state) {
      await this.ctx.storage.sync();
      return new Response('Too many connections. Try again shortly.', { status: 429, headers: { 'Retry-After': String(admission.retryAfterSeconds) } });
    }
    const state = admission.state;
    const connectionId = crypto.randomUUID();
    this.ctx.storage.sql.exec('INSERT INTO connections(user_id,connection_id) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET connection_id=excluded.connection_id', actor.id, connectionId);
    await this.ctx.storage.sync();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as Attachment | null;
      if (attachment?.actor.id === actor.id) socket.close(4001, 'Replaced by another connection');
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ actor, connectionId } satisfies Attachment);
    this.send(server, { type: 'snapshot', snapshot: this.view(state, now) });
    await this.schedule();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const now = Date.now();
    const attachment = socket.deserializeAttachment() as Attachment | null;
    if (!attachment) { socket.close(1009, 'Invalid frame'); return; }
    const current = this.ctx.storage.sql.exec<{ connection_id: string }>('SELECT connection_id FROM connections WHERE user_id=?', attachment.actor.id).toArray()[0];
    if (current?.connection_id !== attachment.connectionId) { socket.close(4001, 'Connection replaced'); return; }
    if (attachment.actor.sessionExpiresAt <= now) { socket.close(4003, 'Session expired'); return; }
    const allowed = this.ctx.storage.transactionSync(() => {
      const state = this.load();
      return Boolean(state && colorOf(state, attachment.actor.id)
        && consumeGameProtocol(this.ctx.storage.sql, attachment.actor.id, 'command', now).allowed);
    });
    if (!allowed) { socket.close(1008, 'Too many commands'); return; }
    if (typeof message !== 'string' || message.length > MAX_FRAME_BYTES || new TextEncoder().encode(message).byteLength > MAX_FRAME_BYTES) {
      countProtocolEvent(this.ctx.storage.sql, 'invalidFrames');
      socket.close(1009, 'Invalid frame');
      return;
    }
    let command: GameCommand | null;
    try { command = parseCommand(JSON.parse(message)); } catch { command = null; }
    if (!command) { this.send(socket, { type: 'error', code: 'invalid_command' }); return; }
    try { this.send(socket, { type: 'command', id: command.id, reply: await this.applyCommand(attachment.actor, command, now, true) }); }
    catch (error) {
      const code = error instanceof Error && error.message === 'session_invalid' ? 'session_invalid' : 'retry_later';
      this.send(socket, { type: 'error', code });
      if (code === 'session_invalid') socket.close(4003, 'Session expired');
    }
  }

  async webSocketClose(socket: WebSocket, _code: number, _reason: string): Promise<void> {
    socket.close(1000, 'Connection closed');
    await this.schedule();
  }

  webSocketError(socket: WebSocket): void { socket.close(1011, 'Connection error'); }

  /** Private binding data. The public route requires owner access. */
  async securityStatus() { return gameProtocolStatus(this.ctx.storage.sql); }

  private send(socket: WebSocket, message: ServerMessage): void {
    try { socket.send(JSON.stringify(message)); } catch { socket.close(1011, 'Connection unavailable'); }
  }

  private broadcast(state: State, now: number): void {
    const snapshot = this.view(state, now);
    for (const socket of this.ctx.getWebSockets()) this.send(socket, { type: 'snapshot', snapshot });
  }

  private delivery(): Delivery | null {
    const row = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM result_delivery WHERE id=1').toArray()[0];
    return row ? JSON.parse(row.value) as Delivery : null;
  }

  async flush(): Promise<void> {
    const now = Date.now();
    const delivery = this.delivery();
    if (!delivery || delivery.nextAttemptAt > now) { await this.schedule(); return; }
    await this.deliverResult(delivery, now);
  }

  /** Binding only. Reconcile one saved terminal receipt after transport recovery. */
  async retryResultDelivery(expected: { eventId: string; terminalDigest: string }): Promise<boolean> {
    if (!expected || typeof expected.eventId !== 'string' || typeof expected.terminalDigest !== 'string') return false;
    const state = this.load();
    if (!state || state.status !== 'finished') return false;
    const result = this.result(state);
    if (result.eventId !== expected.eventId || result.terminalDigest !== expected.terminalDigest) return false;
    const delivery = this.delivery();
    if (!delivery) return true;
    if (delivery.result.status !== 'finished' || delivery.result.eventId !== result.eventId
      || delivery.result.terminalDigest !== result.terminalDigest) return false;
    await this.deliverResult(delivery, Date.now());
    return this.delivery() === null;
  }

  private async deliverResult(delivery: Delivery, now: number): Promise<void> {
    try {
      const competition = this.env.COMPETITION.get(this.env.COMPETITION.idFromName('global'));
      const acknowledgement = await competition.settle(delivery.result);
      if (!acknowledgement.accepted) throw new Error('result_not_accepted');
      if (acknowledgement.pending && delivery.result.status === 'finished') throw new Error('settlement_pending');
      if (delivery.result.status === 'finished') {
        await this.env.DB.prepare('UPDATE active_game_seats SET released_at=? WHERE game_id=? AND released_at IS NULL').bind(now, delivery.result.id).run();
      }
      this.ctx.storage.transactionSync(() => {
        const current = this.delivery();
        if (current?.result.eventId !== delivery.result.eventId) return;
        this.ctx.storage.sql.exec('DELETE FROM result_delivery WHERE id=1');
        const state = this.load();
        if (state && state.version === delivery.result.version && state.rated && state.status === 'finished') {
          state.settlement = 'settled';
          this.save(state);
        }
      });
    } catch {
      this.ctx.storage.transactionSync(() => {
        const current = this.delivery();
        if (current?.result.eventId !== delivery.result.eventId) return;
        current.attempts++;
        current.nextAttemptAt = now + Math.min(300_000, 1_000 * 2 ** Math.min(current.attempts, 8));
        this.ctx.storage.sql.exec('UPDATE result_delivery SET value=? WHERE id=1', JSON.stringify(current));
      });
    }
    await this.committed();
    const state = this.load();
    if (state) this.broadcast(state, Date.now());
  }

  /** Binding only. The public Worker exposes no proof submission endpoint. */
  async acceptTimeoutProof(value: unknown): Promise<boolean> {
    const now = Date.now();
    const accepted = this.ctx.storage.transactionSync(() => {
      const state = this.load();
      const work = this.proofWork();
      if (!state || state.status !== 'pending-adjudication' || state.rulesVersion !== PROOF_RULES_VERSION
        || !state.timeoutProof || !work?.request || state.version !== work.pendingVersion) return false;
      if (this.expire(state, now)) return false;
      const proof = parseProofResult(value, work.request);
      if (!proof || proof.expiresAt <= now) return false;
      const outcome = provedTimeoutOutcome(proof);
      if (!outcome) return false;
      state.version++;
      this.finish(state, outcome, state.endedAt!);
      return true;
    });
    await this.committed();
    const state = this.load();
    if (state) this.broadcast(state, now);
    return accepted;
  }

  /** Alarm work only, outside the synchronous move and clock transaction. */
  async resolveTimeoutProof(): Promise<void> {
    if (this.proving) return;
    const state = this.load();
    const work = this.proofWork();
    if (!state || state.status !== 'pending-adjudication' || state.rulesVersion !== PROOF_RULES_VERSION || !state.timeoutProof
      || !work || work.done || state.version !== work.pendingVersion || work.nextAttemptAt > Date.now()) return;
    this.proving = true;
    try {
      if (!work.request) {
        const source = { rulesVersion: PROOF_RULES_VERSION as typeof PROOF_RULES_VERSION, initialFen: state.initialFen,
          moves: state.moves.map(move => move.from + move.to + (move.promotion ?? '')), fen: this.engine(state).fen(),
          gameId: state.id, pendingVersion: state.version, survivor: this.engine(state).turn() === 'w' ? 'b' as const : 'w' as const };
        const request: TimeoutProofRequest = { ...source, ...await proofDigests(source), v: 1,
          profileVersion: PROOF_PROFILE, reservationId: state.id, requestId: `timeout:${state.id}:${state.version}`,
          expiresAt: state.endedAt! + ADJUDICATION_WAIT_MS, attempt: work.attempt };
        if (this.load()?.version !== work.pendingVersion) return;
        work.request = request;
      }
      const request = work.request;
      if (request.expiresAt <= Date.now()) return;
      work.deliveries++;
      work.nextAttemptAt = request.expiresAt;
      this.saveProofWork(work);
      await this.ctx.storage.sync();
      let retryDelivery = false;
      let transient = false;
      const cancellation = new AbortController();
      const timer = setTimeout(() => cancellation.abort(), Math.max(1, request.expiresAt - Date.now()));
      try {
        if (!this.env.PROVER) throw new Error('proof_binding_unavailable');
        const response = await this.env.PROVER.get(this.env.PROVER.idFromName(PROOF_INSTANCE)).fetch(new Request('http://proof.internal/prove', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
          signal: cancellation.signal,
        }));
        if (!response.ok) {
          retryDelivery = response.status >= 500 || response.status === 429;
        } else {
          const result = parseProofResult(await readJson<unknown>(response, PROOF_RESULT_BYTES), request);
          if (result && await this.acceptTimeoutProof(result)) return;
          transient = Boolean(result && transientProof(result));
        }
      } catch { retryDelivery = true; }
      finally { clearTimeout(timer); }
      this.ctx.storage.transactionSync(() => {
        const current = this.load();
        if (current?.status !== 'pending-adjudication' || current.version !== work.pendingVersion) return;
        if (transient && work.attempt === 1) {
          work.attempt = 2;
          work.deliveries = 0;
          work.request = { ...request, attempt: 2 };
        } else if (!(retryDelivery && work.deliveries < 2)) work.done = true;
        work.nextAttemptAt = Math.min(request.expiresAt, Date.now() + 250);
        this.saveProofWork(work);
      });
    } finally { this.proving = false; await this.committed(); }
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const state = this.ctx.storage.transactionSync(() => {
      const state = this.load();
      if (state) this.expire(state, now);
      return state;
    });
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as Attachment | null;
      if (!attachment || attachment.actor.sessionExpiresAt <= now) socket.close(4003, 'Session expired');
    }
    await this.ctx.storage.sync();
    if (state) this.broadcast(state, now);
    await this.resolveTimeoutProof();
    await this.flush();
  }
}
