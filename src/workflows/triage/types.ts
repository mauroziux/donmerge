/**
 * Type definitions for the Triage workflow.
 *
 * DonMerge receives error context from the caller (any ticket/error source)
 * and provides LLM triage, auto-fix, and tracker integration.
 */

// ── Caller-provided error context ──────────────────────────────────────────────

/**
 * Error context provided by the caller.
 *
 * DonMerge does not fetch from any external error tracking service.
 * The caller supplies all relevant error context; DonMerge provides the compute
 * (LLM triage, auto-fix PR, tracker issue creation).
 */
export interface ErrorContext {
  /** Short summary of the error (e.g. "NullPointerException in UserService.getProfile") */
  title: string;
  /** Detailed description of the error */
  description: string;
  /** Stack trace as a single string (may contain multiple frames) */
  stack_trace: string;
  /** List of file paths implicated by the error */
  affected_files: string[];
  /** Assessed severity (optional — LLM will infer if omitted) */
  severity?: 'critical' | 'error' | 'warning';
  /** Environment where the error occurred (e.g. "production", "staging") */
  environment?: string;
  /** Additional metadata from the caller (e.g. event count, user count, tags) */
  metadata?: Record<string, unknown>;
  /** Original URL of the error/ticket in the source system (e.g. Sentry, GitHub Issue) */
  source_url?: string;
  /** Sentry issue ID — used for deduplication (same across all events in an issue) */
  sentry_issue_id?: string;
}

// ── Triage output ──────────────────────────────────────────────────────────────

export interface TriageOutput {
  root_cause: string;
  stack_trace_summary: string;
  affected_files: string[];
  suggested_fix: string;
  confidence: 'high' | 'medium' | 'low';
  severity: 'critical' | 'error' | 'warning';
}

/** A single surgical edit operation. */
export interface AutoFixEdit {
  /** 2-5 lines of context from the original file to locate the edit site */
  search: string;
  /** The replacement text (empty string to delete) */
  replace: string;
  /** Human-readable description of this edit */
  description: string;
}

/** Output from the LLM fix-generation prompt. */
export interface AutoFixOutput {
  /** Path of the file to modify (must match a file in sourceCode) */
  file_path: string;
  /** Human-readable description of what the fix does */
  description: string;
  /** One or more surgical edit operations (empty = no confident fix) */
  edits: AutoFixEdit[];
}

/** Sandbox interface used by auto-fix V2 — matches the Cloudflare Sandbox exec() API. */
export interface AutoFixSandbox {
  exec(command: string, options?: {
    timeout?: number;
    cwd?: string;
    env?: Record<string, string | undefined>;
  }): Promise<{
    success: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
  setEnvVars(vars: Record<string, string | undefined>): Promise<void>;
}

/** Input context for the auto-fix pipeline. */
export interface AutoFixContext {
  repo: string;
  sha: string;
  githubToken: string;
  errorTitle: string;
  sourceUrl: string;
  triageOutput: TriageOutput;
  /** Source code map (required for V1, optional for V2 which clones the repo). */
  sourceCode?: Map<string, string>;
}

// ── Triage context ─────────────────────────────────────────────────────────────

export interface TrackerConfig {
  type: 'github' | 'linear' | 'jira';
  token: string;
  team: string;
  labels?: string[];
  jira_base_url?: string;
}

export interface TriageOptions {
  auto_fix?: boolean;
}

export interface CallbackConfig {
  callback_url: string;
  callback_secret: string;
}

export interface TriageContext {
  jobId: string;
  repo: string;
  errorContext: ErrorContext;
  githubToken: string;
  sha: string;
  tracker?: TrackerConfig;
  options?: TriageOptions;
  callback?: CallbackConfig;
  initiatorKeyHash?: string;
}

// ── Status tracking ────────────────────────────────────────────────────────────

export interface TriageStatus {
  state: 'pending' | 'running' | 'complete' | 'failed';
  attempts: number;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  result?: TriageResult;
}

// ── Result ─────────────────────────────────────────────────────────────────────

export interface TriageResult {
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

export interface TriageEnv {
  Sandbox: unknown;
  OPENAI_API_KEY: string;
  /** Kimi K3 API key (Kimi Code, OpenAI-compatible). Primary model when set. */
  KIMI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  /** Primary model in "provider/model" form (e.g. "kimi/k3"). */
  CODEX_MODEL?: string;
  /** Fallback model used when the primary provider fails (e.g. "openai/gpt-4o"). */
  FALLBACK_MODEL?: string;
  TriageProcessor: DurableObjectNamespace;
  DB?: D1Database;
}
