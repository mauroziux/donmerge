/**
 * Tests for github-retry.ts — transient 422 detection and bounded retry.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  GitHubApiError,
  isTransientGitHubError,
  withBoundedRetry,
  TRANSIENT_RETRY_DELAYS_MS,
} from '../github-retry';

describe('GitHubApiError', () => {
  it('carries status and body fields', () => {
    const err = new GitHubApiError(422, 'boom');
    expect(err.status).toBe(422);
    expect(err.body).toBe('boom');
  });

  it('preserves the legacy message format for classifyError compatibility', () => {
    const err = new GitHubApiError(422, 'boom');
    expect(err.message).toBe('GitHub API error 422: boom');
  });

  it('is an instance of Error', () => {
    const err = new GitHubApiError(500, 'x');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('isTransientGitHubError', () => {
  it('returns true for 422 with transient body', () => {
    const err = new GitHubApiError(
      422,
      'An internal error occurred, please try again.'
    );
    expect(isTransientGitHubError(err)).toBe(true);
  });

  it('returns false for 422 with a validation body (anchor/suggestion)', () => {
    const err = new GitHubApiError(422, 'Validation failed: invalid line numbers');
    expect(isTransientGitHubError(err)).toBe(false);
  });

  it('returns false for 500', () => {
    const err = new GitHubApiError(500, 'internal error occurred, please try again.');
    expect(isTransientGitHubError(err)).toBe(false);
  });

  it('falls back to message parsing for plain Error', () => {
    const err = new Error('GitHub API error 422: An internal error occurred, please try again.');
    expect(isTransientGitHubError(err)).toBe(true);
  });

  it('returns false for non-GitHub errors', () => {
    expect(isTransientGitHubError(new Error('something else'))).toBe(false);
    expect(isTransientGitHubError('string')).toBe(false);
    expect(isTransientGitHubError(null)).toBe(false);
  });
});

describe('withBoundedRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the value on first success without retry', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withBoundedRetry(fn, {
      delays: [1000],
      bail: () => true,
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on a non-bailed error then succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce('ok');
    const promise = withBoundedRetry(fn, {
      delays: [1000],
      bail: () => false, // don't bail on the transient error
    });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('fails immediately when bail returns true', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('validation'));
    await expect(
      withBoundedRetry(fn, { delays: [1000, 3000], bail: () => true })
    ).rejects.toThrow('validation');
    expect(fn).toHaveBeenCalledTimes(1); // no retry
  });

  it('exhausts all attempts then rethrows the last error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('always fails'));
    const promise = withBoundedRetry(fn, {
      delays: [1000, 3000],
      bail: () => false,
    });
    // Attach the rejection handler BEFORE advancing timers to avoid an
    // unhandled-rejection window while the fake-clock sleep is pending.
    const assertion = expect(promise).rejects.toThrow('always fails');
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(3000);
    await assertion;
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('retries only transient errors when bail uses isTransientGitHubError', async () => {
    const transient = new GitHubApiError(422, 'An internal error occurred, please try again.');
    const validation = new GitHubApiError(422, 'Validation failed: bad anchor');
    // first transient, then success
    const fn = vi.fn().mockRejectedValueOnce(transient).mockResolvedValueOnce('recovered');
    const promise = withBoundedRetry(fn, {
      delays: TRANSIENT_RETRY_DELAYS_MS,
      bail: (err) => !isTransientGitHubError(err),
    });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await promise;
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);

    // now a validation error bails immediately
    const fn2 = vi.fn().mockRejectedValue(validation);
    await expect(
      withBoundedRetry(fn2, {
        delays: TRANSIENT_RETRY_DELAYS_MS,
        bail: (err) => !isTransientGitHubError(err),
      })
    ).rejects.toBe(validation);
    expect(fn2).toHaveBeenCalledTimes(1);
  });
});
