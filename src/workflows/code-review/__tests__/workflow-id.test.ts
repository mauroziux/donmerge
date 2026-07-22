import { describe, expect, it } from 'vitest';
import { buildReviewWorkflowInstanceId } from '../workflow-id';

describe('buildReviewWorkflowInstanceId', () => {
  it('keeps the stable per-PR ID for ordinary PR events', () => {
    expect(buildReviewWorkflowInstanceId('tableoltd', 'rms', 3710)).toBe(
      'review-tableoltd-rms-3710'
    );
  });

  it('uses a deterministic comment-specific ID for @donmerge re-reviews', () => {
    expect(buildReviewWorkflowInstanceId('tableoltd', 'rms', 3710, 5041217452)).toBe(
      'review-tableoltd-rms-3710-comment-5041217452'
    );
  });

  it('does not add a suffix for invalid comment IDs', () => {
    expect(buildReviewWorkflowInstanceId('tableoltd', 'rms', 3710, 0)).toBe(
      'review-tableoltd-rms-3710'
    );
    expect(buildReviewWorkflowInstanceId('tableoltd', 'rms', 3710, -1)).toBe(
      'review-tableoltd-rms-3710'
    );
  });
});
