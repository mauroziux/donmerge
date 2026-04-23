/**
 * Tests for utils.ts
 */

import { describe, it, expect } from 'vitest';
import {
  parseRepoConfigs,
  getRepoConfig,
  safeJsonParse,
  parseModelConfig,
  formatPromptError,
  safeStringify,
} from '../utils';

describe('parseRepoConfigs', () => {
  it('should return empty map for empty string', () => {
    expect(parseRepoConfigs('')).toEqual(new Map());
  });

  it('should return empty map for undefined', () => {
    expect(parseRepoConfigs(undefined)).toEqual(new Map());
  });

  it('should return empty map for whitespace-only string', () => {
    expect(parseRepoConfigs('   ')).toEqual(new Map());
  });

  it('should parse single repo without branch', () => {
    const result = parseRepoConfigs('tableoltd/my-repo');
    expect(result.get('tableoltd/my-repo')).toEqual({
      owner: 'tableoltd',
      repo: 'my-repo',
    });
  });

  it('should parse single repo with branch', () => {
    const result = parseRepoConfigs('tableoltd/my-repo:main');
    expect(result.get('tableoltd/my-repo')).toEqual({
      owner: 'tableoltd',
      repo: 'my-repo',
      baseBranch: 'main',
    });
  });

  it('should parse multiple repos', () => {
    const result = parseRepoConfigs('tableoltd/repo1:main,tableoltd/repo2:develop');
    expect(result.size).toBe(2);
    expect(result.get('tableoltd/repo1')).toEqual({
      owner: 'tableoltd',
      repo: 'repo1',
      baseBranch: 'main',
    });
    expect(result.get('tableoltd/repo2')).toEqual({
      owner: 'tableoltd',
      repo: 'repo2',
      baseBranch: 'develop',
    });
  });

  it('should handle mixed repos with and without branch', () => {
    const result = parseRepoConfigs('org/repo1:main,org/repo2,org/repo3:staging');
    expect(result.size).toBe(3);
    expect(result.get('org/repo1')?.baseBranch).toBe('main');
    expect(result.get('org/repo2')?.baseBranch).toBeUndefined();
    expect(result.get('org/repo3')?.baseBranch).toBe('staging');
  });

  it('should normalize repo names to lowercase', () => {
    const result = parseRepoConfigs('TableOLTD/My-Repo:Main');
    expect(result.get('tableoltd/my-repo')).toBeDefined();
    expect(result.get('TableOLTD/My-Repo')).toBeUndefined();
  });

  it('should handle trailing/leading whitespace', () => {
    const result = parseRepoConfigs('  tableoltd/repo1:main , tableoltd/repo2  ');
    expect(result.size).toBe(2);
  });

  it('should skip empty entries from trailing comma', () => {
    const result = parseRepoConfigs('tableoltd/repo1:main,');
    expect(result.size).toBe(1);
  });

  it('should ignore entries without a slash (malformed)', () => {
    const result = parseRepoConfigs('invalid-entry:main');
    expect(result.size).toBe(0);
  });
});

describe('getRepoConfig', () => {
  it('should return config for a matching repo', () => {
    const result = getRepoConfig('tableoltd', 'repo1', 'tableoltd/repo1:main');
    expect(result).toEqual({
      owner: 'tableoltd',
      repo: 'repo1',
      baseBranch: 'main',
    });
  });

  it('should return null for non-matching repo', () => {
    const result = getRepoConfig('other', 'repo', 'tableoltd/repo1:main');
    expect(result).toBeNull();
  });

  it('should be case-insensitive', () => {
    const result = getRepoConfig('TABLEOLTD', 'REPO1', 'tableoltd/repo1:main');
    expect(result).not.toBeNull();
  });

  it('should return null for undefined config', () => {
    const result = getRepoConfig('tableoltd', 'repo1', undefined);
    expect(result).toBeNull();
  });
});

describe('safeJsonParse', () => {
  it('should parse valid JSON', () => {
    expect(safeJsonParse('{"key": "value"}')).toEqual({ key: 'value' });
  });

  it('should parse JSON wrapped in markdown code block', () => {
    const input = '```json\n{"approved": true}\n```';
    expect(safeJsonParse(input)).toEqual({ approved: true });
  });

  it('should parse JSON wrapped in bare code block', () => {
    const input = '```\n{"approved": true}\n```';
    expect(safeJsonParse(input)).toEqual({ approved: true });
  });

  it('should parse JSON with leading/trailing whitespace', () => {
    expect(safeJsonParse('  {"key": 42}  ')).toEqual({ key: 42 });
  });

  it('should throw on invalid JSON', () => {
    expect(() => safeJsonParse('not json')).toThrow();
  });

  it('should throw descriptive error for non-string input', () => {
    expect(() => safeJsonParse(42 as unknown as string)).toThrow(
      /Expected prompt response to be string/
    );
  });

  it('should handle JSON with markdown code block and extra whitespace', () => {
    const input = '```json  \n{"comments": []}\n  ```  ';
    expect(safeJsonParse(input)).toEqual({ comments: [] });
  });
});

describe('parseModelConfig', () => {
  it('should default to openai/gpt-5.3-codex for undefined', () => {
    expect(parseModelConfig(undefined)).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.3-codex',
    });
  });

  it('should treat empty string as a model name (openai provider)', () => {
    // Empty string has no '/' so it's treated as model-only, defaulting to openai provider
    expect(parseModelConfig('')).toEqual({
      providerID: 'openai',
      modelID: '',
    });
  });

  it('should parse provider/model format', () => {
    expect(parseModelConfig('anthropic/claude-3-opus')).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-3-opus',
    });
  });

  it('should treat model-only as openai', () => {
    expect(parseModelConfig('gpt-4o')).toEqual({
      providerID: 'openai',
      modelID: 'gpt-4o',
    });
  });

  it('should handle models with slashes in the ID', () => {
    expect(parseModelConfig('openai/gpt-5.3-codex')).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.3-codex',
    });
  });

  it('should handle whitespace', () => {
    expect(parseModelConfig('  openai/gpt-4o  ')).toEqual({
      providerID: 'openai',
      modelID: 'gpt-4o',
    });
  });

  it('should fallback for empty provider', () => {
    expect(parseModelConfig('/gpt-4o')).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.3-codex',
    });
  });

  it('should fallback for empty model', () => {
    expect(parseModelConfig('openai/')).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5.3-codex',
    });
  });
});

describe('formatPromptError', () => {
  it('should format a simple error', () => {
    const error = new Error('API rate limited');
    const result = formatPromptError(error, 'gpt-4o');
    expect(result).toBe("Flue prompt failed for model 'gpt-4o': API rate limited");
  });

  it('should handle non-Error input', () => {
    const result = formatPromptError('string error', 'gpt-4o');
    expect(result).toBe("Flue prompt failed for model 'gpt-4o': unknown error");
  });

  it('should include error details when available', () => {
    const error = new Error('validation failed') as Error & { cause: { field: 'body' } };
    error.cause = { field: 'body' };
    const result = formatPromptError(error, 'gpt-4o');
    expect(result).toContain('validation failed');
    expect(result).toContain('field');
  });

  it('should extract JSON details from error message', () => {
    const error = new Error('failed {"code": 429, "message": "rate limited"}');
    const result = formatPromptError(error, 'gpt-4o');
    expect(result).toContain('"code": 429');
  });

  it('should handle null error', () => {
    const result = formatPromptError(null, 'gpt-4o');
    expect(result).toBe("Flue prompt failed for model 'gpt-4o': unknown error");
  });
});

describe('safeStringify', () => {
  it('should stringify a plain object', () => {
    expect(safeStringify({ key: 'value' })).toBe('{"key":"value"}');
  });

  it('should handle circular references gracefully', () => {
    const obj: Record<string, unknown> = { name: 'test' };
    obj.self = obj;
    const result = safeStringify(obj);
    expect(result).toBe('[unserializable error details]');
  });

  it('should handle primitive values', () => {
    expect(safeStringify(42)).toBe('42');
    expect(safeStringify('hello')).toBe('"hello"');
    expect(safeStringify(null)).toBe('null');
  });
});
