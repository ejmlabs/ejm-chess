import { env } from 'cloudflare:workers';
import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import handler from '../src/server/index';
import { currentActor, hasRecoveryEmail } from '../src/server/auth';
import type { Env } from '../src/server/env';
import type { TournamentView } from '../src/shared/tournaments';

const origin = 'http://localhost:8787';
let address = 1;
afterEach(() => { vi.restoreAllMocks(); });
function request(path: string, cookie = '', body?: unknown) {
  return new Request(origin + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: origin, Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      'X-Turnstile-Token': 'local-development', 'CF-Connecting-IP': `198.51.100.${address++}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function http(value: Request) {
  const context = createExecutionContext();
  const response = await handler.fetch(value, env, context);
  await waitOnExecutionContext(context);
  return response;
}
async function user() {
  const username = `p${crypto.randomUUID().replaceAll('-', '').slice(0, 23)}`;
  const response = await http(request('/api/auth/sign-up/email', '', {
    username, name: username, password: 'test-only-password-12345',
  }));
  expect(response.status).toBe(200);
  const cookie = response.headers.get('Set-Cookie')!.split(';')[0];
  const actor = (await currentActor(request('/api/me', cookie), env))!;
  expect(actor).toMatchObject({ accountReady: true, emailVerified: false });
  expect(hasRecoveryEmail(actor.email)).toBe(false);
  return { actor, cookie };
}

it('maps routine tournament RPC failures to safe HTTP 4xx responses and successful actions to public views', async () => {
  const startsAt = Math.ceil(Date.now() / 3_600_000) * 3_600_000 + 3_600_000;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(startsAt - 16 * 60_000);
  const competition = env.COMPETITION.get(env.COMPETITION.idFromName('global'));
  await runInDurableObject(competition, async (instance, state) => {
    const internal = instance as unknown as { env: Env; schedule(): Promise<void> };
    internal.env = { ...internal.env, TOURNAMENTS_ENABLED: 'true' };
    internal.schedule = async () => {};
    await state.storage.deleteAlarm();
  });
  const entrants = await Promise.all(Array.from({ length: 5 }, () => user()));
  const withoutCredential = await user();
  await env.DB.prepare("UPDATE account SET password=NULL WHERE userId=? AND providerId='credential'").bind(withoutCredential.actor.id).run();
  const path = `/api/tournaments/hourly-${startsAt}`;
  const early = await http(request(`${path}/register`, entrants[0].cookie, {}));
  expect(early.status).toBe(409);
  expect(await early.json()).toMatchObject({ error: 'REGISTRATION_CLOSED' });
  clock.mockReturnValue(startsAt - 10 * 60_000);
  const denied = await http(request(`${path}/register`, withoutCredential.cookie, {}));
  expect(denied.status).toBe(403);
  expect(await denied.json()).toMatchObject({ error: 'TOURNAMENT_INELIGIBLE' });
  for (const entrant of entrants.slice(0, 4)) {
    const response = await http(request(`${path}/register`, entrant.cookie, {}));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: `hourly-${startsAt}`, myStatus: 'registered' });
  }
  const full = await http(request(`${path}/register`, entrants[4].cookie, {}));
  expect(full.status).toBe(409);
  expect(await full.json()).toMatchObject({ error: 'TOURNAMENT_FULL' });
  const publicResponse = await http(request(path));
  expect(publicResponse.status).toBe(200);
  const publicView = await publicResponse.json() as TournamentView;
  expect(publicView.myStatus).toBeNull();
  expect(publicView.myGameId).toBeNull();
  expect(JSON.stringify(publicView)).not.toContain(entrants[0].actor.sessionId);
  expect(JSON.stringify(publicView)).not.toContain('placeholder.invalid');
  const removed = await http(request(`${path}/withdraw`, entrants[0].cookie, {}));
  expect(removed.status).toBe(200);
  expect((await removed.json() as TournamentView).players).toHaveLength(3);
  clock.mockReturnValue(startsAt);
  const late = await http(request(`${path}/withdraw`, entrants[1].cookie, {}));
  expect(late.status).toBe(409);
  expect(await late.json()).toMatchObject({ error: 'TOURNAMENT_STARTED' });
  const missing = await http(request('/api/tournaments/unknown'));
  expect(missing.status).toBe(404);
  const anonymous = await http(request(`${path}/register`, '', {}));
  expect(anonymous.status).toBe(401);
});
