/**
 * Tests for issue-lifecycle.ts
 */

import { describe, it, expect } from 'vitest';
import {
  transitionToNew,
  transitionToOpen,
  transitionToFixed,
  transitionToReintroduced,
} from '../issue-lifecycle';
import { createTrackedIssue } from './helpers';

describe('issue lifecycle transitions', () => {
  const baseIssue = createTrackedIssue({
    status: 'new',
    firstSeenCommit: 'abc123',
    lastSeenCommit: 'abc123',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  it('transitionToNew should set status to new and update lastSeenCommit', () => {
    const result = transitionToNew(baseIssue, 'def456');
    expect(result.status).toBe('new');
    expect(result.lastSeenCommit).toBe('def456');
    expect(result.updatedAt).not.toBe(baseIssue.updatedAt);
    expect(result.fixedCommit).toBeUndefined();
  });

  it('transitionToOpen should set status to open', () => {
    const result = transitionToOpen(baseIssue, 'def456');
    expect(result.status).toBe('open');
    expect(result.lastSeenCommit).toBe('def456');
  });

  it('transitionToFixed should set status to fixed and record fixedCommit', () => {
    const result = transitionToFixed(baseIssue, 'def456');
    expect(result.status).toBe('fixed');
    expect(result.fixedCommit).toBe('def456');
    expect(result.lastSeenCommit).toBe('def456');
  });

  it('transitionToReintroduced should set status to reintroduced', () => {
    const fixedIssue = createTrackedIssue({ status: 'fixed' });
    const result = transitionToReintroduced(fixedIssue, 'ghi789');
    expect(result.status).toBe('reintroduced');
    expect(result.lastSeenCommit).toBe('ghi789');
    // Should NOT set fixedCommit for reintroduced
    expect(result.fixedCommit).toBeUndefined();
  });

  it('should preserve all other fields during transition', () => {
    const result = transitionToOpen(baseIssue, 'new-sha');
    expect(result.id).toBe(baseIssue.id);
    expect(result.fingerprint).toBe(baseIssue.fingerprint);
    expect(result.repo).toBe(baseIssue.repo);
    expect(result.prNumber).toBe(baseIssue.prNumber);
    expect(result.ruleId).toBe(baseIssue.ruleId);
    expect(result.body).toBe(baseIssue.body);
    expect(result.firstSeenCommit).toBe(baseIssue.firstSeenCommit);
  });

  it('should update updatedAt timestamp', () => {
    const before = new Date();
    const result = transitionToOpen(baseIssue, 'sha');
    const after = new Date();
    const updatedAt = new Date(result.updatedAt);
    expect(updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(updatedAt.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
  });
});
