import type { Pool } from './protocol';
import type { TournamentCadence } from './tournaments';

export type ArenaStatus = 'scheduled' | 'running' | 'draining' | 'finished' | 'cancelled';
export type ArenaEntryState = 'registered' | 'reserving' | 'queued' | 'playing' | 'paused' | 'releasing' | 'withdrawn';

/** Public, complete snapshot. It contains no caller's registration or seat. */
export interface ArenaSummary {
  id: string;
  format: 'arena-v1';
  cadence: TournamentCadence;
  pool: Pool;
  rated: false;
  startsAt: number;
  registrationOpensAt: number;
  closesAt: number;
  finishedAt: number | null;
  status: ArenaStatus;
  reason: string | null;
  entrants: number;
  unresolvedGames: number;
  maxEntrants: number;
  provisional: boolean;
  generation: number;
  watermark: number;
  generatedAt: number;
}

export interface ArenaList {
  enabled: boolean;
  serverNow: number;
  events: ArenaSummary[];
  limits: { maxEntrants: number };
}

export interface ArenaStanding {
  id: string;
  name: string;
  points: number;
  games: number;
  rank: number;
}

export interface ArenaStandingsPage {
  id: string;
  format: 'arena-v1';
  generation: number;
  watermark: number;
  generatedAt: number;
  provisional: boolean;
  standings: ArenaStanding[];
  nextCursor: string | null;
}

/** Private primary-authority state. HTTP responses must use no-store. */
export interface ArenaMe {
  id: string;
  format: 'arena-v1';
  serverNow: number;
  status: ArenaStatus;
  registered: boolean;
  state: ArenaEntryState | null;
  gameId: string | null;
  points: number;
  games: number;
  queuedAt: number | null;
  reason: string | null;
}

export type ArenaActionResult =
  | { ok: true; value: ArenaMe }
  | { ok: false; error: { status: number; code: string; message: string } };
