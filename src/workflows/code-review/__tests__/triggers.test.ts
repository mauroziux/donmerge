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
  createReactionPayload,
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

    it('bare @donmerge → shouldRun:true, triggers review', () => {
      const payload = createIssueCommentPayload('@donmerge');
      const result = parseTrigger('issue_comment', payload);
      expect(result.shouldRun).toBe(true);
      expect(result.prNumber).toBe(42);
      expect(result.retrigger).toBe(true);
      expect(result.feedback).toBeUndefined();
    });

    it('@donmerge please review this → shouldRun:true, triggers review', () => {
      const payload = createIssueCommentPayload('@donmerge please review this');
      const result = parseTrigger('issue_comment', payload);
      expect(result.shouldRun).toBe(true);
      expect(result.instruction).toBe('please review this');
      expect(result.feedback).toBeUndefined();
    });

    it('@donmerge review → shouldRun:true, triggers review', () => {
      const payload = createIssueCommentPayload('@donmerge review');
      const result = parseTrigger('issue_comment', payload);
      expect(result.shouldRun).toBe(true);
      expect(result.feedback).toBeUndefined();
    });
  });

  // ─── Feedback command routing (issue_comment) ──────────────────────

  describe('issue_comment — feedback command routing', () => {
    it('@donmerge dismiss <fp> → shouldRun:false, routes to feedback', () => {
      const payload = createIssueCommentPayload('@donmerge dismiss abc123');
      const result = parseTrigger('issue_comment', payload);
      expect(result.shouldRun).toBe(false);
      expect(result.feedback).toEqual({ type: 'dismiss', fingerprint: 'abc123' });
      expect(result.reason).toBe('feedback command');
      expect(result.prNumber).toBe(42);
      expect(result.commentType).toBe('issue');
    });

    it('@donmerge accept <fp> → shouldRun:false, routes to feedback', () => {
      const payload = createIssueCommentPayload('@donmerge accept def456');
      const result = parseTrigger('issue_comment', payload);
      expect(result.shouldRun).toBe(false);
      expect(result.feedback).toEqual({ type: 'accept', fingerprint: 'def456' });
      expect(result.reason).toBe('feedback command');
    });

    it('@donmerge override <fp> suggestion → shouldRun:false, routes to feedback', () => {
      const payload = createIssueCommentPayload('@donmerge override abc123 suggestion');
      const result = parseTrigger('issue_comment', payload);
      expect(result.shouldRun).toBe(false);
      expect(result.feedback).toEqual({
        type: 'override',
        fingerprint: 'abc123',
        newSeverity: 'suggestion',
      });
      expect(result.reason).toBe('feedback command');
    });

    it('@donmerge preference Focus on security → shouldRun:false, routes to feedback (learning)', () => {
      const payload = createIssueCommentPayload('@donmerge preference Focus on security');
      const result = parseTrigger('issue_comment', payload);
      expect(result.shouldRun).toBe(false);
      expect(result.feedback).toEqual({ type: 'preference', text: 'Focus on security' });
      expect(result.reason).toBe('feedback command');
    });

    it('@donmerge ignore PHPDoc comments → shouldRun:false, routes to feedback (learning)', () => {
      const payload = createIssueCommentPayload('@donmerge ignore PHPDoc comments');
      const result = parseTrigger('issue_comment', payload);
      expect(result.shouldRun).toBe(false);
      expect(result.feedback).toEqual({
        type: 'preference',
        text: "Don't comment on: PHPDoc comments",
      });
      expect(result.reason).toBe('feedback command');
    });

    it('@donmerge focus authentication → shouldRun:false, routes to feedback (learning)', () => {
      const payload = createIssueCommentPayload('@donmerge focus authentication');
      const result = parseTrigger('issue_comment', payload);
      expect(result.shouldRun).toBe(false);
      expect(result.feedback).toEqual({
        type: 'preference',
        text: 'Focus on: authentication',
      });
      expect(result.reason).toBe('feedback command');
    });

    it('@donmerge focus src/auth.ts → shouldRun:true, triggers review (has file path)', () => {
      const payload = createIssueCommentPayload('@donmerge focus src/auth.ts');
      const result = parseTrigger('issue_comment', payload);
      expect(result.shouldRun).toBe(true);
      expect(result.feedback).toBeUndefined();
      expect(result.focusFiles).toContain('src/auth.ts');
    });

    it('@donmerge focus `src/auth.ts` and `src/api.ts` → shouldRun:true, triggers review', () => {
      const payload = createIssueCommentPayload(
        '@donmerge focus `src/auth.ts` and `src/api.ts`'
      );
      const result = parseTrigger('issue_comment', payload);
      expect(result.shouldRun).toBe(true);
      expect(result.focusFiles).toContain('src/auth.ts');
      expect(result.focusFiles).toContain('src/api.ts');
    });

    it('feedback commands include commentId, githubUser, inReplyToId', () => {
      const payload = createIssueCommentPayload('@donmerge dismiss abc123', {
        comment: { body: '@donmerge dismiss abc123', id: 777, in_reply_to_id: 555, user: { login: 'reviewer1' } },
      });
      const result = parseTrigger('issue_comment', payload);
      expect(result.commentId).toBe(777);
      expect(result.githubUser).toBe('reviewer1');
      expect(result.inReplyToId).toBe(555);
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

  // ─── Feedback command routing (pull_request_review_comment) ────────

  describe('pull_request_review_comment — feedback command routing', () => {
    it('@donmerge dismiss <fp> → shouldRun:false, routes to feedback', () => {
      const payload = createReviewCommentPayload('@donmerge dismiss abc123');
      const result = parseTrigger('pull_request_review_comment', payload);
      expect(result.shouldRun).toBe(false);
      expect(result.feedback).toEqual({ type: 'dismiss', fingerprint: 'abc123' });
      expect(result.reason).toBe('feedback command');
      expect(result.commentType).toBe('review');
    });

    it('@donmerge accept <fp> → shouldRun:false, routes to feedback', () => {
      const payload = createReviewCommentPayload('@donmerge accept def456');
      const result = parseTrigger('pull_request_review_comment', payload);
      expect(result.shouldRun).toBe(false);
      expect(result.feedback).toEqual({ type: 'accept', fingerprint: 'def456' });
      expect(result.reason).toBe('feedback command');
    });

    it('@donmerge override <fp> critical → shouldRun:false, routes to feedback', () => {
      const payload = createReviewCommentPayload('@donmerge override abc123 critical');
      const result = parseTrigger('pull_request_review_comment', payload);
      expect(result.shouldRun).toBe(false);
      expect(result.feedback).toEqual({
        type: 'override',
        fingerprint: 'abc123',
        newSeverity: 'critical',
      });
      expect(result.reason).toBe('feedback command');
    });

    it('@donmerge preference No PHPDoc → shouldRun:false, routes to feedback (learning)', () => {
      const payload = createReviewCommentPayload('@donmerge preference No PHPDoc needed');
      const result = parseTrigger('pull_request_review_comment', payload);
      expect(result.shouldRun).toBe(false);
      expect(result.feedback).toEqual({ type: 'preference', text: 'No PHPDoc needed' });
      expect(result.reason).toBe('feedback command');
    });

    it('@donmerge ignore logging → shouldRun:false, routes to feedback (learning)', () => {
      const payload = createReviewCommentPayload('@donmerge ignore logging statements');
      const result = parseTrigger('pull_request_review_comment', payload);
      expect(result.shouldRun).toBe(false);
      expect(result.feedback).toEqual({
        type: 'preference',
        text: "Don't comment on: logging statements",
      });
      expect(result.reason).toBe('feedback command');
    });

    it('@donmerge focus security → shouldRun:false, routes to feedback (learning)', () => {
      const payload = createReviewCommentPayload('@donmerge focus security');
      const result = parseTrigger('pull_request_review_comment', payload);
      expect(result.shouldRun).toBe(false);
      expect(result.feedback).toEqual({
        type: 'preference',
        text: 'Focus on: security',
      });
      expect(result.reason).toBe('feedback command');
    });

    it('@donmerge focus src/auth.ts → shouldRun:true, triggers review (has file path)', () => {
      const payload = createReviewCommentPayload('@donmerge focus src/auth.ts');
      const result = parseTrigger('pull_request_review_comment', payload);
      expect(result.shouldRun).toBe(true);
      expect(result.focusFiles).toContain('src/auth.ts');
    });

    it('feedback commands include commentId, githubUser, inReplyToId', () => {
      const payload = createReviewCommentPayload('@donmerge dismiss abc123', {
        comment: { body: '@donmerge dismiss abc123', id: 888, in_reply_to_id: 666, user: { login: 'reviewer2' } },
      });
      const result = parseTrigger('pull_request_review_comment', payload);
      expect(result.commentId).toBe(888);
      expect(result.githubUser).toBe('reviewer2');
      expect(result.inReplyToId).toBe(666);
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

  // ─── Reaction routing ─────────────────────────────────────────────

  describe('reaction event', () => {
    it('thumbsdown → shouldRun:false, routes to feedback (dismiss)', () => {
      const payload = createReactionPayload('thumbsdown');
      const result = parseTrigger('reaction', payload);
      expect(result.shouldRun).toBe(false);
      expect(result.feedback).toEqual({ type: 'dismiss' });
      expect(result.prNumber).toBe(42);
      expect(result.commentId).toBe(99);
      expect(result.commentType).toBe('review');
      expect(result.githubUser).toBe('dev');
    });

    it('thumbsup → shouldRun:false, routes to feedback (accept)', () => {
      const payload = createReactionPayload('thumbsup');
      const result = parseTrigger('reaction', payload);
      expect(result.shouldRun).toBe(false);
      expect(result.feedback).toEqual({ type: 'accept' });
      expect(result.prNumber).toBe(42);
      expect(result.commentId).toBe(99);
      expect(result.commentType).toBe('review');
    });

    it('non-thumbs reaction (heart) → shouldRun:false, ignored', () => {
      const payload = createReactionPayload('heart');
      const result = parseTrigger('reaction', payload);
      expect(result.shouldRun).toBe(false);
      expect(result.feedback).toBeUndefined();
      expect(result.reason).toBe('non-thumbs reaction');
    });

    it('non-thumbs reaction (hooray) → shouldRun:false, ignored', () => {
      const payload = createReactionPayload('hooray');
      const result = parseTrigger('reaction', payload);
      expect(result.shouldRun).toBe(false);
      expect(result.feedback).toBeUndefined();
      expect(result.reason).toBe('non-thumbs reaction');
    });

    it('non-thumbs reaction (laugh) → shouldRun:false, ignored', () => {
      const payload = createReactionPayload('laugh');
      const result = parseTrigger('reaction', payload);
      expect(result.shouldRun).toBe(false);
      expect(result.feedback).toBeUndefined();
      expect(result.reason).toBe('non-thumbs reaction');
    });

    it('should NOT trigger on "deleted" action', () => {
      const payload = createReactionPayload('thumbsdown', { action: 'deleted' });
      const result = parseTrigger('reaction', payload);
      expect(result.shouldRun).toBe(false);
      expect(result.reason).toBe('ignored reaction');
    });

    it('should NOT trigger if issue is not a PR', () => {
      const payload = createReactionPayload('thumbsdown', {
        issue: { number: 42 }, // no pull_request key
      });
      const result = parseTrigger('reaction', payload);
      expect(result.shouldRun).toBe(false);
      expect(result.reason).toBe('ignored reaction');
    });

    it('should NOT trigger if comment.id is missing', () => {
      const payload = createReactionPayload('thumbsdown', {
        comment: undefined,
      });
      const result = parseTrigger('reaction', payload);
      expect(result.shouldRun).toBe(false);
      expect(result.reason).toBe('ignored reaction');
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
