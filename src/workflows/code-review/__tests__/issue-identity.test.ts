/**
 * Tests for issue-identity.ts
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeCodeSnippet,
  normalizeRuleId,
  normalizeSymbolName,
  normalizeEntityType,
  buildLogicalKey,
  buildAnchorKey,
  computeSnippetHash,
  computeFingerprint,
} from '../issue-identity';
import { createReviewComment } from './helpers';

describe('normalizeCodeSnippet', () => {
  it('should lowercase the snippet', () => {
    expect(normalizeCodeSnippet('Hello World')).toBe('hello world');
  });

  it('should replace inline code backticks with spaces', () => {
    // normalizeCodeSnippet replaces `...` with space, then collapses whitespace
    const result = normalizeCodeSnippet('const x = `hello` + "world"');
    expect(result).toBe('const x = + "world"');
    expect(result).not.toContain('`');
  });

  it('should collapse whitespace', () => {
    expect(normalizeCodeSnippet('  hello   world  ')).toBe('hello world');
  });

  it('should trim leading/trailing whitespace', () => {
    expect(normalizeCodeSnippet('  hello  ')).toBe('hello');
  });

  it('should handle empty string', () => {
    expect(normalizeCodeSnippet('')).toBe('');
  });
});

describe('normalizeRuleId', () => {
  it('should normalize to lowercase kebab-case', () => {
    expect(normalizeRuleId('Inverted Response Check')).toBe('inverted-response-check');
  });

  it('should remove leading/trailing hyphens', () => {
    expect(normalizeRuleId('--rule-id--')).toBe('rule-id');
  });

  it('should filter out single-character segments', () => {
    expect(normalizeRuleId('a-b-c')).toBeUndefined();
  });

  it('should limit to 8 segments', () => {
    const input = 'one two three four five six seven eight nine ten';
    expect(normalizeRuleId(input)).toBe('one-two-three-four-five-six-seven-eight');
  });

  it('should return undefined for empty string', () => {
    expect(normalizeRuleId('')).toBeUndefined();
  });

  it('should return undefined for undefined', () => {
    expect(normalizeRuleId(undefined)).toBeUndefined();
  });

  it('should return undefined for whitespace-only', () => {
    expect(normalizeRuleId('   ')).toBeUndefined();
  });
});

describe('normalizeSymbolName', () => {
  it('should trim whitespace', () => {
    expect(normalizeSymbolName('  myFunction  ')).toBe('myFunction');
  });

  it('should return the value as-is (no lowercasing)', () => {
    expect(normalizeSymbolName('MyClass')).toBe('MyClass');
  });

  it('should return undefined for empty string', () => {
    expect(normalizeSymbolName('')).toBeUndefined();
  });

  it('should return undefined for undefined', () => {
    expect(normalizeSymbolName(undefined)).toBeUndefined();
  });
});

describe('normalizeEntityType', () => {
  it('should accept valid entity types', () => {
    expect(normalizeEntityType('method')).toBe('method');
    expect(normalizeEntityType('function')).toBe('function');
    expect(normalizeEntityType('class')).toBe('class');
    expect(normalizeEntityType('variable')).toBe('variable');
    expect(normalizeEntityType('module')).toBe('module');
  });

  it('should lowercase the input', () => {
    expect(normalizeEntityType('FUNCTION')).toBe('function');
  });

  it('should return undefined for invalid types', () => {
    expect(normalizeEntityType('interface')).toBeUndefined();
    expect(normalizeEntityType('type')).toBeUndefined();
    expect(normalizeEntityType('unknown')).toBeUndefined();
  });

  it('should return undefined for empty/undefined', () => {
    expect(normalizeEntityType('')).toBeUndefined();
    expect(normalizeEntityType(undefined)).toBeUndefined();
  });
});

describe('buildLogicalKey', () => {
  it('should combine ruleId, entityType, and symbolName with pipe separator', () => {
    const result = buildLogicalKey({
      ruleId: 'inverted-response',
      entityType: 'function',
      symbolName: 'myFunc',
      filePath: 'src/index.ts',
      codeSnippet: 'return !success',
    });
    expect(result).toBe('inverted-response|function|myfunc');
  });

  it('should lowercase the result', () => {
    const result = buildLogicalKey({
      ruleId: 'RULE',
      entityType: 'Class',
      symbolName: 'MyClass',
      filePath: 'src/Foo.ts',
      codeSnippet: 'code',
    });
    expect(result).toBe('rule|class|myclass');
  });
});

describe('buildAnchorKey', () => {
  it('should combine filePath and normalized code snippet', () => {
    const result = buildAnchorKey({
      ruleId: 'rule',
      entityType: 'function',
      symbolName: 'fn',
      filePath: 'src/index.ts',
      codeSnippet: 'return !success',
    });
    expect(result).toBe('src/index.ts|return !success');
  });

  it('should lowercase the result', () => {
    const result = buildAnchorKey({
      ruleId: 'rule',
      entityType: 'function',
      symbolName: 'fn',
      filePath: 'SRC/Index.ts',
      codeSnippet: 'RETURN TRUE',
    });
    expect(result).toBe('src/index.ts|return true');
  });
});

describe('computeSnippetHash', () => {
  it('should return a consistent hash for the same snippet', async () => {
    const hash1 = await computeSnippetHash('const x = 1');
    const hash2 = await computeSnippetHash('const x = 1');
    expect(hash1).toBe(hash2);
  });

  it('should return different hashes for different snippets', async () => {
    const hash1 = await computeSnippetHash('const x = 1');
    const hash2 = await computeSnippetHash('const y = 2');
    expect(hash1).not.toBe(hash2);
  });

  it('should normalize snippets before hashing', async () => {
    const hash1 = await computeSnippetHash('const X = 1');
    const hash2 = await computeSnippetHash('const x = 1');
    expect(hash1).toBe(hash2);
  });
});

describe('computeFingerprint', () => {
  const baseInput = {
    ruleId: 'inverted-response',
    entityType: 'function' as const,
    symbolName: 'myFunc',
    filePath: 'src/index.ts',
    codeSnippet: 'return !success',
  };

  it('should return a consistent fingerprint', async () => {
    const fp1 = await computeFingerprint(baseInput);
    const fp2 = await computeFingerprint(baseInput);
    expect(fp1).toBe(fp2);
  });

  it('should change when any input field changes', async () => {
    const fp1 = await computeFingerprint(baseInput);
    const fp2 = await computeFingerprint({ ...baseInput, ruleId: 'different-rule' });
    expect(fp1).not.toBe(fp2);
  });
});


