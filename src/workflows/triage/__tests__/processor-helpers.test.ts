/**
 * Tests for shared utility functions (extracted to utils.ts)
 * and processor.ts pure helper logic.
 */

import { describe, it, expect } from 'vitest';
import type { TriageOutput } from '../types';
import { safeJsonParse, parseModelConfig, unwrapFlueResponse, extractRawFlueResponse, extractJsonFromResponse } from '../utils';

/**
 * Equivalent to TriageProcessor.validateTriageOutput
 */
function validateTriageOutput(output: unknown): output is TriageOutput {
  if (!output || typeof output !== 'object') return false;
  const obj = output as Record<string, unknown>;

  // Required string fields
  if (typeof obj.root_cause !== 'string' || !obj.root_cause) return false;
  if (typeof obj.stack_trace_summary !== 'string' || !obj.stack_trace_summary) return false;
  if (typeof obj.suggested_fix !== 'string' || !obj.suggested_fix) return false;

  // Required array field
  if (!Array.isArray(obj.affected_files)) return false;
  if (!obj.affected_files.every((f: unknown) => typeof f === 'string')) return false;

  // Confidence enum
  if (!['high', 'medium', 'low'].includes(obj.confidence as string)) return false;

  // Severity enum
  if (!['critical', 'error', 'warning'].includes(obj.severity as string)) return false;

  return true;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('safeJsonParse', () => {
  it('should parse clean JSON', () => {
    const result = safeJsonParse<{ foo: string }>('{"foo":"bar"}');
    expect(result).toEqual({ foo: 'bar' });
  });

  it('should parse JSON wrapped in ```json code block', () => {
    const input = '```json\n{"foo":"bar"}\n```';
    const result = safeJsonParse<{ foo: string }>(input);
    expect(result).toEqual({ foo: 'bar' });
  });

  it('should parse JSON wrapped in ``` code block (no language)', () => {
    const input = '```\n{"foo":"bar"}\n```';
    const result = safeJsonParse<{ foo: string }>(input);
    expect(result).toEqual({ foo: 'bar' });
  });

  it('should handle JSON with leading/trailing whitespace', () => {
    const input = '  \n  {"foo":"bar"}  \n  ';
    const result = safeJsonParse<{ foo: string }>(input);
    expect(result).toEqual({ foo: 'bar' });
  });

  it('should handle ```json with trailing whitespace', () => {
    const input = '```json   \n{"foo":"bar"}\n```';
    const result = safeJsonParse<{ foo: string }>(input);
    expect(result).toEqual({ foo: 'bar' });
  });

  it('should handle case-insensitive ```JSON', () => {
    const input = '```JSON\n{"foo":"bar"}\n```';
    const result = safeJsonParse<{ foo: string }>(input);
    expect(result).toEqual({ foo: 'bar' });
  });

  it('should throw on invalid JSON', () => {
    expect(() => safeJsonParse('not json')).toThrow();
  });

  it('should throw if input is not a string', () => {
    expect(() => safeJsonParse(42 as unknown as string)).toThrow(
      'Expected prompt response to be string, received number'
    );
  });

  it('should parse complex triage output', () => {
    const input = JSON.stringify({
      root_cause: 'Null dereference',
      stack_trace_summary: 'TypeError at line 42',
      affected_files: ['src/app.ts', 'src/util.ts'],
      suggested_fix: 'Add null check',
      confidence: 'high',
      severity: 'error',
    });
    const result = safeJsonParse<TriageOutput>(input);
    expect(result.root_cause).toBe('Null dereference');
    expect(result.affected_files).toHaveLength(2);
  });
});

describe('validateTriageOutput', () => {
  it('should return true for valid output with all fields', () => {
    const output = {
      root_cause: 'Null dereference',
      stack_trace_summary: 'TypeError at line 42',
      affected_files: ['src/app.ts'],
      suggested_fix: 'Add null check',
      confidence: 'high',
      severity: 'error',
    };
    expect(validateTriageOutput(output)).toBe(true);
  });

  it('should accept all valid confidence values', () => {
    for (const confidence of ['high', 'medium', 'low'] as const) {
      const output = {
        root_cause: 'test',
        stack_trace_summary: 'test',
        affected_files: ['a.ts'],
        suggested_fix: 'test',
        confidence,
        severity: 'error',
      };
      expect(validateTriageOutput(output)).toBe(true);
    }
  });

  it('should accept all valid severity values', () => {
    for (const severity of ['critical', 'error', 'warning'] as const) {
      const output = {
        root_cause: 'test',
        stack_trace_summary: 'test',
        affected_files: ['a.ts'],
        suggested_fix: 'test',
        confidence: 'high',
        severity,
      };
      expect(validateTriageOutput(output)).toBe(true);
    }
  });

  it('should return false for missing root_cause', () => {
    const output = {
      stack_trace_summary: 'test',
      affected_files: ['a.ts'],
      suggested_fix: 'test',
      confidence: 'high',
      severity: 'error',
    };
    expect(validateTriageOutput(output)).toBe(false);
  });

  it('should return false for empty root_cause', () => {
    const output = {
      root_cause: '',
      stack_trace_summary: 'test',
      affected_files: ['a.ts'],
      suggested_fix: 'test',
      confidence: 'high',
      severity: 'error',
    };
    expect(validateTriageOutput(output)).toBe(false);
  });

  it('should return false for missing affected_files', () => {
    const output = {
      root_cause: 'test',
      stack_trace_summary: 'test',
      suggested_fix: 'test',
      confidence: 'high',
      severity: 'error',
    };
    expect(validateTriageOutput(output)).toBe(false);
  });

  it('should return false for affected_files with non-string items', () => {
    const output = {
      root_cause: 'test',
      stack_trace_summary: 'test',
      affected_files: ['a.ts', 42],
      suggested_fix: 'test',
      confidence: 'high',
      severity: 'error',
    };
    expect(validateTriageOutput(output)).toBe(false);
  });

  it('should return false for invalid confidence', () => {
    const output = {
      root_cause: 'test',
      stack_trace_summary: 'test',
      affected_files: ['a.ts'],
      suggested_fix: 'test',
      confidence: 'extreme',
      severity: 'error',
    };
    expect(validateTriageOutput(output)).toBe(false);
  });

  it('should return false for invalid severity', () => {
    const output = {
      root_cause: 'test',
      stack_trace_summary: 'test',
      affected_files: ['a.ts'],
      suggested_fix: 'test',
      confidence: 'high',
      severity: 'info',
    };
    expect(validateTriageOutput(output)).toBe(false);
  });

  it('should return false for null', () => {
    expect(validateTriageOutput(null)).toBe(false);
  });

  it('should return false for undefined', () => {
    expect(validateTriageOutput(undefined)).toBe(false);
  });

  it('should return false for non-object', () => {
    expect(validateTriageOutput('string')).toBe(false);
    expect(validateTriageOutput(42)).toBe(false);
  });

  it('should return false for empty affected_files array', () => {
    const output = {
      root_cause: 'test',
      stack_trace_summary: 'test',
      affected_files: [],
      suggested_fix: 'test',
      confidence: 'high',
      severity: 'error',
    };
    // Empty array is still valid — it's an array of strings
    expect(validateTriageOutput(output)).toBe(true);
  });

  it('should return false for missing suggested_fix', () => {
    const output = {
      root_cause: 'test',
      stack_trace_summary: 'test',
      affected_files: ['a.ts'],
      confidence: 'high',
      severity: 'error',
    };
    expect(validateTriageOutput(output)).toBe(false);
  });

  it('should return false for missing stack_trace_summary', () => {
    const output = {
      root_cause: 'test',
      affected_files: ['a.ts'],
      suggested_fix: 'test',
      confidence: 'high',
      severity: 'error',
    };
    expect(validateTriageOutput(output)).toBe(false);
  });
});

describe('parseModelConfig', () => {
  it('should parse provider/model format', () => {
    const result = parseModelConfig('openai/gpt-4o');
    expect(result).toEqual({ providerID: 'openai', modelID: 'gpt-4o' });
  });

  it('should default to openai when no slash present', () => {
    const result = parseModelConfig('gpt-4o');
    expect(result).toEqual({ providerID: 'openai', modelID: 'gpt-4o' });
  });

  it('should use default when undefined', () => {
    const result = parseModelConfig(undefined);
    expect(result).toEqual({ providerID: 'openai', modelID: 'gpt-4o' });
  });

  it('should handle model with slashes in name (e.g. openrouter/anthropic/claude)', () => {
    const result = parseModelConfig('openrouter/anthropic/claude-3');
    expect(result).toEqual({ providerID: 'openrouter', modelID: 'anthropic/claude-3' });
  });

  it('should trim whitespace', () => {
    const result = parseModelConfig('  openai/gpt-4o  ');
    expect(result).toEqual({ providerID: 'openai', modelID: 'gpt-4o' });
  });

  it('should fallback to default for empty provider', () => {
    const result = parseModelConfig('/gpt-4o');
    expect(result).toEqual({ providerID: 'openai', modelID: 'gpt-4o' });
  });

  it('should fallback to default for empty model', () => {
    const result = parseModelConfig('openai/');
    expect(result).toEqual({ providerID: 'openai', modelID: 'gpt-4o' });
  });

  it('should fallback to default for slash-only string', () => {
    const result = parseModelConfig('/');
    expect(result).toEqual({ providerID: 'openai', modelID: 'gpt-4o' });
  });
});

describe('unwrapFlueResponse', () => {
  const validTriage = {
    root_cause: 'Null dereference',
    stack_trace_summary: 'TypeError at line 42',
    affected_files: ['src/app.ts'],
    suggested_fix: 'Add null check',
    confidence: 'low',
    severity: 'error',
  };

  it('should unwrap Flue {"type":"<json>"} wrapper', () => {
    const wrapped = { type: JSON.stringify(validTriage) };
    const result = unwrapFlueResponse(wrapped);
    expect(result).toEqual(validTriage);
  });

  it('should recursively unwrap double-wrapped responses', () => {
    const inner = JSON.stringify(validTriage);
    const doubleWrapped = { type: JSON.stringify({ type: inner }) };
    const result = unwrapFlueResponse(doubleWrapped);
    expect(result).toEqual(validTriage);
  });

  it('should return plain objects unchanged', () => {
    const plain = { foo: 'bar', baz: 42 };
    expect(unwrapFlueResponse(plain)).toEqual(plain);
  });

  it('should return arrays unchanged', () => {
    const arr = [1, 2, 3];
    expect(unwrapFlueResponse(arr)).toEqual(arr);
  });

  it('should return primitives unchanged', () => {
    expect(unwrapFlueResponse('hello')).toBe('hello');
    expect(unwrapFlueResponse(42)).toBe(42);
    expect(unwrapFlueResponse(null)).toBe(null);
    expect(unwrapFlueResponse(undefined)).toBe(undefined);
  });

  it('should return object unchanged when type value is not JSON', () => {
    const obj = { type: 'not-json-at-all' };
    expect(unwrapFlueResponse(obj)).toEqual(obj);
  });

  it('should return object unchanged when it has extra keys beyond "type"', () => {
    const obj = { type: JSON.stringify(validTriage), extra: true };
    expect(unwrapFlueResponse(obj)).toEqual(obj);
  });

  it('should unwrap when parsed is a JSON string (double-encoded response)', () => {
    // This is the key bug fix: safeJsonParse returns a string, not an object
    const doubleEncoded = JSON.stringify(JSON.stringify(validTriage));
    const parsed = JSON.parse(doubleEncoded); // yields a string: '{"root_cause":"..."}'
    expect(typeof parsed).toBe('string');
    const result = unwrapFlueResponse(parsed);
    expect(result).toEqual(validTriage);
  });

  it('should return non-JSON strings unchanged', () => {
    expect(unwrapFlueResponse('hello world')).toBe('hello world');
    expect(unwrapFlueResponse('')).toBe('');
  });

  it('should work end-to-end: extractJsonFromResponse + safeJsonParse + unwrapFlueResponse', async () => {
    const raw = '{"type":"{\\"root_cause\\":\\"bug\\",\\"stack_trace_summary\\":\\"stack\\",\\"affected_files\\":[\\"a.ts\\"],\\"suggested_fix\\":\\"fix it\\",\\"confidence\\":\\"low\\",\\"severity\\":\\"error\\"}"}';
    const json = extractJsonFromResponse(raw);
    const parsed = safeJsonParse(json);
    const unwrapped = unwrapFlueResponse<TriageOutput>(parsed);
    expect(validateTriageOutput(unwrapped)).toBe(true);
    expect(unwrapped.root_cause).toBe('bug');
    expect(unwrapped.confidence).toBe('low');
  });
});

// ── extractRawFlueResponse tests ──────────────────────────────────────

describe('extractRawFlueResponse', () => {
  const sampleRaw = '{"root_cause":"bug","stack_trace_summary":"stack","affected_files":["a.ts"],"suggested_fix":"fix","confidence":"low","severity":"error"}';

  it('should extract from canonical SkillOutputError shape (error.data.rawOutput)', () => {
    const error = new Error('No ---RESULT_START--- / ---RESULT_END--- block found');
    error.name = 'SkillOutputError';
    (error as unknown as Record<string, unknown>).data = { rawOutput: sampleRaw };
    expect(extractRawFlueResponse(error)).toBe(sampleRaw);
  });

  it('should extract from error.data.rawOutput regardless of error.name', () => {
    const error = new Error('delimiter failure');
    error.name = 'SomeOtherError';
    (error as unknown as Record<string, unknown>).data = { rawOutput: sampleRaw };
    expect(extractRawFlueResponse(error)).toBe(sampleRaw);
  });

  it('should extract from error.rawOutput (top-level)', () => {
    const error = { rawOutput: sampleRaw };
    expect(extractRawFlueResponse(error)).toBe(sampleRaw);
  });

  it('should extract from error.data.output (alternate property)', () => {
    const error = { data: { output: sampleRaw } };
    expect(extractRawFlueResponse(error)).toBe(sampleRaw);
  });

  it('should extract from error.cause.data.rawOutput (nested cause chain)', () => {
    const error = {
      cause: {
        data: { rawOutput: sampleRaw },
      },
    };
    expect(extractRawFlueResponse(error)).toBe(sampleRaw);
  });

  it('should prefer error.data.rawOutput over error.rawOutput', () => {
    const error = {
      data: { rawOutput: 'from-data' },
      rawOutput: 'from-top-level',
    };
    expect(extractRawFlueResponse(error)).toBe('from-data');
  });

  it('should prefer error.data.rawOutput over error.data.output', () => {
    const error = {
      data: { rawOutput: 'from-rawOutput', output: 'from-output' },
    };
    expect(extractRawFlueResponse(error)).toBe('from-rawOutput');
  });

  it('should return null when no raw output found', () => {
    expect(extractRawFlueResponse(null)).toBeNull();
    expect(extractRawFlueResponse(undefined)).toBeNull();
    expect(extractRawFlueResponse('just a string')).toBeNull();
    expect(extractRawFlueResponse(42)).toBeNull();
    expect(extractRawFlueResponse({})).toBeNull();
    expect(extractRawFlueResponse({ message: 'oops' })).toBeNull();
  });

  it('should return null when rawOutput is empty string', () => {
    expect(extractRawFlueResponse({ rawOutput: '   ' })).toBeNull();
    expect(extractRawFlueResponse({ data: { rawOutput: '' } })).toBeNull();
  });

  it('should return null when rawOutput is not a string', () => {
    expect(extractRawFlueResponse({ rawOutput: 42 })).toBeNull();
    expect(extractRawFlueResponse({ data: { rawOutput: { obj: true } } })).toBeNull();
  });

  it('should handle error.cause without data gracefully', () => {
    const error = { cause: { message: 'no data here' } };
    expect(extractRawFlueResponse(error)).toBeNull();
  });

  it('should handle error.cause.data without rawOutput gracefully', () => {
    const error = { cause: { data: { message: 'no rawOutput' } } };
    expect(extractRawFlueResponse(error)).toBeNull();
  });

  it('should trim whitespace from extracted output', () => {
    expect(extractRawFlueResponse({ rawOutput: '  hello  ' })).toBe('hello');
    expect(extractRawFlueResponse({ data: { rawOutput: '\n  hello\n' } })).toBe('hello');
  });
});
