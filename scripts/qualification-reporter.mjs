import { writeFile } from 'node:fs/promises';

// A host reporter keeps measurements out of worker console forwarding. Task
// metadata uses Vitest's public API and is saved even when a later check fails.
export default class QualificationReporter {
  measurements = [];

  onTestCaseResult(testCase) {
    const measurement = testCase.meta().qualification;
    if (measurement) this.measurements.push({ ...measurement, test: testCase.fullName, result: testCase.result().state });
  }

  async onTestRunEnd() {
    const path = process.env.CHESS_QUALIFICATION_REPORT;
    if (!path) throw new Error('CHESS_QUALIFICATION_REPORT is required for the qualification reporter.');
    await writeFile(path, JSON.stringify(this.measurements, null, 2) + '\n');
  }
}
