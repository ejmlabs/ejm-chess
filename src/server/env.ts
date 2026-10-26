import type { Game } from './game';
import type { Competition } from './competition';
import type { StockfishAnalyzer } from './analysis';
import type { BudgetEnv } from './budget';
import type { TimeoutProver } from './proof-pool';

export interface Env extends BudgetEnv {
  ASSETS: Fetcher;
  DB: D1Database;
  GAME: DurableObjectNamespace<Game>;
  COMPETITION: DurableObjectNamespace<Competition>;
  AUTH_SECRET: string;
  AUTH_BASE_URL: string;
  BUDGET_STOP_WEBHOOK_SECRET?: string;
  LOCAL_DEV?: string;
  PRODUCTION_RESOURCE_IDS?: string;
  OPERATION_MODE?: string;
  TOURNAMENTS_ENABLED?: string;
  ARENAS_ENABLED?: string;
  ARENA_ENTRANT_LIMIT?: string;
  ARENA_GAME_LIMIT?: string;
  ARENA_RETAINED_GAME_LIMIT?: string;
  ARENA_GAME_ID_LIMIT?: string;
  ARENA_AUTHORITY_BYTE_LIMIT?: string;
  GAME_RETIREMENT_MODE?: string;
  RANKED_ENABLED?: string;
  /** Exact supported profile and a private binding are required for new ranked admission. */
  TIMEOUT_PROOF_PROFILE?: string;
  MONTHLY_PROOF_LIMIT?: string;
  PROVER?: DurableObjectNamespace<TimeoutProver>;
  RANKED_GAME_LIMIT?: string;
  RANKED_QUEUE_LIMIT?: string;
  RANKED_RETAINED_GAME_LIMIT?: string;
  CASUAL_GAME_LIMIT?: string;
  CASUAL_GAME_ID_LIMIT?: string;
  AI_ENABLED?: string;
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
  EMAIL?: { send(message: { from: string; to: string[]; subject: string; text: string }): Promise<unknown> };
  EMAIL_FROM?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  OWNER_EMAILS?: string;
  ANALYSIS_QUEUE?: Queue;
  ANALYZER?: DurableObjectNamespace<StockfishAnalyzer>;
  ANALYSIS_ENABLED?: string;
  ANALYSIS_DAILY_LIMIT?: string;
  ANALYSIS_DEAD_LETTER_QUEUE?: Queue;
}

/** The browser engine needs no provider credential. Explicit false remains a kill switch. */
export function aiEnabled(env: Pick<Env, 'AI_ENABLED'>): boolean {
  return env.AI_ENABLED === 'true';
}
