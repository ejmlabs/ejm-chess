/** Private diagnostic values only. Never retain exception text or request data. */
export const CAPACITY_FAILURE_STAGES = [
  'native-envelope', 'native-ticket', 'workflow-claim', 'native-initialize',
  'native-method', 'registration-auth', 'registration-account', 'registration-step',
  'arena-register', 'native-follow-on', 'native-finish', 'native-metrics',
] as const;
export type CapacityFailureStage = typeof CAPACITY_FAILURE_STAGES[number];

// The private Worker and Node driver share this allowlist.
const PRIVATE_FAILURE_CODES = new Set([
  'capacity_abort_returned', 'capacity_admissions_expired', 'capacity_auth_environment_changed',
  'capacity_auth_meter_missing', 'capacity_binding_invalid', 'capacity_binding_secret_invalid',
  'capacity_binding_unresolved', 'capacity_candidate_unqualified', 'capacity_competition_method_invalid',
  'capacity_competition_restart_unproved', 'capacity_controller_call_denied', 'capacity_fault_unqualified', 'capacity_fixture_expired',
  'capacity_fixture_primary_state_unresolved', 'capacity_game_method_invalid', 'capacity_game_observation_unavailable',
  'capacity_game_step_invalid', 'capacity_game_workflow_plan_missing', 'capacity_ingress_stopped', 'capacity_isolate_stopped',
  'capacity_native_completion_unresolved', 'capacity_native_envelope_missing', 'capacity_native_event_conflict',
  'capacity_native_event_missing', 'capacity_native_follow_on_unresolved', 'capacity_native_generation_fenced',
  'capacity_native_generation_invalid', 'capacity_native_method_missing', 'capacity_native_metrics_regressed',
  'capacity_native_metrics_unavailable', 'capacity_native_metrics_uncertain', 'capacity_native_name_missing',
  'capacity_native_reply_invalid', 'capacity_native_retry_bound_exceeded', 'capacity_native_retry_bound_invalid',
  'capacity_native_retry_reservation_missing', 'capacity_native_ticket_invalid', 'capacity_native_work_denied',
  'capacity_native_work_expired', 'capacity_no_assets', 'capacity_primary_auth_unfunded',
  'capacity_projection_transport_unavailable', 'capacity_protocol_expired', 'capacity_public_projection_unavailable',
  'capacity_public_read_metrics_unavailable', 'capacity_reads_expired', 'capacity_recovery_delivery_unresolved',
  'capacity_recovery_invalid', 'capacity_recovery_result_unresolved', 'capacity_restart_abort_returned',
  'capacity_restart_invalid', 'capacity_restart_not_armed', 'capacity_restart_not_drained',
  'capacity_result_acknowledgment_lost', 'capacity_retirement_alarm_unconfirmed', 'capacity_retirement_barrier_lost',
  'capacity_retirement_envelope_exceeded', 'capacity_retirement_invalid', 'capacity_retirement_not_drained',
  'capacity_retirement_unconfirmed', 'capacity_run_unresolved', 'capacity_session_invalid', 'capacity_settlement_pending',
  'capacity_shutdown_competition_pending', 'capacity_shutdown_early', 'capacity_shutdown_game_pending',
  'capacity_shutdown_game_unconfirmed', 'capacity_shutdown_native_pending', 'capacity_shutdown_socket_cohort_invalid',
  'capacity_shutdown_socket_pending', 'capacity_shutdown_unconfirmed', 'capacity_step_already_issued',
  'capacity_terminal_observation_unresolved', 'capacity_unknown_competition', 'capacity_unknown_game',
  'capacity_unmetered_d1_batch', 'capacity_unmetered_d1_operation', 'capacity_unmetered_d1_raw',
  'capacity_unmetered_d1_statement', 'capacity_unmetered_native_storage',
  'capacity_workflow_allowance', 'capacity_workflow_block_invalid', 'capacity_workflow_completion_invalid',
  'capacity_workflow_completion_unresolved', 'capacity_workflow_completion_tail_exceeded',
  'capacity_workflow_envelope_exceeded', 'capacity_workflow_event_invalid',
  'capacity_workflow_intent_conflict', 'capacity_workflow_metrics_uncertain', 'capacity_workflow_plan_invalid',
  'capacity_workflow_plan_missing', 'capacity_workflow_profile_conflict', 'capacity_workflow_profile_invalid',
  'capacity_workflow_ticket_invalid', 'capacity_workflow_unresolved',
  // Controller, ledger, fault and budget guards reach the Worker through the same RPC.
  'capacity_budget_binding_invalid', 'capacity_budget_resource_changed', 'capacity_calendar_binding_invalid',
  'capacity_charge_invalid', 'capacity_completion_invalid', 'capacity_conflict_fault_unproved',
  'capacity_controller_bootstrap_exceeded', 'capacity_controller_envelope_exceeded', 'capacity_controller_reentrant',
  'capacity_controller_stop_tail_exceeded', 'capacity_controller_unqualified', 'capacity_diagnostic_game_denied',
  'capacity_fault_invalid', 'capacity_fault_result_missing', 'capacity_fixture_batch_invalid', 'capacity_game_invalid',
  'capacity_ingress_invalid', 'capacity_intent_account_invalid', 'capacity_intent_binding_conflict',
  'capacity_intent_ledger_fenced', 'capacity_intent_ledger_invalid', 'capacity_intent_not_reserved',
  'capacity_intent_observation_invalid', 'capacity_permit_corrupt', 'capacity_stop_invalid',
  'capacity_ticket_secret_invalid', 'capacity_work_invalid',
]);
export const capacityPrivateFailureCode = (value: unknown): string | null =>
  typeof value === 'string' && PRIVATE_FAILURE_CODES.has(value) ? value : null;

const USAGE_FIELDS = ['doRowsRead', 'doRowsWritten', 'doStorageBytes', 'd1RowsRead', 'd1RowsWritten',
  'd1StorageBytes', 'd1Statements', 'd1Retries', 'd1RetryReadSurcharge', 'unresolvedD1'] as const;
const WORK_FIELDS = ['workerRequests', 'nativeDoRequests', 'workerCpuMs', 'doRowsWritten', 'doRowsRead',
  'd1RowsWritten', 'd1RowsRead', 'doStorageBytes', 'd1StorageBytes'] as const;
const ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'TimeoutError']);
// The generic D1 code is last, so a message naming both keeps the specific cause.
const CAUSE_CODES = ['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_ERROR', 'SQLITE_CONSTRAINT', 'SQLITE_FULL', 'SQLITE_IOERR',
  'D1_EXEC_ERROR', 'D1_TYPE_ERROR', 'D1_COLUMN_NOTFOUND', 'D1_ERROR'] as const;
const PREFIX = 'capacity-native-failure:';
const MAX_AUDIT_BYTES = 3072;
type Usage = Record<typeof USAGE_FIELDS[number], number> & { uncertain: boolean };
type Work = Record<typeof WORK_FIELDS[number], number>;
const pick = <K extends string>(keys: readonly K[], source: Record<K, number>): Record<K, number> =>
  Object.fromEntries(keys.map(key => [key, source[key]])) as Record<K, number>;
export interface CapacityFailureAudit {
  version: 1; kind: 'Game' | 'Competition'; stage: CapacityFailureStage; index: number | null;
  code: string; errorName: string; causeCode: string | null;
  readBound: number | null; usage: Usage; envelope: Work | null;
}

function counts(value: unknown, fields: readonly string[]): boolean {
  return Boolean(value && typeof value === 'object' && fields.every(key => {
    const field = (value as Record<string, unknown>)[key];
    return Number.isSafeInteger(field) && Number(field) >= 0;
  }));
}

/** Reject unknown fields as well as unsafe strings, before storing a receipt. */
export function readCapacityFailureAudit(raw: string | null): CapacityFailureAudit | null {
  if (!raw || raw.length > MAX_AUDIT_BYTES) return null;
  try {
    const audit = JSON.parse(raw) as CapacityFailureAudit;
    if (!audit || Object.keys(audit).sort().join(',') !== 'causeCode,code,envelope,errorName,index,kind,readBound,stage,usage,version'
      || audit.version !== 1 || !['Game', 'Competition'].includes(audit.kind)
      || !(CAPACITY_FAILURE_STAGES as readonly unknown[]).includes(audit.stage)
      || (audit.index !== null && (!Number.isSafeInteger(audit.index) || audit.index < 0 || audit.index >= 1_000_000))
      || !capacityPrivateFailureCode(audit.code) || !ERROR_NAMES.has(audit.errorName)
      || (audit.causeCode !== null && !capacityPrivateFailureCode(audit.causeCode)
        && !(CAUSE_CODES as readonly unknown[]).includes(audit.causeCode))
      || (audit.readBound !== null && (!Number.isSafeInteger(audit.readBound) || audit.readBound < 1))
      || !counts(audit.usage, USAGE_FIELDS) || typeof audit.usage.uncertain !== 'boolean'
      || Object.keys(audit.usage).sort().join(',') !== [...USAGE_FIELDS, 'uncertain'].sort().join(',')
      || (audit.envelope !== null && (!counts(audit.envelope, WORK_FIELDS)
        || Object.keys(audit.envelope).sort().join(',') !== [...WORK_FIELDS].sort().join(',')))) return null;
    return audit;
  } catch { return null; }
}

export function capacityFailureFromError(error: unknown): CapacityFailureAudit | null {
  return error instanceof Error && error.message.startsWith(PREFIX)
    ? readCapacityFailureAudit(error.message.slice(PREFIX.length)) : null;
}

/** An RPC-safe receipt, with no new native I/O or successful completion. */
export function capacityNativeFailure(error: unknown,
  values: Pick<CapacityFailureAudit, 'kind' | 'stage' | 'index' | 'readBound' | 'usage' | 'envelope'>): Error {
  const prior = capacityFailureFromError(error);
  // A nested native receipt keeps its root cause. Only its missing step is this call's.
  if (prior) return new Error(PREFIX + JSON.stringify({ ...prior, index: prior.index ?? values.index }));
  const original = error instanceof Error ? error : null;
  const cause = original?.cause instanceof Error ? original.cause : original;
  const code = capacityPrivateFailureCode(original?.message) ?? 'capacity_run_unresolved';
  const causeCode = capacityPrivateFailureCode(cause?.message)
    ?? CAUSE_CODES.find(value => cause?.message.includes(value)) ?? null;
  const audit: CapacityFailureAudit = { version: 1, ...values, code,
    errorName: original && ERROR_NAMES.has(original.name) ? original.name : 'Error', causeCode,
    usage: { ...pick(USAGE_FIELDS, values.usage), uncertain: values.usage.uncertain },
    envelope: values.envelope ? pick(WORK_FIELDS, values.envelope) : null };
  return new Error(PREFIX + JSON.stringify(audit));
}
