/**
 * Tests for finding-verifier.ts (plan 003-U3).
 *
 * Invariants:
 *   - only `supported` criticals survive into the published result
 *   - refuted/undecidable findings are withheld AND reported, never silently dropped
 *   - verifier infrastructure failures fail closed for publishing (withheld)
 *     but stay honest (note explains the failure)
 *   - the second pass merge only ever ADDS findings
 */

import { describe, it, expect, vi } from 'vitest';

import type { ReviewComment, ReviewResult } from '../types';
import {
  buildVerificationPrompt,
  mergeSecondPass,
  parseVerifierResponse,
  verifyReviewResult,
} from '../finding-verifier';
import type { ModelConfig } from '../../../lib/llm-providers';
import { hasBlockingFindings } from '../processor-utils';
import { checkConclusion } from '../review-coverage';

const MODEL: ModelConfig = { providerID: 'kimi', modelID: 'k3' };
const PATCHES = [
  { filename: 'src/api/bookings.ts', patch: '@@ -42 +42 @@\n-oldBooking()\n+createBooking()' },
  { filename: 'src/other.ts', patch: '@@ -9 +9 @@\n-oldOther()\n+newOther()' },
];

function critical(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    path: 'src/api/bookings.ts',
    line: 42,
    side: 'RIGHT',
    severity: 'critical',
    issueKey: 'missing-idempotency-key',
    ruleId: 'idempotency-missing',
    body: '🔴 **Issue:** Missing idempotency key causes duplicate bookings when the webhook retries.',
    ...overrides,
  };
}

function suggestion(): ReviewComment {
  return critical({ severity: 'suggestion', issueKey: 'minor-note', line: 7 });
}

function review(comments: ReviewComment[]): ReviewResult {
  return {
    approved: comments.length === 0,
    summary: 'Base summary.',
    prSummary: {
      overview: 'o',
      keyChanges: ['k'],
      codeQuality: 'q',
      testingNotes: 't',
      riskAssessment: 'r',
    },
    lineComments: comments,
    criticalIssues: comments.filter((c) => c.severity === 'critical').map((c) => c.body.slice(0, 40)),
    suggestions: [],
  };
}

const verifierSupported = JSON.stringify({
  verdict: 'supported',
  explanation: 'The retry path reaches createBooking twice; no guard exists.',
});
const verifierRefuted = JSON.stringify({
  verdict: 'refuted',
  explanation: 'A unique index on idempotency_key rejects the second insert.',
});

describe('parseVerifierResponse', () => {
  it('parses all three verdicts', () => {
    expect(parseVerifierResponse(verifierSupported)?.verdict).toBe('supported');
    expect(parseVerifierResponse(verifierRefuted)?.verdict).toBe('refuted');
    expect(
      parseVerifierResponse('{"verdict": "insufficient_evidence", "explanation": "callers not shown"}')?.verdict
    ).toBe('insufficient_evidence');
  });

  it('extracts JSON from fenced/markdown-wrapped responses', () => {
    expect(parseVerifierResponse('```json\n' + verifierRefuted + '\n```')?.verdict).toBe('refuted');
  });

  it('rejects unknown verdicts, empty explanations and garbage', () => {
    expect(parseVerifierResponse('{"verdict": "maybe", "explanation": "x"}')).toBeNull();
    expect(parseVerifierResponse('{"verdict": "supported", "explanation": ""}')).toBeNull();
    expect(parseVerifierResponse('not json at all')).toBeNull();
  });
});

describe('buildVerificationPrompt', () => {
  it('frames the task as refutation and carries the candidate + evidence', () => {
    const prompt = buildVerificationPrompt({
      repo: 'acme/rms',
      candidate: critical(),
      diffExcerpt: 'FILE: src/api/bookings.ts\n+await createBooking(payload);',
    });

    expect(prompt).toContain('try to REFUTE');
    expect(prompt).toContain('acme/rms');
    expect(prompt).toContain('src/api/bookings.ts');
    expect(prompt).toContain('Missing idempotency key');
    expect(prompt).toContain('<diff>');
    expect(prompt).toContain('insufficient_evidence');
  });
});

describe('verifyReviewResult', () => {
  it('places a late candidate hunk first even when earlier files exceed the context budget', async () => {
    const promptFn = vi.fn(async (_prompt: string) => verifierSupported);
    const filePatches = [
      { filename: 'src/large.ts', patch: `@@ -0,0 +1 @@\n+${'x'.repeat(21_000)}` },
      ...PATCHES,
    ];
    const output = await verifyReviewResult({ promptFn, model: MODEL, repo: 'acme/rms', filePatches, result: review([critical()]) });
    expect(output.result.lineComments).toHaveLength(1);
    const prompt = promptFn.mock.calls[0][0];
    expect(prompt).toContain('FILE: src/api/bookings.ts\n@@ -42 +42 @@\n-oldBooking()\n+createBooking()');
    expect(prompt).not.toContain('x'.repeat(21_000));
  });

  it('finds the candidate hunk after an oversized earlier hunk in the same file', async () => {
    const promptFn = vi.fn(async (_prompt: string) => verifierSupported);
    const filePatches = [{ filename: 'src/api/bookings.ts', patch:
      `@@ -1 +1 @@\n-old\n+${'x'.repeat(21_000)}\n@@ -42 +42 @@\n-oldBooking()\n+createBooking()` }];
    await verifyReviewResult({ promptFn, model: MODEL, repo: 'acme/rms', filePatches, result: review([critical()]) });
    expect(promptFn).toHaveBeenCalledTimes(1);
    expect(promptFn.mock.calls[0][0]).toContain('@@ -42 +42 @@\n-oldBooking()\n+createBooking()');
  });

  it.each([
    ['missing file', [{ filename: 'other.ts', patch: '@@ -42 +42 @@\n-old\n+new' }]],
    ['missing patch', [{ filename: 'src/api/bookings.ts' }]],
    ['wrong side', [{ filename: 'src/api/bookings.ts', patch: '@@ -42 +42,0 @@\n-removed' }]],
    ['truncated hunk', [{ filename: 'src/api/bookings.ts', patch: '@@ -42,2 +42,2 @@\n-old\n+new' }]],
    ['oversized candidate hunk', [{ filename: 'src/api/bookings.ts', patch: `@@ -42 +42 @@\n-old\n+${'x'.repeat(21_000)}` }]],
  ])('keeps the review neutral for %s instead of asking the model to guess', async (_label, filePatches) => {
    const promptFn = vi.fn(async () => verifierRefuted);
    const output = await verifyReviewResult({
      promptFn, model: MODEL, repo: 'acme/rms', filePatches,
      result: { ...review([critical()]), criticalIssues: [] },
    });
    expect(promptFn).not.toHaveBeenCalled();
    expect(output.result.verificationPending).toBe(true);
    expect(output.notes[0]).toContain('insufficient_evidence');
    expect(checkConclusion(hasBlockingFindings(output.result), undefined, output.result.verificationPending)).toBe('neutral');
  });

  it('verifies removed lines on the LEFT side of a complete hunk', async () => {
    const promptFn = vi.fn(async () => verifierSupported);
    const output = await verifyReviewResult({
      promptFn, model: MODEL, repo: 'acme/rms', filePatches: PATCHES,
      result: review([critical({ side: 'LEFT' })]),
    });
    expect(promptFn).toHaveBeenCalledTimes(1);
    expect(output.result.lineComments).toHaveLength(1);
  });

  it('keeps supported criticals untouched and passes suggestions through unverified', async () => {
    const promptFn = vi.fn(async () => verifierSupported);
    const input = review([critical(), suggestion()]);

    const output = await verifyReviewResult({ promptFn, model: MODEL, repo: 'acme/rms', filePatches: PATCHES, result: input });

    expect(promptFn).toHaveBeenCalledTimes(1); // only the critical was verified
    expect(output.result.lineComments).toHaveLength(2);
    expect(output.notes).toEqual([]);
  });

  it('withholds refuted criticals and reports them in the summary', async () => {
    const promptFn = vi.fn(async () => verifierRefuted);

    const output = await verifyReviewResult({
      promptFn,
      model: MODEL,
      repo: 'acme/rms',
      filePatches: PATCHES,
      result: { ...review([critical()]), criticalIssues: [] },
    });

    expect(output.result.lineComments).toHaveLength(0);
    expect(output.result.criticalIssues).toHaveLength(0);
    expect(output.notes).toHaveLength(1);
    expect(output.notes[0]).toContain('refuted');
    expect(output.notes[0]).toContain('src/api/bookings.ts:42');
    expect(output.result.summary).toContain('Withheld');
    // A refuted claim is wrong, not pending: no verificationPending flag
    expect(output.result.verificationPending).toBeUndefined();
  });

  it('keeps the check neutral when a refuted inline finding has an unrelated critical summary', async () => {
    const input = {
      ...review([critical()]),
      criticalIssues: ['A separate SQL injection permits an attacker to read another tenant’s data.'],
    };
    const output = await verifyReviewResult({
      promptFn: vi.fn(async () => verifierRefuted), model: MODEL, repo: 'acme/rms', filePatches: PATCHES, result: input,
    });
    expect(output.result.lineComments).toEqual([]);
    expect(output.result.verificationPending).toBe(true);
    expect(output.result.summary).toContain('A separate SQL injection');
    expect(checkConclusion(hasBlockingFindings(output.result), undefined, output.result.verificationPending)).toBe('neutral');
  });

  it('treats a possibly duplicate summary as unresolved without a stable finding ID', async () => {
    const output = await verifyReviewResult({
      promptFn: vi.fn(async () => verifierRefuted), model: MODEL, repo: 'acme/rms', filePatches: PATCHES,
      result: review([critical()]),
    });
    expect(output.result.lineComments).toEqual([]);
    expect(output.result.verificationPending).toBe(true);
    expect(checkConclusion(hasBlockingFindings(output.result), undefined, output.result.verificationPending)).toBe('neutral');
  });

  it('preserves an earlier pending-verification state when a later claim is refuted', async () => {
    const input = { ...review([critical()]), criticalIssues: [], verificationPending: true };
    const output = await verifyReviewResult({
      promptFn: vi.fn(async () => verifierRefuted), model: MODEL, repo: 'acme/rms', filePatches: PATCHES, result: input,
    });
    expect(output.result.verificationPending).toBe(true);
  });

  it('verifier infrastructure failure withholds the finding (never publishes unverified)', async () => {
    const promptFn = vi.fn(async () => {
      throw new Error('gateway exploded');
    });

    const output = await verifyReviewResult({
      promptFn,
      model: MODEL,
      repo: 'acme/rms',
      filePatches: PATCHES,
      result: review([critical()]),
    });

    expect(output.result.lineComments).toHaveLength(0);
    expect(output.notes[0]).toContain('insufficient_evidence');
    expect(output.notes[0]).toContain('gateway exploded');
    // Undecidable ≠ clean: the run must not certify the PR as clean
    expect(output.result.verificationPending).toBe(true);
  });

  it('non-contract verifier output counts as insufficient evidence', async () => {
    const promptFn = vi.fn(async () => 'sure, looks fine to me');

    const output = await verifyReviewResult({
      promptFn,
      model: MODEL,
      repo: 'acme/rms',
      filePatches: PATCHES,
      result: review([critical()]),
    });

    expect(output.result.lineComments).toHaveLength(0);
    expect(output.notes[0]).toContain('expected JSON contract');
  });

  it('verifies each critical independently', async () => {
    const responses = [verifierSupported, verifierRefuted];
    const promptFn = vi.fn(async () => responses.shift() ?? verifierSupported);

    const output = await verifyReviewResult({
      promptFn,
      model: MODEL,
      repo: 'acme/rms',
      filePatches: PATCHES,
      result: review([critical(), critical({ path: 'src/other.ts', line: 9, issueKey: 'second' })]),
    });

    expect(promptFn).toHaveBeenCalledTimes(2);
    expect(output.result.lineComments).toHaveLength(1);
    expect(output.result.lineComments[0].issueKey).toBe('missing-idempotency-key');
    expect(output.notes.filter(note => note.includes('refuted'))).toHaveLength(1);
    // criticalIssues rebuilt from the SURVIVING inline findings
    expect(output.result.criticalIssues).toHaveLength(1);
    expect(output.result.criticalIssues[0]).toContain('idempotency');
    expect(output.result.verificationPending).toBe(true);
  });
});

describe('mergeSecondPass', () => {
  it('adds only NEW findings from the second pass', () => {
    const first = review([critical()]);
    const second = review([
      critical(), // duplicate — same issueKey
      critical({ path: 'src/policy.ts', line: 3, issueKey: 'missing-scope-check' }),
    ]);

    const merged = mergeSecondPass(first, second);

    expect(merged.lineComments).toHaveLength(2);
    expect(merged.criticalIssues).toHaveLength(2);
    expect(merged.summary).toContain('second independent pass');
  });

  it('keeps the first verdict when the second pass is clean', () => {
    const first = review([]);
    const merged = mergeSecondPass(first, review([]));

    expect(merged).toBe(first);
  });

  it('retains a withheld critical candidate from the second pass even without new comments', () => {
    const first = review([]);
    const second = { ...review([]), qualityFilterPending: true };
    expect(mergeSecondPass(first, second).qualityFilterPending).toBe(true);
  });

  it('retains a standalone blocking issue from a second pass without inline anchors', () => {
    const first = review([]);
    const second = { ...review([]), criticalIssues: ['Removing the guard allows unbounded SMS abuse.'] };
    const merged = mergeSecondPass(first, second);
    expect(merged.criticalIssues).toContain('Removing the guard allows unbounded SMS abuse.');
  });
});
