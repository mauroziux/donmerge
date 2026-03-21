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

export function matchCurrentFindingsToStored(
  current: CurrentIssue[],
  stored: TrackedIssue[]
): IssueMatchResult {
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
