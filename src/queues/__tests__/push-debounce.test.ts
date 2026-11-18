/**
 * Tests for push-debounce.ts — synchronize burst collapse (cost control).
 */

import { describe, it, expect } from 'vitest';

import {
  DEFAULT_PUSH_DEBOUNCE_SECONDS,
  MAX_QUEUE_DELAY_SECONDS,
  parseDebounceSeconds,
  isDebounceEnabled,
  isDebouncedPush,
  debounceSendOptions,
} from '../push-debounce';
import type { WebhookContext } from '../../workflows/code-review/types';

function syncContext(overrides: Partial<WebhookContext> = {}): WebhookContext {
  return {
    owner: 'tableoltd',
    repo: 'rms',
    prNumber: 42,
    retrigger: true,
    triggerAction: 'synchronize',
    headSha: 'abc123',
    ...overrides,
  };
}

describe('parseDebounceSeconds', () => {
  it('defaults to 600 when the env var is unset', () => {
    expect(parseDebounceSeconds(undefined)).toBe(DEFAULT_PUSH_DEBOUNCE_SECONDS);
  });

  it('defaults to 600 on garbage input', () => {
    expect(parseDebounceSeconds('abc')).toBe(DEFAULT_PUSH_DEBOUNCE_SECONDS);
    expect(parseDebounceSeconds('-5')).toBe(DEFAULT_PUSH_DEBOUNCE_SECONDS);
  });

  it('honors explicit values including 0 (disabled)', () => {
    expect(parseDebounceSeconds('0')).toBe(0);
    expect(parseDebounceSeconds('60')).toBe(60);
  });
});

describe('isDebounceEnabled', () => {
  it('is enabled by default', () => {
    expect(isDebounceEnabled({})).toBe(true);
  });

  it('is disabled when the env var is 0', () => {
    expect(isDebounceEnabled({ REVIEW_PUSH_DEBOUNCE_SECONDS: '0' })).toBe(false);
  });
});

describe('isDebouncedPush', () => {
  it('matches automatic synchronize retriggers', () => {
    expect(isDebouncedPush(syncContext())).toBe(true);
  });

  it('never debounces explicit requests', () => {
    expect(isDebouncedPush(syncContext({ commentId: 7 }))).toBe(false);
    expect(isDebouncedPush(syncContext({ instruction: 'focus on auth' }))).toBe(false);
    expect(isDebouncedPush(syncContext({ focusFiles: ['src/x.ts'] }))).toBe(false);
  });

  it('never debounces non-synchronize actions or missing head SHA', () => {
    expect(isDebouncedPush(syncContext({ triggerAction: 'opened' }))).toBe(false);
    expect(isDebouncedPush(syncContext({ headSha: undefined }))).toBe(false);
    expect(isDebouncedPush(undefined)).toBe(false);
  });
});

describe('debounceSendOptions', () => {
  it('returns a delay for automatic synchronize pushes', () => {
    const options = debounceSendOptions({}, 'pull_request', syncContext());
    expect(options).toEqual({ delaySeconds: DEFAULT_PUSH_DEBOUNCE_SECONDS });
  });

  it('caps the delay at the queue platform limit', () => {
    const options = debounceSendOptions(
      { REVIEW_PUSH_DEBOUNCE_SECONDS: '99999' },
      'pull_request',
      syncContext()
    );
    expect(options).toEqual({ delaySeconds: MAX_QUEUE_DELAY_SECONDS });
  });

  it('returns undefined for opened/reopened/comment triggers', () => {
    expect(debounceSendOptions({}, 'pull_request', syncContext({ triggerAction: 'opened' }))).toBeUndefined();
    expect(debounceSendOptions({}, 'pull_request', syncContext({ commentId: 7 }))).toBeUndefined();
    expect(debounceSendOptions({}, 'issue_comment', syncContext())).toBeUndefined();
  });

  it('returns undefined when debounce is disabled', () => {
    expect(
      debounceSendOptions({ REVIEW_PUSH_DEBOUNCE_SECONDS: '0' }, 'pull_request', syncContext())
    ).toBeUndefined();
  });
});
