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
}

export function matchCurrentFindingsToStored(
  current: CurrentIssue[],
  stored: TrackedIssue[],
  options: MatchOptions = {}
): IssueMatchResult {
  const assumeMissingResolved = options.assumeMissingResolved !== false;
  const newIssues: TrackedIssue[] = [];
  const persistingIssues: TrackedIssue[] = [];
  const resolvedIssues: TrackedIssue[] = [];
  const reintroducedIssues: TrackedIssue[] = [];

  const matchedStoredIds = new Set<string>();

  for (const finding of current) {
    const existing = findBestMatch(finding, stored);
    if (!existing) {
      newIssues.push(finding.payload);
      continue;
    }

    matchedStoredIds.add(existing.id);
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
    if (issue.status === 'open' || issue.status === 'new') {
      resolvedIssues.push(issue);
    }
  }

  return { newIssues, persistingIssues, resolvedIssues, reintroducedIssues };
}

function findBestMatch(current: CurrentIssue, stored: TrackedIssue[]): TrackedIssue | undefined {
  const exactFingerprint = stored.find((issue) => issue.fingerprint === current.fingerprint);
  if (exactFingerprint) return exactFingerprint;

  const logicalKey = stored.find((issue) => issue.logicalKey === current.logicalKey);
  if (logicalKey) return logicalKey;

  return stored.find((issue) => issue.anchorKey === current.anchorKey);
}
