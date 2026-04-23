/**
 * Tests for issue-key.ts
 */

import { describe, it, expect } from 'vitest';
import {
  deriveIssueKey,
  extractIssueSentence,
  normalizeIssueKey,
  buildIssueIdentity,
  extractIssueTerms,
} from '../issue-key';

describe('deriveIssueKey', () => {
  it('should derive key from body when issueKey is not provided', () => {
    const result = deriveIssueKey({
      body: '🔴 **Issue:** The SQL query is vulnerable to injection attacks',
    });
    expect(result).toBeDefined();
    expect(result).toContain('sql');
  });

  it('should prefer body-derived key over provided key', () => {
    const result = deriveIssueKey({
      issueKey: 'my-custom-key',
      body: '🔴 **Issue:** Response status codes are inverted',
    });
    expect(result).toContain('response');
  });

  it('should fall back to provided key when body has no Issue section', () => {
    const result = deriveIssueKey({
      issueKey: 'fallback-key',
      body: 'Just a comment',
    });
    expect(result).toBe('fallback-key');
  });

  it('should return undefined when neither body nor key provides a valid key', () => {
    const result = deriveIssueKey({
      issueKey: 'x',
      body: 'no issue section',
    });
    expect(result).toBeUndefined();
  });
});

describe('extractIssueSentence', () => {
  it('should extract text after **Issue:** (preserves original case)', () => {
    const result = extractIssueSentence('🔴 **Issue:** SQL injection vulnerability detected');
    expect(result).toContain('SQL');
    expect(result).toContain('injection');
  });

  it('should be case-insensitive', () => {
    const result = extractIssueSentence('🔴 **issue:** some problem here');
    expect(result).toContain('problem');
  });

  it('should return undefined when no Issue section exists', () => {
    expect(extractIssueSentence('No issue section here')).toBeUndefined();
  });

  it('should remove inline code backticks and replace with spaces', () => {
    const result = extractIssueSentence('🔴 **Issue:** The `getUser` function is broken');
    expect(result).not.toContain('`');
    // backtick content is replaced with space, not preserved
    expect(result).toContain('function');
  });

  it('should remove stop words', () => {
    const result = extractIssueSentence('🔴 **Issue:** This is a test of the issue extraction');
    // "this", "is", "a", "the" should be removed
    expect(result).not.toContain(' this ');
    expect(result).not.toContain(' the ');
  });
});

describe('normalizeIssueKey', () => {
  it('should normalize to lowercase kebab-case', () => {
    expect(normalizeIssueKey('SQL-Injection-Vulnerability')).toBe('sql-injection-vulnerability');
  });

  it('should filter single-character segments', () => {
    expect(normalizeIssueKey('a-b-c')).toBeUndefined();
  });

  it('should limit to 8 segments', () => {
    const input = 'one-two-three-four-five-six-seven-eight-nine';
    expect(normalizeIssueKey(input)).toBe('one-two-three-four-five-six-seven-eight');
  });

  it('should handle undefined', () => {
    expect(normalizeIssueKey(undefined)).toBeUndefined();
  });

  it('should handle empty string', () => {
    expect(normalizeIssueKey('')).toBeUndefined();
  });

  it('should strip leading/trailing hyphens', () => {
    expect(normalizeIssueKey('--key-value--')).toBe('key-value');
  });
});

describe('buildIssueIdentity', () => {
  it('should combine path and issue key', () => {
    const result = buildIssueIdentity('src/api/users.ts', 'sql-injection');
    expect(result).toBe('src/api/users.ts|sql-injection');
  });

  it('should lowercase the result', () => {
    const result = buildIssueIdentity('SRC/API/Users.ts', 'SQL-Injection');
    expect(result).toBe('src/api/users.ts|sql-injection');
  });

  it('should return undefined for undefined issue key', () => {
    expect(buildIssueIdentity('src/api/users.ts', undefined)).toBeUndefined();
  });

  it('should return undefined for invalid issue key', () => {
    expect(buildIssueIdentity('src/api/users.ts', 'x')).toBeUndefined();
  });
});

describe('extractIssueTerms', () => {
  it('should extract meaningful terms from an issue sentence', () => {
    const terms = extractIssueTerms('🔴 **Issue:** SQL injection vulnerability in query builder');
    expect(terms).toContain('sql');
    expect(terms).toContain('injection');
    expect(terms).toContain('vulnerability');
    expect(terms).toContain('query');
    expect(terms).toContain('builder');
  });

  it('should filter out terms shorter than 3 characters', () => {
    const terms = extractIssueTerms('🔴 **Issue:** The API has an XSS bug');
    expect(terms).not.toContain('an');
    // 'has' is 3 chars and not in STOP_WORDS, so it passes the length filter
    expect(terms).toContain('has');
  });

  it('should filter out stop words', () => {
    const terms = extractIssueTerms('🔴 **Issue:** The value logic has an issue with condition');
    expect(terms).not.toContain('value');
    expect(terms).not.toContain('logic');
    expect(terms).not.toContain('issue');
    expect(terms).not.toContain('condition');
  });

  it('should return empty array for body without Issue section', () => {
    expect(extractIssueTerms('No issue here')).toEqual([]);
  });
});
