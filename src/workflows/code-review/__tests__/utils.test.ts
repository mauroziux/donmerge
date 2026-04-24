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
  extractRawFlueResponse,
  extractJsonFromResponse,
  classifyError,
} from '../utils';
import { ErrorCode } from '../error-codes';

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

describe('extractRawFlueResponse', () => {
  it('should extract rawOutput from a SkillOutputError', () => {
    const error = new Error('No ---RESULT_START--- block found');
    (error as Record<string, unknown>).name = 'SkillOutputError';
    (error as Record<string, unknown>).data = {
      sessionId: 'abc-123',
      rawOutput: '{"approved": true, "summary": "Looks good"}',
    };
    expect(extractRawFlueResponse(error)).toBe('{"approved": true, "summary": "Looks good"}');
  });

  it('should return null for non-SkillOutputError', () => {
    const error = new Error('some other error');
    expect(extractRawFlueResponse(error)).toBeNull();
  });

  it('should return null for null input', () => {
    expect(extractRawFlueResponse(null)).toBeNull();
  });

  it('should return null for undefined input', () => {
    expect(extractRawFlueResponse(undefined)).toBeNull();
  });

  it('should return null for string input', () => {
    expect(extractRawFlueResponse('error')).toBeNull();
  });

  it('should return null when data.rawOutput is missing', () => {
    const error = new Error('delimiter missing');
    (error as Record<string, unknown>).name = 'SkillOutputError';
    (error as Record<string, unknown>).data = { sessionId: 'abc' };
    expect(extractRawFlueResponse(error)).toBeNull();
  });

  it('should return null when data is missing entirely', () => {
    const error = new Error('delimiter missing');
    (error as Record<string, unknown>).name = 'SkillOutputError';
    expect(extractRawFlueResponse(error)).toBeNull();
  });

  it('should return null when rawOutput is an empty string', () => {
    const error = new Error('delimiter missing');
    (error as Record<string, unknown>).name = 'SkillOutputError';
    (error as Record<string, unknown>).data = { rawOutput: '   ' };
    expect(extractRawFlueResponse(error)).toBeNull();
  });

  it('should return null when rawOutput is not a string', () => {
    const error = new Error('delimiter missing');
    (error as Record<string, unknown>).name = 'SkillOutputError';
    (error as Record<string, unknown>).data = { rawOutput: 42 };
    expect(extractRawFlueResponse(error)).toBeNull();
  });

  it('should handle rawOutput with surrounding whitespace', () => {
    const error = new Error('delimiter missing');
    (error as Record<string, unknown>).name = 'SkillOutputError';
    (error as Record<string, unknown>).data = { rawOutput: '  {"key": "val"}  ' };
    expect(extractRawFlueResponse(error)).toBe('{"key": "val"}');
  });
});

describe('extractJsonFromResponse', () => {
  it('should return text as-is when it starts with {', () => {
    const json = '{"approved": true}';
    expect(extractJsonFromResponse(json)).toBe(json);
  });

  it('should return text as-is when it starts with [', () => {
    const json = '[1, 2, 3]';
    expect(extractJsonFromResponse(json)).toBe(json);
  });

  it('should strip ```json code fences', () => {
    const input = '```json\n{"approved": true}\n```';
    expect(extractJsonFromResponse(input)).toBe('{"approved": true}');
  });

  it('should strip bare ``` code fences', () => {
    const input = '```\n{"approved": true}\n```';
    expect(extractJsonFromResponse(input)).toBe('{"approved": true}');
  });

  it('should find JSON object in mixed text', () => {
    const input = 'Here is the review:\n{"approved": true, "summary": "good"}\nEnd of review.';
    expect(extractJsonFromResponse(input)).toBe('{"approved": true, "summary": "good"}');
  });

  it('should find JSON array in mixed text when no object present', () => {
    const input = 'Results:\n[{"id": 1}, {"id": 2}]\nDone.';
    expect(extractJsonFromResponse(input)).toBe('[{"id": 1}, {"id": 2}]');
  });

  it('should prefer object over array when both present', () => {
    const input = 'Stats: [1,2,3]\nData: {"key": "value"}\nEnd.';
    // First { at "Data:" line, last } at "value"} — extracts the object
    expect(extractJsonFromResponse(input)).toContain('"key"');
  });

  it('should handle text with preamble before JSON', () => {
    const input = "I've reviewed the code. Here's my assessment:\n{\"approved\": false}";
    expect(extractJsonFromResponse(input)).toBe('{"approved": false}');
  });

  it('should handle JSON with nested braces', () => {
    const input = 'Some text {"a": {"b": 1}, "c": 2} more text';
    const result = extractJsonFromResponse(input);
    expect(result).toBe('{"a": {"b": 1}, "c": 2}');
    expect(JSON.parse(result)).toEqual({ a: { b: 1 }, c: 2 });
  });

  it('should return cleaned text when no JSON boundaries found', () => {
    const input = 'Just plain text with no JSON at all';
    expect(extractJsonFromResponse(input)).toBe('Just plain text with no JSON at all');
  });

  it('should handle empty string', () => {
    expect(extractJsonFromResponse('')).toBe('');
  });

  it('should handle text that is only a code fence with JSON', () => {
    const input = '```json\n{"summary": "ok"}\n```';
    expect(extractJsonFromResponse(input)).toBe('{"summary": "ok"}');
  });

  it('should handle text with leading/trailing whitespace', () => {
    const input = '   {"key": "val"}   ';
    expect(extractJsonFromResponse(input)).toBe('{"key": "val"}');
  });
});

describe('classifyError', () => {
  it('should classify Flue prompt errors as LLM_FAILURE', () => {
    const error = new Error("Flue prompt failed for model 'openai/gpt-5.3-codex': timeout");
    const result = classifyError(error);
    expect(result.code).toBe(ErrorCode.LLM_FAILURE);
    expect(result.detail).toContain('Flue prompt failed');
  });

  it('should classify SkillOutputError as LLM_FAILURE', () => {
    const error = new Error('SkillOutputError: delimiter not found');
    const result = classifyError(error);
    expect(result.code).toBe(ErrorCode.LLM_FAILURE);
  });

  it('should classify exceeded maximum attempts as MAX_ATTEMPTS', () => {
    const error = new Error('Review exceeded maximum attempts (6)');
    const result = classifyError(error);
    expect(result.code).toBe(ErrorCode.MAX_ATTEMPTS);
  });

  it('should classify GitHub API errors as GITHUB_API', () => {
    const error = new Error('GitHub API error 403: Forbidden');
    const result = classifyError(error);
    expect(result.code).toBe(ErrorCode.GITHUB_API);
  });

  it('should classify Invalid review output as INVALID_OUTPUT', () => {
    const error = new Error('Invalid review output after retry: missing summary');
    const result = classifyError(error);
    expect(result.code).toBe(ErrorCode.INVALID_OUTPUT);
  });

  it('should classify unknown errors as INTERNAL', () => {
    const error = new Error('Something completely unexpected');
    const result = classifyError(error);
    expect(result.code).toBe(ErrorCode.INTERNAL);
  });

  it('should handle non-Error input as INTERNAL', () => {
    const result = classifyError('just a string');
    expect(result.code).toBe(ErrorCode.INTERNAL);
    expect(result.detail).toBe('just a string');
  });

  it('should preserve original message in detail', () => {
    const error = new Error('Flue prompt failed for model openai/gpt-5.3-codex: No ---RESULT_START---');
    const result = classifyError(error);
    expect(result.detail).toContain('---RESULT_START---');
  });
});
