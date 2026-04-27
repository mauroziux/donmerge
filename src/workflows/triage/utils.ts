/**
 * Shared utilities for the Triage workflow.
 *
 * Extracted from processor.ts and auto-fix.ts to avoid duplication.
 */

/**
 * Parse model configuration from environment variable.
 * Format: "provider/model" or just "model" (defaults to openai).
 */
export function parseModelConfig(raw?: string): { providerID: string; modelID: string } {
  const value = (raw ?? 'openai/gpt-5.3-codex').trim();
  if (!value.includes('/')) {
    return { providerID: 'openai', modelID: value };
  }
  const [providerID, ...rest] = value.split('/');
  const modelID = rest.join('/').trim();
  if (!providerID.trim() || !modelID) {
    return { providerID: 'openai', modelID: 'gpt-5.3-codex' };
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
 * Extract raw model response from a Flue SkillOutputError.
 *
 * When Flue's delimiter extraction fails (e.g. the model ignores
 * ---RESULT_START---/---RESULT_END--- instructions), the full model
 * response is available on error.data.rawOutput.
 *
 * Returns the raw output string if present, or null otherwise.
 */
export function extractRawFlueResponse(error: unknown): string | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const err = error as Record<string, unknown>;

  // Check for SkillOutputError by name and data.rawOutput presence
  if (err.name !== 'SkillOutputError') {
    return null;
  }

  const data = err.data as Record<string, unknown> | undefined;
  if (!data || typeof data.rawOutput !== 'string') {
    return null;
  }

  const rawOutput = (data.rawOutput as string).trim();
  return rawOutput.length > 0 ? rawOutput : null;
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

  if (obj.patched_content !== null && typeof obj.patched_content !== 'string') {
    return { valid: false, reason: 'patched_content must be a string or null' };
  }

  return { valid: true };
}
