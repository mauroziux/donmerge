/**
 * Type definitions for the Sentry Triage workflow.
 */

import type { FlueRuntime } from '@flue/cloudflare';

// ── Sentry API response types ──────────────────────────────────────────────────

export interface SentryIssueData {
  id: string;
  shortId: string;
  title: string;
  project: {
    slug: string;
    id: string;
  };
  firstSeen: string;
  lastSeen: string;
  count: string;
  userCount: number;
  platform: string;
  environment: string | null;
  tags: Array<{ key: string; value: string }>;
  events?: SentryEvent[];
}

export interface SentryEvent {
  id: string;
  timestamp: string;
  exceptions?: Array<{
    type: string;
    value: string;
    stacktrace: {
      frames: Array<{
        filename: string;
        function: string;
        lineno: number;
        colno: number;
        absPath: string;
        context?: Array<[number, string]>;
        inApp: boolean;
        module?: string;
        package?: string;
      }>;
    };
  }>;
  breadcrumbs?: Array<{
    timestamp: string;
    category: string;
    message: string;
    type: string;
    data?: Record<string, unknown>;
  }>;
  request?: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
  };
  contexts?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  tags?: Array<{ key: string; value: string }>;
}

// ── URL parsing ────────────────────────────────────────────────────────────────

export interface ParsedSentryUrl {
  org: string;
  issueId: string;
  originalUrl: string;
}

// ── Triage output ──────────────────────────────────────────────────────────────

export interface SentryTriageOutput {
  root_cause: string;
  stack_trace_summary: string;
  affected_files: string[];
  suggested_fix: string;
  confidence: 'high' | 'medium' | 'low';
  severity: 'critical' | 'error' | 'warning';
}

/** Output from the LLM fix-generation prompt. */
export interface AutoFixOutput {
  /** Path of the file to modify (must match a file in sourceCode) */
  file_path: string;
  /** Human-readable description of what the fix does */
  description: string;
  /** Complete patched file content (not a diff — the full new file) */
  patched_content: string | null;
}

/** Input context for the auto-fix pipeline. */
export interface AutoFixContext {
  repo: string;
  sha: string;
  githubToken: string;
  sentryIssueId: string;
  sentryIssueUrl: string;
  sentryTitle: string;
  triageOutput: SentryTriageOutput;
  sourceCode: Map<string, string>;
  flue: FlueRuntime;
}

// ── Triage context ─────────────────────────────────────────────────────────────

export interface TrackerConfig {
  type: 'github' | 'linear' | 'jira';
  token: string;
  team: string;
  labels?: string[];
  jira_base_url?: string;
}

export interface SentryTriageOptions {
  auto_fix?: boolean;
}

export interface CallbackConfig {
  callback_url: string;
  callback_secret: string;
}

export interface SentryTriageContext {
  jobId: string;
  repo: string;
  sentryIssueUrl: string;
  sentryAuthToken: string;
  githubToken: string;
  sha: string;
  tracker?: TrackerConfig; // Phase D: tracker integration
  options?: SentryTriageOptions;
  callback?: CallbackConfig; // Phase C: callback invocation
  sentryData?: SentryIssueData;
  initiatorKeyHash?: string;
}

// ── Status tracking ────────────────────────────────────────────────────────────

export interface SentryTriageStatus {
  state: 'pending' | 'running' | 'complete' | 'failed';
  attempts: number;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  result?: SentryTriageResult;
}

// ── Result ─────────────────────────────────────────────────────────────────────

export interface SentryTriageResult {
  root_cause: string;
  stack_trace_summary: string;
  affected_files: string[];
  suggested_fix: string;
  confidence: 'high' | 'medium' | 'low';
  severity: 'critical' | 'error' | 'warning';
  fix_pr_url?: string | null;
  tracker_issue_url?: string | null;
}

// ── Environment ────────────────────────────────────────────────────────────────

export interface SentryTriageEnv {
  Sandbox: unknown;
  OPENAI_API_KEY: string;
  CODEX_MODEL?: string;
  SentryTriageProcessor: DurableObjectNamespace;
}
