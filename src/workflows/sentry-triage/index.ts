/**
 * Sentry Triage Workflow
 *
 * This module provides automated Sentry error triage analysis,
 * fetching issue data from Sentry API, correlating with source code,
 * and using LLM analysis to produce root cause diagnosis.
 */

// Types
export type {
  SentryIssueData,
  SentryEvent,
  ParsedSentryUrl,
  SentryTriageOutput,
  SentryTriageContext,
  SentryTriageStatus,
  TrackerConfig,
  SentryTriageOptions,
  CallbackConfig,
  SentryTriageResult,
  SentryTriageEnv,
  AutoFixOutput,
  AutoFixContext,
} from './types';

// URL parser
export { parseSentryUrl } from './sentry-url-parser';

// Sentry API client
export {
  sentryFetch,
  fetchSentryIssue,
  fetchSentryEvents,
  fetchFullSentryIssue,
  transformEvent,
} from './sentry-api';

// Repo code fetcher
export {
  extractInAppPaths,
  fetchFile,
  fetchRepoCodeForTriage,
} from './repo-fetcher';

// Prompts
export {
  TriagePromptBuilder,
  buildTriagePrompt,
  sanitizeSentryData,
  sanitizeSentryTitle,
  formatEventForPrompt,
  TRIAGE_OUTPUT_SCHEMA,
  SYSTEM_PROMPT,
  CRITICAL_RULES,
  SENTRY_DATA_HEADER,
  SOURCE_CODE_HEADER,
  OUTPUT_SCHEMA_HEADER,
  SEVERITY_GUIDELINES,
} from './prompts';

// Durable Object
export { SentryTriageProcessor, getSentryTriageProcessor } from './processor';

// Shared utilities
export { parseModelConfig, safeJsonParse } from './utils';

// Auto-fix
export { runAutoFix } from './auto-fix';

// Trackers
export { runCreateIssue } from './trackers';
export type { TrackerClient, TrackerIssueParams, TrackerIssueResult, TrackerIssueContext } from './trackers';
