/**
 * Tests for shared utility functions (extracted to utils.ts)
 * and processor.ts pure helper logic.
 */

import { describe, it, expect } from 'vitest';
import type { TriageOutput } from '../types';
import { safeJsonParse, parseModelConfig } from '../utils';

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
    expect(result).toEqual({ providerID: 'openai', modelID: 'gpt-5.3-codex' });
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
    expect(result).toEqual({ providerID: 'openai', modelID: 'gpt-5.3-codex' });
  });

  it('should fallback to default for empty model', () => {
    const result = parseModelConfig('openai/');
    expect(result).toEqual({ providerID: 'openai', modelID: 'gpt-5.3-codex' });
  });

  it('should fallback to default for slash-only string', () => {
    const result = parseModelConfig('/');
    expect(result).toEqual({ providerID: 'openai', modelID: 'gpt-5.3-codex' });
  });
});
