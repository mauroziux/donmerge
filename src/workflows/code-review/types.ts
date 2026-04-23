/**
 * Type definitions for the DonMerge code review workflow.
 */

export interface WorkerEnv {
  Sandbox: unknown;
  OPENAI_API_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_TOKEN_PAT?: string;
  CODEX_MODEL?: string;
  MAX_REVIEW_FILES?: string;
  REPO_CONFIGS?: string;     // "owner/repo:branch,owner/repo2:branch2" - branch is optional
  REVIEW_TRIGGER?: string;
}

/**
 * Per-repository configuration
 */
export interface RepoConfig {
  owner: string;
  repo: string;
  baseBranch?: string;  // If not set, review all PRs regardless of target branch
}

export interface GitHubRepository {
  owner: { login: string };
  name: string;
}

export interface PullRequestPayload {
  number: number;
}

export interface CheckRunPayload {
  id: number;
  name: string;
  pull_requests: Array<PullRequestPayload>;
}

export interface WebhookPayload {
  action?: string;
  installation?: { id: number };
  repository?: GitHubRepository;
  pull_request?: PullRequestPayload;
  issue?: {
    number: number;
    pull_request?: Record<string, unknown>;
  };
  comment?: { body?: string; id?: number };
  check_run?: CheckRunPayload;
}

export interface ReviewComment {
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  body: string;
  severity: 'critical' | 'suggestion' | 'low';
  issueKey?: string;
  ruleId?: string;
  entityType?: 'method' | 'function' | 'class' | 'variable' | 'module';
  symbolName?: string;
  codeSnippet?: string;
}

export interface PreviousComment {
  id: number;
  path: string;
  line: number;
  body: string;
  inReplyToId?: number;
  fingerprint?: string;
  issueKey?: string;
  ruleId?: string;
  entityType?: 'method' | 'function' | 'class' | 'variable' | 'module';
  symbolName?: string;
  codeSnippet?: string;
  resolved?: boolean;
  resolutionReplyId?: number;
}

export type IssueStatus = 'new' | 'open' | 'fixed' | 'reintroduced' | 'dismissed';

export interface TrackedIssue {
  id: string;
  fingerprint: string;
  logicalKey: string;
  anchorKey: string;
  repo: string;
  prNumber: number;
  ruleId: string;
  entityType: 'method' | 'function' | 'class' | 'variable' | 'module';
  symbolName: string;
  filePath: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  snippetHash: string;
  severity: 'critical' | 'suggestion' | 'low';
  body: string;
  status: IssueStatus;
  githubCommentId?: number;
  resolutionReplyId?: number;
  firstSeenCommit: string;
  lastSeenCommit: string;
  fixedCommit?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FileSummary {
  path: string;
  changeType: 'added' | 'modified' | 'deleted' | 'renamed';
  summary: string;
}

/**
 * Structured PR summary for rich review output
 */
export interface PRSummary {
  overview: string;           // 1-2 sentence high-level description
  keyChanges: string[];       // List of main changes
  codeQuality: string;        // Assessment of code quality
  testingNotes: string;       // Testing coverage/observations
  riskAssessment: string;     // Risk level and concerns
}

export interface ReviewResult {
  approved: boolean;
  summary: string;            // Fallback simple summary
  prSummary?: PRSummary;      // Structured summary (preferred)
  lineComments: ReviewComment[];
  criticalIssues: string[];
  suggestions: string[];
  resolvedComments?: number[];
  fileSummaries?: FileSummary[];
}

export interface WebhookContext {
  owner: string;
  repo: string;
  prNumber: number;
  retrigger: boolean;
  commentId?: number;
  commentType?: 'issue' | 'review';
  installationId?: number;
  instruction?: string;
  focusFiles?: string[];
}

export interface FastValidationResult {
  shouldProcess: boolean;
  status: number;
  body: Record<string, unknown>;
  context?: WebhookContext;
}

export interface TriggerResult {
  shouldRun: boolean;
  prNumber: number;
  retrigger: boolean;
  commentId?: number;
  commentType?: 'issue' | 'review';
  instruction?: string;
  focusFiles?: string[];
  reason?: string;
}

export interface ModelConfig {
  providerID: string;
  modelID: string;
}

/**
 * Repository context files for better code review
 */
export interface RepoContext {
  // Standards/Instructions files
  agents?: string;         // AGENTS.md
  cursorrules?: string;    // .cursorrules
  claude?: string;         // CLAUDE.md
  contributing?: string;   // CONTRIBUTING.md
  development?: string;    // DEVELOPMENT.md

  // Config files
  packageJson?: string;    // package.json
  tsconfig?: string;       // tsconfig.json
  eslint?: string;         // eslint.config.js or .eslintrc.*
  prettier?: string;       // .prettierrc or .prettierrc.json
  biome?: string;          // biome.json

  // Documentation
  readme?: string;         // README.md
}

/**
 * A skill entry from .donmerge — a repo file used as LLM context.
 */
export interface DonmergeSkill {
  /** Path to the file in the repo (e.g., "DESIGN.md", "docs/API_CONVENTIONS.md") */
  path: string;
  /** Human-readable description of what this file provides to the reviewer */
  description: string;
}

/**
 * Parsed .donmerge configuration file.
 * All fields are optional — an empty file or missing file is valid.
 */
export interface DonmergeConfig {
  /** Schema version. Must be "1". */
  version?: string;
  /** Glob patterns for files to exclude from review. */
  exclude?: string[];
  /** Glob patterns for files to always include (overrides exclude). */
  include?: string[];
  /** Additional context files for the LLM reviewer. */
  skills?: DonmergeSkill[];
  /** Custom instructions appended to the review prompt. */
  instructions?: string;
  /** Path-specific severity overrides. Map of glob pattern → severity. */
  severity?: Record<string, 'critical' | 'suggestion' | 'low'>;
}

/**
 * Resolved .donmerge config with skills content fetched.
 * This is the runtime object passed through the pipeline.
 */
export interface DonmergeResolved {
  /** Original parsed config (may be partial/empty). */
  config: DonmergeConfig;
  /** Fetched skills content: path → content. */
  skillsContent: Map<string, string>;
  /** Skills that failed to fetch: path → error. */
  skillsErrors: Map<string, string>;
}
