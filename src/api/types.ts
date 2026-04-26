/**
 * API types for the Push Model Architecture.
 *
 * "Callers provide credentials. donmerge provides compute."
 */

import type { ReviewResult } from '../workflows/code-review/types';
import type {
  SentryTriageResult as SentryTriageResultType,
  TrackerConfig as TrackerConfigType,
  SentryTriageOptions as SentryTriageOptionsType,
} from '../workflows/sentry-triage/types';

// ── Request types ──────────────────────────────────────────────────────────────

export interface PushReviewRequest {
  /** Required: caller's GitHub PAT */
  github_token: string;
  /** Repository owner */
  owner: string;
  /** Repository name */
  repo: string;
  /** PR number to review */
  pr_number: number;
  /** Optional: override LLM model (e.g. "openai/gpt-4o") */
  model?: string;
  /** Optional: max files to review */
  max_files?: number;
}

// ── Response types ─────────────────────────────────────────────────────────────

export interface PushReviewResponse {
  /** Format: "review/{owner}/{repo}/{pr_number}" */
  job_id: string;
  status: 'pending';
  message: string;
}

export interface SentryTriageRequest {
  repo: string;
  sentry_issue_url: string;
  sentry_auth_token: string;
  github_token: string;
  sha: string;
  tracker?: TrackerConfig;
  options?: SentryTriageOptions;
}

export interface SentryTriageResponse {
  job_id: string;
  status: 'pending';
  message: string;
}

// Re-export types from sentry-triage/types so API consumers can still import from here
export type TrackerConfig = TrackerConfigType;
export type SentryTriageOptions = SentryTriageOptionsType;
export type SentryTriageResult = SentryTriageResultType;

export interface JobStatusResponse {
  job_id: string;
  status: 'pending' | 'running' | 'complete' | 'failed';
  /** ReviewResult or SentryTriageResult when complete */
  result?: ReviewResult | SentryTriageResultType;
  /** Error message when failed */
  error?: string;
  created_at: string;
  updated_at: string;
}

// ── Internal types ─────────────────────────────────────────────────────────────

export interface AuthenticatedRequest {
  apiKey: string;
  keyType: 'live' | 'test';
}

export interface RateLimitInfo {
  allowed: boolean;
  remaining: number;
  reset_at: number;
}
