import type { IssueStatus, TrackedIssue } from './types';

function updateIssue(issue: TrackedIssue, updates: Partial<TrackedIssue>): TrackedIssue {
  return {
    ...issue,
    ...updates,
    updatedAt: new Date().toISOString(),
  };
}

function transitionToStatus(
  issue: TrackedIssue,
  status: IssueStatus,
  commitSha: string
): TrackedIssue {
  const base = updateIssue(issue, {
    status,
    lastSeenCommit: commitSha,
  });

  if (status === 'fixed') {
    return updateIssue(base, { fixedCommit: commitSha });
  }

  return base;
}

export function transitionToNew(issue: TrackedIssue, commitSha: string): TrackedIssue {
  return transitionToStatus(issue, 'new', commitSha);
}

export function transitionToOpen(issue: TrackedIssue, commitSha: string): TrackedIssue {
  return transitionToStatus(issue, 'open', commitSha);
}

export function transitionToFixed(issue: TrackedIssue, commitSha: string): TrackedIssue {
  return transitionToStatus(issue, 'fixed', commitSha);
}

export function transitionToReintroduced(issue: TrackedIssue, commitSha: string): TrackedIssue {
  return transitionToStatus(issue, 'reintroduced', commitSha);
}
