/**
 * Shared utilities for the Triage workflow.
 *
 * Extracted from processor.ts and auto-fix.ts to avoid duplication.
 */

import { Buffer } from 'node:buffer';

/**
 * Parse model configuration from environment variable.
 * Format: "provider/model" or just "model" (defaults to openai).
 */
export function parseModelConfig(raw?: string): { providerID: string; modelID: string } {
  const value = (raw ?? 'openai/gpt-4o').trim();
  if (!value.includes('/')) {
    return { providerID: 'openai', modelID: value };
  }
  const [providerID, ...rest] = value.split('/');
  const modelID = rest.join('/').trim();
  if (!providerID.trim() || !modelID) {
    return { providerID: 'openai', modelID: 'gpt-4o' };
  }
  return { providerID: providerID.trim(), modelID };
}

/**
 * Safely parse JSON from LLM responses, handling markdown code blocks.
 */
export function safeJsonParse<T>(jsonText: string): T {
  if (typeof jsonText !== 'string') {
    throw new Error(`Expected prompt response to be string, received ${typeof jsonText}`);
  }
  const cleaned = jsonText
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```/, '')
    .replace(/```$/, '')
    .trim();
  return JSON.parse(cleaned) as T;
}

// TODO: consolidate with code-review/utils.ts
/**
 * Extract raw model response from a Flue error.
 *
 * When Flue's delimiter extraction fails (e.g. the model ignores
 * ---RESULT_START---/---RESULT_END--- instructions), the full model
 * response may be available in several locations depending on the
 * error shape:
 *
 *  1. error.data.rawOutput   — canonical SkillOutputError (current)
 *  2. error.rawOutput         — some Flue versions expose it at top level
 *  3. error.data.output       — alternate property name
 *  4. error.cause.data.rawOutput — nested cause chain
 *
 * Returns the raw output string if present, or null otherwise.
 */
export function extractRawFlueResponse(error: unknown): string | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const err = error as Record<string, unknown>;

  // Helper: extract a non-empty trimmed string from a candidate value
  const asString = (v: unknown): string | null => {
    if (typeof v === 'string') {
      const trimmed = v.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    return null;
  };

  // 1. Canonical: error.data.rawOutput (SkillOutputError shape)
  const data = err.data as Record<string, unknown> | undefined;
  if (data && typeof data === 'object') {
    const fromDataRawOutput = asString(data.rawOutput);
    if (fromDataRawOutput) return fromDataRawOutput;

    // 3. Alternate: error.data.output
    const fromDataOutput = asString(data.output);
    if (fromDataOutput) return fromDataOutput;
  }

  // 2. Top-level: error.rawOutput
  const fromTopLevel = asString(err.rawOutput);
  if (fromTopLevel) return fromTopLevel;

  // 4. Nested cause: error.cause.data.rawOutput
  const cause = err.cause as Record<string, unknown> | undefined;
  if (cause && typeof cause === 'object') {
    const causeData = cause.data as Record<string, unknown> | undefined;
    if (causeData && typeof causeData === 'object') {
      const fromCause = asString(causeData.rawOutput);
      if (fromCause) return fromCause;
    }
  }

  return null;
}

// TODO: consolidate with code-review/utils.ts
/**
 * Extract a JSON substring from a mixed-text LLM response.
 *
 * Tries in order:
 * 1. Strip markdown code fences (```json ... ```)
 * 2. Find first { and last } for a JSON object
 * 3. Find first [ and last ] for a JSON array
 * 4. Return the original text as-is
 */
export function extractJsonFromResponse(text: string): string {
  const trimmed = text.trim();

  // Already valid JSON?
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return trimmed;
  }

  // Strip markdown code fences
  const noFence = trimmed
    .replace(/^```json\s*/i, '')
    .replace(/^```/, '')
    .replace(/```$/, '')
    .trim();

  if (noFence.startsWith('{') || noFence.startsWith('[')) {
    return noFence;
  }

  // Try to find JSON in mixed text by locating boundaries
  const objStart = trimmed.indexOf('{');
  const objEnd = trimmed.lastIndexOf('}');
  const arrStart = trimmed.indexOf('[');
  const arrEnd = trimmed.lastIndexOf(']');

  const hasObject = objStart !== -1 && objEnd > objStart;
  const hasArray = arrStart !== -1 && arrEnd > arrStart;

  if (hasObject && hasArray) {
    // If the array brackets encompass the object braces, use the array
    if (arrStart <= objStart && arrEnd >= objEnd) {
      return trimmed.slice(arrStart, arrEnd + 1);
    }
    // Otherwise prefer the object
    return trimmed.slice(objStart, objEnd + 1);
  }

  if (hasArray) {
    return trimmed.slice(arrStart, arrEnd + 1);
  }

  if (hasObject) {
    return trimmed.slice(objStart, objEnd + 1);
  }

  // Give up, return the cleaned text
  return noFence;
}

/**
 * Unwrap Flue's `{"type": "<json_string>"}` response wrapper.
 *
 * Flue wraps LLM output in `{"type":"..."}` where the value is a
 * JSON-serialized string of the actual payload.  This helper detects
 * that pattern and recursively unwraps it so downstream validation
 * sees the real object at the top level.
 *
 * Safe to call on any parsed value — non-objects or objects without
 * a `type` field are returned unchanged.
 */
export function unwrapFlueResponse<T>(parsed: unknown): T {
  // Handle case where parsed is a string that looks like JSON (double-encoded).
  // Flue can return a JSON-encoded string instead of a parsed object, e.g.
  //   safeJsonParse('"\"{\\\"root_cause\\\":\\\"...\\\"}\""') → "{\"root_cause\":\"...\"}"
  if (typeof parsed === 'string') {
    const trimmed = parsed.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const innerParsed = JSON.parse(trimmed);
        return unwrapFlueResponse<T>(innerParsed);
      } catch {
        // Not valid JSON, return as-is
      }
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return parsed as T;
  }

  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(obj);

  // Only unwrap when the object looks like Flue's wrapper:
  // exactly one key named "type" whose value is a string that parses as JSON.
  if (keys.length === 1 && keys[0] === 'type' && typeof obj.type === 'string') {
    const inner = obj.type.trim();
    // Quick check: must look like JSON (starts with { or [)
    if (inner.startsWith('{') || inner.startsWith('[')) {
      try {
        const innerParsed = JSON.parse(inner);
        // Recurse in case of double-wrapping
        return unwrapFlueResponse<T>(innerParsed);
      } catch {
        // Not valid JSON inside — return as-is
      }
    }
  }

  return parsed as T;
}

/**
 * Validate AutoFixOutput structure.
 *
 * Returns `{ valid: true }` when the output has the expected shape,
 * or `{ valid: false, reason }` explaining what's wrong.
 */
export function validateFixOutput(output: unknown): { valid: boolean; reason?: string } {
  if (!output || typeof output !== 'object') {
    return { valid: false, reason: 'output is not an object' };
  }
  const obj = output as Record<string, unknown>;

  if (typeof obj.file_path !== 'string' || !obj.file_path) {
    return { valid: false, reason: 'file_path must be a non-empty string' };
  }

  if (typeof obj.description !== 'string' || !obj.description) {
    return { valid: false, reason: 'description must be a non-empty string' };
  }

  if (!Array.isArray(obj.edits)) {
    return { valid: false, reason: 'edits must be an array' };
  }

  for (let i = 0; i < obj.edits.length; i++) {
    const edit = obj.edits[i] as Record<string, unknown>;
    if (!edit || typeof edit !== 'object') {
      return { valid: false, reason: `edits[${i}] must be an object` };
    }
    if (typeof edit.search !== 'string' || !edit.search) {
      return { valid: false, reason: `edits[${i}].search must be a non-empty string` };
    }
    if (typeof edit.replace !== 'string') {
      return { valid: false, reason: `edits[${i}].replace must be a string` };
    }
    if (typeof edit.description !== 'string' || !edit.description) {
      return { valid: false, reason: `edits[${i}].description must be a non-empty string` };
    }
  }

  return { valid: true };
}

// ── Base64 helpers (UTF-8 safe) ──────────────────────────────────────────────

/**
 * Encode a UTF-8 string to base64.
 *
 * Uses Buffer (available under nodejs_compat) instead of btoa(), which
 * throws on characters outside the Latin1 range (e.g. Spanish accents, emojis).
 */
export function utf8ToBase64(str: string): string {
  return Buffer.from(str, 'utf-8').toString('base64');
}

/**
 * Decode a base64 string back to a UTF-8 string.
 *
 * Uses Buffer instead of atob() so multi-byte characters round-trip correctly.
 */
export function base64ToUtf8(b64: string): string {
  return Buffer.from(b64, 'base64').toString('utf-8');
}

// ── Edit application ──────────────────────────────────────────────────────────

export interface ApplyEditsResult {
  content: string;
  applied: number;
  failed: number;
}

/**
 * Apply surgical search/replace edits to a file's content.
 *
 * Returns null when the majority of edits fail to match,
 * indicating the LLM output likely doesn't align with the source.
 */
export function applyEdits(
  content: string,
  edits: Array<{ search: string; replace: string }>
): ApplyEditsResult | null {
  let result = content;
  let applied = 0;
  let failed = 0;

  for (const edit of edits) {
    const searchTrimmed = edit.search.trim();
    if (searchTrimmed && result.includes(searchTrimmed)) {
      result = result.replace(searchTrimmed, edit.replace.trim());
      applied++;
    } else {
      console.warn('Edit search string not found, skipping', {
        search: searchTrimmed.slice(0, 100),
      });
      failed++;
    }
  }

  if (failed > applied) return null;
  return { content: result, applied, failed };
}
