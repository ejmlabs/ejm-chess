import { afterEach, describe, expect, it, vi } from 'vitest';
import { CAPACITY_BINDING_HEADER, readCapacityBinding, signCapacityBinding,
  type CapacityBindingAuthorization } from '../src/server/capacity-binding';
import { capacityAccountId, capacityEventId } from '../src/shared/capacity-corpus';
import { capacityFixtureManifest } from './capacity-fixtures';

const secret = 'capacity-local-binding-test-secret-with-at-least-32-bytes';
const manifest = () => capacityFixtureManifest(Date.UTC(2026, 9, 25, 17, 50));
afterEach(() => vi.restoreAllMocks());

describe('prepaid capacity Game routing proof', () => {
  it('carries the fixed native identity and actual seats within the bounded header', async () => {
    const m = manifest();
    vi.spyOn(Date, 'now').mockReturnValue(m.earliestArmAt + 1_000);
    const binding: CapacityBindingAuthorization = { intentIndex: 0, eventIndex: 0,
      eventId: capacityEventId(0, m.earliestArmAt), gameId: crypto.randomUUID(), reservationId: crypto.randomUUID(),
      whiteAccountIndex: 1_500, blackAccountIndex: 45, whiteId: capacityAccountId(1_500), blackId: capacityAccountId(45),
      generation: 1, workflowNonce: crypto.randomUUID() };
    const proof = await signCapacityBinding(binding, m, secret);
    const request = new Request(`https://${m.host}/capacity/step/16004`, { headers: { [CAPACITY_BINDING_HEADER]: proof } });
    expect(proof.length).toBeLessThanOrEqual(2_048);
    expect(await readCapacityBinding(request, m, secret, 0)).toEqual(binding);
    for (const altered of [{ ...m, runId: crypto.randomUUID() }, { ...m, digest: 'd'.repeat(64) },
      { ...m, sourceDigest: 'e'.repeat(64) }, { ...m, configDigest: 'f'.repeat(64) },
      { ...m, hardCloseAt: m.hardCloseAt + 1_000 }]) {
      await expect(readCapacityBinding(request, altered, secret, 0)).rejects.toThrow('capacity_binding_invalid');
    }
    await expect(readCapacityBinding(request, m, secret, 1)).rejects.toThrow('capacity_binding_invalid');
    await expect(readCapacityBinding(request, m, 'a-different-private-secret-with-at-least-32-bytes', 0))
      .rejects.toThrow('capacity_binding_invalid');
    vi.spyOn(Date, 'now').mockReturnValue(m.hardCloseAt);
    await expect(readCapacityBinding(request, m, secret, 0)).rejects.toThrow('capacity_binding_invalid');
  });

  it('cannot sign a guessed event, inconsistent seat, or missing workflow generation', async () => {
    const m = manifest();
    const binding: CapacityBindingAuthorization = { intentIndex: 0, eventIndex: 0,
      eventId: capacityEventId(0, m.earliestArmAt), gameId: crypto.randomUUID(), reservationId: crypto.randomUUID(),
      whiteAccountIndex: 0, blackAccountIndex: 1_000, whiteId: capacityAccountId(0), blackId: capacityAccountId(1_000),
      generation: 1, workflowNonce: crypto.randomUUID() };
    for (const altered of [{ ...binding, eventIndex: 1 }, { ...binding, whiteId: capacityAccountId(1) },
      { ...binding, blackAccountIndex: 2_000, blackId: capacityAccountId(2_000) }, { ...binding, generation: 0 }]) {
      await expect(signCapacityBinding(altered, m, secret)).rejects.toThrow('capacity_binding_invalid');
    }
    await expect(readCapacityBinding(new Request(`https://${m.host}`, {
      headers: { [CAPACITY_BINDING_HEADER]: 'x'.repeat(2_049) },
    }), m, secret, 0)).rejects.toThrow('capacity_binding_invalid');
  });
});
