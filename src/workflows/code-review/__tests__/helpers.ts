/**
 * Shared test helpers, factories, and fixtures for code review tests.
 */

import type {
  WebhookPayload,
  TrackedIssue,
  ReviewComment,
  PreviousComment,
  RepoContext,
} from '../types';
import type { ReviewPromptContext } from '../prompts/builder';

// ─── Webhook Payload Factories ───────────────────────────────────────

export function createPullRequestPayload(overrides: Partial<WebhookPayload> = {}): WebhookPayload {
  return {
    action: 'opened',
    installation: { id: 123456 },
    repository: {
      owner: { login: 'tableoltd' },
      name: 'test-repo',
    },
    pull_request: { number: 42 },
    ...overrides,
  };
}

export function createIssueCommentPayload(
  body: string,
  overrides: Partial<WebhookPayload> = {}
): WebhookPayload {
  return {
    action: 'created',
    installation: { id: 123456 },
    repository: {
      owner: { login: 'tableoltd' },
      name: 'test-repo',
    },
    issue: {
      number: 42,
      pull_request: {},
    },
    comment: { body, id: 99 },
    ...overrides,
  };
}

export function createReviewCommentPayload(
  body: string,
  overrides: Partial<WebhookPayload> = {}
): WebhookPayload {
  return {
    action: 'created',
    installation: { id: 123456 },
    repository: {
      owner: { login: 'tableoltd' },
      name: 'test-repo',
    },
    pull_request: { number: 42 },
    comment: { body, id: 100 },
    ...overrides,
  };
}

export function createCheckRunPayload(
  prNumbers: number[],
  overrides: Partial<WebhookPayload> = {}
): WebhookPayload {
  return {
    action: 'rerequested',
    installation: { id: 123456 },
    repository: {
      owner: { login: 'tableoltd' },
      name: 'test-repo',
    },
    check_run: {
      id: 1,
      name: 'DonMerge Review',
      pull_requests: prNumbers.map((n) => ({ number: n })),
    },
    ...overrides,
  };
}

// ─── TrackedIssue Factory ────────────────────────────────────────────

let issueCounter = 0;

export function createTrackedIssue(overrides: Partial<TrackedIssue> = {}): TrackedIssue {
  issueCounter += 1;
  return {
    id: `issue-${issueCounter}`,
    fingerprint: `fp-${issueCounter}`,
    logicalKey: `rule-${issueCounter}|function|myFunc`,
    anchorKey: `src/index.ts|some code snippet`,
    repo: 'tableoltd/test-repo',
    prNumber: 42,
    ruleId: `rule-${issueCounter}`,
    entityType: 'function',
    symbolName: 'myFunc',
    filePath: 'src/index.ts',
    line: 10,
    side: 'RIGHT',
    snippetHash: 'hash123',
    severity: 'critical',
    body: 'This is a test issue',
    status: 'new',
    firstSeenCommit: 'abc123',
    lastSeenCommit: 'abc123',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function resetIssueCounter(): void {
  issueCounter = 0;
}

// ─── ReviewComment Factory ───────────────────────────────────────────

export function createReviewComment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    path: 'src/index.ts',
    line: 10,
    side: 'RIGHT',
    body: '🔴 **Issue:** Test issue\n\n💡 **Suggestion:** Fix it',
    severity: 'critical',
    ...overrides,
  };
}

// ─── PreviousComment Factory ─────────────────────────────────────────

export function createPreviousComment(overrides: Partial<PreviousComment> = {}): PreviousComment {
  return {
    id: 1,
    path: 'src/index.ts',
    line: 10,
    body: '🔴 **Issue:** Test issue\n\n💡 **Suggestion:** Fix it',
    ...overrides,
  };
}

// ─── ReviewPromptContext Factory ─────────────────────────────────────

export function createReviewPromptContext(
  overrides: Partial<ReviewPromptContext> = {}
): ReviewPromptContext {
  return {
    owner: 'tableoltd',
    repo: 'test-repo',
    prNumber: 42,
    retrigger: false,
    diffText: 'diff --git a/src/index.ts b/src/index.ts\n+export function hello() { return "world"; }',
    ...overrides,
  };
}

// ─── RepoContext Factory ─────────────────────────────────────────────

export function createRepoContext(overrides: Partial<RepoContext> = {}): RepoContext {
  return {
    agents: 'This project follows strict TypeScript conventions.',
    readme: '# Test Repo\n\nA test repository.',
    ...overrides,
  };
}

// ─── PEM Key Constants ───────────────────────────────────────────────

/**
 * Minimal valid PEM private key for testing (not cryptographically valid, just format-valid).
 */
export const SAMPLE_PEM_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEA
-----END PRIVATE KEY-----`;

/**
 * A valid base64-encoded string that will decode successfully.
 */
export const VALID_BASE64_PEM_CONTENT = 'SGVsbG8gV29ybGQ=';

/**
 * A valid-looking PEM with escaped newlines (common in env vars / secrets).
 */
export const PEM_WITH_ESCAPED_NEWLINES =
  '-----BEGIN PRIVATE KEY-----\\nMIGHAgEA\\n-----END PRIVATE KEY-----';
