import type { TrackedIssue } from './types';

const ISSUE_STORAGE_KEY = 'trackedIssues';

export async function loadTrackedIssues(storage: DurableObjectStorage): Promise<TrackedIssue[]> {
  const stored = await storage.get<TrackedIssue[]>(ISSUE_STORAGE_KEY);
  return Array.isArray(stored) ? stored : [];
}

export async function saveTrackedIssues(
  storage: DurableObjectStorage,
  issues: TrackedIssue[]
): Promise<void> {
  await storage.put(ISSUE_STORAGE_KEY, issues);
}
