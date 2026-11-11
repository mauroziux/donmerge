/**
 * Tests for review-coverage.ts (plan 002-U2).
 *
 * The planner decides which discovered files reach the LLM prompt and
 * produces a manifest that makes every omission visible. The invariants:
 *   - focus scope is explicit and never silently widened
 *   - .donmerge policy excludes are recorded as policy, not as reviewed
 *   - budgets drop whole files with a reason, never mid-hunk
 *   - files without a patch never count as reviewed
 *   - scopeComplete is true ONLY for a full-PR review with nothing pending
 */

import { describe, it, expect } from 'vitest';

import {
  DEFAULT_DIFF_CHAR_BUDGET,
  planReviewFiles,
  buildCoverageManifest,
  coverageReportText,
  type DiscoveredFile,
} from '../review-coverage';

function file(name: string, patchChars = 100): DiscoveredFile {
  return { filename: name, patch: '@@ -1,1 +1,1 @@\n' + 'x'.repeat(patchChars) };
}

const NO_EXCLUDE = () => false;
const BIG_BUDGET = { maxFiles: 50, diffCharBudget: DEFAULT_DIFF_CHAR_BUDGET };

describe('planReviewFiles', () => {
  it('selects all eligible files and marks them reviewed', () => {
    const plan = planReviewFiles({
      discovered: [file('a.ts'), file('src/b.ts')],
      isExcluded: NO_EXCLUDE,
      ...BIG_BUDGET,
    });

    expect(plan.selected.map((f) => f.filename)).toEqual(['a.ts', 'src/b.ts']);
    expect(plan.entries.every((e) => e.status === 'reviewed')).toBe(true);
    expect(plan.focused).toBe(false);
    expect(plan.diffTruncated).toBe(false);
  });

  it('applies focus before the file budget: a focused file beyond maxFiles is still selected', () => {
    const discovered = Array.from({ length: 60 }, (_, i) => file(`f${i}.ts`));
    discovered[55] = file('critical/late-file.ts');

    const plan = planReviewFiles({
      discovered,
      focusFiles: ['critical/late-file.ts'],
      isExcluded: NO_EXCLUDE,
      maxFiles: 10,
      diffCharBudget: DEFAULT_DIFF_CHAR_BUDGET,
    });

    expect(plan.selected.map((f) => f.filename)).toEqual(['critical/late-file.ts']);
    expect(plan.focused).toBe(true);
    expect(plan.entries.find((e) => e.path === 'critical/late-file.ts')?.status).toBe('reviewed');
    // Everything else is focused-out — including files that would normally
    // have competed for the maxFiles budget.
    expect(plan.entries.filter((e) => e.status === 'focused-out')).toHaveLength(59);
  });

  it('focus that matches nothing selects nothing and flags focusNoMatch (no silent full review)', () => {
    const plan = planReviewFiles({
      discovered: [file('a.ts'), file('b.ts')],
      focusFiles: ['does/not/exist.rs'],
      isExcluded: NO_EXCLUDE,
      ...BIG_BUDGET,
    });

    expect(plan.selected).toEqual([]);
    expect(plan.focusNoMatch).toBe(true);
    expect(plan.entries.every((e) => e.status === 'focused-out')).toBe(true);
  });

  it('records policy excludes as excluded-policy, not reviewed', () => {
    const plan = planReviewFiles({
      discovered: [file('src/keep.ts'), file('docs/generated.md'), file('src/also-keep.ts')],
      isExcluded: (p) => p.startsWith('docs/'),
      ...BIG_BUDGET,
    });

    expect(plan.selected.map((f) => f.filename)).toEqual(['src/keep.ts', 'src/also-keep.ts']);
    expect(plan.entries.find((e) => e.path === 'docs/generated.md')?.status).toBe('excluded-policy');
  });

  it('maxFiles budget drops whole files with a pending-budget reason', () => {
    const discovered = Array.from({ length: 12 }, (_, i) => file(`f${i}.ts`));

    const plan = planReviewFiles({
      discovered,
      isExcluded: NO_EXCLUDE,
      maxFiles: 5,
      diffCharBudget: DEFAULT_DIFF_CHAR_BUDGET,
    });

    expect(plan.selected).toHaveLength(5);
    expect(plan.entries.filter((e) => e.status === 'pending-budget')).toHaveLength(7);
    expect(plan.entries.find((e) => e.path === 'f5.ts')?.reason).toContain('max file budget');
  });

  it('diff character budget drops whole files and flags diffTruncated', () => {
    // Two files that each fit, but not together.
    const a = file('a-big.ts', 400);
    const b = file('b-big.ts', 400);

    const plan = planReviewFiles({
      discovered: [a, b],
      isExcluded: NO_EXCLUDE,
      maxFiles: 50,
      diffCharBudget: 500,
    });

    expect(plan.selected.map((f) => f.filename)).toEqual(['a-big.ts']);
    expect(plan.diffTruncated).toBe(true);
    expect(plan.entries.find((e) => e.path === 'b-big.ts')?.reason).toContain('diff character budget');
  });

  it('never selects mid-hunk: a file that does not fit whole stays out entirely', () => {
    const plan = planReviewFiles({
      discovered: [file('huge.ts', 10_000)],
      isExcluded: NO_EXCLUDE,
      maxFiles: 50,
      diffCharBudget: 500,
    });

    expect(plan.selected).toEqual([]);
    expect(plan.entries[0].status).toBe('pending-budget');
    expect(plan.diffTruncated).toBe(true);
  });

  it('files without a patch never consume budget and are recorded as no-patch', () => {
    const plan = planReviewFiles({
      discovered: [
        { filename: 'binary.png' }, // no patch
        file('text.ts'),
      ],
      isExcluded: NO_EXCLUDE,
      maxFiles: 1,
      diffCharBudget: DEFAULT_DIFF_CHAR_BUDGET,
    });

    // binary.png did not burn the single-file budget: text.ts still got it.
    expect(plan.selected.map((f) => f.filename)).toEqual(['text.ts']);
    expect(plan.entries.find((e) => e.path === 'binary.png')?.status).toBe('no-patch');
  });
});

describe('buildCoverageManifest', () => {
  const baseCtx = { headSha: 'abc123', changedFilesCount: 3, apiFileCapReached: false };

  it('scopeComplete=true only for a full review with nothing pending', () => {
    const plan = planReviewFiles({
      discovered: [file('a.ts'), file('b.ts'), file('c.ts')],
      isExcluded: NO_EXCLUDE,
      ...BIG_BUDGET,
    });
    const manifest = buildCoverageManifest(plan, baseCtx);

    expect(manifest.scopeComplete).toBe(true);
    expect(manifest.reviewedCount).toBe(3);
    expect(manifest.pendingCount).toBe(0);
  });

  it('scopeComplete=false when files were left out by budget', () => {
    const plan = planReviewFiles({
      discovered: Array.from({ length: 10 }, (_, i) => file(`f${i}.ts`)),
      isExcluded: NO_EXCLUDE,
      maxFiles: 5,
      diffCharBudget: DEFAULT_DIFF_CHAR_BUDGET,
    });
    const manifest = buildCoverageManifest(plan, { ...baseCtx, changedFilesCount: 10 });

    expect(manifest.scopeComplete).toBe(false);
    expect(manifest.pendingCount).toBe(5);
  });

  it('scopeComplete=false for focused reviews even when the focus is fully covered', () => {
    const plan = planReviewFiles({
      discovered: [file('a.ts'), file('b.ts')],
      focusFiles: ['a.ts'],
      isExcluded: NO_EXCLUDE,
      ...BIG_BUDGET,
    });
    const manifest = buildCoverageManifest(plan, baseCtx);

    expect(manifest.focused).toBe(true);
    expect(manifest.reviewedCount).toBe(1);
    expect(manifest.scopeComplete).toBe(false);
  });

  it('scopeComplete=false when discovery missed declared files or hit the API cap', () => {
    const shortDiscovery = planReviewFiles({
      discovered: [file('a.ts')],
      isExcluded: NO_EXCLUDE,
      ...BIG_BUDGET,
    });
    expect(
      buildCoverageManifest(shortDiscovery, { ...baseCtx, changedFilesCount: 3 }).scopeComplete
    ).toBe(false);

    const capped = planReviewFiles({
      discovered: [file('a.ts')],
      isExcluded: NO_EXCLUDE,
      ...BIG_BUDGET,
    });
    expect(
      buildCoverageManifest(capped, { ...baseCtx, changedFilesCount: 1, apiFileCapReached: true })
        .scopeComplete
    ).toBe(false);
  });

  it('policy excludes do not break completeness', () => {
    const plan = planReviewFiles({
      discovered: [file('a.ts'), file('dist/bundle.js')],
      isExcluded: (p) => p.startsWith('dist/'),
      ...BIG_BUDGET,
    });
    const manifest = buildCoverageManifest(plan, { ...baseCtx, changedFilesCount: 2 });

    expect(manifest.scopeComplete).toBe(true);
    expect(manifest.excludedPolicyCount).toBe(1);
  });
});

describe('coverageReportText', () => {
  it('reports full coverage compactly', () => {
    const plan = planReviewFiles({
      discovered: [file('a.ts')],
      isExcluded: NO_EXCLUDE,
      ...BIG_BUDGET,
    });
    const text = coverageReportText(buildCoverageManifest(plan, {
      headSha: 'a',
      changedFilesCount: 1,
      apiFileCapReached: false,
    }));

    expect(text).toContain('Coverage: full');
  });

  it('lists pending files and warns the verdict is scope-limited', () => {
    const plan = planReviewFiles({
      discovered: Array.from({ length: 4 }, (_, i) => file(`f${i}.ts`)),
      isExcluded: NO_EXCLUDE,
      maxFiles: 2,
      diffCharBudget: DEFAULT_DIFF_CHAR_BUDGET,
    });
    const text = coverageReportText(buildCoverageManifest(plan, {
      headSha: 'a',
      changedFilesCount: 4,
      apiFileCapReached: false,
    }));

    expect(text).toContain('Coverage: partial');
    expect(text).toContain('`f2.ts`');
    expect(text).toContain('does not certify the rest of the PR');
  });

  it('focus without matches says nothing was reviewed', () => {
    const plan = planReviewFiles({
      discovered: [file('a.ts')],
      focusFiles: ['nope.rs'],
      isExcluded: NO_EXCLUDE,
      ...BIG_BUDGET,
    });
    const text = coverageReportText(buildCoverageManifest(plan, {
      headSha: 'a',
      changedFilesCount: 1,
      apiFileCapReached: false,
    }));

    expect(text).toContain('matched none of the changed files');
    expect(text).toContain('nothing was reviewed');
  });
});
