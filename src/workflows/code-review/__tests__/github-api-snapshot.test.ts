/**
 * Tests for the snapshot/coverage additions to github-api.ts (plans 002 + 005-U1).
 *
 * - fetchAllPrFiles paginates the whole file list and flags the 3000-file cap
 * - fetchPrHeadSha reads the live PR head
 * - completeCheckRun reports neutral (not green) for partial-scope reviews
 * - fetchRepoContext reads at an explicit ref with deterministic per-key priority
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  completeCheckRun,
  fetchAllPrFiles,
  fetchPrHeadSha,
  fetchRepoContext,
  fetchRepoFile,
} from '../github-api';
import type { CoverageManifest } from '../review-coverage';

beforeEach(() => {
  vi.clearAllMocks();
});

function jsonResponse(body: unknown) {
  return { ok: true, json: () => Promise.resolve(body) };
}

function fileEntry(filename: string, patch = '@@ -1 +1 @@\n+x') {
  return { filename, patch };
}

describe('fetchAllPrFiles', () => {
  it('paginates until a short page and returns every file', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => fileEntry(`f${i}.ts`));
    const page2 = [fileEntry('last.ts')];
    mockFetch
      .mockResolvedValueOnce(jsonResponse(page1))
      .mockResolvedValueOnce(jsonResponse(page2));

    const discovery = await fetchAllPrFiles('owner', 'repo', 9, 'token', 101);

    expect(discovery.files).toHaveLength(101);
    expect(discovery.files[100].filename).toBe('last.ts');
    expect(discovery.apiFileCapReached).toBe(false);
    expect(discovery.pagesFetched).toBe(2);

    const firstUrl = mockFetch.mock.calls[0][0] as string;
    const secondUrl = mockFetch.mock.calls[1][0] as string;
    expect(firstUrl).toContain('per_page=100&page=1');
    expect(secondUrl).toContain('page=2');
  });

  it('stops when the declared changed-file count is covered', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(Array.from({ length: 100 }, (_, i) => fileEntry(`f${i}.ts`)))
    );

    const discovery = await fetchAllPrFiles('owner', 'repo', 9, 'token', 100);

    expect(discovery.files).toHaveLength(100);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('flags the API hard cap when 3000 files are reached', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(Array.from({ length: 100 }, (_, i) => fileEntry(`f${i}.ts`)))
    );

    const discovery = await fetchAllPrFiles('owner', 'repo', 9, 'token', 5_000);

    expect(discovery.files).toHaveLength(3_000);
    expect(discovery.apiFileCapReached).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(30);
  });
});

describe('fetchPrHeadSha', () => {
  it('returns the live PR head SHA', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ head: { sha: 'deadbeef' }, base: { ref: 'main', sha: 'cafe' } })
    );

    const sha = await fetchPrHeadSha('owner', 'repo', 9, 'token');

    expect(sha).toBe('deadbeef');
    expect(mockFetch.mock.calls[0][0] as string).toContain('/repos/owner/repo/pulls/9');
  });
});

describe('completeCheckRun with coverage', () => {
  const cleanReview = {
    approved: true,
    summary: 'Looks good',
    lineComments: [],
    criticalIssues: [],
    suggestions: [],
  };

  function partialManifest(): CoverageManifest {
    return {
      headSha: 'abc',
      changedFilesCount: 10,
      discoveredCount: 10,
      apiFileCapReached: false,
      reviewedCount: 4,
      excludedPolicyCount: 0,
      focusedOutCount: 0,
      pendingCount: 6,
      focused: false,
      focusNoMatch: false,
      diffTruncated: false,
      scopeComplete: false,
      pending: [{ path: 'f4.ts', status: 'pending-budget', reason: 'max file budget (50) reached' }],
    };
  }

  it('reports success for a clean review with complete coverage', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}));

    const complete = { ...partialManifest(), scopeComplete: true, pendingCount: 0, pending: [] };
    await completeCheckRun('owner', 'repo', 1, cleanReview, 'token', [], complete);

    const body = JSON.parse((mockFetch.mock.calls[0][1] as any).body);
    expect(body.conclusion).toBe('success');
    expect(body.output.title).toContain('✅');
    expect(body.output.text).toContain('Coverage: full');
  });

  it('reports NEUTRAL, not success, for a clean review with partial coverage', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}));

    await completeCheckRun('owner', 'repo', 1, cleanReview, 'token', [], partialManifest());

    const body = JSON.parse((mockFetch.mock.calls[0][1] as any).body);
    expect(body.conclusion).toBe('neutral');
    expect(body.output.title).toContain('Partial review');
    expect(body.output.text).toContain('Coverage: partial');
    expect(body.output.text).toContain('`f4.ts`');
    expect(body.output.text).toContain('does not certify the rest of the PR');
  });

  it('still reports failure when blocking findings exist, even with partial coverage', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}));

    await completeCheckRun(
      'owner',
      'repo',
      1,
      {
        ...cleanReview,
        approved: false,
        criticalIssues: ['Missing idempotency key causes duplicate bookings when the webhook retries'],
      },
      'token',
      [],
      partialManifest()
    );

    const body = JSON.parse((mockFetch.mock.calls[0][1] as any).body);
    expect(body.conclusion).toBe('failure');
  });

  it('verificationPending on a full-scope clean review reports NEUTRAL, not green', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}));

    const complete = { ...partialManifest(), scopeComplete: true, pendingCount: 0, pending: [] };
    await completeCheckRun(
      'owner', 'repo', 1,
      { ...cleanReview, verificationPending: true },
      'token', [], complete
    );

    const body = JSON.parse((mockFetch.mock.calls[0][1] as any).body);
    expect(body.conclusion).toBe('neutral');
    expect(body.output.title).toContain('unverified');
  });

  it('keeps the historical success default when no coverage manifest is provided', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}));

    await completeCheckRun('owner', 'repo', 1, cleanReview, 'token');

    const body = JSON.parse((mockFetch.mock.calls[0][1] as any).body);
    expect(body.conclusion).toBe('success');
  });
});

describe('fetchRepoContext (ref + deterministic priority)', () => {
  function contentsResponse(content: string) {
    return jsonResponse({
      content: btoa(content),
      encoding: 'base64',
    });
  }
  function notFound() {
    return { ok: false, status: 404, text: () => Promise.resolve('not found') };
  }

  it('reads context files at the requested ref', async () => {
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      const url = _url as string;
      if (url.includes('contents/AGENTS.md')) {
        expect(url).toContain('ref=deadbeef');
        return Promise.resolve(contentsResponse('# rules'));
      }
      return Promise.resolve(notFound());
    });

    const ctx = await fetchRepoContext('owner', 'repo', 'deadbeef', 'token');

    expect(ctx.agents).toBe('# rules');
  });

  it('prefers the highest-priority existing config per key regardless of response order', async () => {
    // .eslintrc.js responds FIRST — eslint.config.js (higher priority) must still win.
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('contents/eslint.config.js')) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return contentsResponse('flat-config');
      }
      if (url.includes('contents/.eslintrc.js')) {
        return contentsResponse('legacy-config');
      }
      return notFound();
    });

    const ctx = await fetchRepoContext('owner', 'repo', 'deadbeef', 'token');

    expect(ctx.eslint).toBe('flat-config');
  });

  it('fetchRepoFile encodes the ref parameter', async () => {
    mockFetch.mockResolvedValue(contentsResponse('x'));

    await fetchRepoFile('owner', 'repo', 'src/a.ts', 'token', 'sha with spaces');

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('contents/src/a.ts');
    expect(url).toContain('ref=sha%20with%20spaces');
  });
});

// ─── Idempotent publication (plan 004-U4) ────────────────────────────────────

import {
  findPublishedReviewForRun,
  publishReview,
  parseReviewMarker,
} from '../github-api';
import type { ReviewResult as RR } from '../types';

function cleanReviewResult(): RR {
  return {
    approved: true,
    summary: 'Nothing blocking in the reviewed scope.',
    prSummary: {
      overview: 'o',
      keyChanges: ['k'],
      codeQuality: 'q',
      testingNotes: 't',
      riskAssessment: 'Low.',
    },
    lineComments: [],
    criticalIssues: [],
    suggestions: [],
  };
}

describe('review marker with runId', () => {
  it('marker round-trips runId and stays parseable', () => {
    const marker = parseReviewMarker('<!-- DONMERGE_REVIEW: {"headSha":"abc","runId":"run-1","baseRef":"main"} -->\n\nbody');
    expect(marker).toMatchObject({ headSha: 'abc', runId: 'run-1', baseRef: 'main' });
  });

  it('legacy markers without runId still parse (read back-compat)', () => {
    const marker = parseReviewMarker('<!-- DONMERGE_REVIEW: {"headSha":"abc","baseRef":"main"} -->');
    expect(marker?.headSha).toBe('abc');
    expect(marker?.runId).toBeUndefined();
  });
});

describe('findPublishedReviewForRun', () => {
  it('matches only the same runId AND headSha', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse([
        { body: '<!-- DONMERGE_REVIEW: {"headSha":"abc","runId":"other"} -->' },
        { body: '<!-- DONMERGE_REVIEW: {"headSha":"zzz","runId":"run-1"} -->' },
        { body: '<!-- DONMERGE_REVIEW: {"headSha":"abc","runId":"run-1"} -->' },
      ])
    );

    expect(await findPublishedReviewForRun('o', 'r', 1, 'run-1', 'abc', 't')).toBe('found');
    expect(await findPublishedReviewForRun('o', 'r', 1, 'run-2', 'abc', 't')).toBe('not-found');
    expect(await findPublishedReviewForRun('o', 'r', 1, 'run-1', 'other', 't')).toBe('not-found');
  });

  it('paginates until a short page', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse(Array.from({ length: 100 }, () => ({ body: 'x' }))))
      .mockResolvedValueOnce(jsonResponse([{ body: '<!-- DONMERGE_REVIEW: {"headSha":"abc","runId":"run-1"} -->' }]));

    expect(await findPublishedReviewForRun('o', 'r', 1, 'run-1', 'abc', 't')).toBe('found');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('returns unknown (not not-found) when the scan hits its page cap', async () => {
    mockFetch.mockResolvedValue(
      jsonResponse(Array.from({ length: 100 }, () => ({ body: 'no marker here' })))
    );

    expect(await findPublishedReviewForRun('o', 'r', 1, 'run-1', 'abc', 't')).toBe('unknown');
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });
});

describe('publishReview idempotency', () => {
  function postUrls() {
    return mockFetch.mock.calls.filter(
      ([url, init]) => (url as string).endsWith('/pulls/1/reviews') && (init as RequestInit)?.method === 'POST'
    );
  }

  it('skips the POST when this run already published (step replay)', async () => {
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (url.includes('/pulls/1/reviews?') && method === 'GET') {
        return jsonResponse([
          { body: '<!-- DONMERGE_REVIEW: {"headSha":"abc","runId":"run-1"} -->\n\nearlier' },
        ]);
      }
      return jsonResponse({});
    });

    const dropped = await publishReview(
      'o', 'r', 1, 'abc', cleanReviewResult(), 't',
      undefined, undefined, 'main', 'run-1'
    );

    expect(dropped).toEqual([]);
    expect(postUrls()).toHaveLength(0);
  });

  it('posts when no marker matches, and embeds runId in the body', async () => {
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/pulls/1/reviews?')) return jsonResponse([]);
      return jsonResponse({ id: 9 });
    });

    await publishReview(
      'o', 'r', 1, 'abc', { ...cleanReviewResult(), approved: false, criticalIssues: ['x causes y'] },
      't', undefined, undefined, 'main', 'run-1'
    );

    expect(postUrls()).toHaveLength(1);
    const body = JSON.parse((postUrls()[0][1] as RequestInit).body as string);
    expect(body.body).toContain('"runId":"run-1"');
  });

  it('refuses a blind retry when the marker scan is page-capped (unknown) after an ambiguous failure', async () => {
    let postAttempts = 0;
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (url.endsWith('/pulls/1/reviews') && method === 'POST') {
        postAttempts += 1;
        return {
          ok: false,
          status: 422,
          text: async () => JSON.stringify({ message: 'An internal error occurred, please try again.' }),
        };
      }
      if (url.includes('/pulls/1/reviews?') && method === 'GET') {
        // >500 reviews without our marker: the scan cannot prove absence.
        return jsonResponse(Array.from({ length: 100 }, () => ({ body: 'x' })));
      }
      return jsonResponse({});
    });

    await expect(
      publishReview(
        'o', 'r', 1, 'abc', { ...cleanReviewResult(), approved: false, criticalIssues: ['x causes y'] },
        't', undefined, undefined, 'main', 'run-1'
      )
    ).rejects.toThrow(/refusing blind retry/);
    expect(postAttempts).toBe(1);
  });

  it('reconciles an accepted-but-lost POST instead of duplicating it', async () => {
    let postAttempts = 0;
    let posted = false;
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (url.endsWith('/pulls/1/reviews') && method === 'POST') {
        postAttempts += 1;
        if (postAttempts === 1) {
          posted = true; // GitHub accepted it but the response was lost
          return {
            ok: false,
            status: 422,
            text: async () => JSON.stringify({ message: 'An internal error occurred, please try again.' }),
          };
        }
        throw new Error('must not POST a second time');
      }
      if (url.includes('/pulls/1/reviews?') && method === 'GET') {
        // Only AFTER the first (accepted) POST does the review exist.
        return jsonResponse(
          posted
            ? [{ body: '<!-- DONMERGE_REVIEW: {"headSha":"abc","runId":"run-1"} -->\n\nposted' }]
            : []
        );
      }
      return jsonResponse({});
    });

    await publishReview(
      'o', 'r', 1, 'abc', { ...cleanReviewResult(), approved: false, criticalIssues: ['x causes y'] },
      't', undefined, undefined, 'main', 'run-1'
    );

    expect(postAttempts).toBe(1);
  });
});

// ─── Host-side file context (plan 003-U1) ────────────────────────────────────

import { fetchFileContentsAtRef } from '../github-api';

describe('fetchFileContentsAtRef', () => {
  function okBody(content: string) {
    return jsonResponse({ content: btoa(content), encoding: 'base64' });
  }

  it('fetches at the pinned ref within file and char budgets', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('contents/a.ts')) {
        expect(url).toContain('ref=head1');
        return okBody('const a = 1;');
      }
      if (url.includes('contents/b.ts')) return okBody('const b = 2;');
      return { ok: false, status: 404, text: async () => 'nf' };
    });

    const files = await fetchFileContentsAtRef('o', 'r', ['a.ts', 'b.ts', 'missing.ts'], 'head1', 't', {
      maxFiles: 8,
      maxCharsPerFile: 100,
      maxCharsTotal: 1_000,
    });

    expect(files.map((f) => f.path)).toEqual(['a.ts', 'b.ts']);
  });

  it('drops files that would exceed the total budget (no partial overflow)', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('big1')) return okBody('x'.repeat(60));
      if (url.includes('big2')) return okBody('y'.repeat(60));
      return { ok: false, status: 404, text: async () => 'nf' };
    });

    const files = await fetchFileContentsAtRef('o', 'r', ['big1.ts', 'big2.ts'], 'head1', 't', {
      maxFiles: 8,
      maxCharsPerFile: 100,
      maxCharsTotal: 100,
    });

    expect(files).toHaveLength(1);
  });

  it('caps the number of files fetched regardless of path count', async () => {
    const requested: string[] = [];
    mockFetch.mockImplementation(async (url: string) => {
      const match = url.match(/contents\/([^?]+)/);
      if (match) requested.push(match[1]);
      return { ok: false, status: 404, text: async () => 'nf' };
    });

    await fetchFileContentsAtRef('o', 'r', ['a', 'b', 'c'], 'head1', 't', {
      maxFiles: 2,
      maxCharsPerFile: 10,
      maxCharsTotal: 100,
    });

    expect(requested).toEqual(['a', 'b']);
  });
});
