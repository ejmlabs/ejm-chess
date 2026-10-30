import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { createPlaceholderEmail } from '@better-auth/core/utils/email';
import type { Actor, GameSnapshot, InitGame } from '../src/shared/protocol';
import type { Env } from '../src/server/env';
import type { Competition } from '../src/server/competition';
import type { Game } from '../src/server/game';
import { PROOF_PROFILE, unknownProof, type TimeoutProofRequest } from '../src/server/proof-contract';

export async function player(anonymous = false, options: { recoveryEmail?: boolean } = {}): Promise<Actor> {
  const now = Date.now();
  const id = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  const username = anonymous ? null : `p${id.replaceAll('-', '').slice(0, 23)}`;
  const email = options.recoveryEmail === false ? createPlaceholderEmail({ identifier: id, namespace: 'chess' }) : `${id}@example.test`;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO user(id,name,email,emailVerified,isAnonymous,username,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?)')
      .bind(id, `Player ${id.slice(0, 6)}`, email, anonymous || options.recoveryEmail === false ? 0 : 1, anonymous ? 1 : 0, username, new Date(now - 30 * 86_400_000).toISOString(), new Date(now).toISOString()),
    ...(!anonymous ? [env.DB.prepare('INSERT INTO account(id,accountId,providerId,userId,password,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)')
      // This authority fixture never authenticates a password. Native hashing is covered by auth tests.
      .bind(crypto.randomUUID(), id, 'credential', id, 'fake-test-only-password-hash', new Date(now).toISOString(), new Date(now).toISOString())] : []),
    env.DB.prepare('INSERT INTO session(id,userId,token,expiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
      .bind(sessionId, id, crypto.randomUUID(), new Date(now + 86_400_000).toISOString(), new Date(now).toISOString(), new Date(now).toISOString()),
  ]);
  return { id, name: `Player ${id.slice(0, 6)}`, isAnonymous: anonymous, sessionId, sessionExpiresAt: now + 86_400_000 };
}

export async function enableRanked(stub: DurableObjectStub<Competition> | DurableObjectStub<Game>): Promise<void> {
  await runInDurableObject(stub as DurableObjectStub<Game>, instance => {
    const internal = instance as unknown as { env: Env };
    internal.env = { ...internal.env, RANKED_ENABLED: 'true', TIMEOUT_PROOF_PROFILE: PROOF_PROFILE, MONTHLY_PROOF_LIMIT: '1000',
      // Existing authority tests use no native solver. Their private fixture
      // can only report unknown, so it cannot invent a supported timeout win.
      PROVER: { idFromName: (name: string) => name, get: () => ({ fetch: async (request: Request) =>
        Response.json(unknownProof(await request.json() as TimeoutProofRequest, 'solver-undetermined')) }) } as unknown as Env['PROVER'] };
  });
}

/** Direct Game unit fixtures admit an ID without exercising HTTP admission. */
export async function admitGameFixture(input: InitGame): Promise<void> {
  if (input.rated || input.tournament) return;
  await env.DB.prepare('INSERT OR IGNORE INTO casual_game_admissions(game_id,creator_id,created_at,reservation_id) VALUES(?,?,?,?)')
    .bind(input.id, input.white.id, Date.now(), input.reservationId ?? null).run();
}

export async function activeGame(): Promise<{ game: DurableObjectStub<Game>; white: Actor; black: Actor; snapshot: GameSnapshot }> {
  const [white, black] = await Promise.all([player(), player()]);
  const id = crypto.randomUUID();
  const game = env.GAME.get(env.GAME.idFromName(id));
  await admitGameFixture({ id, format: 'blitz', rated: false, white, black });
  await game.init({ id, format: 'blitz', rated: false, white, black });
  const first = await game.command(white, { type: 'ready', id: crypto.randomUUID(), expectedVersion: 0 });
  if (!first.ok) throw new Error(first.code);
  const second = await game.command(black, { type: 'ready', id: crypto.randomUUID(), expectedVersion: first.snapshot.version });
  if (!second.ok) throw new Error(second.code);
  return { game, white, black, snapshot: second.snapshot };
}
