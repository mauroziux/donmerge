/**
 * API types for the Push Model Architecture.
 *
 * "Callers provide credentials. donmerge provides compute."
 */

import type { ReviewResult } from '../workflows/code-review/types';
import type {
  TriageResult as TriageResultType,
  TrackerConfig as TrackerConfigType,
  TriageOptions as TriageOptionsType,
} from '../workflows/triage/types';

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

export interface TriageRequest {
  /** Full repository path "owner/repo" */
  repo: string;
  /** GitHub PAT with repo scope */
  github_token: string;
  /** Git SHA or branch name to analyze */
  sha: string;
  /** Error context (title, description, stack trace, affected files, etc.) */
  error_context: {
    title: string;
    description: string;
    stack_trace: string;
    affected_files: string[];
    severity?: 'critical' | 'error' | 'warning';
    environment?: string;
    metadata?: Record<string, unknown>;
    source_url?: string;
  };
  /** Tracker configuration (optional) */
  tracker?: TrackerConfig;
  /** Triage options (optional) */
  options?: TriageOptions;
}

export interface TriageResponse {
  job_id: string;
  status: 'pending';
  message: string;
}

// Re-export types from triage/types so API consumers can import from here
export type TrackerConfig = TrackerConfigType;
export type TriageOptions = TriageOptionsType;
export type TriageResult = TriageResultType;

export interface JobStatusResponse {
  job_id: string;
  status: 'pending' | 'running' | 'complete' | 'failed';
  /** ReviewResult or TriageResult when complete */
  result?: ReviewResult | TriageResultType;
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
