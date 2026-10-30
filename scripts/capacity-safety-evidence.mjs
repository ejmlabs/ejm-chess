import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const CAPACITY_SAFETY_FILES = Object.freeze(['report.json', 'source.json', 'worker-unarmed.mjs',
  'focused-tests.json', 'native-workflow.json', 'native-retirement.json', 'allowance.json', 'allowance-local-only.mjs']);

// These checks cover uncertainty, lifetime permits, finite work and real native
// cleanup. The complete 19,000-game provider workload remains a separate gate.
export const CAPACITY_SAFETY_TESTS = Object.freeze({
  'test/capacity-run.test.ts': [
    'funds every diagnostic ingress call across fresh Worker consumers',
    'recovers only the saved Competition workflow after a stop and reconstruction',
    'confirms the short registration stop only from one completed zero-Game workflow',
    'does not arm without a compiled, verified, fixed manifest or renew an existing run',
    'keeps uncertain receipts charged across stop, store reconstruction and month change',
    'holds unresolved native permits and reserved work through lost replies and expiry',
    'reserves the worst next operation and keeps alarms, sockets and overlapping events charged',
    'denies the 2049th object while preserving every unresolved native permit',
    'does not double-spend grants under concurrent ingress or retry an uncertain grant',
    'charges physical storage high water marks once and keeps unknown growth reserved',
    'fences every unresolved caller and consumes one exact generation retirement before reacquiring',
    'retains every socket generation and all lost or expired retirement allowances',
  ],
  'test/capacity-workflow.test.ts': [
    'reserves the named operation and records the actual completion tail across cold starts',
    'keeps an interrupted reservation after reconstruction and rejects new native work',
    'refuses a next operation that cannot fit without spending or refunding its slot',
  ],
  'test/capacity-native.test.ts': [
    'closes the registration diagnostic from real accounts and rejects all Game work',
    'freezes a cold interrupted Game alarm before native work',
    'freezes a cold interrupted Competition alarm before native work',
    'fences a failed Game alarm and its scheduled tail after uncertain cleanup',
    'fences a failed Competition alarm and its scheduled tail after uncertain cleanup',
    'meters a prepaid workflow across native events and reconstruction without per-event controller RPCs',
    'does not confirm native shutdown for an empty Game',
    'reserves before activation and settles only after the real native reply without retrying lost work',
    'holds an interrupted second ready reservation and fences reconstructed work and its alarm',
    'rejects second ready replay after a completed native reply is lost and the wrapper is reconstructed',
    'measures real readiness, legal moves, resignation and delivery without changing native authority',
  ],
});

export const capacitySafetyHash = bytes => createHash('sha256').update(bytes).digest('hex');
const check = (condition, code) => { if (!condition) throw new Error(code); };
const equal = (a, b, code) => check(isDeepStrictEqual(a, b), code);
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function validateCapacitySafetyReports({ report, fixture, tests, workflow, retirement, allowance }, ceilings) {
  check(report.schema === 'ejm-chess-focused-capacity-safety-v1' && report.localOnly === true
    && report.providerQualification === false && report.fullWorkload === false
    && report.productionGatesChanged === false && report.passed === true && report.failure === null
    && Array.isArray(report.sourceChanges) && report.sourceChanges.length === 0,
  'capacity_seal_focused_safety_required');
  check(fixture.schema === 'ejm-chess-capacity-safety-source-v1' && fixture.localOnly === true
    && fixture.providerQualification === false && report.sourceDigest === fixture.sourceDigest
    && hex(fixture.sourceDigest) && hex(fixture.unarmedBundleSha256) && hex(fixture.allowanceBundleSha256),
  'capacity_seal_safety_identity_invalid');
  check(tests.success === true && tests.numFailedTests === 0, 'capacity_seal_safety_tests_failed');
  let matched = 0;
  for (const [path, names] of Object.entries(CAPACITY_SAFETY_TESTS)) {
    const suite = tests.testResults?.find(suite => suite.name?.endsWith('/' + path));
    check(suite && suite.status === 'passed', 'capacity_seal_safety_suite_missing');
    for (const name of names) {
      const cases = suite.assertionResults?.filter(test => test.title === name);
      check(cases?.length === 1 && cases[0].status === 'passed', 'capacity_seal_safety_case_missing');
      matched++;
    }
  }
  check(tests.numPassedTests >= matched, 'capacity_seal_safety_test_count_invalid');
  check(workflow.schema === 'ejm-chess-native-workflow-local-v1' && workflow.observed?.failure === null
    && workflow.observed.results?.length === 15 && workflow.observed.results.every(value => value.accepted === true)
    && workflow.observed.gameState?.workflow?.closed === 1 && workflow.observed.gameState.workflow.unresolved === 0
    && workflow.observed.gameState.pendingDelivery === 0 && workflow.observed.gameState.alarm === null
    && Object.values(workflow.checks ?? {}).length > 0 && Object.values(workflow.checks).every(value => value === true),
  'capacity_seal_safety_native_workflow_incomplete');
  const gameEvents = workflow.observed.measured?.events?.filter(event => event.kind === 'Game');
  const tail = gameEvents?.at(-1);
  check(gameEvents?.length > 0 && tail.drained?.pendingNative === 0 && tail.drained.alarm === false && tail.drained.sockets === 0
    && workflow.observed.measured.events.every(event => event.usage?.uncertain === false && event.usage.unresolvedD1 === 0),
  'capacity_seal_safety_native_drain_missing');
  const observedWork = JSON.parse(workflow.observed.gameState.workflow.observed);
  const reservedWork = JSON.parse(workflow.observed.gameState.workflow.reserved);
  const workKeys = ['workerRequests', 'nativeDoRequests', 'workerCpuMs', 'doRowsWritten', 'doRowsRead',
    'd1RowsWritten', 'd1RowsRead', 'doStorageBytes', 'd1StorageBytes'].sort();
  equal(Object.keys(observedWork).sort(), workKeys, 'capacity_seal_safety_work_fields_invalid');
  equal(Object.keys(reservedWork).sort(), workKeys, 'capacity_seal_safety_work_fields_invalid');
  check(workflow.observed.gameState.workflow.stopped === 0 && Object.values(reservedWork).every(value => value === 0),
    'capacity_seal_safety_native_work_held');
  for (const [key, value] of Object.entries(observedWork)) {
    check(Number.isSafeInteger(value) && value >= 0 && value <= fixture.workflows.regular.envelope[key],
      'capacity_seal_safety_native_work_exceeded');
  }
  const native = retirement.observed, rc = retirement.checks;
  check(retirement.schema === 'ejm-chess-native-retirement-local-v1' && native
    && ['exactPrivateAbort', 'lifetimeReleasedOnce', 'poisonedStubReplaysOriginalError', 'reacquiredBeforeNewGeneration',
      'freshNativeIncarnation', 'durableStatePreserved', 'actualAlarmInterrupted', 'abortCannotBeCaught',
      'noFutureAlarm', 'noUnresolvedDispatch', 'measuredControllerRows'].every(key => rc?.[key] === true)
    && native.confirmed === true && native.repeatedConfirm === false && native.status?.unresolvedDispatches === 0
    && native.firstError?.message === `capacity-retired:${native.grant?.runId}:${native.grant?.objectKey}:${native.grant?.generation}:${native.grant?.nonce}`
    && native.poisonedReplay?.message === native.firstError.message && native.retired?.activeObjects === 2
    && native.reacquired === true && native.status.activeObjects === 3 && native.after?.wrapper?.generation === 2
    && native.after.incarnation !== native.before?.incarnation && native.after.probe?.preserved === 1
    && native.after.consumed === 2 && native.after.probe.retire_caught === 0 && native.after.probe.retire_returned === 0
    && native.after?.alarm === null && native.afterRetryWindow?.alarm === null
    && native.after.probe.alarm_entered === 1 && native.after.probe.alarm_returned === 0
    && native.afterRetryWindow.probe?.alarm_entered === 1 && native.afterRetryWindow.probe.alarm_returned === 0
    && native.controllerObservations?.usage?.uncertain === false,
  'capacity_seal_safety_native_retirement_missing');
  equal(Object.keys(retirement.sourceHashes ?? {}).sort(), ['src/server/capacity-meter.ts', 'src/server/capacity-native.ts',
    'src/server/capacity-run.ts'], 'capacity_seal_safety_probe_sources_missing');
  for (const [path, digest] of Object.entries(retirement.sourceHashes ?? {})) {
    check(fixture.sources[path] === digest, 'capacity_seal_safety_probe_source_changed');
  }
  equal(allowance.ceilings, ceilings, 'capacity_seal_safety_ceiling_changed');
  check(allowance.allowance && Object.keys(allowance.allowance).length === 9, 'capacity_seal_safety_allowance_missing');
  for (const [key, value] of Object.entries(allowance.allowance)) {
    check(Number.isSafeInteger(value) && value >= 0 && value <= ceilings[key], 'capacity_seal_safety_allowance_exceeded');
  }
  if (fixture.registrationDiagnosticPlan) {
    check(allowance.registrationDiagnosticAllowance && Object.keys(allowance.registrationDiagnosticAllowance).length === 9,
      'capacity_seal_safety_diagnostic_allowance_missing');
    for (const [key, value] of Object.entries(allowance.registrationDiagnosticAllowance)) {
      check(Number.isSafeInteger(value) && value >= 0 && value <= ceilings[key], 'capacity_seal_safety_diagnostic_allowance_exceeded');
    }
  }
  check(Array.isArray(report.priorFailedFullWorkloads) && report.priorFailedFullWorkloads.length > 0
    && report.priorFailedFullWorkloads.every(ref => typeof ref.file === 'string' && hex(ref.sha256)),
  'capacity_seal_prior_failure_evidence_missing');
  return { fixture, report, matchedSafetyTests: matched };
}

export async function readCapacitySafetyEvidence(source, record, base, ceilings) {
  check(record && typeof record.directory === 'string' && record.files, 'capacity_seal_safety_evidence_missing');
  equal(Object.keys(record.files).sort(), [...CAPACITY_SAFETY_FILES].sort(), 'capacity_seal_safety_files_invalid');
  const directory = resolve(base, record.directory), values = {};
  for (const name of CAPACITY_SAFETY_FILES) {
    const bytes = await readFile(resolve(directory, name));
    check(bytes.length <= 32 * 1024 ** 2 && capacitySafetyHash(bytes) === record.files[name], 'capacity_seal_safety_reference_changed');
    if (name.endsWith('.json')) values[name] = JSON.parse(bytes);
  }
  const fixture = values['source.json'];
  check(fixture.unarmedBundleSha256 === record.files['worker-unarmed.mjs']
    && fixture.allowanceBundleSha256 === record.files['allowance-local-only.mjs'], 'capacity_seal_safety_bundle_changed');
  const paths = Object.keys(fixture.sources ?? {});
  check(paths.length > 0 && paths.length <= 10_000, 'capacity_seal_safety_source_graph_missing');
  equal(paths, [...paths].sort(), 'capacity_seal_safety_source_order_changed');
  for (const path of paths) {
    check(!isAbsolute(path) && !path.split('/').includes('..') && !path.includes('\\') && hex(fixture.sources[path])
      && !/(^|\/)(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?|sessions\.private\.json)$/.test(path), 'capacity_seal_safety_source_invalid');
    check(capacitySafetyHash(await readFile(resolve(source, path))) === fixture.sources[path], 'capacity_seal_raw_source_changed');
  }
  check(capacitySafetyHash(JSON.stringify(fixture.sources)) === fixture.sourceDigest
    && fixture.configDigest === fixture.sources['wrangler.capacity.jsonc'], 'capacity_seal_safety_source_digest_changed');
  const report = values['report.json'];
  for (const ref of report.priorFailedFullWorkloads ?? []) {
    const bytes = await readFile(resolve(base, ref.file));
    check(bytes.length <= 2 * 1024 ** 2 && capacitySafetyHash(bytes) === ref.sha256, 'capacity_seal_prior_failure_changed');
    const prior = JSON.parse(bytes);
    check(prior.localOnly === true && prior.fullWorkload === true && prior.providerQualification === false
      && prior.passed === false, 'capacity_seal_prior_failure_invalid');
  }
  return validateCapacitySafetyReports({ report, fixture, tests: values['focused-tests.json'], workflow: values['native-workflow.json'],
    retirement: values['native-retirement.json'], allowance: values['allowance.json'] }, ceilings);
}
