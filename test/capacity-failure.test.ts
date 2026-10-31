import { describe, expect, it } from 'vitest';
import { capacityFailureResponse } from '../src/server/capacity-qualification';
import { CapacityNativeMeter } from '../src/server/capacity-meter';
import { capacityFailureFromError, capacityNativeFailure, readCapacityFailureAudit } from '../src/shared/capacity-failure';

const usage = new CapacityNativeMeter().snapshot();
const receipt = (error: unknown, values: Partial<Parameters<typeof capacityNativeFailure>[1]> = {}) =>
  capacityNativeFailure(error, { kind: 'Competition', stage: 'native-method', index: null, readBound: null, usage,
    envelope: null, ...values });
const raw = (error: Error) => error.message.slice(error.message.indexOf('{'));

describe('private capacity failure receipts', () => {
  it('keeps retry-bound and controller failures as 503 and strips arbitrary error data', async () => {
    for (const code of ['capacity_native_retry_bound_exceeded', 'capacity_native_retry_bound_invalid',
      'capacity_native_retry_reservation_missing', 'capacity_controller_envelope_exceeded',
      'capacity_controller_bootstrap_exceeded', 'capacity_controller_stop_tail_exceeded']) {
      const response = capacityFailureResponse(new Error(code));
      expect(response.status).toBe(503);
      expect(response.headers.get('X-Capacity-Failure')).toBe(code);
    }
    const error = new Error('D1_ERROR: cookie=never-retain-this-fixture-secret', {
      cause: new TypeError('SQLITE_BUSY: private SQL and token=never-retain-this-fixture-secret'),
    });
    const encoded = receipt(error, { stage: 'registration-auth', index: 10829, readBound: 128 });
    const response = capacityFailureResponse(encoded);
    expect(response.status).toBe(503);
    const header = response.headers.get('X-Capacity-Audit');
    expect(header).not.toContain('never-retain');
    expect(header).not.toContain('private SQL');
    expect(readCapacityFailureAudit(header)).toMatchObject({ stage: 'registration-auth', index: 10829,
      code: 'capacity_run_unresolved', causeCode: 'SQLITE_BUSY' });
    expect(readCapacityFailureAudit(header!.replace('registration-auth', 'private-fixture-secret'))).toBeNull();
    expect(readCapacityFailureAudit(header!.replace('"version":1', '"extra":"private-fixture-secret","version":1'))).toBeNull();
    expect(await response.json()).toMatchObject({ code: 'CAPACITY_RUN_UNRESOLVED', failure: { index: 10829 } });
  });

  it('never names a cause it cannot prove', () => {
    for (const thrown of ['private-fixture-secret', { message: 'capacity_work_invalid' }, new Error('Network connection lost.')]) {
      const audit = capacityFailureFromError(receipt(thrown));
      expect(audit).toMatchObject({ code: 'capacity_run_unresolved', errorName: 'Error', causeCode: null });
    }
    const response = capacityFailureResponse(new Error('capacity_unlisted_private_fixture'));
    expect(response.status).toBe(503);
    expect(response.headers.get('X-Capacity-Failure')).toBe('capacity_run_unresolved');
    expect(response.headers.get('X-Capacity-Audit')).toBeNull();
    // The specific database code wins over the generic one in the same message.
    expect(capacityFailureFromError(receipt(new Error('D1_ERROR: SQLITE_BUSY: private-fixture-secret'))))
      .toMatchObject({ causeCode: 'SQLITE_BUSY' });
  });

  it('keeps a nested receipt root cause and adds only the missing step', () => {
    const nested = receipt(new Error('capacity_game_observation_unavailable'), { kind: 'Game', stage: 'native-follow-on' });
    expect(capacityFailureFromError(receipt(nested, { stage: 'native-method', index: 42, readBound: 128 })))
      .toMatchObject({ kind: 'Game', stage: 'native-follow-on', code: 'capacity_game_observation_unavailable',
        index: 42, readBound: null });
    const stepped = receipt(new Error('capacity_native_ticket_invalid'), { index: 7 });
    expect(capacityFailureFromError(receipt(stepped, { index: 42 }))).toMatchObject({ index: 7 });
  });

  it('rejects oversized, fractional and negative receipts', () => {
    const valid = raw(receipt(new Error('capacity_native_follow_on_unresolved'), { index: 5 }));
    expect(readCapacityFailureAudit(valid)).toMatchObject({ index: 5, code: 'capacity_native_follow_on_unresolved' });
    expect(readCapacityFailureAudit(valid.replace('"version"', '"version"' + ' '.repeat(4_096)))).toBeNull();
    expect(readCapacityFailureAudit(valid.replace('"doRowsRead":0', '"doRowsRead":1.5'))).toBeNull();
    expect(readCapacityFailureAudit(valid.replace('"d1Retries":0', '"d1Retries":-1'))).toBeNull();
    expect(readCapacityFailureAudit(valid.replace('"index":5', '"index":1000000'))).toBeNull();
    expect(readCapacityFailureAudit(valid.slice(0, -1))).toBeNull();
    expect(readCapacityFailureAudit(null)).toBeNull();
  });
});
