import type { TrackedIssue } from './types';

export interface CurrentIssue {
  fingerprint: string;
  logicalKey: string;
  anchorKey: string;
  payload: TrackedIssue;
}

export interface IssueMatchResult {
  newIssues: TrackedIssue[];
  persistingIssues: TrackedIssue[];
  resolvedIssues: TrackedIssue[];
  reintroducedIssues: TrackedIssue[];
  matchedIssues: Map<CurrentIssue, TrackedIssue>;
}

export interface MatchOptions {
  /**
   * When true (default, historical behavior), stored open issues that the
   * current run did not observe are treated as resolved.
   *
   * When false (partial/focused reviews, plan 002-U4), absence of a finding
   * is NOT evidence of a fix: the file may not have been reviewed at all, so
   * unmatched open issues stay open ("not assessed") instead of flipping to
   * fixed.
   */
  assumeMissingResolved?: boolean;
  /**
   * Even on a full-scope run, only issues in files the run actually reviewed
   * may auto-resolve: a file excluded by .donmerge policy was never assessed,
   * so its open issues must survive (plan 002-U4 hardening).
   */
  reviewedPaths?: Set<string>;
}

export function matchCurrentFindingsToStored(
  current: CurrentIssue[],
  stored: TrackedIssue[],
  options: MatchOptions = {}
): IssueMatchResult {
  const assumeMissingResolved = options.assumeMissingResolved !== false;
  const reviewedPaths = options.reviewedPaths;
  const newIssues: TrackedIssue[] = [];
  const persistingIssues: TrackedIssue[] = [];
  const resolvedIssues: TrackedIssue[] = [];
  const reintroducedIssues: TrackedIssue[] = [];

  const matchedStoredIds = new Set<string>();
  const matchedIssues = new Map<CurrentIssue, TrackedIssue>();

  // Reserve exact matches before looser matching can consume their issue.
  for (const finding of current) {
    const exact = stored.find((issue) => issue.fingerprint === finding.fingerprint && !matchedStoredIds.has(issue.id));
    if (exact) {
      matchedStoredIds.add(exact.id);
      matchedIssues.set(finding, exact);
    }
  }

  for (const finding of current) {
    const existing = matchedIssues.get(finding) ?? findBestMatch(finding, stored.filter((issue) => !matchedStoredIds.has(issue.id)));
    if (!existing) {
      newIssues.push(finding.payload);
      continue;
    }

    matchedStoredIds.add(existing.id);
    matchedIssues.set(finding, existing);
    if (existing.status === 'fixed') {
      reintroducedIssues.push(existing);
    } else {
      persistingIssues.push(existing);
    }
  }

  for (const issue of stored) {
    if (matchedStoredIds.has(issue.id)) {
      continue;
    }
    if (!assumeMissingResolved) {
      // Partial/focused scope: keep the stored state untouched. The issue was
      // simply not assessed in this run.
      continue;
    }
    if (reviewedPaths && !reviewedPaths.has(issue.filePath)) {
      // The file holding this issue was not part of the reviewed scope (e.g.
      // excluded by repo policy): absence of a finding says nothing about it.
      continue;
    }
    if (issue.status === 'open' || issue.status === 'new') {
      resolvedIssues.push(issue);
    }
  }

  return { newIssues, persistingIssues, resolvedIssues, reintroducedIssues, matchedIssues };
}

export function findBestMatch(current: CurrentIssue, stored: TrackedIssue[]): TrackedIssue | undefined {
  const exactFingerprint = stored.find((issue) => issue.fingerprint === current.fingerprint);
  if (exactFingerprint) return exactFingerprint;

  const logicalKey = stored.find((issue) => issue.logicalKey === current.logicalKey);
  if (logicalKey) return logicalKey;

  return stored.find((issue) => issue.anchorKey === current.anchorKey);
}
