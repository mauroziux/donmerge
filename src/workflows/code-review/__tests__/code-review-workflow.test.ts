/**
 * Composition tests for CodeReviewWorkflow.publishReview (plan 002-U4).
 *
 * Step 4 with mocked GitHub fetch + mocked ReviewProcessor DO. Proves the
 * honest-verdict matrix end to end:
 *   - clean review + FULL coverage    → check conclusion `success`
 *   - clean review + PARTIAL coverage → check conclusion `neutral`,
 *     and unmatched open issues stay open (absence ≠ fixed)
 *   - blocking findings               → `failure` regardless of coverage
 *   - full coverage may auto-resolve unmatched open issues (historical behavior)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// WorkflowEntrypoint comes from the Workers runtime module — stub it.
vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class {
    state: unknown;
    env: unknown;
    constructor(state: unknown, env: unknown) {
      this.state = state;
      this.env = env;
    }
  },
  NonRetryableError: class extends Error {},
}));

vi.mock('cloudflare:workflows', () => ({
  NonRetryableError: class extends Error {},
}));

vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn() }));

vi.mock('@flue/cloudflare', () => ({
  FlueRuntime: class {
    constructor(_opts: unknown) {}
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { CodeReviewWorkflow } from '../code-review-workflow';
import type { CoverageManifest } from '../review-coverage';
import type { ReviewResult, TrackedIssue } from '../types';
import { createTrackedIssue, resetIssueCounter } from './helpers';

type WorkflowPrData = {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  checkRunId: number;
  githubToken: string;
  prTitle?: string;
  prBody?: string | null;
  baseBranch?: string;
  baseSha?: string;
  changedFilesCount?: number;
  willReview: boolean;
  retrigger: boolean;
  commentId?: number;
  commentType?: 'issue' | 'review';
  instruction?: string;
  focusFiles?: string[];
  model?: string;
  maxFiles?: number;
};
type WorkflowPreparedFiles = {
  prData: WorkflowPrData;
  diffText: string;
  repoContext: Record<string, never>;
  activePreviousComments: never[];
  filePatches: Array<{ filename: string; patch?: string }>;
  coverage: CoverageManifest;
};

// ── fixtures ─────────────────────────────────────────────────────────────────

function prData(): WorkflowPrData {
  return {
    owner: 'owner',
    repo: 'repo',
    prNumber: 42,
    headSha: 'headsha',
    checkRunId: 777,
    githubToken: 'token',
    baseBranch: 'main',
    willReview: true,
    retrigger: false,
  };
}

function fullCoverage(): CoverageManifest {
  return {
    headSha: 'headsha',
    changedFilesCount: 2,
    discoveredCount: 2,
    apiFileCapReached: false,
    reviewedCount: 2,
    excludedPolicyCount: 0,
    focusedOutCount: 0,
    pendingCount: 0,
    focused: false,
    focusNoMatch: false,
    diffTruncated: false,
    scopeComplete: true,
    pending: [],
  };
}

function partialCoverage(): CoverageManifest {
  return {
    ...fullCoverage(),
    reviewedCount: 1,
    pendingCount: 1,
    pending: [{ path: 'b.ts', status: 'pending-budget', reason: 'diff character budget reached' }],
    scopeComplete: false,
  };
}

function cleanReview(): ReviewResult {
  return {
    approved: true,
    summary: 'No blocking findings.',
    prSummary: {
      overview: 'Adds a validation guard.',
      keyChanges: ['Validates payload before booking'],
      codeQuality: 'Fine.',
      testingNotes: 'Covered.',
      riskAssessment: 'Low.',
    },
    lineComments: [],
    criticalIssues: [],
    suggestions: [],
    resolvedComments: [],
  };
}

function blockingReview(): ReviewResult {
  return {
    ...cleanReview(),
    approved: false,
    criticalIssues: [
      'Missing idempotency key causes duplicate bookings when the webhook retries and the response is lost',
    ],
  };
}

function llmResult(coverage: CoverageManifest, result: ReviewResult) {
  const prepared: WorkflowPreparedFiles = {
    prData: prData(),
    diffText: 'FILE: a.ts\n+ok',
    repoContext: {},
    activePreviousComments: [],
    filePatches: [{ filename: 'a.ts', patch: '@@ -1 +1 @@\n+ok' }],
    coverage,
  };
  return { preparedFiles: prepared, result };
}

// (The unused PrData alias above is removed — structural types keep the
// harness decoupled from the module's private interfaces.)

// ── harness ──────────────────────────────────────────────────────────────────

interface CapturedCall {
  url: string;
  method: string;
  body?: unknown;
}

function setupGitHubMock(): CapturedCall[] {
  const calls: CapturedCall[] = [];
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });

    if (url.includes('/pulls/42/reviews?') && method === 'GET') {
      return { ok: true, json: async () => [] };
    }
    if (url.includes('/pulls/42/comments')) {
      return { ok: true, json: async () => [] };
    }
    if (url.includes('/check-runs') && method === 'PATCH') {
      return { ok: true, json: async () => ({}) };
    }
    if (url.includes('/repos/owner/repo/pulls/42') && method === 'GET') {
      return { ok: true, json: async () => ({ body: 'PR description', title: 't' }) };
    }
    if (url.includes('/repos/owner/repo/pulls/42') && method === 'PATCH') {
      return { ok: true, json: async () => ({}) };
    }
    if (url.includes('/repos/owner/repo/pulls/42/reviews') && method === 'POST') {
      return { ok: true, json: async () => ({ id: 1000 }) };
    }
    return { ok: true, json: async () => ({}) };
  });
  return calls;
}

function setupProcessorStub(seedIssues: TrackedIssue[]) {
  const saved: TrackedIssue[][] = [];
  const stub = {
    loadTrackedIssuesRpc: vi.fn(async () => seedIssues),
    saveTrackedIssuesRpc: vi.fn(async (issues: TrackedIssue[]) => {
      saved.push(issues);
    }),
    updateFromWorkflow: vi.fn(async () => {}),
  };
  return { stub, saved };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetIssueCounter();
});

function makeWorkflow() {
  return new CodeReviewWorkflow({} as never, { MAX_REVIEW_FILES: '50' } as never);
}

// ── the matrix ───────────────────────────────────────────────────────────────

describe('publishReview verdict matrix', () => {
  it('clean review + full coverage → success, and auto-resolves unmatched open issues', async () => {
    const calls = setupGitHubMock();
    const openIssue = createTrackedIssue({ filePath: 'b.ts', status: 'open' });
    const { stub, saved } = setupProcessorStub([openIssue]);

    await (makeWorkflow() as unknown as {
      publishReview: (r: unknown, s: unknown) => Promise<void>;
    }).publishReview(llmResult(fullCoverage(), cleanReview()), stub);

    const checkPatch = calls.find(
      (c) => c.url.includes('/check-runs/777') && c.method === 'PATCH'
    );
    expect(checkPatch?.body).toMatchObject({ status: 'completed', conclusion: 'success' });

    const lastSave = saved[saved.length - 1] ?? [];
    const storedOpen = lastSave.find((i) => i.id === openIssue.id);
    expect(storedOpen?.status).toBe('fixed');
  });

  it('clean review + PARTIAL coverage → neutral check, unmatched open issue stays open', async () => {
    const calls = setupGitHubMock();
    const openIssue = createTrackedIssue({ filePath: 'b.ts', status: 'open' });
    const { stub, saved } = setupProcessorStub([openIssue]);

    await (makeWorkflow() as unknown as {
      publishReview: (r: unknown, s: unknown) => Promise<void>;
    }).publishReview(llmResult(partialCoverage(), cleanReview()), stub);

    const checkPatch = calls.find(
      (c) => c.url.includes('/check-runs/777') && c.method === 'PATCH'
    );
    expect(checkPatch?.body).toMatchObject({ status: 'completed', conclusion: 'neutral' });
    expect((checkPatch?.body as { output: { text: string } }).output.text).toContain(
      'Coverage: partial'
    );

    // Absence of the finding is NOT evidence of a fix on a partial run.
    const lastSave = saved[saved.length - 1] ?? [];
    const storedOpen = lastSave.find((i) => i.id === openIssue.id);
    expect(storedOpen?.status).toBe('open');
  });

  it('blocking findings → failure even with partial coverage', async () => {
    const calls = setupGitHubMock();
    const { stub } = setupProcessorStub([]);

    await (makeWorkflow() as unknown as {
      publishReview: (r: unknown, s: unknown) => Promise<void>;
    }).publishReview(llmResult(partialCoverage(), blockingReview()), stub);

    const checkPatch = calls.find(
      (c) => c.url.includes('/check-runs/777') && c.method === 'PATCH'
    );
    expect(checkPatch?.body).toMatchObject({ status: 'completed', conclusion: 'failure' });
  });

  it('PR description records the partial-scope caveat', async () => {
    const calls = setupGitHubMock();
    const { stub } = setupProcessorStub([]);

    await (makeWorkflow() as unknown as {
      publishReview: (r: unknown, s: unknown) => Promise<void>;
    }).publishReview(llmResult(partialCoverage(), cleanReview()), stub);

    const prPatch = calls.find(
      (c) => c.url.endsWith('/repos/owner/repo/pulls/42') && c.method === 'PATCH'
    );
    const body = (prPatch?.body as { body: string }).body;
    expect(body).toContain('### 📊 Coverage');
    expect(body).toContain('Coverage: partial');
    // The author's own description is preserved ahead of the DonMerge block.
    expect(body.startsWith('PR description')).toBe(true);
  });
});
