/**
 * Retry helpers for GitHub API calls.
 *
 * GitHub's reviews endpoint occasionally returns a generic transient 422 with
 * body "An internal error occurred, please try again." — distinct from the
 * validation 422s that cite a specific cause (anchor, body length, malformed
 * suggestion). Treating the transient one like a validation failure surfaces
 * an opaque error the workflow cannot recover from; retrying it with bounded
 * backoff clears it on its own.
 *
 * Adapted from pullfrog's `isTransientReviewError` + `yes.op` retry, rewritten
 * in DonMerge's plain-TS idiom (no arktype, no external retry lib).
 */

/** Backoff schedule for transient GitHub 422 responses. 3 attempts total. */
export const TRANSIENT_RETRY_DELAYS_MS = [1_000, 3_000];

/**
 * Typed GitHub API error carrying the HTTP status and response body, so retry
 * predicates can decide without parsing the message string. Extends Error and
 * preserves the legacy `GitHub API error <status>: <body>` message format so
 * existing classifyError / log parsers keep working.
 */
export class GitHubApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`GitHub API error ${status}: ${body}`);
    this.name = 'GitHubApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * True iff the error is a GitHub transient "internal error" 422 on the reviews
 * endpoint. Such errors clear on their own within seconds and are safe to retry.
 *
 * The body is stable across occurrences and distinct from every other 422 cause
 * we care about (anchor validation, body length, malformed suggestion), which
 * all cite the specific problem.
 */
export function isTransientGitHubError(err: unknown): boolean {
  if (err instanceof GitHubApiError) {
    return err.status === 422 && /internal error occurred, please try again/i.test(err.body);
  }
  // Fall back to message parsing for errors thrown before GitHubApiError existed
  // or by callers that wrap the error.
  if (err instanceof Error) {
    return (
      /GitHub API error 422/.test(err.message) &&
      /internal error occurred, please try again/i.test(err.message)
    );
  }
  return false;
}

export interface RetryOptions {
  /** Delays (ms) between retries. Total attempts = delays.length + 1. */
  delays: number[];
  /** Return true to fail immediately (do not retry) for this error. */
  bail: (err: unknown) => boolean;
  /** Optional name for log clarity. */
  name?: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` and retry on non-bailed errors up to `delays.length` times, sleeping
 * `delays[i]` ms before the (i+1)-th retry.
 *
 * - If `bail(err)` returns true, the error is rethrown immediately (no retry).
 * - If all attempts are exhausted, the last error is rethrown.
 * - If `fn` resolves, the value is returned (never retried on success).
 *
 * Idempotency: GitHub's `POST /reviews` is NOT idempotent, so callers MUST only
 * wrap a call that throws before any side effect is observable. githubFetch
 * throws on non-2xx before returning, so a successful post is never retried.
 */
export async function withBoundedRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  let lastError: unknown;
  const totalAttempts = options.delays.length + 1;
  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (options.bail(err) || attempt === totalAttempts) {
        throw err;
      }
      const delay = options.delays[attempt - 1];
      if (options.name) {
        console.warn(
          `[${options.name}] attempt ${attempt}/${totalAttempts} failed, retrying in ${delay}ms`,
          { errorMessage: err instanceof Error ? err.message : String(err) }
        );
      }
      await sleep(delay);
    }
  }
  throw lastError;
}
