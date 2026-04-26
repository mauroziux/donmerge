/**
 * Sentry Triage Prompts Module
 *
 * Provides structured, secure, and testable prompt construction
 * for Sentry error triage analysis.
 *
 * @example
 * ```typescript
 * import { buildTriagePrompt } from './prompts';
 *
 * const prompt = buildTriagePrompt({
 *   sentryData: issueData,
 *   sourceCode: new Map([['src/app.ts', fileContent]]),
 *   sha: 'abc123',
 *   repo: 'org/repo',
 * });
 * ```
 */

// Builder
export { TriagePromptBuilder, buildTriagePrompt } from './builder';
export type { TriagePromptContext } from './builder';

// Sanitizers
export { sanitizeSentryData, sanitizeSentryTitle, formatEventForPrompt } from './sanitizers';

// Schema
export { TRIAGE_OUTPUT_SCHEMA } from './schema';

// Templates
export {
  SYSTEM_PROMPT,
  CRITICAL_RULES,
  SENTRY_DATA_HEADER,
  SOURCE_CODE_HEADER,
  OUTPUT_SCHEMA_HEADER,
  SEVERITY_GUIDELINES,
} from './templates';

// Fix prompt builder
export { FixPromptBuilder, buildFixPrompt } from './fix-builder';
export type { FixPromptContext } from './fix-builder';
export { FIX_OUTPUT_SCHEMA } from './fix-schema';
export {
  FIX_SYSTEM_PROMPT,
  FIX_RULES,
  FIX_CONTEXT_HEADER,
  FIX_SOURCE_HEADER,
  FIX_OUTPUT_HEADER,
} from './fix-templates';
