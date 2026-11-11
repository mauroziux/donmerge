/**
 * Tests for parseJobId helper in routes.ts
 */

import { describe, it, expect, vi } from 'vitest';

// Mock the processor imports that pull in cloudflare:workers
vi.mock('../../workflows/code-review/processor', () => ({
  getReviewProcessor: vi.fn(),
}));

vi.mock('../../workflows/triage/processor', () => ({
  getTriageProcessor: vi.fn(),
}));

vi.mock('../auth', () => ({
  validateApiKey: vi.fn(),
}));

import { parseJobId, handlePushReview } from '../routes';
import { validateApiKey } from '../auth';
import { getReviewProcessor } from '../../workflows/code-review/processor';

it('hashes API credentials, assigns distinct unknown-head identities, and returns 409 on conflict', async () => {
  vi.mocked(validateApiKey).mockReturnValue({ apiKey: 'caller-secret' } as never);
  const startReview = vi.fn().mockResolvedValue({ started: false, reason: 'pending_conflict' });
  vi.mocked(getReviewProcessor).mockReturnValue({ startReview } as never);
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('head unavailable'));
  const makeContext = (token: string) => ({
    req: { header: () => 'Bearer caller-secret', json: async () => ({ owner: 'acme', repo: 'repo', pr_number: 42, github_token: token }) },
    env: { ReviewProcessor: {} },
    json: (body: unknown, status: number) => ({ body, status }),
  });
  try {
    const first = await handlePushReview(makeContext('token-one')) as unknown as { status: number };
    const second = await handlePushReview(makeContext('token-two')) as unknown as { status: number };
    expect(first.status).toBe(409);
    expect(second.status).toBe(409);
    const [a, b] = startReview.mock.calls.map(([ctx]) => ctx);
    expect(a.githubCredentialHash).toMatch(/^[a-f0-9]{64}$/);
    expect(a.githubCredentialHash).not.toBe(b.githubCredentialHash);
    expect(a.requestNonce).not.toBe(b.requestNonce);
    expect(JSON.stringify({ hash: a.githubCredentialHash, caller: a.initiatorKeyHash })).not.toContain('token-one');
  } finally {
    fetchSpy.mockRestore();
    vi.clearAllMocks();
  }
});

describe('parseJobId', () => {
  it('parses review/ prefixed job IDs', () => {
    expect(parseJobId('review/acme/my-repo/42')).toEqual({
      type: 'review',
      doName: 'acme/my-repo/42',
    });
  });

  it('parses triage/ prefixed job IDs', () => {
    expect(parseJobId('triage/abc123def456')).toEqual({
      type: 'triage',
      doName: 'triage/abc123def456',
    });
  });

  it('parses sentry-triage/ prefixed job IDs (backward compat)', () => {
    expect(parseJobId('sentry-triage/abc123')).toEqual({
      type: 'triage',
      doName: 'sentry-triage/abc123',
    });
  });

  it('parses sentry-webhook/ prefixed job IDs', () => {
    expect(parseJobId('sentry-webhook/abc123')).toEqual({
      type: 'triage',
      doName: 'sentry-webhook/abc123',
    });
  });

  it('returns null for unknown prefixes', () => {
    expect(parseJobId('unknown/something')).toBeNull();
  });

  it('strips triage/ prefix when inner starts with sentry-webhook/', () => {
    expect(parseJobId('triage/sentry-webhook/abc123')).toEqual({
      type: 'triage',
      doName: 'sentry-webhook/abc123',
    });
  });

  it('strips triage/ prefix when inner starts with sentry-triage/', () => {
    expect(parseJobId('triage/sentry-triage/abc123')).toEqual({
      type: 'triage',
      doName: 'sentry-triage/abc123',
    });
  });

  it('preserves triage/ prefix for regular triage job IDs', () => {
    expect(parseJobId('triage/regular-uuid')).toEqual({
      type: 'triage',
      doName: 'triage/regular-uuid',
    });
  });

  it('returns null for empty string', () => {
    expect(parseJobId('')).toBeNull();
  });
});
