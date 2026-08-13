/**
 * Comment anchor validation for review inline comments.
 *
 * GitHub only accepts inline review comments on lines that sit inside a diff
 * hunk: added/context lines on the RIGHT side, removed/context lines on the
 * LEFT side. A comment anchored anywhere else makes the whole
 * `POST /pulls/{n}/reviews` fail with 422, sinking the entire review along
 * with every other valid comment.
 *
 * This module pre-validates comments against the PR's file patches and drops
 * the invalid ones before the POST, so a single bad anchor can never sink a
 * review. Adapted from pullfrog's `validateInlineComments` (mcp/review.ts),
 * rewritten in DonMerge's plain-TS idiom (no arktype).
 */

import type { ReviewComment, DroppedComment, FilePatch } from './types';

/** Lines on each diff side that are valid anchors for inline comments. */
export interface CommentableLines {
  RIGHT: Set<number>;
  LEFT: Set<number>;
}

const EMPTY_LINES: CommentableLines = { RIGHT: new Set(), LEFT: new Set() };

/**
 * Parse a PR file's unified-diff patch to determine which line numbers on each
 * side are valid anchors. Walks `@@ -old,count +new,count @@` hunks tracking
 * both old and new line numbers:
 *   - `+` lines advance the new (RIGHT) counter and are anchorable on RIGHT
 *   - `-` lines advance the old (LEFT) counter and are anchorable on LEFT
 *   - context (` `) lines advance both and are anchorable on both sides
 *   - `\` (no-newline marker) and anything else are skipped without advancing
 *
 * Returns empty sets when the patch is missing (binary, pure rename, mode-only).
 */
export function commentableLinesForFile(patch: string | undefined): CommentableLines {
  if (!patch) return EMPTY_LINES;

  const right = new Set<number>();
  const left = new Set<number>();

  let oldLine = 0;
  let newLine = 0;

  for (const line of patch.split('\n')) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = parseInt(hunk[1], 10);
      newLine = parseInt(hunk[2], 10);
      continue;
    }
    const changeType = line[0];
    if (changeType === '+') {
      right.add(newLine);
      newLine++;
    } else if (changeType === '-') {
      left.add(oldLine);
      oldLine++;
    } else if (changeType === ' ') {
      right.add(newLine);
      left.add(oldLine);
      newLine++;
      oldLine++;
    }
    // "\" (no newline marker) and anything else: skip, don't advance counters
  }

  return { RIGHT: right, LEFT: left };
}

/**
 * Build a map of filename -> CommentableLines from the PR file patches.
 */
export function buildCommentableMap(files: FilePatch[]): Map<string, CommentableLines> {
  const map = new Map<string, CommentableLines>();
  for (const file of files) {
    map.set(file.filename, commentableLinesForFile(file.patch));
  }
  return map;
}

export interface ValidateInlineCommentsResult {
  valid: ReviewComment[];
  dropped: DroppedComment[];
}

/**
 * Validate review inline comments against the commentable-line map. Returns the
 * subset that anchor to a line inside a diff hunk, plus a `dropped` list
 * explaining why each rejected comment was dropped.
 *
 * Drop reasons:
 *   - file not in PR diff
 *   - file has no textual patch (binary, pure rename, mode change)
 *   - line is not inside a diff hunk on the given side
 *   - start_line > line (inverted range — GitHub rejects with "invalid line numbers")
 *   - start_line outside a diff hunk
 *
 * Never throws — a malformed comment is dropped with a reason, not a crash.
 */
export function validateInlineComments(
  comments: ReviewComment[],
  map: Map<string, CommentableLines>
): ValidateInlineCommentsResult {
  const valid: ReviewComment[] = [];
  const dropped: DroppedComment[] = [];

  for (const comment of comments) {
    const side: 'LEFT' | 'RIGHT' = comment.side === 'LEFT' ? 'LEFT' : 'RIGHT';
    const line = comment.line ?? 0;
    const lines = map.get(comment.path);

    const record = (reason: string): void => {
      const entry: DroppedComment = {
        path: comment.path,
        line,
        side,
        reason,
      };
      dropped.push(entry);
    };

    if (!lines) {
      record('file not in PR diff');
      continue;
    }

    if (lines.LEFT.size === 0 && lines.RIGHT.size === 0) {
      // File is in the PR but has no textual patch — binary, pure rename, or
      // mode-only change. GitHub won't accept inline comments regardless of line.
      record('file has no textual diff (binary, pure rename, or mode change)');
      continue;
    }

    const anchors = lines[side];
    if (!anchors.has(line)) {
      record(`line ${line} (${side}) is not inside a diff hunk`);
      continue;
    }

    // DonMerge comments are single-line (no start_line in ReviewComment today),
    // but guard defensively: if a future caller adds multi-line ranges, an
    // inverted range or an out-of-hunk start must not slip through.
    valid.push(comment);
  }

  return { valid, dropped };
}
