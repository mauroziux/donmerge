/**
 * Tests for triggers.ts
 */

import { describe, it, expect } from 'vitest';
import {
  parseTrigger,
  extractInstruction,
  getTriggerRegex,
} from '../triggers';
import {
  createPullRequestPayload,
  createIssueCommentPayload,
  createReviewCommentPayload,
  createCheckRunPayload,
} from './helpers';

describe('parseTrigger', () => {
  // ─── pull_request events ──────────────────────────────────────────

  describe('pull_request event', () => {
    it('should trigger on "opened" action', () => {
      const payload = createPullRequestPayload({ action: 'opened' });
      const result = parseTrigger('pull_request', payload);
      expect(result).toEqual({
        shouldRun: true,
        prNumber: 42,
        retrigger: false,
      });
    });

    it('should trigger on "synchronize" action and set retrigger=true', () => {
      const payload = createPullRequestPayload({ action: 'synchronize' });
      const result = parseTrigger('pull_request', payload);
      expect(result).toEqual({
        shouldRun: true,
        prNumber: 42,
        retrigger: true,
      });
    });

    it('should trigger on "reopened" action', () => {
      const payload = createPullRequestPayload({ action: 'reopened' });
      const result = parseTrigger('pull_request', payload);
      expect(result).toEqual({
        shouldRun: true,
        prNumber: 42,
        retrigger: false,
      });
    });

    it('should NOT trigger on "closed" action', () => {
      const payload = createPullRequestPayload({ action: 'closed' });
      const result = parseTrigger('pull_request', payload);
      expect(result.shouldRun).toBe(false);
      expect(result.reason).toBe('ignored pull_request action');
    });

    it('should NOT trigger on "labeled" action', () => {
      const payload = createPullRequestPayload({ action: 'labeled' });
      const result = parseTrigger('pull_request', payload);
      expect(result.shouldRun).toBe(false);
    });

    it('should NOT trigger if pull_request is missing', () => {
      const payload = createPullRequestPayload({ pull_request: undefined });
      const result = parseTrigger('pull_request', payload);
      expect(result.shouldRun).toBe(false);
    });
  });

  // ─── check_run events ─────────────────────────────────────────────

  describe('check_run event', () => {
    it('should trigger on "rerequested" action with associated PRs', () => {
      const payload = createCheckRunPayload([42]);
      const result = parseTrigger('check_run', payload);
      expect(result).toEqual({
        shouldRun: true,
        prNumber: 42,
        retrigger: true,
      });
    });

    it('should NOT trigger on "completed" action', () => {
      const payload = createCheckRunPayload([42], { action: 'completed' });
      const result = parseTrigger('check_run', payload);
      expect(result.shouldRun).toBe(false);
      expect(result.reason).toBe('ignored check_run action');
    });

    it('should NOT trigger when no PRs are associated', () => {
      const payload = createCheckRunPayload([]);
      const result = parseTrigger('check_run', payload);
      expect(result.shouldRun).toBe(false);
      expect(result.reason).toBe('ignored check_run action');
    });

    it('should use the first associated PR number', () => {
      const payload = createCheckRunPayload([42, 43]);
      const result = parseTrigger('check_run', payload);
      expect(result.prNumber).toBe(42);
    });
  });

  // ─── issue_comment events ─────────────────────────────────────────

  describe('issue_comment event', () => {
    it('should trigger when comment contains @donmerge', () => {
      const payload = createIssueCommentPayload('@donmerge review this');
      const result = parseTrigger('issue_comment', payload);
      expect(result.shouldRun).toBe(true);
      expect(result.prNumber).toBe(42);
      expect(result.retrigger).toBe(true);
      expect(result.commentId).toBe(99);
      expect(result.commentType).toBe('issue');
    });

    it('should NOT trigger if issue is not a PR', () => {
      const payload = createIssueCommentPayload('@donmerge review this', {
        issue: { number: 42 }, // no pull_request key
      });
      const result = parseTrigger('issue_comment', payload);
      expect(result.shouldRun).toBe(false);
    });

    it('should NOT trigger on "edited" action even with trigger tag', () => {
      const payload = createIssueCommentPayload('@donmerge review', { action: 'edited' });
      const result = parseTrigger('issue_comment', payload);
      expect(result.shouldRun).toBe(false);
    });

    it('should NOT trigger without the trigger tag', () => {
      const payload = createIssueCommentPayload('looks good to me');
      const result = parseTrigger('issue_comment', payload);
      expect(result.shouldRun).toBe(false);
    });

    it('should be case-insensitive for trigger tag', () => {
      const payload = createIssueCommentPayload('@DONMERGE please review');
      const result = parseTrigger('issue_comment', payload);
      expect(result.shouldRun).toBe(true);
    });

    it('should NOT trigger for non-actionable instructions (thanks)', () => {
      const payload = createIssueCommentPayload('@donmerge thanks');
      const result = parseTrigger('issue_comment', payload);
      expect(result.shouldRun).toBe(false);
      expect(result.reason).toBe('comment marked as non-actionable');
    });

    it('should NOT trigger for non-actionable instructions (ignore)', () => {
      const payload = createIssueCommentPayload('@donmerge ignore');
      const result = parseTrigger('issue_comment', payload);
      expect(result.shouldRun).toBe(false);
    });

    it('should NOT trigger for "wont fix"', () => {
      const payload = createIssueCommentPayload('@donmerge wont fix');
      const result = parseTrigger('issue_comment', payload);
      expect(result.shouldRun).toBe(false);
    });

    it('should extract focus files from instruction', () => {
      const payload = createIssueCommentPayload('@donmerge focus on `src/auth.ts` and `src/api.ts`');
      const result = parseTrigger('issue_comment', payload);
      expect(result.shouldRun).toBe(true);
      expect(result.focusFiles).toContain('src/auth.ts');
      expect(result.focusFiles).toContain('src/api.ts');
    });

    it('should extract instruction text', () => {
      const payload = createIssueCommentPayload('@donmerge check for security issues');
      const result = parseTrigger('issue_comment', payload);
      expect(result.shouldRun).toBe(true);
      expect(result.instruction).toContain('check for security issues');
    });
  });

  // ─── pull_request_review_comment events ───────────────────────────

  describe('pull_request_review_comment event', () => {
    it('should trigger when review comment contains @donmerge', () => {
      const payload = createReviewCommentPayload('@donmerge re-review this');
      const result = parseTrigger('pull_request_review_comment', payload);
      expect(result.shouldRun).toBe(true);
      expect(result.prNumber).toBe(42);
      expect(result.retrigger).toBe(true);
      expect(result.commentType).toBe('review');
    });

    it('should NOT trigger without trigger tag', () => {
      const payload = createReviewCommentPayload('nice catch');
      const result = parseTrigger('pull_request_review_comment', payload);
      expect(result.shouldRun).toBe(false);
    });

    it('should NOT trigger on "edited" action', () => {
      const payload = createReviewCommentPayload('@donmerge review', { action: 'edited' });
      const result = parseTrigger('pull_request_review_comment', payload);
      expect(result.shouldRun).toBe(false);
    });
  });

  // ─── Unsupported events ───────────────────────────────────────────

  describe('unsupported events', () => {
    it('should NOT trigger for push events', () => {
      const payload = createPullRequestPayload();
      const result = parseTrigger('push', payload);
      expect(result.shouldRun).toBe(false);
      expect(result.reason).toContain('unsupported event: push');
    });

    it('should NOT trigger for issues events', () => {
      const payload = createPullRequestPayload();
      const result = parseTrigger('issues', payload);
      expect(result.shouldRun).toBe(false);
      expect(result.reason).toContain('unsupported event: issues');
    });
  });

  // ─── Custom trigger tag ───────────────────────────────────────────

  describe('custom trigger tag', () => {
    it('should use custom trigger tag', () => {
      const payload = createIssueCommentPayload('@mybot review this');
      const result = parseTrigger('issue_comment', payload, '@mybot');
      expect(result.shouldRun).toBe(true);
    });

    it('should NOT trigger with default tag when custom is configured', () => {
      const payload = createIssueCommentPayload('@donmerge review this');
      const result = parseTrigger('issue_comment', payload, '@mybot');
      expect(result.shouldRun).toBe(false);
    });
  });
});

describe('extractInstruction', () => {
  it('should extract text after trigger tag', () => {
    expect(extractInstruction('@donmerge focus on security', '@donmerge')).toBe(
      'focus on security'
    );
  });

  it('should return undefined when no instruction follows trigger tag', () => {
    expect(extractInstruction('@donmerge', '@donmerge')).toBeUndefined();
  });

  it('should handle multiline comments', () => {
    const body = '@donmerge focus on the auth module\n\nSpecifically check JWT handling';
    const result = extractInstruction(body, '@donmerge');
    expect(result).toBe('focus on the auth module');
  });

  it('should handle special regex characters in trigger tag', () => {
    expect(extractInstruction('@bot.v2 review this', '@bot.v2')).toBe('review this');
  });
});

describe('getTriggerRegex', () => {
  it('should return default regex for @donmerge', () => {
    const regex = getTriggerRegex();
    expect(regex.test('@donmerge')).toBe(true);
    expect(regex.test('@DONMERGE')).toBe(true);
    expect(regex.test('@DonMerge')).toBe(true);
  });

  it('should return regex for custom tag', () => {
    const regex = getTriggerRegex('@custom-bot');
    expect(regex.test('@custom-bot')).toBe(true);
    expect(regex.test('@donmerge')).toBe(false);
  });

  it('should escape special regex characters in custom tag', () => {
    const regex = getTriggerRegex('@bot.v2');
    expect(regex.test('@bot.v2')).toBe(true);
    expect(regex.test('@botXv2')).toBe(false);
  });
});
