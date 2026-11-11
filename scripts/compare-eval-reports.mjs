#!/usr/bin/env node
/**
 * Compare two offline evaluation reports (plan 001-U4).
 *
 *   node scripts/compare-eval-reports.mjs --baseline base.json --candidate cand.json
 *
 * Exits non-zero when the candidate regresses against the baseline:
 *   - any sentinel critical defect lost
 *   - any false-clean verdict
 *   - lower precision / recall / criticalRecall / cleanFalseAlarmRate (worse)
 *
 * Reports are produced by `EVAL_REPORT_DIR=<dir> npm run eval:review`.
 * Synthetic-only reports are regression evidence, never live-model proof.
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    baseline: { type: 'string' },
    candidate: { type: 'string' },
  },
});

if (!values.baseline || !values.candidate) {
  console.error('usage: compare-eval-reports.mjs --baseline <report.json> --candidate <report.json>');
  process.exit(2);
}

function load(path) {
  const report = JSON.parse(readFileSync(path, 'utf8'));
  for (const field of ['detection', 'honesty', 'sentinelsLost']) {
    if (!(field in report)) {
      console.error(`FAIL: ${path} is not an evaluation report (missing ${field})`);
      process.exit(2);
    }
  }
  return report;
}

const baseline = load(values.baseline);
const candidate = load(values.candidate);

const failures = [];

if (candidate.sentinelsLost.length > 0) {
  failures.push(`sentinel defects lost: ${candidate.sentinelsLost.join(', ')}`);
}
if (candidate.honesty.falseCleanVerdicts > 0) {
  failures.push(`false-clean verdicts: ${candidate.honesty.falseCleanVerdicts}`);
}

const metrics = [
  ['detection.precision', baseline.detection.precision, candidate.detection.precision, (b, c) => c < b],
  ['detection.recall', baseline.detection.recall, candidate.detection.recall, (b, c) => c < b],
  [
    'detection.criticalRecall',
    baseline.detection.criticalRecall,
    candidate.detection.criticalRecall,
    (b, c) => c < b,
  ],
  [
    'detection.cleanFalseAlarmRate',
    baseline.detection.cleanFalseAlarmRate,
    candidate.detection.cleanFalseAlarmRate,
    (b, c) => c > b,
  ],
];

for (const [name, baseValue, candValue, regressed] of metrics) {
  const line = `${name}: baseline=${baseValue.toFixed(3)} candidate=${candValue.toFixed(3)}`;
  if (regressed(baseValue, candValue)) {
    failures.push(`REGRESSION ${line}`);
  } else {
    console.log(`ok      ${line}`);
  }
}

if (failures.length > 0) {
  console.error('\nFAIL: evaluation regressed against baseline');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('\nPASS: candidate does not regress against baseline');
