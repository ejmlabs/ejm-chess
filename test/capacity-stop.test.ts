import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import capacityWorker from '../src/server/capacity-qualification';
import type { CapacityEnv } from '../src/server/capacity-native';
import { capacityNativeFailure, readCapacityFailureAudit } from '../src/shared/capacity-failure';
import { CapacityNativeMeter } from '../src/server/capacity-meter';
import { capacityFixtureManifest } from './capacity-fixtures';

// Only the sealed manifest changes. It lets the real stop route run in this local test.
vi.mock('../src/server/capacity-run', async importOriginal => ({
  ...await importOriginal<typeof import('../src/server/capacity-run')>(),
  SEALED_CAPACITY_MANIFEST: (await import('./capacity-fixtures')).capacityFixtureManifest(),
}));

const token = 'a'.repeat(43);
const host = capacityFixtureManifest().host;

function stopFixture(finish: () => Promise<unknown>) {
  const control = { recoverCompetitionWorkflow: async () => ({ id: 'x', objectKey: 'competition', mode: 'workflow' }),
    stop: vi.fn(async () => {}), status: async () => ({ stopReason: 'owner-stop' }),
    complete: vi.fn(async () => true), confirmShutdown: vi.fn(async () => true) };
  const competition = { idFromName: (name: string) => name, get: () => ({ finishQualification: finish }) };
  const capacityEnv = { DB: env.DB, GAME: env.GAME, COMPETITION: competition,
    CAPACITY_RUN: { idFromName: (name: string) => name, get: () => control },
    AUTH_SECRET: 'capacity-local-stop-secret-with-at-least-32-bytes', CAPACITY_TOKEN: token } as unknown as CapacityEnv;
  const stop = () => capacityWorker.fetch(new Request(`https://${host}/capacity/stop`, { method: 'POST', body: '{}',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }), capacityEnv);
  return { control, stop };
}

describe('private capacity owner stop', () => {
  it('returns the native finish failure receipt after the controller stop, and never succeeds', async () => {
    const receipt = capacityNativeFailure(new Error('capacity_shutdown_competition_pending'), { kind: 'Competition',
      stage: 'native-method', index: null, readBound: null, usage: new CapacityNativeMeter().snapshot(), envelope: null });
    const { control, stop } = stopFixture(async () => { throw receipt; });
    const response = await stop();
    expect(response.status).toBe(503);
    expect(response.headers.get('X-Capacity-Failure')).toBe('capacity_shutdown_competition_pending');
    expect(readCapacityFailureAudit(response.headers.get('X-Capacity-Audit'))).toMatchObject({
      kind: 'Competition', stage: 'native-method', index: null, code: 'capacity_shutdown_competition_pending' });
    expect(control.stop).toHaveBeenCalledOnce();
    expect(control.complete).not.toHaveBeenCalled();
  });

  it('keeps a lost native finish reply as an unknown failure', async () => {
    const { control, stop } = stopFixture(async () => { throw new Error('Network connection lost. private-fixture-secret'); });
    const response = await stop();
    expect(response.status).toBe(503);
    expect(response.headers.get('X-Capacity-Failure')).toBe('capacity_run_unresolved');
    expect(response.headers.get('X-Capacity-Audit')).toBeNull();
    expect(JSON.stringify(await response.json())).not.toContain('private-fixture-secret');
    expect(control.stop).toHaveBeenCalledOnce();
  });

  it('still reports a completed shutdown with the controller status', async () => {
    const reply = { ticketId: 'x', value: {}, workflowActual: {}, drained: { pendingNative: 0, alarm: false, sockets: 0 } };
    const { control, stop } = stopFixture(async () => reply);
    const response = await stop();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stopReason: 'owner-stop' });
    expect(control.confirmShutdown).toHaveBeenCalledOnce();
  });
});
