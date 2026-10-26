import type { Pool } from './protocol';

export type TournamentCadence = 'hourly' | 'daily' | 'weekly';
export type TournamentStatus = 'scheduled' | 'registering' | 'starting' | 'running' | 'intermission' | 'finished' | 'cancelled';
export type TournamentPlayerStatus = 'registered' | 'admitted' | 'skipped-busy' | 'skipped-ineligible';

export interface TournamentView {
  id: string;
  cadence: TournamentCadence;
  pool: Pool;
  startsAt: number;
  registrationOpensAt: number;
  status: TournamentStatus;
  reason: string | null;
  rated: false;
  round: number;
  rounds: number;
  roundDeadlineAt: number | null;
  nextRoundAt: number | null;
  finishedAt: number | null;
  maxPlayers: number;
  players: { id: string; name: string; status: 'registered' | 'admitted' | 'not-admitted' }[];
  standings: { id: string; name: string; rank: number; points: number }[];
  games: {
    id: string; round: number; whiteId: string; blackId: string;
    status: 'creating' | 'ready' | 'active' | 'pending-adjudication' | 'finished';
    whitePoints: number | null; blackPoints: number | null; reason: string | null;
  }[];
  myStatus: TournamentPlayerStatus | null;
  myGameId: string | null;
}

export interface TournamentList {
  enabled: boolean;
  serverNow: number;
  events: TournamentView[];
  limits: { minPlayers: number; maxPlayers: number; maxActive: number; registrationMinutes: number };
}

/** Expected failures cross the Durable Object RPC boundary as data. */
export type TournamentActionResult =
  | { ok: true; value: TournamentView }
  | { ok: false; error: { status: number; code: string; message: string } };
