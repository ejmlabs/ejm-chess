import type { EngineLevel } from './engine';

export type Pool = 'blitz' | 'rapid';
export type Color = 'w' | 'b';

/** Derived standard-start bound: (96 pawn moves + 30 captures) * 100 + 100. See docs/result-bounds.md. */
export const MAX_GAME_PLIES = 12_700;

export const FORMATS: Record<Pool, { label: string; initialMs: number; incrementMs: number }> = {
  blitz: { label: '5 + 3', initialMs: 300_000, incrementMs: 3_000 },
  rapid: { label: '10 + 5', initialMs: 600_000, incrementMs: 5_000 },
};

/** Identity admitted by the authenticated Worker, never by a browser payload. */
export interface Actor {
  id: string;
  name: string;
  isAnonymous: boolean;
  sessionId: string;
  sessionExpiresAt: number;
}

export interface Seat {
  id: string;
  name: string;
  isAnonymous: boolean;
  ready: boolean;
}

export interface InitGame {
  id: string;
  format: Pool;
  rated: boolean;
  white: Actor;
  black?: Actor;
  reservationId?: string;
  ai?: { modelId: string; level: EngineLevel };
  tournament?: TournamentGame;
}

export interface TournamentGame {
  id: string;
  format?: 'round-robin-v1' | 'arena-v1';
  round: number;
  deadlineAt: number;
}

export interface AiOpponent {
  modelId: string;
  name: string;
  actualModel: string | null;
  /** Absent only on retained provider-era records. */
  level?: EngineLevel;
}

export type AiFailure = 'AI_UNAVAILABLE' | 'AI_MODEL_UNAVAILABLE' | 'AI_QUOTA' | 'AI_INVALID_MOVE' | 'AI_PROVIDER_FAILED';

export type GameStatus = 'waiting' | 'ready' | 'active' | 'finished' | 'pending-adjudication';
export type ResultReason = 'checkmate' | 'stalemate' | 'threefold-repetition' | 'fifty-move-rule'
  | 'insufficient-material' | 'resignation' | 'draw-agreement' | 'readiness-expired'
  | 'eligibility-revoked' | 'timeout-insufficient-material' | 'timeout-win' | 'timeout-needs-review'
  | 'technical-void' | 'ai-unavailable';

export interface GameOutcome {
  winner: Color | null;
  score: 0 | 0.5 | 1 | null;
  reason: ResultReason;
  decisionId?: string;
  aiError?: AiFailure;
}

export interface MoveEvent {
  version: number;
  ply: number;
  by: Color;
  from: string;
  to: string;
  promotion?: string;
  san: string;
  fen: string;
  acceptedAt: number;
}

export interface GameSnapshot {
  id: string;
  format: Pool;
  rated: boolean;
  rulesVersion: string;
  status: GameStatus;
  version: number;
  white: Seat;
  black: Seat | null;
  fen: string;
  turn: Color;
  moves: MoveEvent[];
  clocks: { w: number; b: number; running: Color | null; deadline: number | null };
  serverNow: number;
  readinessDeadline: number | null;
  drawOfferedBy: Color | null;
  outcome: GameOutcome | null;
  settlement: 'unrated' | 'pending' | 'settled';
  startedAt: number | null;
  endedAt: number | null;
  ai?: AiOpponent & { thinking: boolean };
  tournament?: TournamentGame;
}

export type GameCommand = {
  id: string;
  expectedVersion: number;
} & (
  | { type: 'move' | 'engine-move'; from: string; to: string; promotion?: 'q' | 'r' | 'b' | 'n' }
  | { type: 'ready' | 'resign' | 'offer-draw' | 'accept-draw' | 'decline-draw' }
);

export interface CommandReceipt {
  id: string;
  version: number;
  acceptedAt: number;
}

export type CommandReply =
  | { ok: true; receipt: CommandReceipt; snapshot: GameSnapshot }
  | { ok: false; code: string; snapshot: GameSnapshot };

export type ServerMessage =
  | { type: 'snapshot'; snapshot: GameSnapshot }
  | { type: 'command'; id: string; reply: CommandReply }
  | { type: 'error'; code: string };

export interface GameResult {
  eventId: string;
  id: string;
  format: Pool;
  rated: boolean;
  reservationId: string | null;
  white: Seat;
  black: Seat | null;
  status: 'finished' | 'pending-adjudication';
  version: number;
  rulesVersion: string;
  /** Canonical terminal record, compared with the game authority over the private binding. */
  terminalDigest: string;
  outcome: GameOutcome;
  startedAt: number | null;
  endedAt: number;
  createdAt: number;
  pgn: string;
  plies: number;
  ai?: AiOpponent;
  tournament?: TournamentGame;
}

export type QueueState =
  | { status: 'closed'; reason: string }
  | { status: 'idle' }
  | { status: 'queued'; pool: Pool; joinedAt: number }
  | { status: 'tournament'; pool: Pool; tournamentId: string }
  | { status: 'reserved' | 'live' | 'settling'; pool: Pool; gameId: string };

export interface RatingState {
  rating: number;
  rd: number;
  vol: number;
  games: number;
  lastPlayedAt: number | null;
  inactivityWeek: number;
  version: number;
}

export interface PublicRating {
  pool: Pool;
  rating: number | null;
  games: number;
  distinctOpponents: number;
  deviation: number | null;
  lastPlayedAt: number | null;
  updatedAt: number | null;
  status: 'established' | 'provisional' | 'inactive' | 'unranked' | 'pending';
  pending: boolean;
  eligible: boolean;
}

export interface PublicProfile {
  id: string;
  name: string;
  rankedOpen: boolean;
  pools: PublicRating[];
}

export const RULES_VERSION = 'online-2026-10-v4-unattended';
/** Earlier casual, tournament and arena policies. Stored games keep their saved version. */
export const PRIOR_RULES_VERSIONS = ['online-2026-10-v1', 'online-2026-10-v2-unattended'] as const;
export const RATING_VERSION = 'glicko2-online-2026-10-v1';
