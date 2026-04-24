/**
 * DonMerge Code Review Workflow
 *
 * This module provides a GitHub App code review bot that automatically reviews
 * Pull Requests when triggered by PR open/sync events or @donmerge mentions.
 */

// Types
export type {
  WorkerEnv,
  GitHubRepository,
  PullRequestPayload,
  CheckRunPayload,
  WebhookPayload,
  ReviewComment,
  PreviousComment,
  FileSummary,
  PRSummary,
  ReviewResult,
  WebhookContext,
  FastValidationResult,
  TriggerResult,
  ModelConfig,
  DonmergeSkill,
  DonmergeConfig,
  DonmergeResolved,
} from './types';

// Main entry points
export { validateWebhookFast, processGitHubCodeReviewWebhook } from './webhook';

// Individual modules (for advanced usage)
export { parseTrigger, extractInstruction, getTriggerRegex } from './triggers';
export {
  githubFetch,
  createCheckRun,
  completeCheckRun,
  failCheckRun,
  addCommentReaction,
  publishReview,
  updatePRDescription,
  fetchRepoFile,
  fetchPreviousDonMergeComments,
  resolveFixedComments,
} from './github-api';
export { resolveGitHubToken, isRepoAllowed, verifyWebhookSignature } from './github-auth';
export { safeJsonParse, parseModelConfig, formatPromptError, safeStringify, classifyError } from './utils';
export { ErrorCode, ErrorCodeDescriptions } from './error-codes';
export type { ErrorCode as ErrorCodeType } from './error-codes';
export { pemToArrayBuffer, base64UrlFromBuffer, timingSafeEqual } from './crypto';
export {
  fetchDonmergeConfig,
  validateDonmergeConfig,
  resolveDonmergeSkills,
  shouldExcludeFile,
  getSeverityOverride,
  globMatch,
} from './donmerge';

// Durable Object
export { ReviewProcessor, getReviewProcessor } from './processor';
