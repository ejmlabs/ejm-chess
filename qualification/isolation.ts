import { env } from 'cloudflare:workers';
import type { Env } from '../src/server/env';

/** Points a Game at one named Competition so a scenario stays apart from the global authority production uses. */
export function authorityBindings(name: string): Pick<Env, 'COMPETITION'> {
  return { COMPETITION: { idFromName: env.COMPETITION.idFromName.bind(env.COMPETITION),
    get: () => env.COMPETITION.get(env.COMPETITION.idFromName(name)) } as unknown as Env['COMPETITION'] };
}
