/**
 * Fetch repo code at a given SHA from stack trace file paths.
 *
 * Self-contained GitHub API helper (does not import from code-review module).
 */

import type { SentryEvent } from './types';

// ── GitHub API helper ──────────────────────────────────────────────────────────

/**
 * Generic GitHub API fetch helper.
 * Self-contained to avoid cross-module imports.
 */
async function githubFetch<T>(
  url: string,
  token: string,
  method: 'GET' | 'POST' | 'PATCH' = 'GET',
  body?: unknown
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'donmerge-sentry-triage',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`GitHub API error ${response.status}: ${errorBody}`);
  }

  return (await response.json()) as T;
}

// ── Path extraction ────────────────────────────────────────────────────────────

/** Patterns to exclude from in-app file paths */
const EXCLUDE_PATTERNS = [
  /node_modules\//,
  /vendor\//,
  /__pycache__\//,
  /\.venv\//,
  /site-packages\//,
  /third_party\//,
  /external\//,
];

/**
 * Extract in-app filenames from Sentry events' stack traces.
 * Filters out node_modules, vendor, and cache paths.
 */
export function extractInAppPaths(events: SentryEvent[]): string[] {
  const paths = new Set<string>();

  for (const event of events) {
    if (!event.exceptions) continue;

    for (const exc of event.exceptions) {
      for (const frame of exc.stacktrace.frames) {
        if (frame.inApp && frame.filename) {
          const excluded = EXCLUDE_PATTERNS.some((pattern) =>
            pattern.test(frame.filename)
          );
          if (!excluded) {
            paths.add(frame.filename);
          }
        }
      }
    }
  }

  return Array.from(paths);
}

// ── File fetching ──────────────────────────────────────────────────────────────

const MAX_FILE_SIZE = 10_000; // 10KB per file
const MAX_TOTAL_SIZE = 30_000; // 30KB total across all files

/**
 * Fetch a single file from GitHub at a given ref (SHA/branch).
 * Returns the decoded file content or null if fetch fails.
 */
export async function fetchFile(
  owner: string,
  repo: string,
  path: string,
  sha: string,
  token: string
): Promise<string | null> {
  try {
    const result = await githubFetch<{
      content: string;
      encoding: string;
      size: number;
    }>(
      `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${sha}`,
      token
    );

    if (result.encoding !== 'base64') {
      return null;
    }

    if (result.size > MAX_FILE_SIZE) {
      return null;
    }

    // Decode base64 content
    const decoded = atob(result.content.replace(/\s/g, ''));
    return decoded;
  } catch {
    // File may not exist or other fetch error — skip gracefully
    return null;
  }
}

/**
 * Fetch repo code relevant to a Sentry triage based on stack trace paths.
 *
 * @returns Map of filename → file content, max 30KB total
 */
export async function fetchRepoCodeForTriage(
  repo: string,
  sha: string,
  events: SentryEvent[],
  githubToken: string
): Promise<Map<string, string>> {
  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName) {
    throw new Error(`Invalid repo format: "${repo}". Expected "owner/repo".`);
  }

  const inAppPaths = extractInAppPaths(events);
  const result = new Map<string, string>();

  // Fetch all files in parallel
  const settled = await Promise.allSettled(
    inAppPaths.map(async (path) => {
      const content = await fetchFile(owner, repoName, path, sha, githubToken);
      return { path, content };
    })
  );

  let totalSize = 0;
  for (const entry of settled) {
    if (totalSize >= MAX_TOTAL_SIZE) break;
    if (entry.status !== 'fulfilled') continue;
    const { path, content } = entry.value;
    if (content) {
      result.set(path, content);
      totalSize += content.length;
    }
  }

  return result;
}
