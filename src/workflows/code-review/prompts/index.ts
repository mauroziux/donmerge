/**
 * Code Review Prompts Module
 *
 * Provides a structured, secure, and testable way to build LLM prompts
 * for code review. Features:
 *
 * - **Input Sanitization**: Prevents prompt injection attacks
 * - **Builder Pattern**: Fluent API for prompt construction
 * - **Externalized Templates**: Separates prompt content from logic
 *
 * @example
 * ```typescript
 * import { buildReviewPrompt } from './prompts';
 *
 * const prompt = buildReviewPrompt({
 *   owner: 'myorg',
 *   repo: 'myrepo',
 *   prNumber: 42,
 *   retrigger: false,
 *   instruction: 'Focus on security',
 *   diffText: '...',
 * });
 * ```
 *
 * @example Using the builder directly
 * ```typescript
 * import { ReviewPromptBuilder } from './prompts';
 *
 * const prompt = new ReviewPromptBuilder({ includeExample: true })
 *   .withContext(ctx)
 *   .withCustomInstruction(instruction)
 *   .withPreviousComments(comments)
 *   .build();
 * ```
 */

// Builder
export { ReviewPromptBuilder, buildReviewPrompt } from './builder';
export type { ReviewPromptContext, PromptBuilderOptions } from './builder';

// Sanitizers
export { sanitizePromptInput, sanitizeDiffText } from './sanitizers';

// Schema
export { REVIEW_OUTPUT_SCHEMA } from './schema';

// Templates (for advanced customization)
export {
  SYSTEM_PROMPT,
  PERSONALITY_SECTION,
  CRITICAL_RULES,
  COMMENT_FORMAT,
  EXAMPLE_COMMENT,
  LANGUAGE_GUIDELINES,
  CUSTOM_INSTRUCTION_TEMPLATE,
  PREVIOUS_COMMENTS_HEADER,
  DONMERGE_SKILLS_HEADER,
  DONMERGE_INSTRUCTION_TEMPLATE,
  APPROVAL_RULES,
  APPROVAL_RULES_WITH_FILE_SUMMARIES,
} from './templates';
