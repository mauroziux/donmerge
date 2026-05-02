/**
 * Path Resolution Utility for Auto-Fix V2
 *
 * Sentry stack frames often report paths like `app/src/features/auth/LoginPage.tsx`
 * while the actual repo path might be `apps/web/src/features/auth/LoginPage.tsx`.
 *
 * This module resolves Sentry-reported paths against the actual files present
 * in the cloned sandbox repository using a multi-strategy approach:
 *   1. Exact match
 *   2. Suffix matching by meaningful suffix (e.g. `src/...`)
 *   3. Basename fallback (e.g. `LoginPage.tsx`)
 */

import type { AutoFixSandbox } from './types';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface PathMapping {
  /** Original path from Sentry/triage (e.g. `app/src/features/auth/LoginPage.tsx`) */
  original: string;
  /** Resolved path in the actual repo, or null if unresolved */
  resolved: string | null;
}

export interface ResolveResult {
  /** Mapping for every input path */
  mappings: PathMapping[];
  /** Only the resolved entries (original → resolved) */
  resolved: Map<string, string>;
  /** Paths that could not be resolved */
  unresolved: string[];
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Extract meaningful suffixes from a path for matching.
 *
 * For `app/src/features/auth/LoginPage.tsx`, returns:
 *   - `app/src/features/auth/LoginPage.tsx` (full)
 *   - `src/features/auth/LoginPage.tsx`     (from first `src/`)
 *   - `features/auth/LoginPage.tsx`
 *   - `auth/LoginPage.tsx`
 *   - `LoginPage.tsx`                       (basename)
 *
 * Ordered from most specific to least specific.
 */
function extractSuffixes(filePath: string): string[] {
  const parts = filePath.split('/');
  const suffixes: string[] = [];

  // Full path
  suffixes.push(filePath);

  // Walk from the start, dropping leading segments
  // Prefer matching from `src/`, `lib/`, `pkg/`, `internal/` etc.
  for (let i = 1; i < parts.length; i++) {
    suffixes.push(parts.slice(i).join('/'));
  }

  return suffixes;
}

// ── Sandbox exec helper ────────────────────────────────────────────────────────

/**
 * Execute a command in the sandbox and return combined stdout+stderr.
 * Re-uses the same pattern as auto-fix-v2.ts.
 */
async function execShell(sandbox: AutoFixSandbox, command: string): Promise<string> {
  const result = await sandbox.exec(command);
  const parts: string[] = [];
  if (result.stdout) parts.push(result.stdout);
  if (result.stderr) parts.push(result.stderr);
  return parts.join('\n');
}

// ── Public API ─────────────────────────────────────────────────────────────────

const REPO_DIR = '/home/user/repo';

/**
 * Resolve Sentry/stack-frame paths against actual files in the cloned repo.
 *
 * Strategies (in order of preference):
 *   1. Exact match — the path exists as-is in the repo
 *   2. Suffix match — find a repo file whose path ends with a meaningful suffix
 *      of the query (e.g. `src/features/auth/LoginPage.tsx`)
 *   3. Basename match — find repo files with the same filename
 *
 * @param sandbox   The sandbox with a cloned repo at `/home/user/repo`
 * @param paths     Paths from Sentry/triage to resolve
 * @returns         Resolution result with mappings, resolved map, and unresolved list
 */
export async function resolvePaths(
  sandbox: AutoFixSandbox,
  paths: string[],
): Promise<ResolveResult> {
  if (paths.length === 0) {
    return { mappings: [], resolved: new Map(), unresolved: [] };
  }

  // Build a file index of the repo using `find`
  // Limit depth and count to avoid excessive output
  const findOutput = await execShell(
    sandbox,
    `cd ${REPO_DIR} && find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/vendor/*' 2>/dev/null | head -5000`,
  );

  const repoFiles = findOutput
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      // Strip leading `./`
      return line.startsWith('./') ? line.slice(2) : line;
    });

  const repoFileSet = new Set(repoFiles);

  const mappings: PathMapping[] = [];
  const resolved = new Map<string, string>();
  const unresolved: string[] = [];

  for (const queryPath of paths) {
    // Normalize: strip leading slashes
    const normalized = queryPath.replace(/^\/+/, '');

    // Strategy 1: Exact match
    if (repoFileSet.has(normalized)) {
      mappings.push({ original: queryPath, resolved: normalized });
      resolved.set(queryPath, normalized);
      continue;
    }

    // Strategy 2: Suffix matching — find unique match by most-specific suffix
    // Try suffixes from most specific to least specific; resolve only when
    // a suffix matches exactly one file.
    let bestMatch: string | null = null;
    const suffixes = extractSuffixes(normalized);

    for (const suffix of suffixes) {
      if (suffix === normalized) continue; // Already tried exact match

      const matches = repoFiles.filter(
        (f) => f === suffix || f.endsWith('/' + suffix),
      );

      if (matches.length === 1) {
        bestMatch = matches[0];
        break; // Most-specific unique match wins
      }
    }

    if (bestMatch) {
      mappings.push({ original: queryPath, resolved: bestMatch });
      resolved.set(queryPath, bestMatch);
      continue;
    }

    // Strategy 3: Basename match
    const basename = normalized.split('/').pop()!;
    const basenameMatches = repoFiles.filter(
      (f) => f.endsWith('/' + basename) || f === basename,
    );

    if (basenameMatches.length === 1) {
      mappings.push({ original: queryPath, resolved: basenameMatches[0] });
      resolved.set(queryPath, basenameMatches[0]);
      continue;
    }

    // Unresolved
    mappings.push({ original: queryPath, resolved: null });
    unresolved.push(queryPath);
  }

  return { mappings, resolved, unresolved };
}

/**
 * Format path mappings into a human-readable section for the agent prompt.
 *
 * Returns a clear PATH MAPPING section the agent can use to translate
 * Sentry paths to actual repo paths.
 */
export function formatPathMappingPrompt(result: ResolveResult): string {
  if (result.mappings.length === 0) return '';

  const lines: string[] = ['\n\nPATH MAPPING (IMPORTANT):'];
  lines.push('The error paths below may differ from the actual repo layout.');
  lines.push('Use the RESOLVED paths when reading/editing files.\n');

  for (const mapping of result.mappings) {
    if (mapping.resolved) {
      if (mapping.original === mapping.resolved) {
        lines.push(`  ${mapping.original} (exact match)`);
      } else {
        lines.push(`  ${mapping.original} → ${mapping.resolved}`);
      }
    } else {
      lines.push(`  ${mapping.original} (NOT FOUND — search by basename or function name)`);
    }
  }

  if (result.unresolved.length > 0) {
    lines.push('\nFor unresolved paths: use `find . -name "<basename>"` or `grep -r "<function>"` to locate the file.');
  }

  return lines.join('\n');
}
