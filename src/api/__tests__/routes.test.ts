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

vi.mock('./auth', () => ({
  validateApiKey: vi.fn(),
}));

import { parseJobId } from '../routes';

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
