/**
 * Tests for fingerprint.ts (comment fingerprint utilities)
 */

import { describe, it, expect } from 'vitest';
import {
  parseFingerprint,
  attachFingerprint,
  computeFingerprint as computeCommentFingerprint,
} from '../fingerprint';

describe('parseFingerprint', () => {
  it('should parse a valid fingerprint marker', () => {
    const body = '<!-- DONMERGE: {"fingerprint":"abc123","version":1} -->\n\nReview comment';
    const result = parseFingerprint(body);
    expect(result).toEqual({ fingerprint: 'abc123', version: 1 });
  });

  it('should return null for body without marker', () => {
    expect(parseFingerprint('Just a regular comment')).toBeNull();
  });

  it('should return null for malformed JSON inside marker', () => {
    const body = '<!-- DONMERGE: invalid json -->';
    expect(parseFingerprint(body)).toBeNull();
  });

  it('should return null for missing closing tag', () => {
    const body = '<!-- DONMERGE: {"fingerprint":"abc","version":1}';
    expect(parseFingerprint(body)).toBeNull();
  });

  it('should return null for empty marker content', () => {
    const body = '<!-- DONMERGE:  -->';
    expect(parseFingerprint(body)).toBeNull();
  });

  it('should return null if fingerprint is not a string', () => {
    const body = '<!-- DONMERGE: {"fingerprint":123,"version":1} -->';
    expect(parseFingerprint(body)).toBeNull();
  });

  it('should return null if version is not a number', () => {
    const body = '<!-- DONMERGE: {"fingerprint":"abc","version":"1"} -->';
    expect(parseFingerprint(body)).toBeNull();
  });
});

describe('attachFingerprint', () => {
  it('should prepend fingerprint marker to comment body', () => {
    const result = attachFingerprint('Great review comment!', 'fp-abc');
    expect(result).toContain('<!-- DONMERGE:');
    expect(result).toContain('"fingerprint":"fp-abc"');
    expect(result).toContain('"version":1');
    expect(result).toContain('Great review comment!');
  });

  it('should place fingerprint before the body with a blank line separator', () => {
    const result = attachFingerprint('Body text', 'fp-xyz');
    expect(result).toMatch(/-->\n\nBody text$/);
  });

  it('should produce parseable output', () => {
    const fp = 'test-fingerprint-123';
    const body = 'Review comment body';
    const attached = attachFingerprint(body, fp);
    const parsed = parseFingerprint(attached);
    expect(parsed).toEqual({ fingerprint: fp, version: 1 });
  });
});

describe('computeFingerprint', () => {
  it('should produce a consistent hash for the same input', async () => {
    const input = { path: 'src/index.ts', line: 10 };
    const hash1 = await computeCommentFingerprint(input);
    const hash2 = await computeCommentFingerprint(input);
    expect(hash1).toBe(hash2);
  });

  it('should produce different hashes for different paths', async () => {
    const hash1 = await computeCommentFingerprint({ path: 'src/a.ts', line: 10 });
    const hash2 = await computeCommentFingerprint({ path: 'src/b.ts', line: 10 });
    expect(hash1).not.toBe(hash2);
  });

  it('should produce different hashes for different lines', async () => {
    const hash1 = await computeCommentFingerprint({ path: 'src/a.ts', line: 10 });
    const hash2 = await computeCommentFingerprint({ path: 'src/a.ts', line: 20 });
    expect(hash1).not.toBe(hash2);
  });

  it('should use issueKey when provided', async () => {
    const hash1 = await computeCommentFingerprint({
      path: 'src/a.ts',
      line: 10,
      issueKey: 'my-issue-key',
    });
    const hash2 = await computeCommentFingerprint({
      path: 'src/a.ts',
      line: 10,
      issueKey: 'my-issue-key',
    });
    expect(hash1).toBe(hash2);
  });

  it('should include side and severity when issueKey is not provided', async () => {
    const hash1 = await computeCommentFingerprint({
      path: 'src/a.ts',
      line: 10,
      side: 'RIGHT',
      severity: 'critical',
    });
    const hash2 = await computeCommentFingerprint({
      path: 'src/a.ts',
      line: 10,
      side: 'LEFT',
      severity: 'critical',
    });
    expect(hash1).not.toBe(hash2);
  });

  it('should lowercase path', async () => {
    const hash1 = await computeCommentFingerprint({ path: 'SRC/Index.ts', line: 10 });
    const hash2 = await computeCommentFingerprint({ path: 'src/index.ts', line: 10 });
    expect(hash1).toBe(hash2);
  });
});
