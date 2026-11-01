import type { Game } from './game';
import type { Competition } from './competition';
import type { AuthEnv } from './auth';
import type { BudgetWebhookEnv } from './budget-webhook';
import type { ProductionResourceEnv } from './production-resources';

/** Each module declares the bindings it reads. Only bindings no single module owns are declared here. */
export interface Env extends AuthEnv, BudgetWebhookEnv, ProductionResourceEnv {
  ASSETS: Fetcher;
  GAME: DurableObjectNamespace<Game>;
  COMPETITION: DurableObjectNamespace<Competition>;
  TOURNAMENTS_ENABLED?: string;
  ARENAS_ENABLED?: string;
  ARENA_ENTRANT_LIMIT?: string;
  ARENA_GAME_LIMIT?: string;
  ARENA_RETAINED_GAME_LIMIT?: string;
  ARENA_GAME_ID_LIMIT?: string;
  ARENA_AUTHORITY_BYTE_LIMIT?: string;
  GAME_RETIREMENT_MODE?: string;
  RANKED_GAME_LIMIT?: string;
  RANKED_QUEUE_LIMIT?: string;
  RANKED_RETAINED_GAME_LIMIT?: string;
  AI_ENABLED?: string;
  TURNSTILE_SITE_KEY?: string;
}

/** Computer practice runs in the browser and needs no provider credential. Only exact `true` enables it. */
export function aiEnabled(env: Pick<Env, 'AI_ENABLED'>): boolean {
  return env.AI_ENABLED === 'true';
}
