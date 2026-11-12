/**
 * Synthetic evaluation corpus (plan 001-U1).
 *
 * Synthetic cases validate PIPELINE MECHANICS offline: the strict contract,
 * the quality gate, defect-identity matching and verdict honesty. They are
 * explicitly NOT a measure of live model capability. Buggy/fixed pairs share
 * a group so both sides land in the same split (no leakage).
 *
 * Domain choices mirror the historical rms usage (idempotency, tenant
 * scoping, DST/timezone, null relations, retry recursion) in TypeScript
 * syntax — language-agnostic mechanics, real failure classes.
 */

import type { EvalCase, HonestyCase } from './corpus';

function output(args: {
  approved: boolean;
  summary: string;
  comments?: Array<Record<string, unknown>>;
  criticalIssues?: string[];
  suggestions?: string[];
}): unknown {
  return {
    approved: args.approved,
    summary: args.summary,
    prSummary: {
      overview: 'Changes the booking webhook handling.',
      keyChanges: ['Webhook processing update'],
      codeQuality: 'Reasonable.',
      testingNotes: 'Some coverage exists.',
      riskAssessment: args.approved ? 'Low.' : 'High.',
    },
    lineComments: args.comments ?? [],
    criticalIssues: args.criticalIssues ?? [],
    suggestions: args.suggestions ?? [],
  };
}

function comment(args: {
  path: string;
  line: number;
  issueKey?: string;
  ruleId?: string;
  severity?: 'critical' | 'suggestion' | 'low';
  body: string;
}): Record<string, unknown> {
  return {
    path: args.path,
    line: args.line,
    side: 'RIGHT',
    severity: args.severity ?? 'critical',
    issueKey: args.issueKey,
    ruleId: args.ruleId ?? args.issueKey,
    entityType: 'function',
    symbolName: 'WebhookHandler.handle',
    codeSnippet: '…',
    body: args.body,
  };
}

const DIFF = 'FILE: src/services/webhook.ts\n@@ -10,7 +10,9 @@\n+export async function handle(payload) {';

export const SYNTHETIC_CORPUS: EvalCase[] = [
  // ── booking idempotency pair ──────────────────────────────────────────────
  {
    id: 'booking-idempotency-buggy',
    name: 'webhook creates duplicate bookings on retry',
    origin: 'synthetic',
    group: 'booking-idempotency',
    split: 'dev',
    diff: DIFF,
    headSha: 'eval-0001',
    changedFilesCount: 1,
    knownDefects: [
      {
        id: 'missing-idempotency-key',
        severity: 'critical',
        file: 'src/services/webhook.ts',
        lineHint: 12,
        description: 'missing idempotency key causes duplicate bookings when the webhook retries',
      },
    ],
    sentinel: true,
    recordedOutput: output({
      approved: false,
      summary: 'The retry path can create duplicate bookings.',
      comments: [
        comment({
          path: 'src/services/webhook.ts',
          line: 12,
          issueKey: 'missing-idempotency-key',
          body:
            '🔴 **Issue:** The handler persists the booking before storing the idempotency key; a lost response and webhook retry causes duplicate bookings. ' +
            '💡 **Suggestion:** Persist the key and the booking in the same transaction.',
        }),
      ],
      criticalIssues: ['Missing idempotency key causes duplicate bookings on retry'],
    }),
  },
  {
    id: 'booking-idempotency-fixed',
    name: 'webhook stores the idempotency key first (fixed pair)',
    origin: 'synthetic',
    group: 'booking-idempotency',
    split: 'dev',
    diff: DIFF,
    headSha: 'eval-0002',
    changedFilesCount: 1,
    knownDefects: [],
    cleanLabel: true,
    recordedOutput: output({ approved: true, summary: 'Clean.' }),
  },

  // ── DST label pair ────────────────────────────────────────────────────────
  {
    id: 'dst-label-buggy',
    name: 'hardcoded CET label wrong during summer',
    origin: 'synthetic',
    group: 'dst-label',
    split: 'dev',
    diff: DIFF,
    headSha: 'eval-0003',
    changedFilesCount: 1,
    knownDefects: [
      {
        id: 'hardcoded-cet-label',
        severity: 'high',
        file: 'src/services/webhook.ts',
        lineHint: 30,
        description: 'timezone label hardcoded to CET is wrong during DST summer time',
      },
    ],
    recordedOutput: output({
      approved: false,
      summary: 'Timezone label mismatch.',
      comments: [
        comment({
          path: 'src/services/webhook.ts',
          line: 30,
          issueKey: 'dst-label-mismatch',
          severity: 'suggestion',
          body:
            '🔴 **Issue:** The label is hardcoded to CET while the logic uses DST-aware Europe/Berlin; during summer the label is wrong and leads to incorrect displayed times. ' +
            '💡 **Suggestion:** Derive the label from the timezone at render time.',
        }),
      ],
    }),
  },
  {
    id: 'dst-label-fixed',
    name: 'label derived from timezone (fixed pair)',
    origin: 'synthetic',
    group: 'dst-label',
    split: 'dev',
    diff: DIFF,
    headSha: 'eval-0004',
    changedFilesCount: 1,
    knownDefects: [],
    cleanLabel: true,
    recordedOutput: output({ approved: true, summary: 'Clean.' }),
  },

  // ── tenant scoping pair (proximity-match path; holdout) ───────────────────
  {
    id: 'tenant-scope-buggy',
    name: 'query misses the restaurant scope',
    origin: 'synthetic',
    group: 'tenant-scope',
    split: 'holdout',
    diff: DIFF,
    headSha: 'eval-0005',
    changedFilesCount: 1,
    knownDefects: [
      {
        id: 'missing-restaurant-scope',
        severity: 'critical',
        file: 'src/services/webhook.ts',
        lineHint: 44,
        description: 'listing query omits restaurant scope and leaks other tenants bookings',
      },
    ],
    sentinel: true,
    // NOTE: issueKey intentionally does NOT share tokens with the defect id —
    // exercises the proximity + term-overlap matching path.
    recordedOutput: output({
      approved: false,
      summary: 'Tenant isolation broken.',
      comments: [
        comment({
          path: 'src/services/webhook.ts',
          line: 46,
          issueKey: 'unscoped-list-query',
          body:
            '🔴 **Issue:** The bookings list query omits the restaurant scope; any tenant receives other tenants bookings, leaking cross-restaurant data. ' +
            '💡 **Suggestion:** Add the restaurant scope to the query builder.',
        }),
      ],
      criticalIssues: ['Missing restaurant scope leaks other tenants bookings'],
    }),
  },
  {
    id: 'tenant-scope-fixed',
    name: 'scope applied (fixed pair)',
    origin: 'synthetic',
    group: 'tenant-scope',
    split: 'holdout',
    diff: DIFF,
    headSha: 'eval-0006',
    changedFilesCount: 1,
    knownDefects: [],
    cleanLabel: true,
    recordedOutput: output({ approved: true, summary: 'Clean.' }),
  },

  // ── null relation + duplicate restatement ────────────────────────────────
  {
    id: 'null-relation-buggy',
    name: 'nullable relation dereferenced (reported twice)',
    origin: 'synthetic',
    group: 'null-relation',
    split: 'dev',
    diff: DIFF,
    headSha: 'eval-0007',
    changedFilesCount: 1,
    knownDefects: [
      {
        id: 'possible-null-relation',
        severity: 'high',
        file: 'src/services/webhook.ts',
        lineHint: 55,
        description: 'nullable relation dereferenced without a check throws a runtime error',
      },
    ],
    recordedOutput: output({
      approved: false,
      summary: 'Null dereference on the relation.',
      comments: [
        comment({
          path: 'src/services/webhook.ts',
          line: 55,
          issueKey: 'possible-null-relation',
          body:
            '🔴 **Issue:** booking.restaurant is nullable but is dereferenced directly; when the relation is absent this throws a runtime error. ' +
            '💡 **Suggestion:** Guard the access.',
        }),
        // Duplicate restatement of the same defect — must count once + one duplicate.
        comment({
          path: 'src/services/webhook.ts',
          line: 57,
          issueKey: 'possible-null-relation-restated',
          body:
            '🔴 **Issue:** The same nullable relation dereference throws a runtime error when missing. 💡 **Suggestion:** Optional-chain it.',
        }),
      ],
    }),
  },

  // ── clean-hard: equivalent refactor ───────────────────────────────────────
  {
    id: 'clean-refactor-equivalent',
    name: 'pure refactor, no behavioral change',
    origin: 'synthetic',
    group: 'clean-hard',
    split: 'dev',
    diff: DIFF,
    headSha: 'eval-0008',
    changedFilesCount: 1,
    knownDefects: [],
    cleanLabel: true,
    recordedOutput: output({ approved: true, summary: 'Clean refactor.' }),
  },

  // ── clean-hard: advisory bait must be dropped by the quality gate ─────────
  {
    id: 'clean-advisory-bait',
    name: 'advisory-only suggestion filtered before verdict',
    origin: 'synthetic',
    group: 'clean-hard',
    split: 'dev',
    diff: DIFF,
    headSha: 'eval-0009',
    changedFilesCount: 1,
    knownDefects: [],
    cleanLabel: true,
    recordedOutput: output({
      approved: true,
      summary: 'Nothing blocking.',
      comments: [
        comment({
          path: 'src/services/webhook.ts',
          line: 20,
          issueKey: 'consider-index',
          severity: 'suggestion',
          body: '🟡 **Suggestion:** Consider adding an index on this table to speed up lookups.',
        }),
      ],
      suggestions: ['Consider adding an index on this table'],
    }),
  },

  // ── retry recursion (sentinel) ────────────────────────────────────────────
  {
    id: 'retry-recursion-buggy',
    name: 'unbounded retry recursion on 401',
    origin: 'synthetic',
    group: 'retry-recursion',
    split: 'dev',
    diff: DIFF,
    headSha: 'eval-0010',
    changedFilesCount: 1,
    knownDefects: [
      {
        id: 'unbounded-retry-recursion',
        severity: 'critical',
        file: 'src/services/webhook.ts',
        lineHint: 88,
        description: 'renewing auth inside the call recurses without a bound and hangs the worker',
      },
    ],
    sentinel: true,
    recordedOutput: output({
      approved: false,
      summary: 'Unbounded recursion on auth renewal.',
      comments: [
        comment({
          path: 'src/services/webhook.ts',
          line: 88,
          issueKey: 'unbounded-retry-recursion',
          body:
            '🔴 **Issue:** Renewing credentials inside the request helper recurses without a bound; a persistent 401 causes unbounded recursion that exhausts the stack and hangs the worker. ' +
            '💡 **Suggestion:** Retry with a bounded counter and fail after N attempts.',
        }),
      ],
      criticalIssues: ['Unbounded retry recursion on persistent 401 hangs the worker'],
    }),
  },
];

function bigPatch(name: string): { filename: string; patch: string } {
  // ~42KB per file: one fits the 50K diff budget, two do not.
  return {
    filename: name,
    patch: `@@ -1,900 +1,900 @@\n${'+const data = 1;\n'.repeat(2_600)}`,
  };
}

export const HONESTY_CASES: HonestyCase[] = [
  {
    id: 'full-clean',
    description: 'complete scope, no blocking findings → success',
    discovered: [
      { filename: 'a.ts', patch: '@@ -1 +1 @@\n+x' },
      { filename: 'b.ts', patch: '@@ -1 +1 @@\n+y' },
    ],
    changedFilesCount: 2,
    apiFileCapReached: false,
    hasBlocking: false,
  },
  {
    id: 'budget-truncated',
    description: 'diff budget drops a file → neutral, never a green clean',
    discovered: [bigPatch('big1.ts'), bigPatch('big2.ts')],
    changedFilesCount: 2,
    apiFileCapReached: false,
    hasBlocking: false,
  },
  {
    id: 'focused-subset',
    description: 'focus review of one file → neutral',
    discovered: [
      { filename: 'a.ts', patch: '@@ -1 +1 @@\n+x' },
      { filename: 'b.ts', patch: '@@ -1 +1 @@\n+y' },
    ],
    changedFilesCount: 2,
    apiFileCapReached: false,
    focusFiles: ['a.ts'],
    hasBlocking: false,
  },
  {
    id: 'no-patch-file',
    description: 'binary/no-patch file present → neutral',
    discovered: [{ filename: 'logo.png' }, { filename: 'a.ts', patch: '@@ -1 +1 @@\n+x' }],
    changedFilesCount: 2,
    apiFileCapReached: false,
    hasBlocking: false,
  },
  {
    id: 'api-cap',
    description: 'GitHub file cap reached → neutral',
    discovered: [{ filename: 'a.ts', patch: '@@ -1 +1 @@\n+x' }],
    changedFilesCount: 3_500,
    apiFileCapReached: true,
    hasBlocking: false,
  },
  {
    id: 'blocking-partial',
    description: 'blocking finding on a partial scope → failure regardless',
    discovered: [bigPatch('big1.ts'), bigPatch('big2.ts')],
    changedFilesCount: 2,
    apiFileCapReached: false,
    hasBlocking: true,
  },
];
