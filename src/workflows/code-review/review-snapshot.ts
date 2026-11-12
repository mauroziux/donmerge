/**
 * Versioned review snapshot helpers (plan 002-U1).
 *
 * A review must describe one immutable version of the PR. The GitHub files
 * endpoint describes a *mutable* PR, so discovery paginates defensively:
 * it stops on short pages, honors the declared `changed_files` count, never
 * trusts beyond GitHub's 3000-file listing cap, and the caller re-checks the
 * PR head afterwards so a push that lands mid-pagination invalidates the
 * snapshot instead of silently mixing two versions of the diff.
 */

/** GitHub's documented hard cap for the "list PR files" endpoint. */
export const GITHUB_PR_FILES_HARD_CAP = 3000;

/** per_page used for the files listing. */
export const PR_FILES_PER_PAGE = 100;

/** Defensive page ceiling (300 pages × 100 = the API hard cap). */
export const PR_FILES_MAX_PAGES = Math.ceil(GITHUB_PR_FILES_HARD_CAP / PR_FILES_PER_PAGE);

export interface PrFileEntry {
  filename: string;
  patch?: string;
}

export interface PrFilesDiscovery {
  files: PrFileEntry[];
  /** True when pagination stopped on the hard cap: discovery is incomplete. */
  apiFileCapReached: boolean;
  /** Pages fetched (observability). */
  pagesFetched: number;
}

/**
 * Thrown when the PR head moved while the snapshot was being built. The
 * workflow surfaces this as a non-retryable step failure (retrying with the
 * same cached PR data would loop) and the coordinator re-runs the new head.
 */
export class PrHeadChangedError extends Error {
  public readonly expectedHeadSha: string;
  public readonly actualHeadSha: string;

  constructor(expectedHeadSha: string, actualHeadSha: string) {
    super(
      `PR head changed during review snapshot: expected ${expectedHeadSha}, now ${actualHeadSha}`
    );
    this.name = 'PrHeadChangedError';
    this.expectedHeadSha = expectedHeadSha;
    this.actualHeadSha = actualHeadSha;
  }
}

/** Build the page URL for the PR files listing. */
export function buildPrFilesPageUrl(
  owner: string,
  repo: string,
  prNumber: number,
  page: number
): string {
  return `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=${PR_FILES_PER_PAGE}&page=${page}`;
}

/**
 * Pure pagination stop decision.
 *
 * Stops when: a short page arrived (last page), the declared changed-file
 * count is covered, the API hard cap was reached, or the page ceiling hit.
 */
export function shouldStopPaginating(args: {
  fetchedThisPage: number;
  totalFetched: number;
  declaredCount: number;
  page: number;
}): boolean {
  if (args.fetchedThisPage < PR_FILES_PER_PAGE) return true;
  if (args.totalFetched >= GITHUB_PR_FILES_HARD_CAP) return true;
  if (args.page >= PR_FILES_MAX_PAGES) return true;
  // declaredCount is trusted only up to the hard cap; beyond it GitHub
  // under-reports, so keep fetching until a short page or the cap.
  if (args.totalFetched < GITHUB_PR_FILES_HARD_CAP && args.totalFetched >= args.declaredCount) {
    return true;
  }
  return false;
}

/** Whether discovery is complete relative to the PR's declared file count. */
export function discoveryMatchesDeclared(
  discoveredCount: number,
  declaredCount: number,
  apiFileCapReached: boolean
): boolean {
  if (apiFileCapReached) return false;
  if (declaredCount <= 0) return true; // unknown declaration — trust the listing
  return discoveredCount >= declaredCount;
}
