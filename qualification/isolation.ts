import { env } from 'cloudflare:workers';
import { settlesWith } from '../test/authority-helpers';

/** Points a Game at one named Competition so a scenario stays apart from the global authority production uses. */
export const authorityBindings = (name: string) => settlesWith(env.COMPETITION.get(env.COMPETITION.idFromName(name)));
