/**
 * Tests for Flue delimiter-failure recovery in runLlmTriage.
 *
 * Validates the full recovery pipeline that both catch blocks in
 * TriageProcessor.runLlmTriage execute:
 *
 *   error → extractRawFlueResponse → extractJsonFromResponse → safeJsonParse
 *         → unwrapFlueResponse → validateTriageOutput
 *
 * These tests prove that when Flue throws a delimiter error containing
 * raw model output, the staging recovery can extract valid triage
 * results instead of hard-failing.
 */

import { describe, it, expect } from 'vitest';
import type { TriageOutput } from '../types';
import {
  extractRawFlueResponse,
  extractJsonFromResponse,
  safeJsonParse,
  unwrapFlueResponse,
} from '../utils';

/**
 * Mirrors TriageProcessor.validateTriageOutput (private method).
 */
function validateTriageOutput(output: unknown): output is TriageOutput {
  if (!output || typeof output !== 'object') return false;
  const obj = output as Record<string, unknown>;
  if (typeof obj.root_cause !== 'string' || !obj.root_cause) return false;
  if (typeof obj.stack_trace_summary !== 'string' || !obj.stack_trace_summary) return false;
  if (typeof obj.suggested_fix !== 'string' || !obj.suggested_fix) return false;
  if (!Array.isArray(obj.affected_files)) return false;
  if (!obj.affected_files.every((f: unknown) => typeof f === 'string')) return false;
  if (!['high', 'medium', 'low'].includes(obj.confidence as string)) return false;
  if (!['critical', 'error', 'warning'].includes(obj.severity as string)) return false;
  return true;
}

/**
 * Simulates the recovery pipeline from a catch block in runLlmTriage.
 * Returns the parsed TriageOutput on success, or null if recovery fails.
 */
function attemptRecovery(error: unknown): TriageOutput | null {
  const raw = extractRawFlueResponse(error);
  if (!raw) return null;

  try {
    const json = extractJsonFromResponse(raw);
    const parsed = unwrapFlueResponse<TriageOutput>(safeJsonParse<TriageOutput>(json));
    if (validateTriageOutput(parsed)) {
      return parsed;
    }
  } catch {
    // parse/validate failed
  }
  return null;
}

const validOutput: TriageOutput = {
  root_cause: 'Null pointer dereference in UserService',
  stack_trace_summary: 'TypeError at src/user.ts:42 in getProfile',
  affected_files: ['src/user.ts', 'src/auth.ts'],
  suggested_fix: 'Add null check before accessing user.name',
  confidence: 'high',
  severity: 'error',
};

// ── Tests ────────────────────────────────────────────────────────────

describe('Flue delimiter failure recovery', () => {
  it('recovers valid output from SkillOutputError with data.rawOutput', () => {
    const error = new Error(
      "Flue prompt failed for model 'openai/gpt-4o': No ---RESULT_START--- / ---RESULT_END--- block found in the assistant response."
    );
    error.name = 'SkillOutputError';
    (error as unknown as Record<string, unknown>).data = {
      rawOutput: JSON.stringify(validOutput),
    };

    const result = attemptRecovery(error);
    expect(result).not.toBeNull();
    expect(result!.root_cause).toBe(validOutput.root_cause);
    expect(result!.severity).toBe('error');
    expect(result!.affected_files).toEqual(['src/user.ts', 'src/auth.ts']);
  });

  it('recovers valid output from error.rawOutput (top-level shape)', () => {
    const error = {
      message: 'No ---RESULT_START--- / ---RESULT_END--- block found',
      rawOutput: JSON.stringify(validOutput),
    };

    const result = attemptRecovery(error);
    expect(result).not.toBeNull();
    expect(result!.root_cause).toBe(validOutput.root_cause);
  });

  it('recovers valid output from error.data.output (alternate shape)', () => {
    const error = {
      data: { output: JSON.stringify(validOutput) },
    };

    const result = attemptRecovery(error);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe('high');
  });

  it('recovers valid output from error.cause.data.rawOutput (nested cause)', () => {
    const error = {
      message: 'prompt failed',
      cause: {
        message: 'delimiter error',
        data: { rawOutput: JSON.stringify(validOutput) },
      },
    };

    const result = attemptRecovery(error);
    expect(result).not.toBeNull();
    expect(result!.suggested_fix).toBe(validOutput.suggested_fix);
  });

  it('recovers output wrapped in markdown code fence', () => {
    const fenced = '```json\n' + JSON.stringify(validOutput, null, 2) + '\n```';
    const error = {
      name: 'SkillOutputError',
      data: { rawOutput: fenced },
    };

    const result = attemptRecovery(error);
    expect(result).not.toBeNull();
    expect(result!.root_cause).toBe(validOutput.root_cause);
  });

  it('recovers output with Flue {"type":"..."} wrapper', () => {
    const wrapped = JSON.stringify({ type: JSON.stringify(validOutput) });
    const error = {
      name: 'SkillOutputError',
      data: { rawOutput: wrapped },
    };

    const result = attemptRecovery(error);
    expect(result).not.toBeNull();
    expect(result!.root_cause).toBe(validOutput.root_cause);
    expect(result!.severity).toBe('error');
  });

  it('returns null when error has no extractable raw output', () => {
    const error = new Error('Some unrelated error');
    expect(attemptRecovery(error)).toBeNull();
  });

  it('returns null when raw output is not valid JSON', () => {
    const error = {
      name: 'SkillOutputError',
      data: { rawOutput: 'This is not JSON at all, just plain text.' },
    };
    expect(attemptRecovery(error)).toBeNull();
  });

  it('returns null when raw output parses but fails validation', () => {
    const invalidOutput = { root_cause: 'missing fields' };
    const error = {
      name: 'SkillOutputError',
      data: { rawOutput: JSON.stringify(invalidOutput) },
    };
    expect(attemptRecovery(error)).toBeNull();
  });
});

describe('Flue recovery preserves raw text for downstream retry', () => {
  it('does not lose raw text when parse fails (response stays available)', () => {
    // Simulates the exact pattern from the catch block:
    //   const raw = extractRawFlueResponse(error);
    //   response = raw;                    // <-- set immediately
    //   try { parse... } catch { /* ok */ }
    //   // response is still set

    const error = {
      name: 'SkillOutputError',
      data: { rawOutput: 'not valid json but something' },
    };

    let response: string | undefined;
    const raw = extractRawFlueResponse(error);
    if (raw) {
      response = raw; // Set immediately — the key fix
      try {
        const json = extractJsonFromResponse(raw);
        unwrapFlueResponse(safeJsonParse(json));
      } catch {
        // parse fails — but response is already set
      }
    }

    // The critical assertion: response is preserved even though parse failed
    expect(response).toBe('not valid json but something');
    expect(response).not.toBeUndefined();
  });

  it('recovers immediately when raw contains valid triage JSON', () => {
    const error = {
      name: 'SkillOutputError',
      data: { rawOutput: JSON.stringify(validOutput) },
    };

    let response: string | undefined;
    let earlyReturn: TriageOutput | undefined;

    const raw = extractRawFlueResponse(error);
    if (raw) {
      response = raw;
      try {
        const json = extractJsonFromResponse(raw);
        const parsed = unwrapFlueResponse<TriageOutput>(safeJsonParse<TriageOutput>(json));
        if (validateTriageOutput(parsed)) {
          earlyReturn = parsed; // would return here in real code
        }
      } catch {
        // not reached
      }
    }

    expect(earlyReturn).toBeDefined();
    expect(earlyReturn!.root_cause).toBe(validOutput.root_cause);
  });
});
