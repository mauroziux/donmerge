/**
 * Tests for github-api.ts
 *
 * Tests the pure logic parts (attachCommentMeta, parseCommentMeta) and
 * the public functions using mocked fetch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  githubFetch,
  createCheckRun,
  completeCheckRun,
  failCheckRun,
  publishReview,
} from '../github-api';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('githubFetch', () => {
  it('should make GET request with correct headers', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: 'test' }),
    });

    const result = await githubFetch<{ data: string }>(
      'https://api.github.com/repos/owner/repo/pulls/1',
      'ghp_token'
    );

    expect(mockFetch).toHaveBeenCalledWith('https://api.github.com/repos/owner/repo/pulls/1', {
      method: 'GET',
      headers: {
        Authorization: 'Bearer ghp_token',
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'codex-review-worker',
      },
      body: undefined,
    });
    expect(result).toEqual({ data: 'test' });
  });

  it('should make POST request with JSON body', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 42 }),
    });

    const result = await githubFetch<{ id: number }>(
      'https://api.github.com/repos/owner/repo/check-runs',
      'token',
      'POST',
      { name: 'test' }
    );

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/owner/repo/check-runs',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'test' }),
      })
    );
    expect(result).toEqual({ id: 42 });
  });

  it('should throw on non-ok response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve('Not Found'),
    });

    await expect(
      githubFetch('https://api.github.com/test', 'token')
    ).rejects.toThrow('GitHub API error 404: Not Found');
  });

  it('should make PATCH request', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    await githubFetch('https://api.github.com/test', 'token', 'PATCH', { body: 'update' });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/test',
      expect.objectContaining({ method: 'PATCH' })
    );
  });
});

describe('createCheckRun', () => {
  it('should POST to check-runs endpoint with correct payload', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: 12345 }),
    });

    const result = await createCheckRun('owner', 'repo', 'abc123sha', 'token');

    expect(result).toEqual({ id: 12345 });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/owner/repo/check-runs',
      expect.objectContaining({
        method: 'POST',
      })
    );

    // Verify the body payload
    const call = mockFetch.mock.calls[0][1] as any;
    const body = JSON.parse(call.body);
    expect(body.name).toBe('DonMerge 🤠 Review');
    expect(body.head_sha).toBe('abc123sha');
    expect(body.status).toBe('in_progress');
  });
});

describe('completeCheckRun', () => {
  it('should PATCH check run with success conclusion when approved', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

    await completeCheckRun(
      'owner', 'repo', 123, {
        approved: true,
        summary: 'Looks great!',
        lineComments: [],
        criticalIssues: [],
        suggestions: [],
      },
      'token'
    );

    const call = mockFetch.mock.calls[0][1] as any;
    const body = JSON.parse(call.body);
    expect(body.status).toBe('completed');
    expect(body.conclusion).toBe('success');
    expect(body.output.title).toContain('✅');
  });

  it('should PATCH check run with failure conclusion when not approved', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

    await completeCheckRun(
      'owner', 'repo', 123, {
        approved: false,
        summary: 'Issues found',
        lineComments: [],
        criticalIssues: ['SQL injection allows attackers to bypass authentication and read user data'],
        suggestions: ['Add tests'],
      },
      'token'
    );

    const call = mockFetch.mock.calls[0][1] as any;
    const body = JSON.parse(call.body);
    expect(body.conclusion).toBe('failure');
    expect(body.output.title).toContain('⚠️');
    expect(body.output.text).toContain('SQL injection allows attackers');
    expect(body.output.text).toContain('Add tests');
  });

  it('should not fail with no visible or validated critical findings', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

    await completeCheckRun(
      'owner', 'repo', 123, {
        approved: false,
        summary: 'Duplicate issues were filtered out',
        lineComments: [],
        criticalIssues: [],
        suggestions: [],
      },
      'token'
    );

    const call = mockFetch.mock.calls[0][1] as any;
    const body = JSON.parse(call.body);
    expect(body.conclusion).toBe('success');
    expect(body.output.title).toContain('✅');
    expect(body.output.text).toContain('- None, ¡nada que objetar!');
  });

  it('should not fail for vague criticalIssues with only domain keywords', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

    await completeCheckRun(
      'owner', 'repo', 123, {
        approved: false,
        summary: 'Vague domain-only issue',
        lineComments: [],
        criticalIssues: ['Verify token handling'],
        suggestions: [],
      },
      'token'
    );

    const call = mockFetch.mock.calls[0][1] as any;
    const body = JSON.parse(call.body);
    expect(body.conclusion).toBe('success');
    expect(body.output.text).toContain('- None, ¡nada que objetar!');
    expect(body.output.text).not.toContain('Verify token handling');
  });

  it('should not fail for vague critical line comments with only domain keywords', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

    await completeCheckRun(
      'owner', 'repo', 123, {
        approved: false,
        summary: 'Vague duplicate issue',
        lineComments: [
          {
            path: 'src/auth.ts',
            line: 12,
            side: 'RIGHT',
            severity: 'critical',
            issueKey: 'verify-token-handling',
            body: '🔴 **Issue:** Verify token handling.',
          },
        ],
        criticalIssues: [],
        suggestions: [],
      },
      'token'
    );

    const call = mockFetch.mock.calls[0][1] as any;
    const body = JSON.parse(call.body);
    expect(body.conclusion).toBe('success');
    expect(body.output.text).toContain('- None, ¡nada que objetar!');
    expect(body.output.text).not.toContain('Verify token handling');
  });

  it('should list critical line comments when criticalIssues is empty', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

    await completeCheckRun(
      'owner', 'repo', 123, {
        approved: false,
        summary: 'Issues found',
        lineComments: [
          {
            path: 'src/auth.ts',
            line: 12,
            side: 'RIGHT',
            severity: 'critical',
            issueKey: 'token-logged',
            body: '🔴 **Issue:** Token is logged when authentication fails, exposing credentials.',
          },
        ],
        criticalIssues: [],
        suggestions: [],
      },
      'token'
    );

    const call = mockFetch.mock.calls[0][1] as any;
    const body = JSON.parse(call.body);
    expect(body.conclusion).toBe('failure');
    expect(body.output.text).toContain('Token is logged when authentication fails');
  });
});

describe('failCheckRun', () => {
  it('should PATCH check run with failure and error code', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

    await failCheckRun('owner', 'repo', 123, 'DM-E001', 'Flue prompt failed for model openai/gpt-4o', 'token');

    const call = mockFetch.mock.calls[0][1] as any;
    const body = JSON.parse(call.body);
    expect(body.status).toBe('completed');
    expect(body.conclusion).toBe('failure');
    expect(body.output.title).toBe('🤠 DonMerge hit a snag [DM-E001]');
    expect(body.output.summary).toBe('Something went wrong during the review.');
    expect(body.output.text).toContain('DM-E001');
    // The text should NOT contain the raw error detail
    expect(body.output.text).not.toContain('Flue prompt failed');
  });
});

describe('publishReview (integration of guards)', () => {
  // A patch with one added line (new 11) and a context line (10/10).
  const PATCH = `@@ -10,2 +10,3 @@
 context-line
+added-line`;
  const FILES = [{ filename: 'src/a.ts', patch: PATCH }];

  it('drops bad-anchor comments, keeps valid ones, and prepends SHA metadata', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ id: 99 }) });

    const dropped = await publishReview(
      'owner', 'repo', 1, 'abc123HEAD',
      {
        approved: true,
        summary: 'Looks good overall. The new auth check is sound.',
        lineComments: [
          { path: 'src/a.ts', line: 11, side: 'RIGHT', severity: 'suggestion', body: 'nit' }, // valid
          { path: 'src/a.ts', line: 999, side: 'RIGHT', severity: 'critical', body: 'bad' }, // dropped (not in hunk)
        ],
        criticalIssues: [],
        suggestions: [],
      },
      'token',
      [], // no previous comments
      FILES,
      'main'
    );

    // exactly one POST happened
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, opts] = mockFetch.mock.calls[0] as [string, any];
    const body = JSON.parse(opts.body);

    // only the valid comment survived
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0].line).toBe(11);

    // the dropped one is reported back
    expect(dropped).toHaveLength(1);
    expect(dropped[0].line).toBe(999);

    // SHA metadata is prepended to the body
    expect(body.body.startsWith('<!-- DONMERGE_REVIEW:')).toBe(true);
    expect(body.body).toContain('abc123HEAD');
    expect(body.body).toContain('main');
    // and the real summary follows the metadata
    expect(body.body).toContain('Looks good overall');
  });

  it('substitutes a degenerate summary with the fallback', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ id: 1 }) });

    await publishReview(
      'owner', 'repo', 1, 'sha',
      {
        approved: true,
        summary: 'test', // degenerate
        lineComments: [],
        criticalIssues: [],
        suggestions: [],
      },
      'token', [], FILES
    );

    const [, opts] = mockFetch.mock.calls[0] as [string, any];
    const body = JSON.parse(opts.body);
    expect(body.body).not.toContain('"test"');
    expect(body.body).toContain('DonMerge completed the review but produced limited output');
  });

  it('skips the POST entirely on an empty non-approve review', async () => {
    const dropped = await publishReview(
      'owner', 'repo', 1, 'sha',
      {
        approved: false,
        summary: '',
        lineComments: [],
        criticalIssues: [],
        suggestions: [],
      },
      'token', [], FILES
    );

    // no POST made
    expect(mockFetch).not.toHaveBeenCalled();
    expect(dropped).toEqual([]);
  });

  it('still posts an empty APPROVE (approved=true, no body, no comments)', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ id: 1 }) });

    await publishReview(
      'owner', 'repo', 1, 'sha',
      {
        approved: true,
        summary: '',
        lineComments: [],
        criticalIssues: [],
        suggestions: [],
      },
      'token', [], FILES
    );

    // degenerate summary -> fallback; empty approve is NOT skipped
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, opts] = mockFetch.mock.calls[0] as [string, any];
    const body = JSON.parse(opts.body);
    expect(body.event).toBe('COMMENT'); // approved -> COMMENT
    expect(body.body).toContain('DonMerge completed the review but produced limited output');
  });
});
