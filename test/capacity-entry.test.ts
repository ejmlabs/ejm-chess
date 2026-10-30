import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import capacityWorker from '../src/server/capacity-qualification';
import type { CapacityEnv } from '../src/server/capacity-native';

describe('unqualified private capacity entry', () => {
  it('does not create a controller, arm, or dispatch work without every compiled gate', async () => {
    let controllerCalls = 0;
    const isolated = { DB: env.DB, GAME: env.GAME, COMPETITION: env.COMPETITION,
      AUTH_SECRET: 'capacity-local-entry-secret-with-at-least-32-bytes', CAPACITY_TOKEN: 'a'.repeat(43),
      CAPACITY_RUN: { get() { controllerCalls++; throw new Error('must_not_instantiate_controller'); } } } as unknown as CapacityEnv;
    for (const path of ['/capacity/manifest', '/capacity/status', '/capacity/arm', '/capacity/game/arbitrary']) {
      const response = await capacityWorker.fetch(new Request('https://chess-capacity-local.ejmlabs.com' + path,
        { method: path === '/capacity/status' || path === '/capacity/manifest' ? 'GET' : 'POST',
          headers: { Authorization: `Bearer ${isolated.CAPACITY_TOKEN}` } }), isolated);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ ready: false, armed: path === '/capacity/manifest' ? null : false });
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
    expect(controllerCalls).toBe(0);
    const leakedBinding = { ...isolated, EMAIL: { send: async () => { throw new Error('must_not_send'); } } };
    const denied = await capacityWorker.fetch(new Request('https://chess-capacity-local.ejmlabs.com/capacity/status',
      { headers: { Authorization: `Bearer ${isolated.CAPACITY_TOKEN}` } }), leakedBinding);
    expect(denied.status).toBe(401);
    expect(controllerCalls).toBe(0);
  });
});
