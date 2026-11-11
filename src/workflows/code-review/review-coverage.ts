/**
 * Review coverage planning and manifest (plan 002-U2).
 *
 * The reviewer must never present a partially-reviewed diff as a complete,
 * clean review. This module owns the deterministic planning that decides which
 * discovered PR files actually reach the LLM prompt, and produces a manifest
 * that records, per file, whether it was reviewed, excluded by policy, left
 * out of a focused review, or skipped because of a budget/patch limitation.
 *
 * Pure logic only — no fetch, no storage. The workflow wires it in
 * prepare-files and the publisher turns the manifest into an honest check-run
 * conclusion (success / neutral / failure).
 */

/** Why a discovered file did or did not reach the LLM prompt. */
export type FileCoverageStatus =
  /** Included in the prompt within budget. */
  | 'reviewed'
  /** Removed by .donmerge exclude/include policy (explicit repo config). */
  | 'excluded-policy'
  /** Not part of the requested focus scope (explicit user request). */
  | 'focused-out'
  /** Eligible but left out by the file-count or diff-character budget. */
  | 'pending-budget'
  /** GitHub returned no patch text; content cannot be reviewed. */
  | 'no-patch';

export interface FileCoverageEntry {
  path: string;
  status: FileCoverageStatus;
  /** Machine-readable detail for pending/limitation statuses. */
  reason?: string;
  /** Length of the patch text (0 when no patch). */
  patchChars: number;
}

export interface DiscoveredFile {
  filename: string;
  patch?: string;
}

export interface PlanReviewFilesInput {
  /** Every file discovered from the PR files API (all pages). */
  discovered: DiscoveredFile[];
  /** Explicit focus paths requested by the user (comment/API). */
  focusFiles?: string[];
  /** .donmerge exclude/include predicate (true = excluded by policy). */
  isExcluded: (path: string) => boolean;
  /** Max files allowed in the prompt (MAX_REVIEW_FILES / push-API override). */
  maxFiles: number;
  /** Max total diff characters allowed in the prompt. */
  diffCharBudget: number;
}

export interface CoveragePlan {
  /** Files that should be rendered into the prompt, in order. */
  selected: DiscoveredFile[];
  /** Per-file coverage decision for every discovered file. */
  entries: FileCoverageEntry[];
  /** Focus paths were requested but matched none of the discovered files. */
  focusNoMatch: boolean;
  /** True when focus filtering applied (scope narrower than the PR). */
  focused: boolean;
  /** True when at least one eligible file was dropped for the char budget. */
  diffTruncated: boolean;
}

export const DEFAULT_DIFF_CHAR_BUDGET = 50_000;

/** Rough per-file overhead in the rendered `FILE: name\npatch\n` block. */
const FILE_BLOCK_OVERHEAD_CHARS = 8; // "FILE: \n" + trailing "\n"

function fileBlockChars(file: DiscoveredFile): number {
  const patch = file.patch ?? '';
  return file.filename.length + patch.length + FILE_BLOCK_OVERHEAD_CHARS;
}

function normalizeFocus(focusFiles?: string[]): string[] {
  return (focusFiles ?? [])
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
}

function matchesFocus(filename: string, focus: string): boolean {
  return filename === focus || filename.endsWith(`/${focus}`);
}

/**
 * Decide which discovered files reach the prompt.
 *
 * Order of precedence (plan 002-U1):
 *   1. focus scope (explicit request; no match is surfaced, never silently
 *      widened back to the full diff)
 *   2. .donmerge exclude/include policy
 *   3. file-count budget (maxFiles)
 *   4. diff-character budget (files whole, never mid-hunk cuts)
 *
 * Files without a patch never consume prompt budget: they are recorded as
 * `no-patch` so the manifest can report the limitation honestly.
 */
export function planReviewFiles(input: PlanReviewFilesInput): CoveragePlan {
  const focus = normalizeFocus(input.focusFiles);
  const focused = focus.length > 0;

  const focusMatches = focused
    ? input.discovered.filter((file) => focus.some((f) => matchesFocus(file.filename, f)))
    : [];
  const focusNoMatch = focused && focusMatches.length === 0;

  const entries: FileCoverageEntry[] = [];
  const selected: DiscoveredFile[] = [];
  let diffTruncated = false;
  let charBudget = Math.max(0, input.diffCharBudget);
  let fileBudget = Math.max(0, input.maxFiles);

  const candidates = focused ? focusMatches : input.discovered;

  for (const file of input.discovered) {
    if (focused && !focus.some((f) => matchesFocus(file.filename, f))) {
      entries.push({
        path: file.filename,
        status: 'focused-out',
        reason: `outside requested focus: ${focus.join(', ')}`,
        patchChars: file.patch?.length ?? 0,
      });
    }
  }

  for (const file of candidates) {
    const patchChars = file.patch?.length ?? 0;

    if (input.isExcluded(file.filename)) {
      entries.push({
        path: file.filename,
        status: 'excluded-policy',
        reason: '.donmerge exclude/include policy',
        patchChars,
      });
      continue;
    }

    if (!file.patch) {
      // No patch text (binary / too-large diff): nothing reviewable. Never
      // spend prompt budget on a "[no patch available]" placeholder.
      entries.push({
        path: file.filename,
        status: 'no-patch',
        reason: 'GitHub returned no patch text (binary or oversized file)',
        patchChars: 0,
      });
      continue;
    }

    const blockChars = fileBlockChars(file);
    if (fileBudget === 0) {
      entries.push({
        path: file.filename,
        status: 'pending-budget',
        reason: `max file budget (${input.maxFiles}) reached`,
        patchChars,
      });
      continue;
    }

    if (blockChars > charBudget) {
      diffTruncated = true;
      entries.push({
        path: file.filename,
        status: 'pending-budget',
        reason: `diff character budget (${input.diffCharBudget}) reached`,
        patchChars,
      });
      continue;
    }

    fileBudget -= 1;
    charBudget -= blockChars;
    selected.push(file);
    entries.push({ path: file.filename, status: 'reviewed', patchChars });
  }

  return { selected, entries, focusNoMatch, focused, diffTruncated };
}

// ── Manifest ────────────────────────────────────────────────────────────────

export interface CoverageManifest {
  /** PR head the manifest was built against. */
  headSha: string;
  /** Files the PR object declares as changed (may exceed what the API lists). */
  changedFilesCount: number;
  /** Files actually discovered through the files API (all pages). */
  discoveredCount: number;
  /** GitHub's 3000-file listing cap was hit; discovery is incomplete. */
  apiFileCapReached: boolean;
  /** Files rendered into the LLM prompt. */
  reviewedCount: number;
  excludedPolicyCount: number;
  focusedOutCount: number;
  /** pending-budget + no-patch files: limitations of this run. */
  pendingCount: number;
  /** The run reviewed a user-requested subset of the PR. */
  focused: boolean;
  /** Focus paths matched nothing; nothing was reviewed. */
  focusNoMatch: boolean;
  /** At least one eligible file was dropped by the character budget. */
  diffTruncated: boolean;
  /**
   * True only when the whole PR was covered: nothing pending, not focused,
   * discovery matched the PR's declared file count and no API cap was hit.
   */
  scopeComplete: boolean;
  /** Pending entries (budget/no-patch), capped for display. */
  pending: Array<{ path: string; status: FileCoverageStatus; reason?: string }>;
}

export interface BuildManifestContext {
  headSha: string;
  changedFilesCount: number;
  apiFileCapReached: boolean;
}

const MAX_PENDING_DISPLAY = 15;

/** Collapse a plan into the reportable manifest for this run. */
export function buildCoverageManifest(
  plan: CoveragePlan,
  ctx: BuildManifestContext
): CoverageManifest {
  const byStatus = (status: FileCoverageStatus) =>
    plan.entries.filter((entry) => entry.status === status);

  const pending = [...byStatus('pending-budget'), ...byStatus('no-patch')];
  const discoveredCount = plan.entries.length;

  const scopeComplete =
    !plan.focused &&
    !plan.focusNoMatch &&
    !plan.diffTruncated &&
    pending.length === 0 &&
    discoveredCount >= ctx.changedFilesCount &&
    !ctx.apiFileCapReached;

  return {
    headSha: ctx.headSha,
    changedFilesCount: ctx.changedFilesCount,
    discoveredCount,
    apiFileCapReached: ctx.apiFileCapReached,
    reviewedCount: byStatus('reviewed').length,
    excludedPolicyCount: byStatus('excluded-policy').length,
    focusedOutCount: byStatus('focused-out').length,
    pendingCount: pending.length,
    focused: plan.focused,
    focusNoMatch: plan.focusNoMatch,
    diffTruncated: plan.diffTruncated,
    scopeComplete,
    pending: pending
      .slice(0, MAX_PENDING_DISPLAY)
      .map(({ path, status, reason }) => ({ path, status, reason })),
  };
}

/** Human-readable coverage note for check-run output and PR description. */
export function coverageReportText(manifest: CoverageManifest): string {
  if (manifest.scopeComplete) {
    return `Coverage: full — ${manifest.reviewedCount} file(s) reviewed, ${manifest.excludedPolicyCount} excluded by repo policy.`;
  }

  const lines: string[] = [];
  lines.push(
    `Coverage: partial — ${manifest.reviewedCount} of ${manifest.discoveredCount} discovered file(s) reached the review.`
  );

  if (manifest.focused) {
    lines.push(
      manifest.focusNoMatch
        ? 'Focused review requested, but the focus path(s) matched none of the changed files; nothing was reviewed.'
        : `Focused review: ${manifest.focusedOutCount} changed file(s) were outside the requested focus and were NOT reviewed.`
    );
  }
  if (manifest.diffTruncated) {
    lines.push('The diff character budget was reached; some files were not sent to the model.');
  }
  if (manifest.pendingCount > 0) {
    const shown = manifest.pending
      .map((p) => `- \`${p.path}\` (${p.status}${p.reason ? `: ${p.reason}` : ''})`)
      .join('\n');
    lines.push(`Not reviewed in this run:\n${shown}`);
    if (manifest.pendingCount > manifest.pending.length) {
      lines.push(`… and ${manifest.pendingCount - manifest.pending.length} more.`);
    }
  }
  if (manifest.apiFileCapReached) {
    lines.push(
      `GitHub's file-listing cap was reached (${manifest.discoveredCount} listed of ${manifest.changedFilesCount} declared); discovery itself is incomplete.`
    );
  } else if (manifest.discoveredCount < manifest.changedFilesCount) {
    lines.push(
      `Discovery mismatch: ${manifest.discoveredCount} listed vs ${manifest.changedFilesCount} declared by the PR.`
    );
  }

  lines.push('This verdict applies only to the reviewed scope; it does not certify the rest of the PR.');
  return lines.join('\n');
}
