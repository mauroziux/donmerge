/**
 * General utility functions for the code review workflow.
 */

import type { ModelConfig, RepoConfig } from './types';
import { ErrorCode, type ErrorCode as ErrorCodeType } from './error-codes';

/**
 * Parse repo configurations from environment variable.
 * 
 * Format: "owner/repo:branch,owner/repo2:branch2"
 * - Branch is optional: "owner/repo" means review all PRs
 * - Branch can be specified: "owner/repo:main" means only PRs targeting main
 * 
 * Examples:
 * - "tableoltd/repo1:main,tableoltd/repo2:develop"
 * - "org/repo1:main,org/repo2,org/repo3:staging"
 */
export function parseRepoConfigs(configVar?: string): Map<string, RepoConfig> {
  const configs = new Map<string, RepoConfig>();
  const raw = (configVar ?? '').trim();
  
  if (!raw) {
    return configs;
  }
  
  const entries = raw.split(',').map(e => e.trim()).filter(e => e.length > 0);
  
  for (const entry of entries) {
    // Check if entry has branch specified: "owner/repo:branch"
    const colonIndex = entry.lastIndexOf(':');
    
    if (colonIndex > 0) {
      // Has branch specified
      const repoPart = entry.slice(0, colonIndex);
      const branch = entry.slice(colonIndex + 1);
      const [owner, repo] = repoPart.split('/');
      
      if (owner && repo) {
        const key = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
        configs.set(key, { owner, repo, baseBranch: branch });
      }
    } else {
      // No branch specified - review all PRs
      const [owner, repo] = entry.split('/');
      if (owner && repo) {
        const key = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
        configs.set(key, { owner, repo });
      }
    }
  }
  
  return configs;
}

/**
 * Get repo config for a specific repository.
 */
export function getRepoConfig(
  owner: string,
  repo: string,
  repoConfigsVar?: string
): RepoConfig | null {
  const key = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
  const repoConfigs = parseRepoConfigs(repoConfigsVar);
  return repoConfigs.get(key) ?? null;
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
 * Parse model configuration from environment variable.
 * Format: "provider/model" or just "model" (defaults to openai).
 */
export function parseModelConfig(raw?: string): ModelConfig {
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
 * Format an error from Flue prompt for logging.
 */
export function formatPromptError(error: unknown, model: string): string {
  if (!(error instanceof Error)) {
    return `Flue prompt failed for model '${model}': unknown error`;
  }

  const details = extractErrorDetails(error);
  return details
    ? `Flue prompt failed for model '${model}': ${error.message}. details=${details}`
    : `Flue prompt failed for model '${model}': ${error.message}`;
}

/**
 * Extract structured details from an error object.
 */
function extractErrorDetails(error: Error): string | null {
  const maybeStructured = error as Error & { cause?: unknown; data?: unknown };
  const candidates = [maybeStructured.cause, maybeStructured.data]
    .filter((value) => value !== undefined)
    .map((value) => safeStringify(value));

  if (candidates.length > 0) {
    return candidates.join(' | ');
  }

  const message = error.message;
  const jsonStart = message.indexOf('{');
  if (jsonStart === -1) {
    return null;
  }

  const jsonCandidate = message.slice(jsonStart);
  try {
    const parsed = JSON.parse(jsonCandidate);
    return safeStringify(parsed);
  } catch {
    return null;
  }
}

/**
 * Safely stringify a value, handling circular references.
 */
export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable error details]';
  }
}

/**
 * Classify an error into an error code and detail message.
 */
export function classifyError(error: unknown): { code: ErrorCodeType; detail: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('GitHub API error')) {
    return { code: ErrorCode.GITHUB_API, detail: message };
  }
  if (message.toLowerCase().includes('quota') ||
      message.includes('insufficient_quota') ||
      message.toLowerCase().includes('rate limit') ||
      message.includes('429')) {
    return { code: ErrorCode.QUOTA_LIMIT, detail: message };
  }
  if (message.includes('Flue prompt failed') || message.includes('SkillOutputError')) {
    return { code: ErrorCode.LLM_FAILURE, detail: message };
  }
  if (message.includes('maximum attempts') || message.includes('exceeded')) {
    return { code: ErrorCode.MAX_ATTEMPTS, detail: message };
  }
  if (message.includes('Invalid review output')) {
    return { code: ErrorCode.INVALID_OUTPUT, detail: message };
  }
  return { code: ErrorCode.INTERNAL, detail: message };
}
