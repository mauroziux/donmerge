# DonMerge Push API Reference

> **Base URL:** `https://donmerge.dev` (production) · `https://tableo-assitant-worker-staging.mauroziux.workers.dev` (staging)

## Overview

The DonMerge Push API lets you trigger **AI-powered code reviews** and **error triage** from any environment — CI/CD pipelines, scripts, or automation tools. Unlike the webhook mode (which requires a GitHub App installation), the push model is **credential-bearing**: you provide your own GitHub tokens alongside your DonMerge API key, and DonMerge handles the compute.

DonMerge is ticket-system-agnostic: the caller provides error context (title, description, stack trace, affected files), and DonMerge provides LLM triage, auto-fix PR generation, and tracker issue creation. Works with errors from Sentry, Datadog, Rollbar, New Relic, GitHub Issues, or any source.

### Key differences from webhook mode

| Feature | Webhook mode | Push API |
|---------|-------------|----------|
| Trigger | GitHub App events | HTTP POST calls |
| Credentials | DonMerge holds tokens | Caller provides tokens |
| Auth | GitHub App installation | API key (`dm_live_*` / `dm_test_*`) |
| Use case | Automated PR reviews | CI/CD integration, custom workflows |
| Token lifetime | Persistent | Redacted after job completes |

---

## Authentication

All push API endpoints require a Bearer token in the `Authorization` header.

### API key format

| Prefix | Environment | Rate limits |
|--------|------------|-------------|
| `dm_live_` | Production | 30 req/min, 200 req/hr |
| `dm_test_` | Staging / testing | 10 req/min, 50 req/hr |

Keys are managed via the `DONMERGE_API_KEYS` environment variable (comma-separated for multiple keys).

### Example

```bash
curl -H "Authorization: Bearer dm_live_abc123def456" \
     https://donmerge.dev/api/v1/review
```

---

## Rate Limiting

Rate limits are enforced per API key using fixed-window counters backed by a Durable Object.

| Key type | Per-minute | Per-hour |
|----------|-----------|----------|
| `dm_live_*` | 30 requests | 200 requests |
| `dm_test_*` | 10 requests | 50 requests |

### 429 Response

When the rate limit is exceeded:

```json
HTTP/1.1 429 Too Many Requests

{
  "error": "Rate limit exceeded",
  "message": "Too many requests. Please try again later.",
  "reset_at": 1714032000
}
```

`reset_at` is a Unix timestamp indicating when the rate limit window resets.

---

## Endpoints

### `POST /api/v1/review` — Trigger code review

Triggers an AI code review for a pull request. Returns a `job_id` for status polling.

#### Request body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `github_token` | `string` | Yes | GitHub PAT with `repo` scope (or `GITHUB_TOKEN` in Actions) |
| `owner` | `string` | Yes | Repository owner (e.g. `"tableoltd"`) |
| `repo` | `string` | Yes | Repository name (e.g. `"my-project"`) |
| `pr_number` | `number` | Yes | Pull request number (positive integer) |
| `model` | `string` | No | Override the LLM model (e.g. `"openai/gpt-4o"`) |
| `max_files` | `number` | No | Max files to review (default: 50) |

#### Response — 202 Accepted

```json
{
  "job_id": "review/tableoltd/my-project/42",
  "status": "pending",
  "message": "Review queued for tableoltd/my-project#42"
}
```

#### Error responses

| Status | Code | When |
|--------|------|------|
| 400 | `Bad request` | Missing required fields, invalid owner/repo format, or pr_number not a positive integer |
| 401 | `Unauthorized` | Invalid or missing API key |
| 429 | `Rate limit exceeded` | Too many requests |
| 500 | `Internal error` | Unexpected server error |

#### Example

```bash
curl -X POST https://donmerge.dev/api/v1/review \
  -H "Authorization: Bearer dm_live_abc123def456" \
  -H "Content-Type: application/json" \
  -d '{
    "github_token": "ghp_xxxxxxxxxxxxxxxxxxxx",
    "owner": "tableoltd",
    "repo": "my-project",
    "pr_number": 42,
    "max_files": 30
  }'
```

400 example:

```bash
# Missing required field
curl -X POST https://donmerge.dev/api/v1/review \
  -H "Authorization: Bearer dm_live_abc123def456" \
  -H "Content-Type: application/json" \
  -d '{"owner": "tableoltd", "repo": "my-project"}'

# Response:
# {"error":"Bad request","message":"Missing required fields: github_token, owner, repo, pr_number"}
```

---

### `POST /api/v1/triage` — Trigger error triage

Triggers an AI analysis of an error against your codebase. The caller provides error context (title, description, stack trace, affected files); DonMerge does not fetch from any external error tracking service. Optionally generates a fix PR and creates a tracker issue.

#### Request body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `repo` | `string` | Yes | Full repository path `"owner/repo"` |
| `github_token` | `string` | Yes | GitHub PAT with `repo` scope |
| `sha` | `string` | Yes | Git SHA or branch name to analyze (e.g. `"main"`, `"a1b2c3d"`) |
| `error_context` | `object` | Yes | Error context (see below) |
| `tracker` | `object` | No | Tracker configuration (see [Tracker Integration](#tracker-integration)) |
| `options` | `object` | No | Triage options (see below) |

**`error_context` sub-object:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | `string` | Yes | Short summary of the error |
| `description` | `string` | Yes | Detailed description of the error |
| `stack_trace` | `string` | Yes | Stack trace as a single string |
| `affected_files` | `string[]` | Yes | List of file paths implicated by the error |
| `severity` | `string` | No | Assessed severity: `"critical"` \| `"error"` \| `"warning"` (LLM infers if omitted) |
| `environment` | `string` | No | Environment where the error occurred (e.g. `"production"`) |
| `metadata` | `object` | No | Additional metadata from the caller (e.g. event count, user count, tags) |
| `source_url` | `string` | No | Original URL of the error/ticket in the source system |

**`options` sub-object:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `auto_fix` | `boolean` | `true` | Attempt to generate a fix PR |

#### Response — 202 Accepted

```json
{
  "job_id": "triage/a1b2c3d4e5f6",
  "status": "pending",
  "message": "Triage queued for tableoltd/my-project"
}
```

#### Error responses

| Status | Code | When |
|--------|------|------|
| 400 | `Bad request` | Missing required fields, invalid repo format, invalid tracker config |
| 401 | `Unauthorized` | Invalid or missing API key |
| 429 | `Rate limit exceeded` | Too many requests |
| 500 | `Internal error` | Unexpected server error |

#### Example

Full request with tracker:

```bash
curl -X POST https://donmerge.dev/api/v1/triage \
  -H "Authorization: Bearer dm_live_abc123def456" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "tableoltd/my-project",
    "github_token": "ghp_xxxxxxxxxxxxxxxxxxxx",
    "sha": "main",
    "error_context": {
      "title": "NullPointerException in UserService.getProfile",
      "description": "User profile is accessed without a null check after the database query returns a partial record",
      "stack_trace": "Error originated in UserService.getProfile (line 42) when accessing user.profile.email\n  at UserService.getProfile (src/services/user.ts:42:15)\n  at ProfileRouter.get (src/routes/profile.ts:18:22)",
      "affected_files": ["src/services/user.ts", "src/routes/profile.ts"],
      "severity": "critical",
      "environment": "production",
      "source_url": "https://sentry.io/organizations/tableoltd/issues/123456/"
    },
    "tracker": {
      "type": "github",
      "token": "ghp_xxxxxxxxxxxxxxxxxxxx",
      "team": "eng",
      "labels": ["bug"]
    },
    "options": {
      "auto_fix": true
    }
  }'
```

Minimal request (no tracker, auto_fix defaults to true):

```bash
curl -X POST https://donmerge.dev/api/v1/triage \
  -H "Authorization: Bearer dm_live_abc123def456" \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "tableoltd/my-project",
    "github_token": "ghp_xxxxxxxxxxxxxxxxxxxx",
    "sha": "main",
    "error_context": {
      "title": "TypeError: Cannot read property of undefined",
      "description": "Property foo accessed on undefined object",
      "stack_trace": "at handleRequest (src/index.ts:42:10)",
      "affected_files": ["src/index.ts"]
    }
  }'
```

---

### `GET /api/v1/status/:job_id` — Check job status

Polls the status of a previously submitted review or triage job.

#### Path parameters

| Parameter | Description |
|-----------|-------------|
| `job_id` | The job identifier returned by the trigger endpoint |

**Review job IDs** have the format `review/{owner}/{repo}/{pr_number}`.
**Triage job IDs** have the format `triage/{uuid}`.

#### Response — 200 OK

```json
{
  "job_id": "review/tableoltd/my-project/42",
  "status": "complete",
  "result": { ... },
  "error": null,
  "created_at": "2026-04-26T10:30:00.000Z",
  "updated_at": "2026-04-26T10:32:15.000Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `job_id` | `string` | The job identifier |
| `status` | `string` | `"pending"` \| `"running"` \| `"complete"` \| `"failed"` |
| `result` | `object` | Present when `status` is `"complete"` (see result schemas below) |
| `error` | `string` | Present when `status` is `"failed"` |
| `created_at` | `string` | ISO 8601 timestamp when the job was created |
| `updated_at` | `string` | ISO 8601 timestamp when the job was last updated |

#### Error responses

| Status | Code | When |
|--------|------|------|
| 401 | `Unauthorized` | Invalid or missing API key |
| 404 | `Not found` | Unknown job_id format or job not found |
| 500 | `Internal error` | Failed to retrieve status |

#### Example

```bash
curl -H "Authorization: Bearer dm_live_abc123def456" \
  https://donmerge.dev/api/v1/status/review/tableoltd/my-project/42
```

While running:

```json
{
  "job_id": "review/tableoltd/my-project/42",
  "status": "running",
  "result": null,
  "error": null,
  "created_at": "2026-04-26T10:30:00.000Z",
  "updated_at": "2026-04-26T10:30:05.000Z"
}
```

---

## Job Lifecycle

All push API jobs follow the same state machine:

```
pending → running → complete
                  → failed
```

| State | Description |
|-------|-------------|
| `pending` | Job received, waiting for a worker to pick it up |
| `running` | Job is actively being processed |
| `complete` | Job finished successfully; `result` is populated |
| `failed` | Job encountered an error; `error` describes the failure |

### Polling pattern

After receiving a `202 Accepted` response with a `job_id`, poll the status endpoint:

```bash
# Poll every 10 seconds until status is "complete" or "failed"
JOB_ID="review/tableoltd/my-project/42"
API_KEY="dm_live_abc123def456"

while true; do
  STATUS=$(curl -s -H "Authorization: Bearer $API_KEY" \
    "https://donmerge.dev/api/v1/status/$JOB_ID" | jq -r '.status')

  echo "Status: $STATUS"

  if [ "$STATUS" = "complete" ] || [ "$STATUS" = "failed" ]; then
    break
  fi

  sleep 10
done
```

**Recommended:** Maximum poll duration of 5 minutes. Reviews and triage typically complete within 30–120 seconds.

### Retry behavior

The server retries failed triage jobs automatically (up to 5 attempts with 10-second delays) for transient errors (network timeouts, temporary failures). Auth errors, quota errors, and validation errors are not retried.

---

## Review Result Schema

When `status` is `"complete"` for a review job, the `result` object contains:

```json
{
  "approved": true,
  "summary": "The PR implements user authentication with JWT tokens. Code quality is good with minor suggestions.",
  "prSummary": {
    "overview": "Adds JWT-based authentication middleware and login/logout endpoints.",
    "keyChanges": [
      "New auth middleware in src/middleware/auth.ts",
      "Login/logout endpoints in src/routes/auth.ts",
      "JWT utility functions in src/utils/jwt.ts"
    ],
    "codeQuality": "Well-structured with clear separation of concerns.",
    "testingNotes": "Unit tests cover happy paths; edge cases for token expiry could be improved.",
    "riskAssessment": "Medium — auth changes require careful review of token validation logic."
  },
  "lineComments": [
    {
      "path": "src/middleware/auth.ts",
      "line": 15,
      "side": "RIGHT",
      "body": "**Critical:** Token expiry should be validated before using the decoded payload.",
      "severity": "critical"
    }
  ],
  "criticalIssues": [
    "Token expiry not validated before decoding in auth middleware"
  ],
  "suggestions": [
    "Consider using a constant-time comparison for token signatures",
    "Add rate limiting to the login endpoint"
  ],
  "resolvedComments": [42, 58],
  "fileSummaries": [
    {
      "path": "src/middleware/auth.ts",
      "changeType": "added",
      "summary": "New JWT authentication middleware"
    },
    {
      "path": "src/routes/auth.ts",
      "changeType": "modified",
      "summary": "Added login and logout endpoints"
    }
  ]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `approved` | `boolean` | Whether the PR passes review |
| `summary` | `string` | Plain-text summary of the review |
| `prSummary` | `object` | Structured summary with overview, key changes, quality, testing, and risk |
| `lineComments` | `array` | Inline comments to post on specific lines of the diff |
| `criticalIssues` | `array` | List of critical issue descriptions |
| `suggestions` | `array` | List of improvement suggestions |
| `resolvedComments` | `array` | IDs of previously posted comments that have been resolved |
| `fileSummaries` | `array` | Per-file change summaries |

---

## Triage Result

When `status` is `"complete"` for a triage job, the `result` object contains:

```json
{
  "root_cause": "NullReferenceException: user.profile is accessed without a null check after the database query returns a partial record.",
  "stack_trace_summary": "Error originated in UserService.getProfile (line 42) when accessing user.profile.email.\n  at UserService.getProfile (src/services/user.ts:42:15)\n  at ProfileRouter.get (/src/routes/profile.ts:18:22)",
  "affected_files": [
    "src/services/user.ts",
    "src/routes/profile.ts"
  ],
  "suggested_fix": "Add a null check for user.profile before accessing its properties. Return a 404 response when the profile is not found.",
  "confidence": "high",
  "severity": "critical",
  "fix_pr_url": "https://github.com/tableoltd/my-project/pull/43",
  "tracker_issue_url": "https://github.com/tableoltd/my-project/issues/101"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `root_cause` | `string` | LLM-generated explanation of the root cause |
| `stack_trace_summary` | `string` | Condensed stack trace with key frames |
| `affected_files` | `string[]` | List of source files implicated by the error |
| `suggested_fix` | `string` | Human-readable fix description |
| `confidence` | `string` | `"high"` \| `"medium"` \| `"low"` — LLM confidence in the analysis |
| `severity` | `string` | `"critical"` \| `"error"` \| `"warning"` — assessed severity |
| `fix_pr_url` | `string` | URL of the auto-fix PR (if `auto_fix` was enabled and succeeded) |
| `tracker_issue_url` | `string` | URL of the created tracker issue (if tracker was configured) |

---

## Auto-Fix

When `options.auto_fix` is `true` (the default), DonMerge attempts to generate a code fix after triage analysis.

### How it works

1. **Triage analysis** identifies the root cause and affected files
2. **Source code** for the affected files is fetched from your repository at the specified `sha`
3. **LLM generates a patch** — the full patched file content (not a diff)
4. **Branch + PR created** on your repository with the fix

### PR format

- **Branch name:** `donmerge/fix/{sanitized-title}-{random}`
- **PR title:** `fix: {error title}` (truncated to 80 chars)
- **PR body:** Includes error link, root cause, fix description, and stack trace summary

### When auto-fix is skipped

Auto-fix returns `null` (and the triage still succeeds) when:

- No affected file is found in the fetched source code
- The LLM cannot confidently generate a fix (`patched_content` is null)
- The patched content is identical to the current file (no-op)
- The LLM returns an invalid file path

### Disabling auto-fix

```json
{
  "options": {
    "auto_fix": false
  }
}
```

---

## Tracker Integration

Trackers create an issue in your project management tool when a triage completes. Configure via the `tracker` field in the triage request.

### GitHub Issues

```json
{
  "tracker": {
    "type": "github",
    "token": "ghp_xxxxxxxxxxxxxxxxxxxx",
    "team": "eng",
    "labels": ["bug"]
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `type` | Yes | Must be `"github"` |
| `token` | Yes | GitHub PAT with repo access |
| `team` | Yes | Team label (used in issue metadata) |
| `labels` | No | Array of label strings to apply to the created issue |

The issue is created in the same repository specified by `repo`.

### Linear

```json
{
  "tracker": {
    "type": "linear",
    "token": "lin_api_xxxxxxxxxxxxxxxxxxxx",
    "team": "ENG",
    "labels": ["bug"]
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `type` | Yes | Must be `"linear"` |
| `token` | Yes | Linear API key |
| `team` | Yes | Linear team key (e.g. `"ENG"`, `"INFRA"`) |
| `labels` | No | Array of label names to apply (resolved by name) |

### Jira

```json
{
  "tracker": {
    "type": "jira",
    "token": "jira-api-token-here",
    "team": "PROJ",
    "labels": ["bug"],
    "jira_base_url": "https://yourcompany.atlassian.net"
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `type` | Yes | Must be `"jira"` |
| `token` | Yes | Jira API token |
| `team` | Yes | Jira project key (e.g. `"PROJ"`) |
| `labels` | No | Array of label strings |
| `jira_base_url` | Yes | Your Jira instance base URL |

### Tracker behavior

- Issues are created with issue type **Bug** (Jira) or standard issue (GitHub/Linear)
- If a fix PR was also created, the PR URL is linked as a comment on the tracker issue
- Tracker failures do **not** cause the triage to fail — the triage result is still returned

---

## Error Handling

### Common errors

| HTTP status | Error | Cause | Resolution |
|------------|-------|-------|------------|
| 400 | `Bad request` | Missing required fields or invalid format | Check request body against the schema above |
| 400 | `Invalid owner or repo format` | Non-alphanumeric characters in owner/repo | Use valid GitHub owner/repo names |
| 400 | `pr_number must be a positive integer` | Non-integer or negative PR number | Pass a valid PR number |
| 400 | `Invalid repo format. Expected "owner/repo"` | Missing slash in repo field | Use `owner/repo` format |
| 400 | `error_context requires: title, description, stack_trace, affected_files` | Missing error_context fields | Provide all required error_context fields |
| 400 | `Tracker requires: type, token, team` | Partial tracker config | Provide all required tracker fields |
| 400 | `Tracker type must be: github, linear, or jira` | Unsupported tracker type | Use one of the supported types |
| 400 | `Jira tracker requires jira_base_url in config` | Missing Jira base URL | Add `jira_base_url` to tracker config |
| 401 | `Unauthorized` | Invalid or missing API key | Verify `Authorization: Bearer dm_live_...` header |
| 404 | `Not found` / `Unknown job type` | Invalid job_id format | Use the exact job_id from the trigger response |
| 404 | `Job {id} not found` | Job doesn't exist or wrong API key scope | Verify the job_id and ensure you're using the same API key |
| 429 | `Rate limit exceeded` | Too many requests | Wait until `reset_at` timestamp, then retry |
| 500 | `Internal error` | Server-side failure | Retry with backoff; contact support if persistent |

### Cold start delays

The first request to a Durable Object may take 1–3 seconds due to cold start. Subsequent requests to the same object are fast. If you observe long polling times on the first request, this is expected.

### Token security

- All tokens (GitHub, tracker) are **redacted** from storage after the job completes
- Tokens are never logged or included in API responses
- Use `dm_test_*` keys in CI/staging environments to isolate production usage
