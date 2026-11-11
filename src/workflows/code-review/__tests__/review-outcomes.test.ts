import { describe, expect, it } from 'vitest';
import { buildReviewOutcomeInputs } from '../review-outcomes';

const finding = {
  fingerprint: 'fp-1',
  logicalKey: 'rule:src/a.ts:7',
  payload: {
    ruleId: 'rule',
    filePath: 'src/a.ts',
    line: 7,
    severity: 'critical' as const,
    body: 'Finding body',
    status: 'open',
  },
};

const marker = '<!-- DONMERGE: {"fingerprint":"fp-1","version":1} -->';

describe('buildReviewOutcomeInputs', () => {
  it('links only the exact DonMerge bot comment to the persisted finding', () => {
    const result = buildReviewOutcomeInputs([finding], [{
      id: 123,
      path: 'src/a.ts',
      line: 7,
      body: `${marker}\n\nFinding body`,
      userLogin: 'donmerge[bot]',
      userType: 'Bot',
    }]);

    expect(result).toEqual([expect.objectContaining({
      fingerprint: 'fp-1',
      githubCommentId: 123,
    })]);
  });

  it('leaves the ID unset for copied markers, other bots, wrong paths, and substring fingerprints', () => {
    const comments = [
      { id: 1, path: 'src/a.ts', line: 7, body: marker, userLogin: 'contributor', userType: 'User' },
      { id: 2, path: 'src/a.ts', line: 7, body: marker, userLogin: 'other-donmerge[bot]', userType: 'Bot' },
      { id: 3, path: 'src/b.ts', line: 7, body: marker, userLogin: 'donmerge[bot]', userType: 'Bot' },
      { id: 4, path: 'src/a.ts', line: 7, body: '<!-- DONMERGE: {"fingerprint":"fp-10","version":1} -->', userLogin: 'donmerge[bot]', userType: 'Bot' },
    ];

    const result = buildReviewOutcomeInputs([finding], comments);
    expect(result[0].githubCommentId).toBeUndefined();
  });

  it('does not reuse a stale stored ID when the published comment cannot be verified', () => {
    const result = buildReviewOutcomeInputs([finding], []);
    expect(result[0].githubCommentId).toBeUndefined();
  });
});
