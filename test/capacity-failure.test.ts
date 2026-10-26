import { describe, expect, it } from 'vitest';
import { capacityFailureResponse } from '../src/server/capacity-qualification';
import { CapacityNativeMeter } from '../src/server/capacity-meter';
import { capacityNativeFailure, readCapacityFailureAudit } from '../src/shared/capacity-failure';

describe('private capacity failure receipts', () => {
  it('keeps retry-bound failures as503 and strips arbitrary error data', async () => {
    for (const code of ['capacity_native_retry_bound_exceeded', 'capacity_native_retry_bound_invalid',
      'capacity_native_retry_reservation_missing']) {
      const response = capacityFailureResponse(new Error(code));
      expect(response.status).toBe(503);
      expect(response.headers.get('X-Capacity-Failure')).toBe(code);
    }
    const error = new Error('D1_ERROR: cookie=never-retain-this-fixture-secret', {
      cause: new TypeError('SQLITE_BUSY: private SQL and token=never-retain-this-fixture-secret'),
    });
    const encoded = capacityNativeFailure(error, { kind: 'Competition', stage: 'registration-auth',
      index: 10829, readBound: 128, usage: new CapacityNativeMeter().snapshot(), envelope: null });
    const response = capacityFailureResponse(encoded);
    expect(response.status).toBe(503);
    const raw = response.headers.get('X-Capacity-Audit');
    expect(raw).not.toContain('never-retain');
    expect(raw).not.toContain('private SQL');
    expect(readCapacityFailureAudit(raw)).toMatchObject({ stage: 'registration-auth', index: 10829,
      code: 'capacity_run_unresolved', causeCode: 'SQLITE_BUSY' });
    expect(readCapacityFailureAudit(raw!.replace('registration-auth', 'private-fixture-secret'))).toBeNull();
    expect(readCapacityFailureAudit(raw!.replace('"version":1', '"extra":"private-fixture-secret","version":1'))).toBeNull();
    expect(await response.json()).toMatchObject({ code: 'CAPACITY_RUN_UNRESOLVED', failure: { index: 10829 } });
  });
});
