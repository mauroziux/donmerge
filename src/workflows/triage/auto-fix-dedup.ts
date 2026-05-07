/**
 * Auto-Fix PR Deduplication
 *
 * Prevents creating duplicate auto-fix PRs for the same underlying error.
 * Sentry creates different issue IDs for the same error on different routes,
 * so we dedup at the PR level using the sanitized error title.
 *
 * Uses the same placeholder-then-update pattern as tracker dedup
 * (runCreateIssueWithDedup in trackers/index.ts).
 */

import type { AutoFixContext } from './types';
import { sanitizeTitle, sanitizeData } from './prompts/sanitizers';

// ── Types ──────────────────────────────────────────────────────────────────────

/** Row shape returned from pr_dedup queries. */
export interface ExistingPrRow {
  id: number;
  pr_url: string;
  pr_number: string;
  branch_name: string;
  source_urls: string;
}

// ── computeSafeTitle ───────────────────────────────────────────────────────────

/**
 * Compute the same safeTitle used in branch naming.
 *
 * This MUST produce exactly the same output as the inline logic in
 * auto-fix-v2.ts `createPrFromSandbox`. Both use:
 *   errorTitle.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase().slice(0, 40)
 */
export function computeSafeTitle(errorTitle: string): string {
  return errorTitle
    .replace(/[^a-zA-Z0-9]/g, '-')
    .toLowerCase()
    .slice(0, 40);
}

// ── findExistingPr ─────────────────────────────────────────────────────────────

/**
 * Find existing PR entry in D1.
 * Returns null if no entry or on DB failure (never throws).
 */
export async function findExistingPr(
  repo: string,
  safeTitle: string,
  db: D1Database,
): Promise<ExistingPrRow | null> {
  try {
    return await db
      .prepare(
        `SELECT id, pr_url, pr_number, branch_name, source_urls
         FROM pr_dedup
         WHERE repo = ? AND safe_title = ?`
      )
      .bind(repo, safeTitle)
      .first<ExistingPrRow>();
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'unknown';
    console.error('[auto-fix-dedup] findExistingPr failed', { error: msg });
    return null;
  }
}

// ── claimDedupSlot ─────────────────────────────────────────────────────────────

/**
 * Try to claim the dedup slot (INSERT placeholder).
 *
 * Returns:
 * - 'claimed'        — slot claimed, proceed with PR creation
 * - 'race_detected'  — another DO already claimed, re-query found placeholder (no PR yet)
 * - 'existing_found' — re-query found a real PR (after INSERT failed), includes the row
 */
export async function claimDedupSlot(
  repo: string,
  safeTitle: string,
  sourceUrl: string,
  db: D1Database,
): Promise<{ status: 'claimed' | 'race_detected' | 'existing_found'; existing?: ExistingPrRow }> {
  try {
    const sourceUrls = JSON.stringify([sourceUrl]);
    await db
      .prepare(
        `INSERT INTO pr_dedup (repo, safe_title, pr_url, pr_number, branch_name, source_urls)
         VALUES (?, ?, '', '', '', ?)`
      )
      .bind(repo, safeTitle, sourceUrls)
      .run();

    return { status: 'claimed' };
  } catch {
    // INSERT failed — re-query to determine current state
    console.log('[auto-fix-dedup] INSERT failed, re-querying to determine state', {
      repo,
      safeTitle,
    });

    try {
      const afterFailure = await db
        .prepare(
          `SELECT id, pr_url, pr_number, branch_name, source_urls
           FROM pr_dedup
           WHERE repo = ? AND safe_title = ?`
        )
        .bind(repo, safeTitle)
        .first<ExistingPrRow>();

      if (afterFailure && afterFailure.pr_url !== '') {
        // Another DO completed — add comment and return
        return { status: 'existing_found', existing: afterFailure };
      }
      // Placeholder or no row — another DO is working on it
      return { status: 'race_detected' };
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'unknown';
      console.error('[auto-fix-dedup] re-query after INSERT failure failed', { error: msg });
      // Treat as race detected — don't create duplicate
      return { status: 'race_detected' };
    }
  }
}

// ── updateDedupSlot ────────────────────────────────────────────────────────────

/**
 * Update placeholder with real PR data.
 * Never throws — logs errors and continues.
 */
export async function updateDedupSlot(
  repo: string,
  safeTitle: string,
  prUrl: string,
  prNumber: string,
  branchName: string,
  sourceUrl: string,
  db: D1Database,
): Promise<void> {
  try {
    // Merge sourceUrl into existing source_urls
    const existing = await db
      .prepare(
        `SELECT source_urls FROM pr_dedup WHERE repo = ? AND safe_title = ?`
      )
      .bind(repo, safeTitle)
      .first<{ source_urls: string }>();

    let mergedUrls: string[];
    try {
      const existingUrls: string[] = JSON.parse(existing?.source_urls ?? '[]');
      if (!existingUrls.includes(sourceUrl)) {
        existingUrls.push(sourceUrl);
      }
      mergedUrls = existingUrls;
    } catch {
      mergedUrls = [sourceUrl];
    }

    await db
      .prepare(
        `UPDATE pr_dedup
         SET pr_url = ?, pr_number = ?, branch_name = ?, source_urls = ?, updated_at = datetime('now')
         WHERE repo = ? AND safe_title = ?`
      )
      .bind(prUrl, prNumber, branchName, JSON.stringify(mergedUrls), repo, safeTitle)
      .run();

    console.log('[auto-fix-dedup] updated dedup slot with PR data', {
      repo,
      safeTitle,
      prUrl,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'unknown';
    console.error('[auto-fix-dedup] failed to update dedup slot (PR was still created)', {
      error: msg,
    });
  }
}

// ── removeDedupSlot ────────────────────────────────────────────────────────────

/**
 * Remove placeholder on failure.
 * Never throws — logs errors and continues.
 */
export async function removeDedupSlot(
  repo: string,
  safeTitle: string,
  db: D1Database,
): Promise<void> {
  try {
    await db
      .prepare(
        `DELETE FROM pr_dedup WHERE repo = ? AND safe_title = ? AND pr_url = ''`
      )
      .bind(repo, safeTitle)
      .run();

    console.log('[auto-fix-dedup] removed placeholder', { repo, safeTitle });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'unknown';
    console.error('[auto-fix-dedup] failed to remove placeholder', { error: msg });
  }
}

// ── recordSourceUrl ────────────────────────────────────────────────────────────

/**
 * Record additional source URL to the accumulated list.
 * Never throws — logs errors and continues.
 */
export async function recordSourceUrl(
  repo: string,
  safeTitle: string,
  sourceUrl: string,
  db: D1Database,
): Promise<void> {
  try {
    const existing = await db
      .prepare(
        `SELECT source_urls FROM pr_dedup WHERE repo = ? AND safe_title = ?`
      )
      .bind(repo, safeTitle)
      .first<{ source_urls: string }>();

    let mergedUrls: string[];
    try {
      const existingUrls: string[] = JSON.parse(existing?.source_urls ?? '[]');
      if (!existingUrls.includes(sourceUrl)) {
        existingUrls.push(sourceUrl);
      }
      mergedUrls = existingUrls;
    } catch {
      mergedUrls = [sourceUrl];
    }

    await db
      .prepare(
        `UPDATE pr_dedup SET source_urls = ?, updated_at = datetime('now') WHERE repo = ? AND safe_title = ?`
      )
      .bind(JSON.stringify(mergedUrls), repo, safeTitle)
      .run();
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'unknown';
    console.error('[auto-fix-dedup] failed to record source URL', { error: msg });
  }
}

// ── Enrichment comment ─────────────────────────────────────────────────────────

/**
 * Build the enrichment comment body for an existing PR.
 */
export function buildEnrichmentCommentBody(
  errorTitle: string,
  sourceUrl: string,
  triageRootCause?: string,
): string {
  const sanitizedTitle = sanitizeTitle(errorTitle);
  const sanitizedRootCause = triageRootCause
    ? sanitizeData(triageRootCause, 500)
    : '';

  const sections = [
    `## 🔄 Additional Sentry Issue Detected`,
    ``,
    `A new Sentry issue maps to the same underlying error:`,
    ``,
    `- **Error**: ${sanitizedTitle}`,
    `- **Sentry Issue**: [View in Sentry](${sourceUrl})`,
  ];

  if (sanitizedRootCause) {
    sections.push(`- **Root Cause**: ${sanitizedRootCause}`);
  }

  sections.push(
    ``,
    `This PR already addresses the root cause. No new PR needed.`,
    ``,
    `---`,
    `*Auto-detected by [DonMerge](https://donmerge.dev) PR Deduplication*`,
  );

  return sections.join('\n');
}

/**
 * Add an enrichment comment to an existing PR via GitHub API (best-effort).
 * Never throws — errors are caught and logged.
 */
export async function addPrEnrichmentComment(
  repo: string,
  prNumber: string,
  context: AutoFixContext,
  githubToken: string,
): Promise<void> {
  try {
    const commentBody = buildEnrichmentCommentBody(
      context.errorTitle,
      context.sourceUrl,
      context.triageOutput.root_cause,
    );

    const response = await fetch(
      `https://api.github.com/repos/${repo}/issues/${prNumber}/comments`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'donmerge-fix-v2',
        },
        body: JSON.stringify({ body: commentBody }),
      },
    );

    if (!response.ok) {
      const errorBody = await response.text();
      console.error('[auto-fix-dedup] failed to add enrichment comment', {
        repo,
        prNumber,
        status: response.status,
        error: errorBody.slice(0, 200),
      });
      return;
    }

    console.log('[auto-fix-dedup] added enrichment comment', { repo, prNumber });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'unknown';
    console.error('[auto-fix-dedup] failed to add enrichment comment', {
      repo,
      prNumber,
      error: msg,
    });
  }
}
