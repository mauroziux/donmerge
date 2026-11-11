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
