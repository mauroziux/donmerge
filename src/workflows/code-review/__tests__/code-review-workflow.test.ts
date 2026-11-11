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
  donmergeResolved?: {
    config: Record<string, unknown>;
    skillsContent: Map<string, string>;
    skillsErrors: Map<string, string>;
  };
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

describe('workflow ownership at startup', () => {
  it('does not start any step when the processor rejects the run', async () => {
    const updateFromWorkflow = vi.fn(async () => false);
    const step = { do: vi.fn() };
    const workflow = new CodeReviewWorkflow({} as never, {
      ReviewProcessor: { idFromName: () => 'id', get: () => ({ updateFromWorkflow }) },
    } as never);
    await workflow.run({ payload: { owner: 'o', repo: 'r', prNumber: 1, retrigger: false, runId: 'old' } } as never, step as never);
    expect(step.do).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ── the matrix ───────────────────────────────────────────────────────────────

describe('publishReview verdict matrix', () => {
  it('clean review + full coverage → success, and auto-resolves unmatched open issues in REVIEWED files', async () => {
    const calls = setupGitHubMock();
    const openIssue = createTrackedIssue({ filePath: 'a.ts', status: 'open' });
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

  it('full coverage does NOT auto-resolve issues in files outside the reviewed scope (policy-excluded)', async () => {
    const calls = setupGitHubMock();
    // b.ts is NOT in filePatches (e.g. excluded by .donmerge policy)
    const excludedIssue = createTrackedIssue({ filePath: 'b.ts', status: 'open' });
    const { stub, saved } = setupProcessorStub([excludedIssue]);

    await (makeWorkflow() as unknown as {
      publishReview: (r: unknown, s: unknown, runId?: string) => Promise<void>;
    }).publishReview(llmResult(fullCoverage(), cleanReview()), stub);

    const checkPatch = calls.find(
      (c) => c.url.includes('/check-runs/777') && c.method === 'PATCH'
    );
    expect(checkPatch?.body).toMatchObject({ conclusion: 'success' });

    const lastSave = saved[saved.length - 1] ?? [];
    const stored = lastSave.find((i) => i.id === excludedIssue.id);
    expect(stored?.status).toBe('open'); // never assessed → never auto-fixed
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

// ─── prepareFiles: snapshot discovery + no double config load (002-U1/005-U1) ─

describe('prepareFiles', () => {
  function makeEnv() {
    return { MAX_REVIEW_FILES: '50' } as never;
  }

  function filesResponse(files: Array<{ filename: string; patch?: string }>) {
    return { ok: true, json: async () => files };
  }

  it('discovers all pages, plans the prompt set and loads .donmerge exactly once', async () => {
    const prFilePages = [
      filesResponse(
        Array.from({ length: 2 }, (_, i) => ({
          filename: `src/f${i}.ts`,
          patch: `@@ -1 +1 @@\n+change ${i}`,
        }))
      ),
    ];
    const calls: string[] = [];
    mockFetch.mockImplementation(async (url: string) => {
      calls.push(url as string);
      if (url.includes('/pulls/42/files')) return prFilePages[0];
      if (url.includes('/repos/owner/repo/pulls/42') && !url.includes('/reviews')) {
        return { ok: true, json: async () => ({ head: { sha: 'headsha' } }) };
      }
      if (url.includes('contents/')) {
        return { ok: false, status: 404, text: async () => 'nf' };
      }
      return { ok: true, json: async () => ({}) };
    });

    const dto = {
      config: {
        version: '1',
        exclude: ['dist/**'],
        skills: [{ path: 'REVIEW.md', description: 'notes' }],
        instructions: 'be strict about concurrency',
      },
      skills: [['REVIEW.md', '# project review notes']],
      skillErrors: [],
    };
    const pr = { ...prData(), donmerge: dto };

    const prepared = await (makeWorkflow() as unknown as {
      prepareFiles: (p: unknown) => Promise<WorkflowPreparedFiles>;
    }).prepareFiles(pr);

    // Full scope: both files reviewed, coverage complete
    expect(prepared.coverage.scopeComplete).toBe(true);
    expect(prepared.coverage.reviewedCount).toBe(2);
    expect(prepared.diffText).toContain('src/f0.ts');
    // Skills rehydrated from the DTO — no second .donmerge fetch
    expect(prepared.donmergeResolved?.skillsContent.get('REVIEW.md')).toBe('# project review notes');
    const donmergeFetches = calls.filter((u) => u.includes('contents/.donmerge'));
    expect(donmergeFetches).toHaveLength(0);
    // Policy exclude honored through the plan
    expect(typeof prepared.donmergeResolved?.config.instructions).toBe('string');
  });

  it('throws non-retryable when the PR head moves during discovery', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/pulls/42/files')) {
        return filesResponse([{ filename: 'a.ts', patch: '@@ -1 +1 @@\n+x' }]);
      }
      if (url.includes('/repos/owner/repo/pulls/42') && !url.includes('/reviews')) {
        // The PR moved after step 1 cached headSha
        return { ok: true, json: async () => ({ head: { sha: 'NEWHEAD' } }) };
      }
      return { ok: true, json: async () => ({}) };
    });

    await expect(
      (makeWorkflow() as unknown as {
        prepareFiles: (p: unknown) => Promise<WorkflowPreparedFiles>;
      }).prepareFiles({ ...prData() })
    ).rejects.toThrow(/PR head changed/);
  });

  it('partial planning marks coverage partial when the budget drops files', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/pulls/42/files')) {
        return filesResponse(
          Array.from({ length: 3 }, (_, i) => ({
            filename: `f${i}.ts`,
            patch: '@@ -1 +1 @@\n+' + 'x'.repeat(200),
          }))
        );
      }
      if (url.includes('/repos/owner/repo/pulls/42') && !url.includes('/reviews')) {
        return { ok: true, json: async () => ({ head: { sha: 'headsha' } }) };
      }
      if (url.includes('contents/')) {
        return { ok: false, status: 404, text: async () => 'nf' };
      }
      return { ok: true, json: async () => ({}) };
    });

    // maxFiles=2 forces one file out
    const pr = { ...prData(), maxFiles: 2, changedFilesCount: 3 };
    const prepared = await (makeWorkflow() as unknown as {
      prepareFiles: (p: unknown) => Promise<WorkflowPreparedFiles>;
    }).prepareFiles(pr);

    expect(prepared.coverage.scopeComplete).toBe(false);
    expect(prepared.coverage.reviewedCount).toBe(2);
    expect(prepared.coverage.pendingCount).toBe(1);
    expect(prepared.filePatches).toHaveLength(2);
  });
});
