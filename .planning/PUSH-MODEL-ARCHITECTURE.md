# Push Model Architecture

> Extending donmerge from a single-tenant GitHub webhook handler to a multi-workflow push-based API service.

**Status:** Planning
**Date:** 2026-04-24
**Author:** Architecture planning session

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Overview](#2-architecture-overview)
3. [API Design](#3-api-design)
4. [New Types & Interfaces](#4-new-types--interfaces)
5. [New Durable Object: SentryTriageProcessor](#5-new-durable-object-sentrytriageprocessor)
6. [Tracker Integration](#6-tracker-integration)
7. [File Changes Summary](#7-file-changes-summary)
8. [Implementation Phases](#8-implementation-phases)
9. [Security Considerations](#9-security-considerations)
10. [Existing Code Review Flow — Migration Path](#10-existing-code-review-flow--migration-path)
11. [Environment Variables](#11-environment-variables)
12. [Example CI/CD Workflows](#12-example-cicd-workflows)
13. [Testing Strategy](#13-testing-strategy)

---

## 1. Executive Summary

### What we're building

donmerge is currently a single-tenant Cloudflare Worker that receives GitHub webhooks and runs AI-powered code reviews. This document describes how to extend it into a **multi-workflow push-based API service** where CI/CD pipelines call donmerge as a stateless compute layer.

### The core insight

> **Callers provide credentials. donmerge provides compute.**

Today, donmerge stores per-company GitHub secrets (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`) and acts as a webhook receiver. In the push model, the caller (a CI/CD pipeline) sends its own credentials with each request. donmerge never stores per-tenant secrets — it only needs its own `OPENAI_API_KEY` and `DONMERGE_API_KEYS` for authentication.

### Current state → Target state

| Aspect | Current | Target |
|--------|---------|--------|
| Entry point | GitHub webhook only | GitHub webhook + REST API |
| Authentication | GitHub webhook secret | API key (`DONMERGE_API_KEY`) |
| Credentials | donmerge stores GitHub App secrets | Caller provides per-request tokens |
| Workflows | Code review only | Code review + Sentry triage + future |
| Tenancy | Single tenant (tableoltd) | Multi-tenant (any repo with an API key) |

---

## 2. Architecture Overview

### Architecture diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        CI/CD Pipelines                              │
│  ┌──────────────────┐  ┌───────────────────┐  ┌────────────────┐  │
│  │  GitHub Actions   │  │  GitLab CI / Other │  │  Sentry Alert  │  │
│  └────────┬─────────┘  └────────┬──────────┘  └───────┬────────┘  │
│           │                      │                      │           │
│           │  POST /api/v1/*      │                      │           │
│           │  + caller tokens     │                      │           │
└───────────┼──────────────────────┼──────────────────────┼───────────┘
            │                      │                      │
            ▼                      ▼                      ▼
┌───────────────────────────────────────────────────────────────────────┐
│                          donmerge Worker                               │
│                                                                        │
│  ┌──────────────────┐  ┌───────────────────┐  ┌──────────────────┐   │
│  │  Auth Middleware   │  │  Rate Limiter DO   │  │  Route Handler   │   │
│  │  (API key check)  │  │  (per-key quotas)  │  │  (FlueWorker)    │   │
│  └──────────────────┘  └───────────────────┘  └──────┬───────────┘   │
│                                                       │               │
│                         ┌─────────────────────────────┤               │
│                         │                             │               │
│                         ▼                             ▼               │
│  ┌──────────────────────────────┐  ┌──────────────────────────────┐  │
│  │     ReviewProcessor DO       │  │   SentryTriageProcessor DO   │  │
│  │  (existing code review)      │  │  (new: Sentry root cause)    │  │
│  │                              │  │                              │  │
│  │  alarm() → runReview()       │  │  alarm() → runTriage()      │  │
│  │  ↓                           │  │  ↓                           │  │
│  │  Sandbox + FlueRuntime       │  │  Sandbox + FlueRuntime       │  │
│  │  ↓                           │  │  ↓                           │  │
│  │  LLM (OpenAI) → Review       │  │  LLM (OpenAI) → Triage       │  │
│  │  ↓                           │  │  ↓                           │  │
│  │  GitHub PR comments          │  │  GitHub PR + Tracker issue   │  │
│  └──────────────────────────────┘  └──────────────────────────────┘  │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐ │
│  │                     Shared: Sandbox DO (containers)               │ │
│  │  Isolated execution environment for LLM calls via FlueRuntime     │ │
│  └──────────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────────┘

            ┌─────────────────────────────────────────────┐
            │        Existing Webhook Flow (unchanged)     │
            │  GitHub ──webhook──▶ POST /webhook/github    │
            │         (donmerge stores secrets)            │
            └─────────────────────────────────────────────┘
```

### Mermaid sequence: Push model code review

```mermaid
sequenceDiagram
    participant CI as CI/CD Pipeline
    participant DM as donmerge API
    participant RL as RateLimiter DO
    participant RP as ReviewProcessor DO
    participant SB as Sandbox DO
    participant GH as GitHub API
    participant LLM as OpenAI

    CI->>DM: POST /api/v1/review<br/>{repo, pr_number, github_token, ...}
    DM->>RL: checkRateLimit(api_key)
    RL-->>DM: allowed
    DM->>RP: startReview(context)
    RP-->>DM: accepted
    DM-->>CI: 202 {job_id, status_url}

    RP->>RP: alarm() fires
    RP->>GH: Fetch PR diff + files (caller token)
    RP->>GH: Fetch .donmerge config (caller token)
    RP->>GH: Fetch repo context (caller token)
    RP->>SB: Create sandbox session
    SB-->>RP: sandbox ready
    RP->>SB: Set env vars (OPENAI_API_KEY + caller token)
    RP->>SB: FlueRuntime prompt
    SB->>LLM: Code review prompt
    LLM-->>SB: Review result JSON
    SB-->>RP: Parsed review
    RP->>GH: Publish review comments (caller token)
    RP->>GH: Complete check run (caller token)

    CI->>DM: GET /api/v1/status/{job_id}
    DM->>RP: getStatus()
    RP-->>DM: {state: "complete", ...}
    DM-->>CI: 200 {state: "complete", result: {...}}
```

### Mermaid sequence: Sentry triage

```mermaid
sequenceDiagram
    participant CI as CI/CD Pipeline
    participant DM as donmerge API
    participant ST as SentryTriageProcessor DO
    participant SB as Sandbox DO
    participant S as Sentry API
    participant GH as GitHub API
    participant LLM as OpenAI
    participant TK as Tracker (Linear/GH/Jira)

    CI->>DM: POST /api/v1/sentry/triage<br/>{sentry_issue_url, sentry_auth_token,<br/>github_token, tracker, options}
    DM->>ST: startTriage(context)
    ST-->>DM: accepted
    DM-->>CI: 202 {job_id, status_url}

    ST->>ST: alarm() fires
    ST->>S: Fetch issue + events + breadcrumbs (caller token)
    ST->>GH: Fetch repo code at SHA (caller token)
    ST->>SB: Create sandbox session
    ST->>SB: FlueRuntime prompt (triage)
    SB->>LLM: Root cause analysis prompt
    LLM-->>SB: Triage result JSON
    SB-->>ST: Parsed triage

    alt auto_fix = true
        ST->>SB: Generate fix
        SB->>LLM: Fix generation prompt
        LLM-->>SB: Code fix
        ST->>GH: Create branch + commit + PR (caller token)
    end

    alt create_issue = true
        ST->>TK: Create tracker issue (caller token)
    end

    ST->>ST: Mark complete
```

### Two entry paths

| Path | Endpoint | Auth | Who holds secrets | Status |
|------|----------|------|-------------------|--------|
| **A. Webhook** | `POST /webhook/github` | GitHub HMAC signature | donmerge (env vars) | Existing, unchanged |
| **B. Push API** | `POST /api/v1/review` | API key | Caller (per-request) | New |
| **B. Push API** | `POST /api/v1/sentry/triage` | API key | Caller (per-request) | New |

---

## 3. API Design

### 3.1 Authentication

All `/api/v1/*` endpoints require an API key passed via the `Authorization` header:

```
Authorization: Bearer dm_live_abc123def456
```

**Key validation flow:**

```
1. Extract token from Authorization header
2. Look up token in DONMERGE_API_KEYS env var (comma-separated for MVP)
3. If not found → 401 Unauthorized
4. Check rate limit via RateLimiter DO (see 3.6)
5. If over limit → 429 Too Many Requests
6. Proceed to route handler
```

**API key format:** `dm_live_<random>` or `dm_test_<random>` (test keys are rate-limited more aggressively).

**MVP storage:** `DONMERGE_API_KEYS` env var (comma-separated list). Future: KV namespace or database.

### 3.2 Code Review Endpoint

```
POST /api/v1/review
```

**Request body:**

```typescript
interface PushReviewRequest {
  /** Repository in "owner/repo" format */
  repo: string;

  /** Pull request number */
  pr_number: number;

  /** GitHub token with repo access (provided by caller).
   *  Must have `contents:read` and `pull_requests:write` permissions. */
  github_token: string;

  /** Git SHA for check run creation (optional, fetched from PR if omitted) */
  sha?: string;

  /** Custom review instruction (optional, appended to system prompt) */
  instruction?: string;

  /** Restrict review to specific files (optional) */
  focus_files?: string[];

  /** URL to a custom .donmerge config (optional, auto-detected from repo if omitted) */
  donmerge_config_url?: string | null;
}
```

**Example request:**

```bash
curl -X POST https://donmerge.example.com/api/v1/review \
  -H "Authorization: Bearer dm_live_abc123" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "myorg/myrepo",
    "pr_number": 42,
    "github_token": "ghs_xxxx",
    "sha": "abc123def456",
    "instruction": "Focus on security vulnerabilities"
  }'
```

**Response:** `202 Accepted`

```json
{
  "ok": true,
  "job_id": "review-myorg-myrepo-42",
  "status_url": "/api/v1/status/review-myorg-myrepo-42",
  "message": "Review queued for processing"
}
```

**How it works:**

This endpoint does exactly what the existing `POST /webhook/github` handler does internally, but:
- The `github_token` comes from the request body instead of being resolved via GitHub App JWT
- No webhook signature validation
- No repo allowlist check (API key is the auth boundary)
- No trigger parsing (if you call this endpoint, you want a review)
- Reuses the existing `ReviewProcessor` DO

### 3.3 Sentry Triage Endpoint

```
POST /api/v1/sentry/triage
```

**Request body:**

```typescript
interface SentryTriageRequest {
  /** Repository in "owner/repo" format */
  repo: string;

  /** Sentry issue URL */
  sentry_issue_url: string;

  /** Sentry auth token (provided by caller).
   *  Needs `org:read`, `project:read`, `issue:read` scopes. */
  sentry_auth_token: string;

  /** GitHub token with repo access (provided by caller).
   *  Needs `contents:read` and (if auto_fix) `contents:write` + `pull_requests:write`. */
  github_token: string;

  /** Git SHA or branch name to analyze code at */
  sha: string;

  /** Issue tracker configuration */
  tracker: TrackerConfig;

  /** Triage options */
  options?: SentryTriageOptions;
}
```

**Example request:**

```bash
curl -X POST https://donmerge.example.com/api/v1/sentry/triage \
  -H "Authorization: Bearer dm_live_abc123" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "myorg/myrepo",
    "sentry_issue_url": "https://sentry.io/organizations/myorg/issues/12345/",
    "sentry_auth_token": "sntrys_xxxx",
    "github_token": "ghs_xxxx",
    "sha": "main",
    "tracker": {
      "type": "linear",
      "token": "lin_api_xxxx",
      "team": "ENG",
      "labels": ["Bug", "Sentry"]
    },
    "options": {
      "auto_fix": false,
      "create_issue": true
    }
  }'
```

**Response:** `202 Accepted`

```json
{
  "ok": true,
  "job_id": "sentry-triage-abc123",
  "status_url": "/api/v1/status/sentry-triage-abc123",
  "message": "Sentry triage queued for processing"
}
```

### 3.4 Status/Callback Endpoint

```
GET /api/v1/status/{job_id}
```

**Response:** `200 OK`

```json
{
  "job_id": "review-myorg-myrepo-42",
  "type": "review",
  "state": "complete",
  "attempts": 1,
  "started_at": "2026-04-24T10:00:00Z",
  "completed_at": "2026-04-24T10:02:30Z",
  "error": null,
  "result": {
    "approved": false,
    "summary": "Found 2 critical issues...",
    "critical_issues_count": 2,
    "suggestions_count": 1
  }
}
```

**State values:** `pending` | `running` | `complete` | `failed`

**Job ID format:**
- Code review: `review-{owner}-{repo}-{pr_number}`
- Sentry triage: `sentry-triage-{uuid}`

### 3.5 Webhook Callback (optional)

Callers can provide a callback URL for async notifications:

```typescript
interface CallbackConfig {
  /** URL to POST results to when the job completes */
  callback_url: string;

  /** HMAC secret for callback signature verification */
  callback_secret: string;
}
```

**Callback payload** (POST to `callback_url`):

```json
{
  "job_id": "review-myorg-myrepo-42",
  "type": "review",
  "state": "complete",
  "result": { ... },
  "timestamp": "2026-04-24T10:02:30Z",
  "signature": "sha256=<hmac_hex>"
}
```

The `signature` header is computed as `HMAC-SHA256(callback_secret, JSON.stringify(payload))`, identical to GitHub's webhook signature scheme. This lets the caller verify the callback is authentic.

### 3.6 Rate Limiting

Rate limiting is implemented via a dedicated `RateLimiter` Durable Object that tracks per-API-key request counts.

**Limits:**

| Key type | Requests/min | Requests/hour | Burst |
|----------|-------------|---------------|-------|
| `dm_live_*` | 30 | 200 | 10 |
| `dm_test_*` | 10 | 50 | 5 |

**Implementation:**

```typescript
class RateLimiterDO extends DurableObject {
  // Uses alarm-based windowed counters
  // Key: api_key → { minute: count, hour: count }
  // Returns { allowed: boolean, retry_after_ms?: number }
}
```

**Response headers on all API responses:**

```
X-RateLimit-Limit: 30
X-RateLimit-Remaining: 27
X-RateLimit-Reset: 1713945600
```

**When rate limited:** `429 Too Many Requests`

```json
{
  "error": "rate_limit_exceeded",
  "message": "Rate limit exceeded. Retry after 30 seconds.",
  "retry_after_ms": 30000
}
```

---

## 4. New Types & Interfaces

All new types are defined in their respective workflow directories. Shared types go in `src/api/types.ts`.

### 4.1 API Types (`src/api/types.ts`)

```typescript
/**
 * API key authentication result.
 */
interface AuthenticatedRequest {
  apiKey: string;
  keyType: 'live' | 'test';
}

/**
 * Base request for all push API endpoints.
 */
interface PushApiRequest {
  /** Repository in "owner/repo" format */
  repo: string;
  /** GitHub token with repo access */
  github_token: string;
}

/**
 * Push code review request.
 * POST /api/v1/review
 */
interface PushReviewRequest extends PushApiRequest {
  pr_number: number;
  sha?: string;
  instruction?: string;
  focus_files?: string[];
  donmerge_config_url?: string | null;
  callback?: CallbackConfig;
}

/**
 * Sentry triage request.
 * POST /api/v1/sentry/triage
 */
interface SentryTriageRequest extends PushApiRequest {
  sentry_issue_url: string;
  sentry_auth_token: string;
  sha: string;
  tracker: TrackerConfig;
  options?: SentryTriageOptions;
  callback?: CallbackConfig;
}

/**
 * Tracker configuration — which issue tracker to use and credentials.
 * Credentials come from the API request, NOT from donmerge env vars.
 */
interface TrackerConfig {
  /** Tracker type */
  type: 'github' | 'linear' | 'jira';
  /** Tracker API token (provided by caller) */
  token: string;
  /** Team or project key (e.g., "ENG" for Linear, "PROJ" for Jira) */
  team: string;
  /** Labels/tags to apply to the created issue */
  labels?: string[];
  /** Jira-specific: base URL (e.g., "https://myorg.atlassian.net") */
  jira_base_url?: string;
}

/**
 * Sentry triage options.
 */
interface SentryTriageOptions {
  /** Create a PR with the suggested fix (default: false) */
  auto_fix?: boolean;
  /** Create an issue in the configured tracker (default: true) */
  create_issue?: boolean;
}

/**
 * Callback configuration for async notifications.
 */
interface CallbackConfig {
  callback_url: string;
  callback_secret: string;
}

/**
 * Job status response.
 * GET /api/v1/status/{job_id}
 */
interface JobStatus {
  job_id: string;
  type: 'review' | 'sentry-triage';
  state: 'pending' | 'running' | 'complete' | 'failed';
  attempts: number;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  result: ReviewJobResult | SentryTriageResult | null;
}

/**
 * Summarized result for a code review job.
 */
interface ReviewJobResult {
  approved: boolean;
  summary: string;
  critical_issues_count: number;
  suggestions_count: number;
  line_comments_count: number;
}

/**
 * Full result for a Sentry triage job.
 */
interface SentryTriageResult {
  root_cause: string;
  stack_trace_summary: string;
  affected_files: string[];
  suggested_fix: string;
  fix_pr_url: string | null;
  tracker_issue_url: string | null;
}
```

### 4.2 Sentry Triage Types (`src/workflows/sentry-triage/types.ts`)

```typescript
/**
 * Sentry issue data fetched from the Sentry API.
 */
interface SentryIssueData {
  /** Issue ID */
  id: string;
  /** Short ID (e.g., "PROJ-1AB") */
  shortId: string;
  /** Issue title */
  title: string;
  /** Sentry project */
  project: { slug: string; id: string };
  /** First seen timestamp */
  firstSeen: string;
  /** Last seen timestamp */
  lastSeen: string;
  /** Event count */
  count: number;
  /** User count */
  userCount: number;
  /** Platform (e.g., "javascript", "python") */
  platform: string;
  /** Environment (e.g., "production") */
  environment: string;
  /** Issue tags */
  tags: Array<{ key: string; value: string }>;
  /** List of events (most recent first) */
  events: SentryEvent[];
}

/**
 * A single Sentry event with full context.
 */
interface SentryEvent {
  /** Event ID */
  id: string;
  /** Event timestamp */
  timestamp: string;
  /** Exception values (the actual error) */
  exceptions: Array<{
    type: string;
    value: string;
    stacktrace: {
      frames: Array<{
        filename: string;
        function: string;
        lineno: number;
        colno: number;
        absPath: string;
        context: Array<[number, string]> | null;
        inApp: boolean;
        module?: string;
        package?: string;
      }>;
    };
  }>;
  /** Breadcrumbs leading to the error */
  breadcrumbs: Array<{
    timestamp: string;
    category: string;
    message: string;
    type: string;
    data?: Record<string, unknown>;
  }>;
  /** Custom request data */
  request?: {
    url: string;
    method: string;
    headers?: Record<string, string>;
  };
  /** Contexts (runtime, OS, etc.) */
  contexts?: Record<string, Record<string, unknown>>;
  /** Extra data */
  extra?: Record<string, unknown>;
  /** Event tags */
  tags?: Array<{ key: string; value: string }>;
}

/**
 * Sentry API error group for issue categorization.
 */
interface SentryErrorGroup {
  /** Main exception type */
  type: string;
  /** Main exception message */
  value: string;
  /** Top frames from the stack trace */
  topFrames: Array<{
    filename: string;
    function: string;
    line: number;
    column: number;
  }>;
}

/**
 * LLM output for Sentry triage.
 */
interface SentryTriageOutput {
  /** Root cause description (2-4 sentences) */
  root_cause: string;
  /** Human-readable stack trace summary */
  stack_trace_summary: string;
  /** Files in the repo that are likely involved */
  affected_files: string[];
  /** Suggested fix description */
  suggested_fix: string;
  /** Confidence level */
  confidence: 'high' | 'medium' | 'low';
  /** Severity assessment */
  severity: 'critical' | 'error' | 'warning';
  /** Optional code diff for auto-fix */
  code_fix?: {
    file: string;
    description: string;
    diff: string;  // unified diff format
  };
}

/**
 * Context stored in the SentryTriageProcessor DO.
 */
interface SentryTriageContext {
  /** Unique job ID */
  jobId: string;
  /** Repository */
  repo: string;
  /** Sentry issue URL */
  sentryIssueUrl: string;
  /** Sentry auth token (ephemeral — only for this job) */
  sentryAuthToken: string;
  /** GitHub token (ephemeral) */
  githubToken: string;
  /** Git SHA or branch */
  sha: string;
  /** Tracker configuration */
  tracker: TrackerConfig;
  /** Triage options */
  options: SentryTriageOptions;
  /** Optional callback */
  callback?: CallbackConfig;
  /** Resolved Sentry issue data (fetched during processing) */
  sentryData?: SentryIssueData;
}

/**
 * Status stored in the SentryTriageProcessor DO.
 */
interface SentryTriageStatus {
  state: 'pending' | 'running' | 'complete' | 'failed';
  attempts: number;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  result?: SentryTriageResult;
}
```

### 4.3 Updated `WorkerEnv` (`src/env.d.ts` additions)

```typescript
interface WorkerEnv {
  // ── Existing (unchanged) ──
  Sandbox: unknown;
  OPENAI_API_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_TOKEN_PAT?: string;
  CODEX_MODEL?: string;
  MAX_REVIEW_FILES?: string;
  REPO_CONFIGS?: string;
  REVIEW_TRIGGER?: string;

  // ── New: Push API ──
  /** Comma-separated list of valid API keys */
  DONMERGE_API_KEYS?: string;
  /** RateLimiter DO namespace */
  RateLimiter: DurableObjectNamespace;
  /** SentryTriageProcessor DO namespace */
  SentryTriageProcessor: DurableObjectNamespace;
}
```

---

## 5. New Durable Object: SentryTriageProcessor

This follows the exact same pattern as `ReviewProcessor`: alarm-based execution with max 5 retries, state in DO storage, and sandbox-based LLM calls.

### 5.1 DO lifecycle

```
startTriage(context)     ← called from API handler
  → store context + status
  → setAlarm(Date.now())  ← fire immediately

alarm()                   ← runs in fresh execution context
  → load context + status
  → if attempts > 5: fail
  → status.state = 'running'
  → runTriage(context)
  → on success: status.state = 'complete'
  → on error: retry in 10s or fail

runTriage(context)
  1. fetchSentryIssue()       ← using caller's sentry_auth_token
  2. fetchRepoCode()          ← using caller's github_token
  3. runLlmTriage()           ← Sandbox + FlueRuntime + OpenAI
  4. (optional) generateFix() ← if auto_fix=true
  5. (optional) createPr()    ← if auto_fix=true
  6. (optional) createIssue() ← if create_issue=true
  7. sendCallback()           ← if callback configured
```

### 5.2 Sentry Data Fetching

The Sentry API client (`src/workflows/sentry-triage/sentry-api.ts`) fetches all relevant data using the caller's auth token:

```
1. Parse sentry_issue_url → extract org slug, issue ID
   URL format: https://sentry.io/organizations/{org}/issues/{id}/

2. GET /api/0/organizations/{org}/issues/{id}/
   → Issue metadata (title, count, platform, environment, tags)

3. GET /api/0/organizations/{org}/issues/{id}/events/?full=true&per_page=5
   → Latest 5 events with full exception data + breadcrumbs

4. (optional) GET /api/0/organizations/{org}/issues/{id}/grouping-info/
   → Error grouping info for deduplication context

5. Combine into SentryIssueData structure
```

**Parsing the Sentry issue URL:**

```typescript
function parseSentryUrl(url: string): { org: string; issueId: string } {
  // Supports:
  //   https://sentry.io/organizations/{org}/issues/{id}/
  //   https://{org}.sentry.io/issues/{id}/
  //   https://{org}.ingest.sentry.io/... (redirect)
  const patterns = [
    /organizations\/(?<org>[^/]+)\/issues\/(?<id>\d+)/,
    /(?<org>[^/.]+)\.sentry\.io\/issues\/(?<id>\d+)/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match?.groups) {
      return { org: match.groups.org, issueId: match.groups.id };
    }
  }
  throw new Error(`Cannot parse Sentry issue URL: ${url}`);
}
```

**Seer integration (optional, future):**

Sentry's Seer provides AI-powered root cause analysis. If the caller's Sentry org has Seer enabled:

```typescript
// Future: use Seer's analysis as additional input to our triage
const seerAnalysis = await fetchSeerAnalysis(org, issueId, sentryAuthToken);
// GET /api/0/organizations/{org}/issues/{id}/ai-fix-suggestions/
```

For the MVP, we fetch raw Sentry data and do our own LLM analysis.

### 5.3 Sandbox Investigation

The sandbox is used identically to the code review flow:

```typescript
const sessionId = `sentry-triage-${jobId}-${Date.now()}`;
const sandbox = getSandbox(this.env.Sandbox, sessionId, { sleepAfter: '30m' });
const flue = new FlueRuntime({ sandbox, sessionId, workdir: '/home/user' });

await sandbox.setEnvVars({
  OPENAI_API_KEY: this.env.OPENAI_API_KEY,
  GITHUB_TOKEN: context.githubToken,
});

await flue.setup();
```

**Fetching repo code at SHA:**

```typescript
// Fetch relevant files from the repo at the given SHA
// We use the GitHub Contents API, falling back to Trees API for directories
async function fetchRepoCodeForTriage(
  repo: string,
  sha: string,
  affectedPaths: string[],  // from stack trace
  githubToken: string
): Promise<Map<string, string>> {
  const [owner, repoName] = repo.split('/');
  const files = new Map<string, string>();

  // First pass: fetch files directly referenced in the stack trace
  for (const path of affectedPaths) {
    const content = await fetchRepoFile(owner, repoName, path, githubToken);
    if (content) files.set(path, content);
  }

  // Second pass: fetch neighboring files for context
  // (e.g., if error is in auth.ts, also fetch middleware.ts if referenced)
  // Limit total context to 30KB to fit in LLM prompt

  return files;
}
```

### 5.4 Triage Prompt Templates

New prompts for root cause analysis, distinct from code review prompts:

**System prompt:**

```
You are DonMerge 🤠 Triage Engineer, an expert at analyzing production errors
and identifying root causes. You have access to Sentry error data (exceptions,
stack traces, breadcrumbs, tags) and the relevant source code.

Your job is to:
1. Analyze the exception and stack trace
2. Correlate it with the source code
3. Identify the root cause
4. Suggest a specific fix
5. (If requested) Generate a code diff for the fix
```

**Triage prompt structure:**

```
1. SYSTEM PROMPT (persona + rules)
2. SENTRY DATA:
   - Issue metadata (title, count, platform, environment)
   - Latest event: exception, stack trace, breadcrumbs, tags
   - Error grouping info
3. SOURCE CODE:
   - Files from the stack trace
   - Related files for context
4. TRACKER INFO:
   - Type, team, labels (for issue creation)
5. OUTPUT SCHEMA (JSON format)
6. INSTRUCTIONS:
   - Focus on root cause, not symptoms
   - Reference specific files and lines
   - Provide actionable fix suggestions
```

**Output schema:**

```json
{
  "root_cause": "string — 2-4 sentences explaining the root cause",
  "stack_trace_summary": "string — human-readable summary of the error path",
  "affected_files": ["string — files involved"],
  "suggested_fix": "string — description of the fix",
  "confidence": "high | medium | low",
  "severity": "critical | error | warning",
  "code_fix": {
    "file": "string — path to the file to modify",
    "description": "string — what the fix does",
    "diff": "string — unified diff format"
  }
}
```

### 5.5 Auto-Fix: PR Creation

When `options.auto_fix = true` and the LLM produces a `code_fix`:

```
1. Validate the diff is parseable and targets a single file
2. Create a new branch: fix/sentry-{issue-id}-{timestamp}
3. Get the file's current SHA on the base branch
4. Create a commit via GitHub Contents API:
   PUT /repos/{owner}/{repo}/contents/{path}
   { message, branch, sha (current file SHA), content (base64 of new file) }
5. Create a PR:
   POST /repos/{owner}/{repo}/pulls
   { title, body (includes Sentry issue link + triage summary), head, base }
```

**PR title format:** `fix(sentry): {short error description}`

**PR body template:**

```markdown
## 🤠 DonMerge Sentry Triage

### Sentry Issue
[{issue_title}]({sentry_issue_url})

### Root Cause
{root_cause}

### Stack Trace Summary
{stack_trace_summary}

### Suggested Fix
{suggested_fix}

---
*Auto-generated by DonMerge Sentry Triage*
```

### 5.6 Tracker Issue Creation

When `options.create_issue = true`:

```typescript
const trackerClient = createTrackerClient(context.tracker);
const issue = await trackerClient.createIssue({
  title: `[Sentry] ${sentryData.title}`,
  description: triageOutput.root_cause,
  labels: context.tracker.labels ?? [],
  severity: triageOutput.severity,
  sentryUrl: context.sentryIssueUrl,
  affectedFiles: triageOutput.affected_files,
});

// If a PR was also created, link them
if (prUrl) {
  await trackerClient.linkToPullRequest(issue.id, prUrl);
}
```

---

## 6. Tracker Integration

### 6.1 Tracker abstraction

```typescript
/**
 * Common interface for issue tracker clients.
 * Credentials come from the API request, not from donmerge config.
 */
interface TrackerClient {
  /** Create a new issue in the tracker */
  createIssue(params: TrackerIssueParams): Promise<TrackerIssueResult>;

  /** Add a comment to an existing issue */
  addComment(issueId: string, comment: string): Promise<void>;

  /** Link a tracker issue to a pull request */
  linkToPullRequest(issueId: string, prUrl: string): Promise<void>;
}

interface TrackerIssueParams {
  title: string;
  description: string;
  labels: string[];
  severity: 'critical' | 'error' | 'warning';
  sentryUrl: string;
  affectedFiles: string[];
}

interface TrackerIssueResult {
  id: string;
  url: string;
  key: string;  // e.g., "ENG-123", "PROJ-456", "#789"
}

/**
 * Factory function to create the right tracker client.
 */
function createTrackerClient(config: TrackerConfig): TrackerClient {
  switch (config.type) {
    case 'github':
      return new GitHubTrackerClient(config);
    case 'linear':
      return new LinearTrackerClient(config);
    case 'jira':
      return new JiraTrackerClient(config);
    default:
      throw new Error(`Unsupported tracker type: ${config.type}`);
  }
}
```

### 6.2 GitHub Issues tracker

```typescript
class GitHubTrackerClient implements TrackerClient {
  constructor(private config: TrackerConfig) {}

  async createIssue(params: TrackerIssueParams): Promise<TrackerIssueResult> {
    const [owner, repo] = /* parse from triage context */;
    const response = await githubFetch<{ number: number; html_url: string }>(
      `https://api.github.com/repos/${owner}/${repo}/issues`,
      this.config.token,
      'POST',
      {
        title: params.title,
        body: this.buildBody(params),
        labels: params.labels,
      }
    );
    return { id: String(response.number), url: response.html_url, key: `#${response.number}` };
  }

  async addComment(issueId: string, comment: string): Promise<void> {
    const [owner, repo] = /* ... */;
    await githubFetch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issueId}/comments`,
      this.config.token, 'POST', { body: comment }
    );
  }

  async linkToPullRequest(issueId: string, prUrl: string): Promise<void> {
    // GitHub auto-links when PR body references the issue number
    // Add a comment with the PR link
    await this.addComment(issueId, `🔗 Fix PR: ${prUrl}`);
  }
}
```

### 6.3 Linear tracker

```typescript
class LinearTrackerClient implements TrackerClient {
  constructor(private config: TrackerConfig) {}

  async createIssue(params: TrackerIssueParams): Promise<TrackerIssueResult> {
    // POST https://api.linear.app/graphql
    const mutation = `
      mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          issue { id url identifier }
        }
      }
    `;
    const response = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: mutation,
        variables: {
          input: {
            teamId: await this.resolveTeamId(this.config.team),
            title: params.title,
            description: this.buildBody(params),
            labels: await this.resolveLabelIds(params.labels),
            priority: this.mapSeverity(params.severity),
          },
        },
      }),
    });
    const data = await response.json();
    const issue = data.data.issueCreate.issue;
    return { id: issue.id, url: issue.url, key: issue.identifier };
  }

  async addComment(issueId: string, comment: string): Promise<void> {
    const mutation = `
      mutation CreateComment($input: CommentCreateInput!) {
        commentCreate(input: $input) { success }
      }
    `;
    await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: mutation,
        variables: { input: { issueId, body: comment } },
      }),
    });
  }

  async linkToPullRequest(issueId: string, prUrl: string): Promise<void> {
    await this.addComment(issueId, `🔗 Fix PR: ${prUrl}`);
  }
}
```

### 6.4 Jira tracker

```typescript
class JiraTrackerClient implements TrackerClient {
  private baseUrl: string;

  constructor(private config: TrackerConfig & { jira_base_url: string }) {
    this.baseUrl = config.jira_base_url.replace(/\/$/, '');
  }

  async createIssue(params: TrackerIssueParams): Promise<TrackerIssueResult> {
    const response = await fetch(`${this.baseUrl}/rest/api/2/issue`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fields: {
          project: { key: this.config.team },
          summary: params.title,
          description: this.buildBody(params),
          issuetype: { name: 'Bug' },
          labels: params.labels,
          priority: { name: this.mapSeverity(params.severity) },
        },
      }),
    });
    const data = await response.json();
    return {
      id: data.id,
      url: `${this.baseUrl}/browse/${data.key}`,
      key: data.key,
    };
  }

  async addComment(issueId: string, comment: string): Promise<void> {
    await fetch(`${this.baseUrl}/rest/api/2/issue/${issueId}/comment`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body: comment }),
    });
  }

  async linkToPullRequest(issueId: string, prUrl: string): Promise<void> {
    // Jira supports remote links to external URLs
    await fetch(`${this.baseUrl}/rest/api/2/issue/${issueId}/remotelink`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        object: { url: prUrl, title: 'Fix Pull Request' },
      }),
    });
  }
}
```

### 6.5 `.donmerge` tracker configuration

Repos can optionally declare their tracker in `.donmerge`:

```yaml
# .donmerge (repo-level config)
version: "1"

# Existing fields
exclude: ["*.generated.ts", "dist/"]
instructions: "Focus on security"

# New: tracker configuration (declared in repo, credentials from API request)
tracker:
  type: linear          # "github" | "linear" | "jira"
  team: ENG             # Linear team key or Jira project key
  labels: [Bug, Sentry] # Labels to apply
  # NOTE: No credentials here. Tokens come from the API request body.
```

This is **optional** — the API request can always override or provide the tracker config directly. The `.donmerge` file just saves CI pipelines from hardcoding the tracker type/team/labels.

---

## 7. File Changes Summary

### New Files

```
src/
├── api/                                    # New API layer
│   ├── types.ts                            # Push API request/response types
│   ├── auth.ts                             # API key validation middleware
│   ├── routes.ts                           # API route handlers
│   └── rate-limit.ts                       # RateLimiter DO + per-key rate limiting
│
├── workflows/
│   └── sentry-triage/                      # New Sentry triage workflow
│       ├── index.ts                        # Public exports
│       ├── types.ts                        # Sentry triage types
│       ├── processor.ts                    # SentryTriageProcessor DO
│       ├── sentry-api.ts                   # Sentry API client
│       ├── sentry-url-parser.ts            # Parse Sentry issue URLs
│       ├── repo-fetcher.ts                 # Fetch repo code at SHA for triage
│       ├── prompts/
│       │   ├── index.ts                    # Prompt barrel export
│       │   ├── builder.ts                  # TriagePromptBuilder (fluent builder)
│       │   ├── templates.ts                # Triage system prompt + rules
│       │   └── schema.ts                   # LLM JSON output schema
│       ├── trackers/
│       │   ├── index.ts                    # Tracker factory + interface
│       │   ├── types.ts                    # TrackerClient interface
│       │   ├── github-tracker.ts           # GitHub Issues client
│       │   ├── linear-tracker.ts           # Linear GraphQL client
│       │   └── jira-tracker.ts             # Jira REST client
│       └── __tests__/
│           ├── processor.test.ts           # DO lifecycle tests
│           ├── sentry-api.test.ts          # Sentry API client tests
│           ├── prompts.test.ts             # Prompt builder tests
│           ├── trackers.test.ts            # Tracker client tests
│           └── sentry-url-parser.test.ts   # URL parsing tests
│
└── env.d.ts                                # NEW: Global env type declarations
```

### Modified Files

| File | Change | Scope |
|------|--------|-------|
| `src/app.ts` | Add push API routes (`/api/v1/review`, `/api/v1/sentry/triage`, `/api/v1/status/:job_id`) | ~30 lines added |
| `wrangler.jsonc` | Add `SentryTriageProcessor` and `RateLimiter` DOs to `durable_objects.bindings` and `migrations` | ~20 lines added |
| `src/workflows/code-review/types.ts` | No changes needed — `WorkerEnv` moves to `src/env.d.ts` | — |
| `.env.example` | Add `DONMERGE_API_KEYS` documentation | ~10 lines added |

### Migration in `wrangler.jsonc`

```jsonc
{
  "durable_objects": {
    "bindings": [
      // ... existing Sandbox + ReviewProcessor ...
      {
        "class_name": "SentryTriageProcessor",
        "name": "SentryTriageProcessor"
      },
      {
        "class_name": "RateLimiter",
        "name": "RateLimiter"
      }
    ]
  },
  "migrations": [
    // ... existing v1 (Sandbox), v2 (ReviewProcessor) ...
    {
      "new_sqlite_classes": ["SentryTriageProcessor", "RateLimiter"],
      "tag": "v3"
    }
  ]
}
```

---

## 8. Implementation Phases

### Phase A: API Foundation (no new workflows)

**Goal:** Existing code review, but callable via push API.

- [ ] Create `src/api/types.ts` — push API request/response types
- [ ] Create `src/api/auth.ts` — API key validation
  - Parse `Authorization: Bearer dm_live_*` header
  - Validate against `DONMERGE_API_KEYS` env var
  - Return `AuthenticatedRequest` or throw 401
- [ ] Create `src/api/rate-limit.ts` — `RateLimiter` DO
  - Per-key sliding window counter (minute + hour)
  - `checkLimit(key)` → `{ allowed, remaining, reset }`
- [ ] Create `src/api/routes.ts` — API route handlers
  - `POST /api/v1/review` → validate request → `ReviewProcessor.startReview()`
  - `GET /api/v1/status/:job_id` → route to appropriate DO → return status
- [ ] Modify `src/app.ts` — register new routes
  - Add auth middleware for `/api/v1/*`
  - Wire to route handlers
- [ ] Modify `wrangler.jsonc` — add `RateLimiter` DO (v3 migration)
- [ ] Update `.env.example` — document `DONMERGE_API_KEYS`
- [ ] **Test:** Call `POST /api/v1/review` from curl with a real PR, verify review completes
- [ ] **Test:** Verify `GET /api/v1/status/{job_id}` returns correct states
- [ ] **Test:** Verify 401 on bad API key, 429 on rate limit exceeded

**Estimated effort:** 2-3 days

### Phase B: Sentry Triage Core

**Goal:** Sentry issue → root cause analysis, no auto-fix or tracker yet.

- [ ] Create `src/workflows/sentry-triage/types.ts`
- [ ] Create `src/workflows/sentry-triage/sentry-api.ts`
  - `fetchSentryIssue(org, issueId, token)` → `SentryIssueData`
  - `fetchSentryEvents(org, issueId, token)` → `SentryEvent[]`
- [ ] Create `src/workflows/sentry-triage/sentry-url-parser.ts`
  - Parse all common Sentry URL formats
- [ ] Create `src/workflows/sentry-triage/prompts/`
  - `templates.ts` — triage system prompt, rules, format
  - `schema.ts` — LLM JSON output schema
  - `builder.ts` — `TriagePromptBuilder` (fluent builder, mirrors `ReviewPromptBuilder`)
- [ ] Create `src/workflows/sentry-triage/repo-fetcher.ts`
  - Fetch files from repo at SHA using stack trace paths
- [ ] Create `src/workflows/sentry-triage/processor.ts`
  - `SentryTriageProcessor` DO with alarm-based execution
  - Steps: fetch Sentry data → fetch repo code → run LLM triage → store result
  - No auto-fix, no tracker yet (those are Phase C/D)
- [ ] Create `src/workflows/sentry-triage/index.ts` — public exports
- [ ] Add `POST /api/v1/sentry/triage` route to `src/api/routes.ts`
- [ ] Modify `wrangler.jsonc` — add `SentryTriageProcessor` DO
- [ ] **Test:** Unit tests for Sentry API client (mocked responses)
- [ ] **Test:** Unit tests for URL parser
- [ ] **Test:** Unit tests for prompt builder
- [ ] **Test:** Integration test: full triage pipeline with mocked Sentry + GitHub

**Estimated effort:** 3-4 days

### Phase C: Auto-Fix (PR Creation)

**Goal:** Sentry triage can create a PR with the suggested fix.

- [ ] Extend `SentryTriageProcessor.runTriage()`:
  - If `options.auto_fix = true` and LLM returns `code_fix`:
    - Validate the diff
    - Create branch via GitHub API
    - Commit the fix
    - Open a PR
- [ ] Add `repo-fetcher.ts` enhancements:
  - Fetch full file content (not just from stack trace)
  - Apply unified diff to get new file content
- [ ] **Test:** Auto-fix with a real repo (or mocked GitHub API)
- [ ] **Test:** Edge cases: multi-file fixes, binary files, merge conflicts

**Estimated effort:** 2-3 days

### Phase D: Tracker Integration

**Goal:** Triage results create issues in GitHub, Linear, or Jira.

- [ ] Create `src/workflows/sentry-triage/trackers/types.ts` — `TrackerClient` interface
- [ ] Create `src/workflows/sentry-triage/trackers/github-tracker.ts`
- [ ] Create `src/workflows/sentry-triage/trackers/linear-tracker.ts`
- [ ] Create `src/workflows/sentry-triage/trackers/jira-tracker.ts`
- [ ] Create `src/workflows/sentry-triage/trackers/index.ts` — factory function
- [ ] Extend `SentryTriageProcessor`:
  - After triage, if `options.create_issue = true`:
    - Create tracker client from config
    - Create issue with triage summary
    - If PR was created, link them
- [ ] Update `.donmerge` config parsing to support `tracker:` section
- [ ] **Test:** Unit tests for each tracker client (mocked API responses)
- [ ] **Test:** Integration test: triage → create Linear issue

**Estimated effort:** 2-3 days

### Phase E: CI/CD Templates & Documentation

**Goal:** Make it dead simple for teams to adopt donmerge push API.

- [ ] Create GitHub Action: `templates/donmerge-review.yml`
  - Triggers on `pull_request` events
  - Calls `POST /api/v1/review` with `${{ secrets.GITHUB_TOKEN }}`
- [ ] Create GitHub Action: `templates/donmerge-sentry-triage.yml`
  - Triggers on Sentry webhook or scheduled check
  - Calls `POST /api/v1/sentry/triage`
- [ ] Create `docs/push-api.md` — API reference
- [ ] Create `docs/setup-guide.md` — Step-by-step setup for new teams
- [ ] Update `README.md` with push model overview

**Estimated effort:** 1-2 days

---

## 9. Security Considerations

### 9.1 Credential handling

| Credential | Who provides | Where it lives | Lifetime |
|-----------|-------------|---------------|----------|
| `github_token` | Caller (CI/CD) | DO storage during job | Cleared on job completion |
| `sentry_auth_token` | Caller (CI/CD) | DO storage during job | Cleared on job completion |
| `tracker.token` | Caller (CI/CD) | DO storage during job | Cleared on job completion |
| `OPENAI_API_KEY` | donmerge (env var) | Worker env | Permanent |
| `DONMERGE_API_KEYS` | donmerge (env var) | Worker env | Permanent |

**Key principle:** donmerge stores **zero** per-tenant secrets. All third-party tokens are ephemeral — they exist only for the duration of a job and are never persisted to durable storage after completion.

**Implementation detail:** The `SentryTriageContext` (stored in DO storage) includes `sentryAuthToken` and `githubToken` for retry support (if the alarm fires again, it needs the tokens). On job completion or failure, these fields are cleared:

```typescript
// After completion or permanent failure:
context.sentryAuthToken = '[REDACTED]';
context.githubToken = '[REDACTED]';
context.tracker.token = '[REDACTED]';
await this.state.storage.put(STATE_KEYS.context, context);
```

### 9.2 API key security

- API keys are checked via timing-safe comparison (same as webhook signatures)
- Keys are stored as plain text in the `DONMERGE_API_KEYS` env var (MVP)
- Future: hash keys with SHA-256 and store hashes, compare against hash of incoming key
- Rate limiting prevents brute-force key guessing

### 9.3 Sandbox isolation

- All LLM calls run inside the Cloudflare Sandbox (container-based DO)
- Each job gets its own sandbox session
- Sandbox is destroyed after job completion (`sleepAfter: '30m'`)
- Caller tokens are passed as env vars to the sandbox, not baked into prompts
- Sentry data and user code are treated as **untrusted input** — sanitized before prompt inclusion

### 9.4 Input sanitization

- Sentry issue titles, descriptions, and breadcrumbs are sanitized using the same `sanitizePromptInput()` function from the code review flow
- Stack trace data is treated as untrusted — no code execution based on stack trace content
- Tracker issue descriptions are plain text, no HTML/Markdown injection

### 9.5 Rate limiting

- Per-API-key rate limits prevent abuse
- `RateLimiter` DO uses sliding window counters
- Separate limits for live and test keys
- 429 responses include `Retry-After` header

---

## 10. Existing Code Review Flow — Migration Path

### Coexistence strategy

The existing `POST /webhook/github` handler stays **completely unchanged**. Both flows coexist:

```
┌──────────────────────────────────────────────┐
│               donmerge Worker                 │
│                                               │
│  Path A: Webhook (existing)                   │
│  ─────────────────────────                    │
│  POST /webhook/github                         │
│  ↓ verifyWebhookSignature()                   │
│  ↓ parseTrigger()                             │
│  ↓ ReviewProcessor.startReview()              │
│  ↓ (donmerge resolves GitHub token via App)   │
│                                               │
│  Path B: Push API (new)                       │
│  ─────────────────────────                    │
│  POST /api/v1/review                          │
│  ↓ validateApiKey()                           │
│  ↓ checkRateLimit()                           │
│  ↓ ReviewProcessor.startReview()              │
│  ↓ (caller provides GitHub token directly)    │
│                                               │
│  Both paths → same ReviewProcessor DO         │
└──────────────────────────────────────────────┘
```

### No changes to webhook flow

- [ ] No code changes to `webhook.ts`, `github-auth.ts`, or `triggers.ts`
- [ ] `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` remain for Company A
- [ ] `REPO_CONFIGS` allowlist only applies to webhook flow (push API has no allowlist)
- [ ] `REVIEW_TRIGGER` comment trigger only applies to webhook flow

### Key difference in ReviewProcessor

The `ReviewProcessor` already has a `githubToken` field in its stored `ReviewContext`. Today it's resolved from the GitHub App JWT. In the push model, it's passed directly:

```typescript
// Webhook path: token resolved from GitHub App
context.githubToken = await resolveGitHubToken(this.env, context.installationId);

// Push API path: token comes directly from request body
context.githubToken = request.github_token;
```

No code change needed in `ReviewProcessor` — it already accepts an optional `githubToken` in context and uses it if present, falling back to `resolveGitHubToken()` only if not provided.

### Optional: migrate Company A to push model

If Company A wants to switch from webhooks to push:

1. Add `DONMERGE_API_KEY=dm_live_xxx` to their CI secrets
2. Add `donmerge-review.yml` GitHub Action to their repo
3. Remove the donmerge webhook from their GitHub repo settings
4. Remove `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `REPO_CONFIGS` from donmerge env

**This is optional.** Company A can stay on webhooks indefinitely.

---

## 11. Environment Variables

### Updated env var reference

```bash
# ══════════════════════════════════════════════════════════════
# SHARED — donmerge owns these (required for all modes)
# ══════════════════════════════════════════════════════════════

# OpenAI API key for LLM access (required)
OPENAI_API_KEY=sk-...

# Codex model to use (optional, default: openai/gpt-5.3-codex)
CODEX_MODEL=openai/gpt-5.3-codex

# Max files to review per PR (optional, default: 50)
MAX_REVIEW_FILES=50

# ══════════════════════════════════════════════════════════════
# PUSH API MODE (new)
# ══════════════════════════════════════════════════════════════

# Comma-separated list of valid API keys (required for push API)
# Format: dm_live_xxxxxxxx or dm_test_xxxxxxxx
DONMERGE_API_KEYS=dm_live_abc123,dm_live_def456,dm_test_xyz789

# ══════════════════════════════════════════════════════════════
# WEBHOOK MODE (existing, Company A only)
# Only needed if using POST /webhook/github
# ══════════════════════════════════════════════════════════════

# GitHub webhook secret (required for webhook mode)
GITHUB_WEBHOOK_SECRET=whsec_...

# GitHub App ID (required for webhook mode)
GITHUB_APP_ID=123456

# GitHub App private key PEM (required for webhook mode)
GITHUB_APP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"

# Optional fallback PAT for webhook mode
GITHUB_TOKEN_PAT=

# Repository allowlist: "owner/repo:branch,owner/repo2" (webhook mode only)
# Configured in wrangler.jsonc vars, not as env var
# REPO_CONFIGS=tableoltd/tableo-s3-browser-app:main

# Comment trigger for manual re-run (webhook mode only)
# Configured in wrangler.jsonc vars
# REVIEW_TRIGGER=@donmerge
```

### Wrangler secrets

For production, store sensitive values as Wrangler secrets instead of env vars:

```bash
# Set secrets via Wrangler CLI (encrypted at rest)
wrangler secret put OPENAI_API_KEY
wrangler secret put DONMERGE_API_KEYS
wrangler secret put GITHUB_WEBHOOK_SECRET
wrangler secret put GITHUB_APP_PRIVATE_KEY
```

---

## 12. Example CI/CD Workflows

### 12.1 Code review on PR (push model)

```yaml
# .github/workflows/donmerge-review.yml
name: DonMerge Code Review

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger DonMerge Review
        run: |
          response=$(curl -s -w "\n%{http_code}" \
            -X POST "${{ vars.DONMERGE_API_URL }}/api/v1/review" \
            -H "Authorization: Bearer ${{ secrets.DONMERGE_API_KEY }}" \
            -H "Content-Type: application/json" \
            -d "{
              \"repo\": \"${{ github.repository }}\",
              \"pr_number\": ${{ github.event.pull_request.number }},
              \"github_token\": \"${{ secrets.GITHUB_TOKEN }}\",
              \"sha\": \"${{ github.event.pull_request.head.sha }}\"
            }")

          http_code=$(echo "$response" | tail -1)
          body=$(echo "$response" | sed '$d')

          echo "Response: $body"

          if [ "$http_code" -ne 202 ]; then
            echo "::error::DonMerge review failed to queue (HTTP $http_code)"
            exit 1
          fi

          echo "Review queued successfully"

        # Don't block the PR on review submission — the review
        # is async and posts comments directly via the GitHub API
        continue-on-error: true
```

### 12.2 Sentry triage on new error (push model)

```yaml
# .github/workflows/donmerge-sentry-triage.yml
name: DonMerge Sentry Triage

on:
  # Option 1: Triggered by Sentry webhook (requires Sentry integration setup)
  repository_dispatch:
    types: [sentry-issue]

  # Option 2: Scheduled check for new Sentry issues
  # schedule:
  #   - cron: '*/15 * * * *'

jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger DonMerge Sentry Triage
        run: |
          response=$(curl -s -w "\n%{http_code}" \
            -X POST "${{ vars.DONMERGE_API_URL }}/api/v1/sentry/triage" \
            -H "Authorization: Bearer ${{ secrets.DONMERGE_API_KEY }}" \
            -H "Content-Type: application/json" \
            -d "{
              \"repo\": \"${{ github.repository }}\",
              \"sentry_issue_url\": \"${{ github.event.client_payload.sentry_issue_url }}\",
              \"sentry_auth_token\": \"${{ secrets.SENTRY_AUTH_TOKEN }}\",
              \"github_token\": \"${{ secrets.GITHUB_TOKEN }}\",
              \"sha\": \"main\",
              \"tracker\": {
                \"type\": \"linear\",
                \"token\": \"${{ secrets.LINEAR_API_TOKEN }}\",
                \"team\": \"ENG\",
                \"labels\": [\"Bug\", \"Sentry\"]
              },
              \"options\": {
                \"auto_fix\": false,
                \"create_issue\": true
              }
            }")

          http_code=$(echo "$response" | tail -1)
          body=$(echo "$response" | sed '$d')

          echo "Response: $body"

          if [ "$http_code" -ne 202 ]; then
            echo "::error::DonMerge Sentry triage failed to queue (HTTP $http_code)"
            exit 1
          fi

          # Parse job_id for status polling (optional)
          job_id=$(echo "$body" | jq -r '.job_id')
          echo "Triage queued: $job_id"

          # Optionally poll for completion
          status_url=$(echo "$body" | jq -r '.status_url')
          echo "Status URL: ${{ vars.DONMERGE_API_URL }}${status_url}"
```

### 12.3 Sentry webhook to GitHub dispatch (bridge)

For teams using Sentry webhooks, a simple bridge function triggers the GitHub Action:

```yaml
# .github/workflows/sentry-webhook-bridge.yml
name: Sentry Webhook Bridge

on:
  workflow_dispatch:
    inputs:
      sentry_issue_url:
        description: 'Sentry issue URL'
        required: true

jobs:
  triage:
    uses: ./.github/workflows/donmerge-sentry-triage.yml
    with:
      sentry_issue_url: ${{ inputs.sentry_issue_url }}
    secrets: inherit
```

Or via a Cloudflare Worker / serverless function that receives the Sentry webhook and dispatches to GitHub:

```typescript
// Simplified Sentry webhook → GitHub dispatch bridge
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const sentryPayload = await request.json();
    const issueUrl = sentryPayload.data?.issue?.url;

    await fetch(
      `https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
        },
        body: JSON.stringify({
          event_type: 'sentry-issue',
          client_payload: { sentry_issue_url: issueUrl },
        }),
      }
    );

    return new Response('OK', { status: 200 });
  },
};
```

---

## 13. Testing Strategy

### 13.1 Unit tests

Each new module gets its own test file:

| Module | Test file | What to test |
|--------|-----------|--------------|
| `api/auth.ts` | `api/__tests__/auth.test.ts` | Key validation, missing header, invalid format, timing-safe comparison |
| `api/rate-limit.ts` | `api/__tests__/rate-limit.test.ts` | Window counting, burst handling, key isolation |
| `api/routes.ts` | `api/__tests__/routes.test.ts` | Request validation, 202 response, 401/429/400 errors |
| `sentry-api.ts` | `sentry-triage/__tests__/sentry-api.test.ts` | URL parsing, API response parsing, error handling |
| `sentry-url-parser.ts` | `sentry-triage/__tests__/sentry-url-parser.test.ts` | All Sentry URL formats |
| `prompts/builder.ts` | `sentry-triage/__tests__/prompts.test.ts` | Prompt construction, sanitization, all sections present |
| `trackers/github-*.ts` | `sentry-triage/__tests__/trackers.test.ts` | Issue creation, commenting, linking (mocked API) |

### 13.2 Integration tests

Test the full pipeline with mocked external APIs:

```typescript
// sentry-triage/__tests__/processor.test.ts
describe('SentryTriageProcessor', () => {
  it('should complete a full triage cycle', async () => {
    // Mock Sentry API to return a sample error
    // Mock GitHub API to return source code
    // Mock LLM to return a triage result
    // Verify: status transitions, result stored, no external side effects
  });

  it('should retry on transient failures', async () => {
    // Mock Sentry API to fail once, then succeed
    // Verify: alarm rescheduled, second attempt succeeds
  });

  it('should fail permanently after 5 attempts', async () => {
    // Mock all API calls to fail
    // Verify: status = 'failed' after 5 alarms
  });

  it('should create a tracker issue when requested', async () => {
    // Mock tracker API
    // Verify: issue created with correct title, labels, description
  });
});
```

### 13.3 E2E test

Manual E2E test against local dev donmerge:

```bash
# 1. Start donmerge locally
wrangler dev

# 2. Set a test API key
export DONMERGE_API_KEYS=dm_test_e2e

# 3. Trigger a code review
curl -X POST http://localhost:8787/api/v1/review \
  -H "Authorization: Bearer dm_test_e2e" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "testorg/testrepo",
    "pr_number": 1,
    "github_token": "ghs_test_token"
  }'

# 4. Poll status
curl http://localhost:8787/api/v1/status/review-testorg-testrepo-1 \
  -H "Authorization: Bearer dm_test_e2e"

# 5. Verify review comments appear on the PR
```

### 13.4 Test fixtures

Create shared test fixtures for common Sentry responses:

```
src/workflows/sentry-triage/__tests__/fixtures/
├── sentry-issue-response.json      # Sample issue metadata
├── sentry-events-response.json     # Sample events with stack traces
├── sentry-javascript-error.json    # JS error with sourcemaps
├── sentry-python-error.json        # Python traceback
└── triage-llm-output.json          # Sample LLM triage output
```

---

## Appendix A: How `POST /api/v1/review` maps to existing code

This shows exactly which existing functions are reused by the push API:

```
POST /api/v1/review
  │
  ├─ validateApiKey()                 ← NEW (src/api/auth.ts)
  ├─ checkRateLimit()                 ← NEW (src/api/rate-limit.ts)
  │
  ├─ Parse PushReviewRequest body     ← NEW (src/api/routes.ts)
  │   ├─ repo → split into owner, repo
  │   ├─ pr_number
  │   ├─ github_token → passed directly (no resolveGitHubToken)
  │   └─ sha, instruction, focus_files
  │
  ├─ getReviewProcessor()             ← EXISTING (processor.ts)
  │   └─ idFromName("owner/repo/pr_number")
  │
  └─ processor.startReview({          ← EXISTING (processor.ts)
       owner, repo, prNumber,
       githubToken: request.github_token,  ← KEY DIFFERENCE
       headSha: request.sha,
       instruction: request.instruction,
       focusFiles: request.focus_files,
       retrigger: false,
     })
       │
       └─ EXISTING pipeline runs unchanged:
          ├─ Fetch PR diff (using caller's token)
          ├─ Fetch .donmerge config
          ├─ Fetch repo context
          ├─ Run LLM review in sandbox
          ├─ Publish review comments
          └─ Complete check run
```

**Net new code for the review push endpoint:** ~100 lines (auth + validation + routing).

---

## Appendix B: Decision Log

| Decision | Options | Chosen | Reason |
|----------|---------|--------|--------|
| Auth method | API key, OAuth, mTLS | API key | Simplest for CI/CD, no browser flow needed |
| API key storage | Env var, KV, DB | Env var (MVP) | Fastest to ship, migrate to KV later |
| Rate limiting | KV counters, DO counters | DO | Accurate sliding window, no KV consistency lag |
| Sentry data source | Sentry API, Sentry webhook | API (pull) | Full issue context, not just alert payload |
| Tracker config location | API request only, .donmerge only, both | Both | .donmerge declares type/team, API provides credentials |
| Credential storage | Encrypted in DO, ephemeral only, never stored | Ephemeral + redacted on completion | Needed for retry support, cleared after terminal state |
| PR creation method | Git data API, Contents API | Contents API | Simpler for single-file fixes, no git knowledge needed |
| LLM model for triage | Same as review, dedicated model | Same model | Shared config, triage uses the same sandbox + FlueRuntime |

---

## Appendix C: Future considerations (out of scope)

These are **not** part of this plan but are anticipated future needs:

1. **WebSocket/SSE for real-time status** — Today we poll `GET /status`. Future: push events via WebSocket or Server-Sent Events.

2. **Web UI dashboard** — A donmerge dashboard showing job history, API key management, usage analytics.

3. **Additional workflows** — The push API is designed to support arbitrary workflows: dependency audit, changelog generation, release note drafting, etc.

4. **API key management API** — `POST /api/v1/keys` to create/revoke keys without redeploying.

5. **KV-based API key storage** — Migrate from env var to KV namespace for dynamic key management.

6. **Sentry Seer integration** — Use Sentry's built-in AI root cause analysis as additional input.

7. **Multi-file auto-fix** — Support fixes that span multiple files (requires Git Data API instead of Contents API).

8. **Webhook for new workflows** — `POST /webhook/sentry` to receive Sentry alerts directly, using donmerge-stored Sentry credentials (for teams that don't want to set up CI/CD bridges).
