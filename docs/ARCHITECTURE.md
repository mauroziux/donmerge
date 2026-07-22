# DonMerge Architecture

This document describes the system architecture of DonMerge — an AI-powered code review and Sentry triage service running on Cloudflare Workers.

---

## Table of Contents

- [System Overview](#system-overview)
- [Code Review Pipeline](#code-review-pipeline)
- [Quality Calibration System](#quality-calibration-system)
- [Issue Tracking Lifecycle](#issue-tracking-lifecycle)
- [Error Handling and Retries](#error-handling-and-retries)
- [Configuration](#configuration)

---

## System Overview

DonMerge is a Cloudflare Worker that receives code review requests via GitHub webhooks or a Push API, processes them through a durable Cloudflare Workflow pipeline, and publishes results back to GitHub as check runs and line comments.

```mermaid
graph TD
    subgraph EntryPoints ["Entry Points"]
        GW["GitHub Webhook<br/>/webhook/github"]
        PA["Push API<br/>POST /api/v1/review"]
        SW["Sentry Webhook<br/>/webhook/sentry"]
    end

    subgraph Worker ["DonMerge Worker"]
        subgraph DurableObjects ["Durable Objects"]
            RP["ReviewProcessor<br/>Status & Concurrency"]
            RL["RateLimiter<br/>API Rate Limiting"]
            TP["TriageProcessor<br/>Error Triage"]
        end

        subgraph Workflows ["Cloudflare Workflows"]
            CRW["CodeReviewWorkflow<br/>4-Step Durable Pipeline"]
        end

        subgraph Sandbox ["Sandbox Container"]
            FLUE["Flue Runtime<br/>OpenCode Server"]
        end
    end

    subgraph ExternalServices ["External Services"]
        GH["GitHub API<br/>PR data, check runs, comments"]
        KIMI["Kimi Code API<br/>K3 primary reviews"]
        OAI["OpenAI API<br/>Automatic fallback"]
    end

    subgraph Downstream ["Downstream Integrations"]
        GIH["GitHub Issues"]
        LIN["Linear"]
        JIR["Jira"]
    end

    GW --> RP
    PA --> RP
    SW --> TP
    RP --> CRW
    CRW --> GH
    CRW --> FLUE
    FLUE --> KIMI
    FLUE -. primary failure .-> OAI
    CRW --> RP
    TP --> GH
    TP --> GIH
    TP --> LIN
    TP --> JIR
```

### Component Responsibilities

| Component | Role |
|-----------|------|
| **ReviewProcessor DO** | Stores review context and status, provides RPC methods for workflow. Does NOT execute the review — that's the workflow's job. |
| **CodeReviewWorkflow** | 4-step durable pipeline: fetch PR data → prepare files → run LLM review → publish review. Retries with exponential backoff. |
| **Sandbox + Flue** | Cloudflare container running OpenCode. It registers Kimi Code as an OpenAI-compatible `kimi` provider for primary reviews and retains built-in OpenAI for automatic fallback. |
| **RateLimiter DO** | Enforces API rate limits for Push API keys (per-key: 30 req/min for live, 10 req/min for test). |
| **TriageProcessor DO** | Handles Sentry error triage — root cause analysis and auto-fix PR creation. |

---

## Code Review Pipeline

The code review pipeline is a Cloudflare Workflow (`CodeReviewWorkflow`) with 4 durable steps. Each step has configurable retries and timeouts.

```mermaid
sequenceDiagram
    participant GH as GitHub / Push API
    participant DO as ReviewProcessor DO
    participant WF as CodeReviewWorkflow
    participant GA as GitHub API
    participant SB as Sandbox + Flue
    participant KIMI as Kimi Code API
    participant OAI as OpenAI API (fallback)

    GH->>DO: startReview(context)
    DO-->>GH: 202 Accepted

    DO->>WF: create WorkflowInstance<br/>(PR ID, or comment-specific ID for @donmerge re-reviews)

    WF->>DO: updateFromWorkflow(state: running)

    rect rgb(240, 248, 255)
        Note over WF,GA: Step 1: fetch-pr-data
        WF->>GA: Resolve GitHub token
        WF->>GA: GET /repos/{owner}/{repo}/pulls/{prNumber}
        WF->>GA: Fetch .donmerge config
        WF->>GA: Add 👀 reaction to trigger comment
        WF->>GA: Resolve .donmerge skills
        WF->>GA: Create check run
        GA-->>WF: PR data + checkRunId
    end

    rect rgb(240, 255, 240)
        Note over WF,GA: Step 2: prepare-files
        WF->>GA: GET /repos/{owner}/{repo}/pulls/{prNumber}/files
        WF->>WF: Apply focus files filter
        WF->>WF: Apply .donmerge exclude/include
        WF->>GA: Fetch repo context (CONTRIBUTING.md, tsconfig, etc.)
        WF->>GA: Fetch previous DonMerge comments (if retrigger)
        GA-->>WF: Diff text + repo context
    end

    rect rgb(255, 248, 240)
        Note over WF,OAI: Step 3: run-llm-review
        WF->>SB: Provision sandbox + Flue runtime
        WF->>SB: Inject KIMI_API_KEY + OPENAI_API_KEY
        WF->>SB: Prompt primary model (default: kimi/k3)
        SB->>KIMI: OpenAI-compatible completion request
        KIMI-->>SB: JSON review result
        alt Provider or output failure
            SB->>OAI: Retry fallback model (default: openai/gpt-4o)
            OAI-->>SB: JSON review result
        end
        SB-->>WF: Raw review JSON
        WF->>WF: Validate + normalize result
        WF->>WF: Apply quality gate (filterLineCommentsByQuality)
        WF->>WF: Apply severity overrides
        WF->>WF: Recompute approval (withBlockingApproval)
    end

    rect rgb(255, 240, 255)
        Note over WF,GA: Step 4: publish-review
        WF->>DO: loadTrackedIssuesRpc()
        DO-->>WF: stored issues
        WF->>WF: Build current issues + match to stored
        WF->>WF: Transition issues (new/open/fixed/reintroduced)
        WF->>DO: saveTrackedIssuesRpc(updated issues)
        WF->>GA: Resolve fixed comments (if enabled)
        WF->>GA: Filter comments (only new + reintroduced)
        WF->>GA: Publish review (summary + line comments)
        WF->>GA: Attach comment IDs to new issues
        WF->>GA: Complete check run (pass/fail)
        WF->>GA: Update PR description
    end

    WF->>DO: updateFromWorkflow(state: complete, result)
    DO->>DO: Redact githubToken from stored context
```

### Step Configuration

| Step | Retries | Timeout | Backoff |
|------|---------|---------|---------|
| `fetch-pr-data` | 3 | 2 minutes | Exponential |
| `prepare-files` | 2 | 2 minutes | Exponential |
| `run-llm-review` | 2 | 5 minutes | Exponential |
| `publish-review` | 2 | 3 minutes | Exponential |

### Deterministic Workflow IDs

Regular PR events use a stable Workflow ID: `review-{owner}-{repo}-{prNumber}`. A comment-triggered `@donmerge` re-review adds the GitHub comment ID: `review-{owner}-{repo}-{prNumber}-comment-{commentId}`.

This ensures that:
- The ReviewProcessor DO still provides one concurrency/status scope per PR
- Duplicate delivery of the same webhook maps to the same workflow instance
- A later comment re-review runs with its **fresh** webhook payload (installation credentials, focus files, and instructions), rather than restarting stale workflow params
- Status queries retain the stable PR-level job ID

---

## Quality Calibration System

DonMerge implements a post-LLM quality gate that filters out generic, vague, or style-only findings. This prevents noise from blocking PRs and ensures only concrete, high-confidence issues affect the approval decision.

### Background

An audit of 100 PRs found that approximately 80% of LLM-generated inline findings were generic, vague, or style-related — not true blocking issues. The quality gate was introduced to separate real correctness risks from noise.

### How the Quality Gate Works

```mermaid
flowchart TD
    A["LLM Output<br/>lineComments + criticalIssues"] --> B["filterLineCommentsByQuality"]

    B --> C{"Is it style/noise?"}
    C -->|Yes| D["DROPPED<br/>PHPDoc, imports,<br/>formatting, naming"]
    C -->|No| E{"Is it vague advisory?"<br/>ensure/verify/consider<br/>without mechanism}

    E -->|Yes| F["DROPPED<br/>No concrete failure<br/>mechanism described"]
    E -->|No| G{"Severity = critical?"}

    G -->|Yes| H{"Has concrete<br/>failure mechanism?"}
    H -->|Yes| I["🔴 KEEP as critical<br/>Blocks merge"]
    H -->|No| J["DROPPED<br/>Critical without<br/>concrete mechanism"]

    G -->|No| K{"Has concrete<br/>failure mechanism?"}
    K -->|Yes| L["🟡 LABEL as Suggestion<br/>Non-blocking"]
    K -->|No| M["DROPPED<br/>Non-critical without<br/>mechanism"]

    B --> N["filterCriticalIssuesByQuality"]
    N --> O{"Has concrete<br/>failure mechanism?"}
    O -->|Yes| P["KEEP in criticalIssues"]
    O -->|No| Q["DROPPED"]

    I --> R["withBlockingApproval"]
    L --> R
    P --> R
    R --> S{"Any critical findings<br/>remaining?"}
    S -->|Yes| T["approved = false<br/>Check run FAILS"]
    S -->|No| U["approved = true<br/>Check run PASSES"]
```

### Pattern Detection

The quality gate uses three categories of regex patterns:

| Pattern Category | Examples | Effect |
|-----------------|----------|--------|
| **Style/Noise** | PHPDoc, imports alphabetical, formatting, refactoring, naming convention | Dropped unless critical domain match |
| **Vague Advisory** | "ensure", "verify", "consider", "may", "could" without failure mechanism | Dropped |
| **Concrete Failure** | "leads to", "causes", "results in", "allows", "crashes", "throws" | Required for blocking |
| **Critical Domain** | SQL injection, XSS, auth, data loss, race condition, null dereference | Elevates severity |
| **Vulnerability Mechanism** | "unsanitized", "unescaped", "attacker-controlled", "directly concatenated" | Combined with critical domain |

### What Blocks vs. What Doesn't

| Finding Type | Before Calibration | After Calibration |
|-------------|-------------------|-------------------|
| 🔴 SQL injection with concrete path | Blocks | Blocks |
| 🔴 "Consider adding auth" (no mechanism) | Blocks | **Dropped** |
| 🟡 Race condition in critical section | Non-blocking | **Blocks** (reclassified) |
| 🟡 "Ensure all errors are handled" | Non-blocking | **Dropped** |
| 🔴 PHPDoc missing on public method | Blocks | **Dropped** |
| 🟡 "Import ordering should be alphabetical" | Non-blocking | **Dropped** |

---

## Issue Tracking Lifecycle

DonMerge tracks findings across re-runs using deterministic fingerprints. Each issue has a stable identity that survives code changes, comment rewording, and line number shifts.

### State Machine

```mermaid
stateDiagram-v2
    [*] --> new: First detection<br/>by LLM

    new --> open: Same PR,<br/>next re-run

    open --> open: Persisting<br/>(still present)

    open --> fixed: Not found<br/>in current diff

    fixed --> reintroduced: Reappears<br/>in new code

    reintroduced --> open: Persisting<br/>again

    new --> fixed: Never persisted<br/>(matched to existing fixed)

    dismissed --> [*]: Manual<br/>dismissal

    note right of new
        First seen in this PR.
        githubCommentId attached
        after publish.
    end note

    note right of fixed
        fixedCommit recorded.
        Resolved comment posted
        (if enabled).
    end note

    note right of reintroduced
        Treated as a new finding
        for publishing purposes.
    end note
```

### Fingerprinting

Each issue is identified by a deterministic fingerprint computed from:

```mermaid
flowchart LR
    A["Review Comment"] --> B["Logical Key"]
    A --> C["Anchor Key"]
    B --> D["Fingerprint<br/>SHA-256(logicalKey|anchorKey)"]
    C --> D

    B --> B1["ruleId | entityType | symbolName"]
    C --> C1["filePath | normalizedCodeSnippet"]
```

| Key | Composition | Purpose |
|-----|-------------|---------|
| **logicalKey** | `{ruleId}\|{entityType}\|{symbolName}` | Identifies the *type* of issue (e.g., "sql-injection\|method\|getUserById") |
| **anchorKey** | `{filePath}\|{normalizedCodeSnippet}` | Identifies the *location* of issue (file + surrounding code) |
| **fingerprint** | `SHA-256(logicalKey\|anchorKey)` | Unique identifier for exact matching |

### Match Strategy

When matching current findings to stored issues:

1. **Exact fingerprint match** — same logical key AND same anchor key
2. **Logical key match** — same rule/entity/symbol (code moved but issue is the same)
3. **Anchor key match** — same file and code snippet (rule wording changed)

### Issue Reconciliation on Re-runs

When a re-trigger occurs, previous DonMerge comments are fetched and used to:
- Reconcile issue keys for stable identity across re-runs
- Sync tracked issues with GitHub comment IDs
- Deduplicate comments (only new + reintroduced issues get published)

---

## Error Handling and Retries

### Workflow Step Retries

Each workflow step has independent retry configuration with exponential backoff:

```mermaid
flowchart TD
    A["Step Execution"] --> B{"Succeeded?"}
    B -->|Yes| C["Proceed to next step"]
    B -->|No| D{"Retries remaining?"}
    D -->|Yes| E["Wait: delay × backoff^attempt"]
    E --> A
    D -->|No| F["Throw error to workflow"]

    F --> G{"checkRunId exists?"}
    G -->|Yes| H["Fail check run<br/>with error code"]
    G -->|No| I["Skip check run"]

    H --> J["Update DO status → failed"]
    I --> J

    J --> K["Redact githubToken"]
    K --> L["Re-throw → Workflows platform<br/>marks instance as failed"]
```

### Check Run Failure on Workflow Error

When any step fails after a check run has been created, the workflow:
1. Calls `failCheckRun()` with a classified error code (DM-E001 through DM-E006)
2. Updates the DO status to `failed`
3. Redacts the GitHub token from stored context
4. Re-throws the error so the Workflows platform records the failure

### DO Status State Machine

```mermaid
stateDiagram-v2
    [*] --> pending: startReview()
    pending --> running: Workflow starts
    running --> complete: All steps succeed
    running --> failed: Any step fails
    pending --> failed: Workflow fails before running

    note right of pending
        Context stored,
        waiting for workflow
    end note

    note right of running
        Workflow is executing
        pipeline steps
    end note

    note right of complete
        Final result stored,
        token redacted
    end note

    note right of failed
        Error recorded,
        token redacted
    end note
```

### Token Redaction

On completion or failure, the DO redacts the GitHub token from stored review context:

```typescript
// processor.ts — updateFromWorkflow()
if (update.state === 'complete' || update.state === 'failed') {
  storedContext.githubToken = undefined;
  await this.state.storage.put(STATE_KEYS.context, storedContext);
}
```

This ensures tokens are not persisted in DO storage after the review lifecycle ends.

### Workflow Output Credential Rule

Cloudflare Workflow step outputs are inspectable through the Workflows API and CLI. Never return a GitHub token or any other credential in a step's serialized return value. Resolve credentials inside the step that uses them, or keep them in internal storage that is not exposed as step output.

---

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `KIMI_API_KEY` | Yes | Kimi Code key for the primary `kimi/k3` provider registered in OpenCode |
| `OPENAI_API_KEY` | Yes | OpenAI key for the automatic fallback provider |
| `FALLBACK_MODEL` | No | Fallback model (default: `openai/gpt-4o`) when the primary provider fails |
| `GITHUB_WEBHOOK_SECRET` | Webhook mode | HMAC secret for webhook signature validation |
| `GITHUB_APP_ID` | Webhook mode | GitHub App ID for installation token resolution |
| `GITHUB_APP_PRIVATE_KEY` | Webhook mode | GitHub App private key (PEM format) |
| `CODEX_MODEL` | No | Primary LLM model (default: `kimi/k3`). Format: `provider/model` |
| `MAX_REVIEW_FILES` | No | Maximum files per PR review (default: `50`) |
| `REPO_CONFIGS` | No | Per-repo base branch config: `owner/repo:branch,...` |
| `REVIEW_TRIGGER` | No | Comment trigger tag (default: `@donmerge`) |
| `DONMERGE_POST_FIXED_REPLIES` | No | Post ✅ replies on fixed issues (`true`/`false`) |
| `DONMERGE_API_KEYS` | Push API | Comma-separated API keys (`dm_live_*`, `dm_test_*`) |
| `SENTRY_WEBHOOK_SECRET` | Sentry | HMAC secrets for Sentry webhook verification |
| `SENTRY_REPO_MAP` | Sentry | Maps Sentry org slugs to GitHub repos |
| `SENTRY_GITHUB_TOKEN` | Sentry | GitHub token for Sentry-triggered code fetching |
| `TENANT_ENCRYPTION_KEY` | D1 multi-tenant | Base64-encoded 256-bit key for secret encryption |
| `LOG_LEVEL` | No | Logging verbosity: `debug`, `info`, `warn`, `error` |

### LLM Provider Routing

`CODEX_MODEL` selects the primary model for code review and triage. The default is `kimi/k3`, implemented as a custom OpenCode provider using Kimi Code's OpenAI-compatible endpoint (`https://api.kimi.com/coding/v1`). `FALLBACK_MODEL` defaults to `openai/gpt-4o` and is attempted if the primary provider fails or cannot produce a valid review response after its format retry.

The model provider is independent of DonMerge's review quality gate: every response still passes JSON validation, normalization, quality filtering, severity calibration, and issue matching before publication.

**Operational note:** Kimi can exceed the current five-minute LLM workflow step timeout on large diffs (for example, a 34-file PR took about 6.4 minutes in production validation). Keep `MAX_REVIEW_FILES` conservative or increase the step timeout before relying on Kimi for large reviews.

### `.donmerge` Configuration File

Placed at the root of reviewed repositories. YAML format, version `"1"`. Missing or invalid files are silently ignored.

```yaml
# .donmerge
version: "1"

# Glob patterns for files to skip
exclude:
  - "*.test.ts"
  - "dist/**"

# Glob patterns that override exclude (include wins)
include:
  - "dist/important-entry.ts"

# Additional context files for the LLM reviewer
# Max 10 files, 20 KB each, 50 KB total
skills:
  - path: "DESIGN.md"
    description: "System architecture"
  - path: "docs/API_CONVENTIONS.md"
    description: "API naming conventions"

# Custom instructions appended to the review prompt
instructions: |
  Focus on:
  - Security vulnerabilities (OWASP Top 10)
  - Performance issues (N+1 queries)

# Per-path severity overrides
severity:
  "src/middleware/**": "critical"
  "**/*.config.ts": "low"
```

### Severity Overrides

The `severity` map in `.donmerge` allows per-path severity reclassification:

- `"critical"` — Finding will block merge (if quality gate passes)
- `"suggestion"` — Non-blocking, labeled 🟡
- `"low"` — Non-blocking, minimal attention

Overrides are applied **after** the LLM produces findings and **before** the quality gate runs. This means a `suggestion`-severity path can elevate a finding to `critical`, or a `critical`-severity path can demote it.

### Error Codes

| Code | Name | Description |
|------|------|-------------|
| `DM-E001` | LLM Failure | Model failed to process the review |
| `DM-E002` | Max Attempts | Exceeded maximum retry attempts |
| `DM-E003` | GitHub API | GitHub API request failed |
| `DM-E004` | Invalid Output | Model produced invalid output after retries |
| `DM-E005` | Internal Error | Unexpected internal error |
| `DM-E006` | Quota Limit | AI model quota or rate limit exceeded |
