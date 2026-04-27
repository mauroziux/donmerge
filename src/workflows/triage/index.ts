/**
 * Triage Workflow
 *
 * This module provides automated error triage analysis,
 * correlating caller-provided error context with source code,
 * and using LLM analysis to produce root cause diagnosis.
 */

// Types
export type {
  ErrorContext,
  TriageOutput,
  TriageContext,
  TriageStatus,
  TrackerConfig,
  TriageOptions,
  CallbackConfig,
  TriageResult,
  TriageEnv,
  AutoFixOutput,
  AutoFixContext,
} from './types';

// Repo code fetcher
export {
  filterInAppPaths,
  fetchFile,
  fetchRepoCodeForTriage,
} from './repo-fetcher';

// Prompts
export {
  TriagePromptBuilder,
  buildTriagePrompt,
  sanitizeData,
  sanitizeTitle,
  sanitizeSentryData,
  sanitizeSentryTitle,
  TRIAGE_OUTPUT_SCHEMA,
  SYSTEM_PROMPT,
  CRITICAL_RULES,
  ERROR_CONTEXT_HEADER,
  SOURCE_CODE_HEADER,
  OUTPUT_SCHEMA_HEADER,
  SEVERITY_GUIDELINES,
} from './prompts';

// Durable Object
export { TriageProcessor, getTriageProcessor } from './processor';

// Shared utilities
export { parseModelConfig, safeJsonParse } from './utils';

// Auto-fix
export { runAutoFix } from './auto-fix';

// Trackers
export { runCreateIssue } from './trackers';
export type { TrackerClient, TrackerIssueParams, TrackerIssueResult, TrackerIssueContext } from './trackers';
