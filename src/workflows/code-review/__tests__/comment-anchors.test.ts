/**
 * Tests for comment-anchors.ts — anchor validation for review inline comments.
 */

import { describe, it, expect } from 'vitest';
import {
  commentableLinesForFile,
  buildCommentableMap,
  validateInlineComments,
} from '../comment-anchors';
import type { ReviewComment, FilePatch } from '../types';

// A small, representative patch: one hunk with a removal, an addition, and context.
// @@ -10,3 +10,4 @@ → old starts at 10, new starts at 10
//   line 10 context (both)
// - line 11 old only (LEFT)
// + line 11 new (RIGHT)
// + line 12 new (RIGHT)
const SAMPLE_PATCH = `@@ -10,3 +10,4 @@
 context-line
-removed-line
+added-line-one
+added-line-two`;

describe('commentableLinesForFile', () => {
  it('returns empty sets for undefined patch', () => {
    const result = commentableLinesForFile(undefined);
    expect(result.RIGHT.size).toBe(0);
    expect(result.LEFT.size).toBe(0);
  });

  it('returns empty sets for empty string patch', () => {
    const result = commentableLinesForFile('');
    expect(result.RIGHT.size).toBe(0);
    expect(result.LEFT.size).toBe(0);
  });

  it('classifies added lines as RIGHT anchors', () => {
    const result = commentableLinesForFile(SAMPLE_PATCH);
    // added lines are new lines 11 and 12
    expect(result.RIGHT.has(11)).toBe(true);
    expect(result.RIGHT.has(12)).toBe(true);
  });

  it('classifies removed lines as LEFT anchors', () => {
    const result = commentableLinesForFile(SAMPLE_PATCH);
    // removed line is old line 11
    expect(result.LEFT.has(11)).toBe(true);
  });

  it('classifies context lines as anchors on both sides', () => {
    const result = commentableLinesForFile(SAMPLE_PATCH);
    // context line: old 10 / new 10
    expect(result.RIGHT.has(10)).toBe(true);
    expect(result.LEFT.has(10)).toBe(true);
  });

  it('does not anchor on the no-newline marker', () => {
    const patch = `@@ -1,2 +1,2 @@
 kept
\\ No newline at end of file
+replacement`;
    const result = commentableLinesForFile(patch);
    // the '\' line should not advance counters incorrectly; new line 1 (kept) + new line 2 (replacement)
    expect(result.RIGHT.has(1)).toBe(true);
    expect(result.RIGHT.has(2)).toBe(true);
  });

  it('handles multiple hunks', () => {
    const patch = `@@ -5,2 +5,2 @@
 a
-b
+c
@@ -20,2 +20,2 @@
 x
-y
+z`;
    const result = commentableLinesForFile(patch);
    expect(result.RIGHT.has(6)).toBe(true); // c at new 6
    expect(result.LEFT.has(6)).toBe(true); // b at old 6
    expect(result.RIGHT.has(21)).toBe(true); // z at new 21
  });
});

describe('buildCommentableMap', () => {
  it('builds a map keyed by filename', () => {
    const files: FilePatch[] = [
      { filename: 'src/a.ts', patch: SAMPLE_PATCH },
      { filename: 'src/b.ts', patch: undefined },
    ];
    const map = buildCommentableMap(files);
    expect(map.has('src/a.ts')).toBe(true);
    expect(map.has('src/b.ts')).toBe(true);
    expect(map.get('src/a.ts')!.RIGHT.size).toBeGreaterThan(0);
  });
});

function makeComment(overrides: Partial<ReviewComment>): ReviewComment {
  return {
    path: 'src/a.ts',
    line: 11,
    side: 'RIGHT',
    body: 'issue',
    severity: 'critical',
    ...overrides,
  };
}

describe('validateInlineComments', () => {
  it('keeps a comment anchored to an added line on the RIGHT', () => {
    const map = buildCommentableMap([{ filename: 'src/a.ts', patch: SAMPLE_PATCH }]);
    const result = validateInlineComments([makeComment({ line: 11, side: 'RIGHT' })], map);
    expect(result.valid).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
  });

  it('keeps a comment anchored to a context line on either side', () => {
    const map = buildCommentableMap([{ filename: 'src/a.ts', patch: SAMPLE_PATCH }]);
    const right = validateInlineComments([makeComment({ line: 10, side: 'RIGHT' })], map);
    expect(right.valid).toHaveLength(1);
    const left = validateInlineComments([makeComment({ line: 10, side: 'LEFT' })], map);
    expect(left.valid).toHaveLength(1);
  });

  it('drops a comment whose line is not inside a hunk', () => {
    const map = buildCommentableMap([{ filename: 'src/a.ts', patch: SAMPLE_PATCH }]);
    const result = validateInlineComments([makeComment({ line: 999, side: 'RIGHT' })], map);
    expect(result.valid).toHaveLength(0);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].reason).toContain('not inside a diff hunk');
  });

  it('drops a comment on a removed line when side is RIGHT', () => {
    const map = buildCommentableMap([{ filename: 'src/a.ts', patch: SAMPLE_PATCH }]);
    // old line 11 is removed (-), so it is a LEFT anchor, not RIGHT
    const result = validateInlineComments([makeComment({ line: 11, side: 'RIGHT' })], map);
    // wait: new line 11 IS added (+added-line-one), so RIGHT 11 is valid.
    // use a line that only exists on LEFT: old 11 removed → but new 11 also exists.
    // To test the RIGHT-invalid case, target old line that has no new counterpart:
    // in this patch every removed line collides with an added line number.
    // Construct a patch where removal and addition counts differ.
    const asymmetric = `@@ -10,3 +10,2 @@
 ctx
-old-only
-also-old
+one-add`;
    const mapA = buildCommentableMap([{ filename: 'x', patch: asymmetric }]);
    // old 11,12 removed; new 11 added. old 12 has no new counterpart.
    const r = validateInlineComments(
      [makeComment({ path: 'x', line: 12, side: 'RIGHT' })],
      mapA
    );
    expect(r.valid).toHaveLength(0);
    expect(r.dropped[0].reason).toContain('not inside a diff hunk');
    // but LEFT 12 is valid (removed line)
    const r2 = validateInlineComments(
      [makeComment({ path: 'x', line: 12, side: 'LEFT' })],
      mapA
    );
    expect(r2.valid).toHaveLength(1);
    // and the original assertion: RIGHT 11 on SAMPLE_PATCH is valid
    expect(result.valid).toHaveLength(1);
  });

  it('drops a comment on a file not present in the diff', () => {
    const map = buildCommentableMap([{ filename: 'src/a.ts', patch: SAMPLE_PATCH }]);
    const result = validateInlineComments(
      [makeComment({ path: 'src/missing.ts', line: 1, side: 'RIGHT' })],
      map
    );
    expect(result.valid).toHaveLength(0);
    expect(result.dropped[0].reason).toBe('file not in PR diff');
  });

  it('drops a comment on a file with no textual patch (binary/rename)', () => {
    const map = buildCommentableMap([{ filename: 'src/binary.png', patch: undefined }]);
    const result = validateInlineComments(
      [makeComment({ path: 'src/binary.png', line: 1, side: 'RIGHT' })],
      map
    );
    expect(result.valid).toHaveLength(0);
    expect(result.dropped[0].reason).toContain('no textual diff');
  });

  it('keeps valid comments while dropping invalid ones in the same batch', () => {
    const map = buildCommentableMap([{ filename: 'src/a.ts', patch: SAMPLE_PATCH }]);
    const result = validateInlineComments(
      [
        makeComment({ line: 11, side: 'RIGHT' }), // valid
        makeComment({ line: 999, side: 'RIGHT' }), // invalid
        makeComment({ path: 'other.ts', line: 1, side: 'RIGHT' }), // invalid (file missing)
      ],
      map
    );
    expect(result.valid).toHaveLength(1);
    expect(result.dropped).toHaveLength(2);
  });

  it('never throws on a malformed comment', () => {
    const map = buildCommentableMap([{ filename: 'src/a.ts', patch: SAMPLE_PATCH }]);
    expect(() =>
      validateInlineComments(
        [makeComment({ line: 0 as unknown as number, side: 'RIGHT' })],
        map
      )
    ).not.toThrow();
  });
});
