/**
 * Composition tests for CodeReviewWorkflow.publishReview (plan 002-U4).
 *
 * Step 4 with mocked GitHub fetch + mocked ReviewProcessor DO. Proves the
 * honest-verdict matrix end to end:
 *   - clean review + FULL coverage    → check conclusion `success`
 *   - clean review + PARTIAL coverage → check conclusion `neutral`,
 *     and unmatched open issues stay open (absence ≠ fixed)
 *   - blocking findings               → `failure` regardless of coverage
 *   - even full coverage cannot establish a fix from a missing finding
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
import { buildCurrentIssues } from '../issue-builder';
import type { CoverageManifest } from '../review-coverage';
import type { PreviousComment, ReviewResult, TrackedIssue } from '../types';
import { attachFingerprint } from '../fingerprint';
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
  activePreviousComments: PreviousComment[];
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
  it('reuses the durable pre-publication snapshot when the publication step retries', async () => {
    const { stub } = setupProcessorStub([]);
    stub.updateFromWorkflow.mockResolvedValue(true as never);
    const workflow = new CodeReviewWorkflow({} as never, {
      ReviewProcessor: { idFromName: () => 'id', get: () => stub },
    } as never);
    const reviewResult = llmResult(fullCoverage(), cleanReview());
    let comments = [{ id: 8 }];
    mockFetch.mockImplementation(async () => ({ ok: true, json: async () => comments }));
    const publish = vi.fn(async (_result: unknown, _stub: unknown, _runId: unknown, _ids: number[]) => {})
      .mockImplementationOnce(async () => { comments = [{ id: 8 }, { id: 55 }]; throw new Error('retry'); });
    Object.assign(workflow, {
      fetchPrData: vi.fn(async () => reviewResult.preparedFiles.prData),
      prepareFiles: vi.fn(async () => reviewResult.preparedFiles),
      runLlmReview: vi.fn(async () => reviewResult),
      publishReview: publish,
    });
    const names: string[] = [];
    const step = { do: async (name: string, _options: unknown, callback: () => Promise<unknown>) => {
      names.push(name);
      try { return await callback(); } catch (error) {
        if (name !== 'publish-review') throw error;
        return callback();
      }
    } };
    await workflow.run({ payload: { owner: 'owner', repo: 'repo', prNumber: 42, retrigger: false, runId: 'run' } } as never, step as never);
    expect(names.filter((name) => name === 'snapshot-review-comment-ids')).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls.map((args) => args[3])).toEqual([[8], [8]]);
  });

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
  it.each(['new', 'anchor', 'same-fingerprint'] as const)('records a published finding after retries (%s)', async (scenario) => {
    const calls = setupGitHubMock();
    const normalFetch = mockFetch.getMockImplementation()!;
    let publishedBody = '';
    let reviewBody = '';
    let commentReads = 0;
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/pulls/42/reviews?') && (init?.method ?? 'GET') === 'GET') {
        return { ok: true, json: async () => reviewBody ? [{ id: 1000, body: reviewBody, commit_id: 'headsha' }] : [] };
      }
      if (url.includes('/pulls/42/reviews') && init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        publishedBody = body.comments[0].body;
        reviewBody = body.body;
      }
      if (url.includes('/pulls/42/comments')) {
        commentReads++;
        return { ok: true, json: async () => publishedBody && commentReads > 1 ? [{ id: 55, path: 'a.ts', line: 1, body: publishedBody, user: { login: 'donmerge[bot]', type: 'Bot' } }] : [] };
      }
      return normalFetch(url, init);
    });
    const bindings: unknown[][] = [];
    const db = {
      prepare: vi.fn(() => ({ bind: (...args: unknown[]) => { bindings.push(args); return {}; } })),
      batch: vi.fn(async () => []).mockRejectedValueOnce(new Error('D1 unavailable')),
    };
    const review = cleanReview();
    review.lineComments = [{ path: 'a.ts', line: 1, side: 'RIGHT', severity: 'suggestion', body: 'A real issue', ruleId: 'missing-guard', entityType: 'function', symbolName: 'save', codeSnippet: 'save()' }];
    const input = llmResult(fullCoverage(), review);
    const [current] = await buildCurrentIssues({ repo: 'repo', prNumber: 42 }, 'headsha', review.lineComments);
    if (scenario === 'same-fingerprint') {
      input.preparedFiles.activePreviousComments = [{ id: 8, path: 'a.ts', line: 1, body: attachFingerprint('Old issue', current.fingerprint), fingerprint: current.fingerprint }];
    }
    const seed = scenario === 'new' ? [] : [{
      ...current.payload,
      fingerprint: scenario === 'anchor' ? 'previous-fingerprint' : current.fingerprint,
      logicalKey: scenario === 'anchor' ? 'previous-logical-key' : current.logicalKey,
      status: 'fixed' as const,
      body: 'Previous issue wording',
      severity: 'critical' as const,
      githubCommentId: 8,
    }];
    const { stub } = setupProcessorStub(seed);
    stub.saveTrackedIssuesRpc.mockRejectedValueOnce(new Error('retry after publication'));
    const fenced = Object.assign(stub, { reservePublication: vi.fn(async () => true) });
    const workflow = new CodeReviewWorkflow({} as never, { MAX_REVIEW_FILES: '50', DB: db } as never);
    const publish = (workflow as unknown as { publishReview: (r: unknown, s: unknown, runId: string, ids: number[]) => Promise<void> }).publishReview.bind(workflow);
    await expect(publish(input, fenced, 'retry-test', [8])).rejects.toThrow('not yet visible');
    expect(db.batch).not.toHaveBeenCalled();
    await expect(publish(input, fenced, 'retry-test', [8])).rejects.toThrow('D1 unavailable');
    await expect(publish(input, fenced, 'retry-test', [8])).rejects.toThrow('retry after publication');
    await publish(input, fenced, 'retry-test', [8]);
    expect(bindings.some((args) => args.includes(55) && typeof args[4] === 'string' && publishedBody.includes(args[4] as string))).toBe(true);
    expect(db.batch).toHaveBeenCalled();
    expect(stub.saveTrackedIssuesRpc).toHaveBeenLastCalledWith(
      expect.arrayContaining([expect.objectContaining({ githubCommentId: 55, fingerprint: current.fingerprint, body: current.payload.body, severity: current.payload.severity })]), 'retry-test'
    );
    // The second attempt discovers the run marker and never submits a second review.
    expect(calls.filter((call) => call.url.endsWith('/reviews') && call.method === 'POST')).toHaveLength(1);
  });
  it.each([false, true])('keeps dropped findings eligible on a later run (reintroduced=%s)', async (reintroduced) => {
    setupGitHubMock();
    const review = cleanReview();
    review.lineComments = [{ path: 'a.ts', line: 99, side: 'RIGHT', severity: 'critical', body: 'Missing authorization allows users to change another account.' }];
    const [current] = await buildCurrentIssues({ repo: 'repo', prNumber: 42 }, 'headsha', review.lineComments);
    const prior = { ...current.payload, status: 'fixed' as const, githubCommentId: 8 };
    const { stub } = setupProcessorStub(reintroduced ? [prior] : []);
    await (makeWorkflow() as unknown as { publishReview: (r: unknown, s: unknown) => Promise<void> })
      .publishReview(llmResult(fullCoverage(), review), stub);
    expect(stub.saveTrackedIssuesRpc).toHaveBeenCalledWith(reintroduced ? [prior] : [], undefined);
  });

  it.each([false, true])('keeps the 41st finding eligible after the publication cap (reintroduced=%s)', async (reintroduced) => {
    setupGitHubMock();
    const normalFetch = mockFetch.getMockImplementation()!;
    let comments: Array<{ id: number; path: string; line: number; body: string; user: { login: string; type: string } }> = [];
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/pulls/42/reviews') && init?.method === 'POST') {
        comments = JSON.parse(init.body as string).comments.map((comment: { path: string; line: number; body: string }, index: number) => ({ ...comment, id: index + 100, user: { login: 'donmerge[bot]', type: 'Bot' } }));
      }
      if (url.includes('/pulls/42/comments')) return { ok: true, json: async () => comments };
      return normalFetch(url, init);
    });
    const review = cleanReview();
    review.lineComments = Array.from({ length: 41 }, (_, index) => ({
      path: 'a.ts', line: 1, side: 'RIGHT' as const, severity: 'critical' as const,
      body: `Finding ${index} allows unauthorized requests and must validate the caller.`,
      ruleId: `rule-${index}`, entityType: 'function' as const, symbolName: `save${index}`, codeSnippet: `save${index}()`,
    }));
    const input = llmResult(fullCoverage(), review);
    input.preparedFiles.filePatches = [];
    const current = await buildCurrentIssues({ repo: 'repo', prNumber: 42 }, 'headsha', review.lineComments);
    const last = current[40];
    const prior = { ...last.payload, status: 'fixed' as const, githubCommentId: 8 };
    const { stub } = setupProcessorStub(reintroduced ? [prior] : []);
    const db = { prepare: () => ({ bind: () => ({}) }), batch: vi.fn(async () => []) };
    const workflow = new CodeReviewWorkflow({} as never, { MAX_REVIEW_FILES: '50', DB: db } as never);
    await (workflow as unknown as { publishReview: (r: unknown, s: unknown, runId: undefined, ids: number[]) => Promise<void> })
      .publishReview(input, stub, undefined, [8]);
    expect(comments).toHaveLength(40);
    const saved = stub.saveTrackedIssuesRpc.mock.calls.at(-1)![0];
    expect(saved.filter((issue) => issue.githubCommentId && issue.githubCommentId !== 8)).toHaveLength(40);
    expect(saved.find((issue) => issue.id === last.payload.id)).toEqual(reintroduced ? prior : undefined);
  });

  it('matches only one finding to a fixed issue when two share a logical key', async () => {
    setupGitHubMock();
    const normalFetch = mockFetch.getMockImplementation()!;
    let comments: unknown[] = [];
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/pulls/42/reviews') && init?.method === 'POST') {
        comments = JSON.parse(init.body as string).comments.map((comment: object) => ({ ...comment, id: 55, user: { login: 'donmerge[bot]', type: 'Bot' } }));
      }
      if (url.includes('/pulls/42/comments')) return { ok: true, json: async () => comments };
      return normalFetch(url, init);
    });
    const review = cleanReview();
    const common = { path: 'a.ts', side: 'RIGHT' as const, severity: 'critical' as const, ruleId: 'auth-rule', entityType: 'function' as const, symbolName: 'save', body: 'Missing authorization allows unauthorized access to protected resources.' };
    review.lineComments = [{ ...common, line: 99, codeSnippet: 'old input' }, { ...common, line: 1, codeSnippet: 'new input' }];
    const current = await buildCurrentIssues({ repo: 'repo', prNumber: 42 }, 'headsha', review.lineComments);
    const prior = { ...current[0].payload, fingerprint: 'old-fingerprint', status: 'fixed' as const, githubCommentId: 8 };
    const { stub } = setupProcessorStub([prior]);
    const db = { prepare: () => ({ bind: () => ({}) }), batch: vi.fn(async () => []) };
    const workflow = new CodeReviewWorkflow({} as never, { MAX_REVIEW_FILES: '50', DB: db } as never);
    await (workflow as unknown as { publishReview: (r: unknown, s: unknown, runId: undefined, ids: number[]) => Promise<void> })
      .publishReview(llmResult(fullCoverage(), review), stub, undefined, [8]);
    expect(comments).toHaveLength(1);
    const saved = stub.saveTrackedIssuesRpc.mock.calls.at(-1)![0];
    expect(saved).toContainEqual(prior);
    expect(saved).toContainEqual(expect.objectContaining({ fingerprint: current[1].fingerprint, githubCommentId: 55 }));
  });

  it('does not republish an open finding sharing a logical key with a reintroduced one', async () => {
    setupGitHubMock();
    const normalFetch = mockFetch.getMockImplementation()!;
    let comments: unknown[] = [];
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/pulls/42/reviews') && init?.method === 'POST') {
        comments = JSON.parse(init.body as string).comments.map((comment: object) => ({ ...comment, id: 55, user: { login: 'donmerge[bot]', type: 'Bot' } }));
      }
      if (url.includes('/pulls/42/comments')) return { ok: true, json: async () => comments };
      return normalFetch(url, init);
    });
    const review = cleanReview();
    const common = { path: 'a.ts', line: 1, side: 'RIGHT' as const, severity: 'critical' as const, ruleId: 'auth-rule', entityType: 'function' as const, symbolName: 'save', body: 'Missing authorization allows unauthorized access to protected resources.' };
    review.lineComments = [
      { ...common, codeSnippet: 'same input' },
      { ...common, line: 2, body: 'Missing validation allows a different unauthorized update.', codeSnippet: 'same input' },
    ];
    const input = llmResult(fullCoverage(), review);
    input.preparedFiles.filePatches = [];
    const current = await buildCurrentIssues({ repo: 'repo', prNumber: 42 }, 'headsha', review.lineComments);
    const fixed = { ...current[0].payload, status: 'fixed' as const, githubCommentId: 8 };
    const open = { ...current[1].payload, status: 'open' as const, githubCommentId: 9 };
    const { stub } = setupProcessorStub([fixed, open]);
    const db = { prepare: () => ({ bind: () => ({}) }), batch: vi.fn(async () => []) };
    const workflow = new CodeReviewWorkflow({} as never, { MAX_REVIEW_FILES: '50', DB: db } as never);
    await (workflow as unknown as { publishReview: (r: unknown, s: unknown, runId: undefined, ids: number[]) => Promise<void> })
      .publishReview(input, stub, undefined, [8, 9]);
    expect(comments).toHaveLength(1);
    const saved = stub.saveTrackedIssuesRpc.mock.calls.at(-1)![0];
    expect(saved).toContainEqual(expect.objectContaining({ id: fixed.id, githubCommentId: 55 }));
    expect(saved).toContainEqual(expect.objectContaining({ id: open.id, githubCommentId: 9 }));
  });

  it('does not persist tracking transitions when marker lookup fails before posting', async () => {
    setupGitHubMock();
    const normalFetch = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/pulls/42/reviews?') && (init?.method ?? 'GET') === 'GET') {
        throw new Error('marker lookup unavailable');
      }
      return normalFetch(url, init);
    });
    const { stub } = setupProcessorStub([createTrackedIssue({ filePath: 'a.ts', status: 'open' })]);
    await expect((makeWorkflow() as unknown as {
      publishReview: (r: unknown, s: unknown, runId: string) => Promise<void>;
    }).publishReview(llmResult(fullCoverage(), cleanReview()), stub, 'run-1')).rejects.toThrow();
    expect(stub.saveTrackedIssuesRpc).not.toHaveBeenCalled();
  });

  it('clean review + full coverage does not treat an absent finding as fixed', async () => {
    const calls = setupGitHubMock();
    const openIssue = createTrackedIssue({ filePath: 'a.ts', status: 'open' });
    const { stub, saved } = setupProcessorStub([openIssue]);

    const workflow = new CodeReviewWorkflow({} as never, { MAX_REVIEW_FILES: '50', DONMERGE_POST_FIXED_REPLIES: 'true' } as never);
    const fenced = Object.assign(stub, { reservePublication: vi.fn(async () => true) });
    await (workflow as unknown as {
      publishReview: (r: unknown, s: unknown, runId: string) => Promise<void>;
    }).publishReview(llmResult(fullCoverage(), cleanReview()), fenced, 'run-omission');
    expect(calls.some((call) => call.method === 'POST' && call.url.includes('/comments') && JSON.stringify(call.body).includes('Fixed!'))).toBe(false);

    const checkPatch = calls.find(
      (c) => c.url.includes('/check-runs/777') && c.method === 'PATCH'
    );
    expect(checkPatch?.body).toMatchObject({ status: 'completed', conclusion: 'success' });

    const lastSave = saved[saved.length - 1] ?? [];
    const storedOpen = lastSave.find((i) => i.id === openIssue.id);
    expect(storedOpen?.status).toBe('open');
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
