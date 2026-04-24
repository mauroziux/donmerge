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
        criticalIssues: ['SQL injection'],
        suggestions: ['Add tests'],
      },
      'token'
    );

    const call = mockFetch.mock.calls[0][1] as any;
    const body = JSON.parse(call.body);
    expect(body.conclusion).toBe('failure');
    expect(body.output.title).toContain('⚠️');
    expect(body.output.text).toContain('SQL injection');
    expect(body.output.text).toContain('Add tests');
  });
});

describe('failCheckRun', () => {
  it('should PATCH check run with failure and error code', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

    await failCheckRun('owner', 'repo', 123, 'DM-E001', 'Flue prompt failed for model openai/gpt-5.3-codex', 'token');

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
