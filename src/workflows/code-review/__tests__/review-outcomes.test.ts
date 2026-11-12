import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildReviewOutcomeInputs, newlyPublishedComments } from '../review-outcomes';
import { buildCurrentIssues } from '../issue-builder';
import { attachFingerprint, computeFingerprint } from '../fingerprint';
import type { ReviewComment } from '../types';
import { publishReview } from '../github-api';

const source: ReviewComment = {
  path: 'src/a.ts', line: 7, side: 'RIGHT', severity: 'critical',
  body: 'Finding body', ruleId: 'rule', entityType: 'method',
  symbolName: 'save', codeSnippet: 'save()', issueKey: 'rule-save',
};

async function setup() {
  const findings = await buildCurrentIssues({ repo: 'repo', prNumber: 1 }, 'sha', [source]);
  const fingerprint = findings[0].fingerprint;
  const body = attachFingerprint(source.body, fingerprint);
  return { findings, fingerprint, body };
}

describe('buildReviewOutcomeInputs', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('links the exact marker produced by publishReview to the outcome', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 99 }) });
    vi.stubGlobal('fetch', fetchMock);
    await publishReview('owner', 'repo', 1, 'sha', {
      approved: false, summary: 'Review found an issue requiring attention.',
      lineComments: [source], criticalIssues: [], suggestions: [],
    }, 'token');
    const post = fetchMock.mock.calls.find((call) => call[1]?.method === 'POST');
    const posted = JSON.parse(post![1].body).comments[0];
    const findings = await buildCurrentIssues({ repo: 'repo', prNumber: 1 }, 'sha', [source]);
    const outcomes = buildReviewOutcomeInputs(findings, [{
      ...posted, id: 123, userLogin: 'donmerge[bot]', userType: 'Bot',
    }]);
    expect(outcomes[0].githubCommentId).toBe(123);
    expect(posted.body).toContain(outcomes[0].fingerprint);
  });
  it('keeps sparse findings in the same file distinct through publication and tracking', async () => {
    const sparse: ReviewComment[] = [
      { path: 'src/a.ts', line: 7, side: 'RIGHT', severity: 'critical', body: 'The first path allows duplicate requests and should use an idempotency key.' },
      { path: 'src/a.ts', line: 8, side: 'RIGHT', severity: 'critical', body: 'The second path omits authorization and allows untrusted updates.' },
    ];
    const findings = await buildCurrentIssues({ repo: 'repo', prNumber: 1 }, 'sha', sparse);
    expect(findings[0].fingerprint).not.toBe(findings[1].fingerprint);
    expect(findings[0].logicalKey).not.toBe(findings[1].logicalKey);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 99 }) });
    vi.stubGlobal('fetch', fetchMock);
    await publishReview('owner', 'repo', 1, 'sha', {
      approved: false, summary: 'Two issues need attention.', lineComments: sparse, criticalIssues: [], suggestions: [],
    }, 'token');
    const post = fetchMock.mock.calls.find((call) => call[1]?.method === 'POST');
    const comments = JSON.parse(post![1].body).comments;
    expect(comments).toHaveLength(2);
    for (const finding of findings) expect(comments.some((comment: { body: string }) => comment.body.includes(finding.fingerprint))).toBe(true);
  });

  it('distinguishes sparse identities even when only quoted text or snippets differ', async () => {
    const base: ReviewComment = { path: 'src/a.ts', line: 7, side: 'RIGHT', severity: 'critical', body: 'Validate `authorization`.' };
    const inputs = [base, { ...base, body: 'Validate `idempotency`.' }, { ...base, codeSnippet: '`first`' }, { ...base, codeSnippet: '`second`' },
      { ...base, ruleId: 'auth-check', symbolName: 'save', codeSnippet: 'save()', body: 'Check authorization' },
      { ...base, ruleId: 'auth-check', symbolName: 'save', codeSnippet: 'save()', body: 'Check idempotency' },
      { ...base, ruleId: 'first-rule' }, { ...base, ruleId: 'second-rule' }];
    const findings = await buildCurrentIssues({ repo: 'repo', prNumber: 1 }, 'sha', inputs);
    expect(new Set(findings.map((f) => f.fingerprint)).size).toBe(inputs.length);
    expect(new Set(findings.map((f) => f.logicalKey)).size).toBe(inputs.length);
    expect(new Set(findings.map((f) => f.anchorKey)).size).toBe(inputs.length);
  });

  it('distinguishes complete findings with identical metadata at different occurrences', async () => {
    const findings = await buildCurrentIssues({ repo: 'repo', prNumber: 1 }, 'sha', [
      source,
      { ...source, line: source.line + 1 },
      { ...source, body: 'A different finding at the same location.' },
      { ...source, path: 'src/A.ts' },
    ]);
    expect(new Set(findings.map((finding) => finding.fingerprint)).size).toBe(4);
    expect(new Set(findings.map((finding) => finding.logicalKey)).size).toBe(1);
  });

  it('distinguishes complete identities whose snippets differ inside backticks', async () => {
    const findings = await buildCurrentIssues({ repo: 'repo', prNumber: 1 }, 'sha', [
      { ...source, codeSnippet: 'const value = `alpha`' },
      { ...source, codeSnippet: 'const value = `beta`' },
    ]);
    expect(findings[0].fingerprint).not.toBe(findings[1].fingerprint);
    expect(findings[0].anchorKey).not.toBe(findings[1].anchorKey);
  });

  it('does not let a legacy fingerprint suppress a different sparse finding on the same line', async () => {
    const first: ReviewComment = { path: 'src/a.ts', line: 7, side: 'RIGHT', severity: 'critical', body: 'The original finding should be validated.' };
    const second = { ...first, body: 'A different issue requires authorization validation.' };
    const legacy = await computeFingerprint(first);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 99 }) });
    vi.stubGlobal('fetch', fetchMock);
    await publishReview('owner', 'repo', 1, 'sha', {
      approved: false, summary: 'Issue found.', lineComments: [second], criticalIssues: [], suggestions: [],
    }, 'token', [{ id: 1, path: first.path, line: first.line, body: attachFingerprint(first.body, legacy), fingerprint: legacy }]);
    const post = fetchMock.mock.calls.find((call) => call[1]?.method === 'POST');
    expect(JSON.parse(post![1].body).comments).toHaveLength(1);
  });

  it('does not suppress a fully identified finding from a sparse legacy marker', async () => {
    const sparse = { ...source, ruleId: undefined, entityType: undefined, symbolName: undefined, codeSnippet: undefined };
    const legacy = await computeFingerprint(sparse);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 99 }) });
    vi.stubGlobal('fetch', fetchMock);
    await publishReview('owner', 'repo', 1, 'sha', {
      approved: false, summary: 'Review found a meaningful issue.', lineComments: [source], criticalIssues: [], suggestions: [],
    }, 'token', [{ id: 1, path: source.path, line: source.line, body: attachFingerprint(sparse.body, legacy), fingerprint: legacy }]);
    const post = fetchMock.mock.calls.find((call) => call[1]?.method === 'POST');
    expect(JSON.parse(post![1].body).comments).toHaveLength(1);
  });

  it('correlates a publication fingerprint with the tracked-issue fingerprint', async () => {
    const { findings, fingerprint, body } = await setup();
    expect(findings[0].fingerprint).toBe(fingerprint);
    const result = buildReviewOutcomeInputs(findings, [{
      id: 123, path: source.path, line: source.line, body,
      userLogin: 'donmerge[bot]', userType: 'Bot',
    }]);
    expect(result[0]).toEqual(expect.objectContaining({ fingerprint, githubCommentId: 123 }));
  });

  it('rejects copied markers, other bots, wrong paths and unrelated fingerprints', async () => {
    const { findings, body } = await setup();
    const comments = [
      { id: 1, path: source.path, line: 7, body, userLogin: 'contributor', userType: 'User' },
      { id: 2, path: source.path, line: 7, body, userLogin: 'other-donmerge[bot]', userType: 'Bot' },
      { id: 3, path: 'src/b.ts', line: 7, body, userLogin: 'donmerge[bot]', userType: 'Bot' },
      { id: 4, path: source.path, line: 7, body: attachFingerprint('finding', 'wrong'), userLogin: 'donmerge[bot]', userType: 'Bot' },
    ];
    const result = buildReviewOutcomeInputs(findings, comments);
    expect(result[0].githubCommentId).toBeUndefined();
  });

  it('never associates historical comments or comments without a prior snapshot', async () => {
    const { findings, body } = await setup();
    const old = { id: 10, path: source.path, line: 7, body, userLogin: 'donmerge[bot]', userType: 'Bot' };
    const fresh = { ...old, id: 11 };
    expect(buildReviewOutcomeInputs(findings, newlyPublishedComments(new Set([10]), [old, fresh]))[0].githubCommentId).toBe(11);
    expect(buildReviewOutcomeInputs(findings, newlyPublishedComments(undefined, [fresh]))[0].githubCommentId).toBeUndefined();
  });

  it('leaves unmatched findings without an ID', async () => {
    const { findings } = await setup();
    expect(buildReviewOutcomeInputs(findings, [])[0].githubCommentId).toBeUndefined();
  });
});
