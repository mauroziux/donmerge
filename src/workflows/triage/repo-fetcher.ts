/**
 * Fetch repo code at a given SHA from affected file paths.
 *
 * Self-contained GitHub API helper (does not import from code-review module).
 */

import { base64ToUtf8 } from './utils';

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
      'User-Agent': 'donmerge-triage',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`GitHub API error ${response.status}: ${errorBody}`);
  }

  return (await response.json()) as T;
}

// ── Path filtering ─────────────────────────────────────────────────────────────

/** Patterns to exclude from affected file paths */
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
 * Filter out non-application file paths (node_modules, vendor, cache, etc.).
 */
export function filterInAppPaths(paths: string[]): string[] {
  return paths.filter((path) => {
    return !EXCLUDE_PATTERNS.some((pattern) => pattern.test(path));
  });
}

// ── File fetching ──────────────────────────────────────────────────────────────

const MAX_FILE_SIZE = 100_000; // 100KB per file
const MAX_TOTAL_SIZE = 200_000; // 200KB total across all files

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

    // Decode base64 content (UTF-8 safe)
    const decoded = base64ToUtf8(result.content.replace(/\s/g, ''));
    return decoded;
  } catch {
    // File may not exist or other fetch error — skip gracefully
    return null;
  }
}

// ── GitHub Tree API fallback ───────────────────────────────────────────────────

interface TreeEntry {
  path: string;
  type: 'blob' | 'tree';
  size?: number;
}

/**
 * Fetch the full git tree for a repo at a given SHA using the Git Data API.
 * Returns all blob (file) paths in the tree.
 */
async function fetchGitTree(
  owner: string,
  repo: string,
  sha: string,
  token: string,
): Promise<string[]> {
  try {
    const result = await githubFetch<{ tree: TreeEntry[] }>(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`,
      token,
    );

    return result.tree
      .filter((entry) => entry.type === 'blob')
      .map((entry) => entry.path);
  } catch {
    return [];
  }
}

/**
 * Extract meaningful suffixes from a path for matching.
 * Returns suffixes from longest to shortest, e.g.:
 *   `app/src/features/auth/LoginPage.tsx` →
 *     `app/src/features/auth/LoginPage.tsx`,
 *     `src/features/auth/LoginPage.tsx`,
 *     `features/auth/LoginPage.tsx`,
 *     `auth/LoginPage.tsx`,
 *     `LoginPage.tsx`
 */
function extractSuffixes(filePath: string): string[] {
  const parts = filePath.split('/');
  const suffixes: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    suffixes.push(parts.slice(i).join('/'));
  }
  return suffixes;
}

/**
 * Try to resolve an unmatched path against the full repo tree using suffix matching.
 *
 * Returns the matching repo path when a suffix resolves to exactly one candidate,
 * or null if no match is found OR if the match is ambiguous (multiple candidates).
 */
function resolveBySuffix(queryPath: string, repoPaths: string[]): string | null {
  const normalized = queryPath.replace(/^\/+/, '');
  const suffixes = extractSuffixes(normalized);

  for (const suffix of suffixes) {
    const matches = repoPaths.filter(
      (p) => p === suffix || p.endsWith('/' + suffix),
    );

    if (matches.length === 1) {
      return matches[0];
    }

    // Ambiguous — multiple candidates match this suffix; skip to avoid guessing
    if (matches.length > 1) {
      continue;
    }
  }

  return null;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Fetch repo code relevant to a triage based on affected file paths.
 *
 * When the initial fetch yields zero files (paths from Sentry don't match
 * the repo layout), falls back to the GitHub Git Tree API to resolve paths
 * by suffix matching against the actual repo structure.
 *
 * @param affectedFiles - List of file paths provided by the caller
 * @returns Map of filename → file content, max 200KB total
 */
export async function fetchRepoCodeForTriage(
  repo: string,
  sha: string,
  affectedFiles: string[],
  githubToken: string
): Promise<Map<string, string>> {
  const [owner, repoName] = repo.split('/');
  if (!owner || !repoName) {
    throw new Error(`Invalid repo format: "${repo}". Expected "owner/repo".`);
  }

  const inAppPaths = filterInAppPaths(affectedFiles);
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

  // Fallback: if zero source files fetched, try GitHub tree suffix matching
  if (result.size === 0 && inAppPaths.length > 0) {
    console.log('[repo-fetcher] Zero files fetched, trying GitHub tree fallback');

    const repoPaths = await fetchGitTree(owner, repoName, sha, githubToken);
    if (repoPaths.length === 0) return result;

    // Resolve each unmatched path by suffix against the full tree
    const resolvedPaths: string[] = [];
    for (const queryPath of inAppPaths) {
      const resolved = resolveBySuffix(queryPath, repoPaths);
      if (resolved) {
        console.log('[repo-fetcher] Resolved path', { from: queryPath, to: resolved });
        resolvedPaths.push(resolved);
      }
    }

    // Fetch resolved paths
    if (resolvedPaths.length > 0) {
      const retrySettled = await Promise.allSettled(
        resolvedPaths.map(async (path) => {
          const content = await fetchFile(owner, repoName, path, sha, githubToken);
          return { path, content };
        })
      );

      for (const entry of retrySettled) {
        if (totalSize >= MAX_TOTAL_SIZE) break;
        if (entry.status !== 'fulfilled') continue;
        const { path, content } = entry.value;
        if (content) {
          result.set(path, content);
          totalSize += content.length;
        }
      }
    }
  }

  return result;
}
