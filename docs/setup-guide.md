# DonMerge Setup Guide

Get AI-powered code review and Sentry triage running in your repository in under 10 minutes.

---

## Prerequisites

| Requirement | Code Review | Sentry Triage |
|------------|:-----------:|:------------:|
| GitHub repository | ✅ | ✅ |
| DonMerge API key | ✅ | ✅ |
| Sentry project | — | ✅ |
| Sentry auth token | — | ✅ |

---

## Get an API Key

Request an API key from the DonMerge team. Keys follow a specific format:

| Prefix | Purpose | Rate limits |
|--------|---------|-------------|
| `dm_live_` | Production use | 30 req/min, 200 req/hr |
| `dm_test_` | Staging / testing | 10 req/min, 50 req/hr |

> **Tip:** Use `dm_test_*` keys in CI to avoid consuming production rate limit budget.

---

## Quick Start: Code Review

### Step 1 — Add the workflow

Copy the review workflow to your repository:

```bash
mkdir -p .github/workflows
curl -o .github/workflows/donmerge-review.yml \
  https://raw.githubusercontent.com/example/donmerge/main/templates/donmerge-review.yml
```

Or create `.github/workflows/donmerge-review.yml` manually with the contents from [`templates/donmerge-review.yml`](../templates/donmerge-review.yml).

### Step 2 — Configure secrets

Go to your repository **Settings → Secrets and variables → Actions** and add:

| Secret | Value |
|--------|-------|
| `DONMERGE_API_KEY` | Your API key (e.g. `dm_live_abc123def456`) |

`GITHUB_TOKEN` is automatically provided by GitHub Actions — no configuration needed.

### Step 3 — (Optional) Configure API URL variable

If you're using a self-hosted or staging instance, add a repository variable:

| Variable | Value |
|----------|-------|
| `DONMERGE_API_URL` | `https://tableo-assitant-worker-staging.mauroziux.workers.dev` |

If not set, the default is `https://donmerge.dev`.

### Step 4 — Open a PR

Create a pull request. The workflow will:

1. Trigger the DonMerge review API
2. Wait for the analysis to complete
3. Post the review as a PR comment

You'll see a comment like:

> **🤠 DonMerge Code Review — ✅ Approved**
>
> ### Summary
> The PR implements ...

---

## Quick Start: Sentry Triage

### Step 1 — Get your Sentry auth token

1. Go to Sentry → **Settings → Auth Tokens**
2. Create a token with these scopes:
   - `org:read`
   - `project:read`
3. Copy the token value

### Step 2 — Add the workflow

Copy the Sentry triage workflow:

```bash
mkdir -p .github/workflows
curl -o .github/workflows/donmerge-sentry-triage.yml \
  https://raw.githubusercontent.com/example/donmerge/main/templates/donmerge-sentry-triage.yml
```

Or create `.github/workflows/donmerge-sentry-triage.yml` manually with the contents from [`templates/donmerge-sentry-triage.yml`](../templates/donmerge-sentry-triage.yml).

### Step 3 — Configure secrets

Add these secrets to your repository:

| Secret | Value |
|--------|-------|
| `DONMERGE_API_KEY` | Your DonMerge API key |
| `SENTRY_AUTH_TOKEN` | Sentry auth token from Step 1 |

### Step 4 — Configure Sentry webhook (direct integration)

DonMerge can receive Sentry webhooks directly — no bridge or GitHub Actions required. Configure a Sentry Internal Integration pointing to your DonMerge instance.

**In DonMerge (environment variables):**

Set these environment variables on your DonMerge Cloudflare Worker:

| Variable | Description |
|----------|-------------|
| `SENTRY_WEBHOOK_SECRET` | Secret used to verify Sentry webhook signatures (HMAC-SHA256) |
| `SENTRY_REPO_MAP` | Maps Sentry org/project slugs to GitHub repos. Format: `"org-slug:owner/repo:branch,org-slug/project:owner/repo:branch"` |
| `SENTRY_GITHUB_TOKEN` | GitHub token (PAT or App token) used to fetch repo code during triage |

Example `SENTRY_REPO_MAP`:
```
my-org:my-org/my-app:main,my-org/backend-api:my-org/api:develop
```

This maps:
- All Sentry projects under `my-org` → `my-org/my-app` (branch: `main`)
- Specifically `my-org/backend-api` → `my-org/api` (branch: `develop`)

**In Sentry:**

1. Go to **Settings → Integrations → Internal Integration → New Integration**
2. Set the webhook URL to: `POST https://your-donmerge-instance.example.com/webhook/sentry`
3. Under "Alert Rules", select **Issue Alert** as the resource
4. Copy the **Client Secret** (or generate one) and set it as `SENTRY_WEBHOOK_SECRET` on your DonMerge worker
5. Create an alert rule that triggers on `event_alert` and sends to this integration

The webhook endpoint verifies the Sentry signature, extracts error context (stack trace, affected files), resolves the target repo from the org slug, and enqueues a triage job automatically.

### Step 5 — Test it

1. Trigger a test event in Sentry (or wait for a real one)
2. Check the **Actions** tab in your GitHub repo — you should see "DonMerge Sentry Triage" running
3. The workflow will create a GitHub Issue with the triage result

---

## Tracker Setup

Trackers automatically create issues in your project management tool when Sentry triage completes. There are two ways to configure trackers depending on your integration path.

### D1 tenants (webhook path)

For multi-tenant D1 setups, tracker config is stored in the database and applied automatically. Configure `tracker_config` (JSON) and a `tracker_token` secret in the D1 project row:

```sql
-- Example: set tracker_config on a project
UPDATE projects
SET tracker_config = '{"type":"github","team":"acme","labels":["bug","sentry"]}'
WHERE id = 1;

-- Add tracker token as encrypted secret
-- (use the encrypt helper from src/lib/aes-gcm.ts)
INSERT INTO secrets (project_id, key, value_encrypted) VALUES (1, 'tracker_token', '<encrypted_value>');
```

The webhook handler validates the config shape and injects it into the triage job automatically. If `tracker_config` is set but `tracker_token` is missing, the webhook returns HTTP 500 (hard-fail) to prevent silent misconfiguration.

### Push API (GitHub Actions path)

Configure the `tracker` field in your triage request body.

#### GitHub Issues

The triage workflow template already includes GitHub tracker configuration by default. It creates issues in the same repository with labels `bug` and `sentry`.

To customize, edit the `tracker` section in `.github/workflows/donmerge-sentry-triage.yml`:

```json
{
  "tracker": {
    "type": "github",
    "token": "${GITHUB_TOKEN}",
    "team": "eng",
    "labels": ["bug", "sentry", "priority-high"]
  }
}
```

#### Linear

To use Linear as your tracker via the push API:

1. Create a Linear API key at **Settings → API → New API Key**
2. Note your team key (e.g., `ENG`, `INFRA`)
3. Add the token as a secret: `LINEAR_API_KEY`
4. Update the tracker config in the workflow:

```json
{
  "tracker": {
    "type": "linear",
    "token": "${{ secrets.LINEAR_API_KEY }}",
    "team": "ENG",
    "labels": ["bug", "sentry"]
  }
}
```

#### Jira

To use Jira as your tracker via the push API:

1. Create an API token at **Atlassian Account Settings → Security → API Tokens**
2. Note your project key (e.g., `PROJ`)
3. Add secrets: `JIRA_API_TOKEN`
4. Update the tracker config:

```json
{
  "tracker": {
    "type": "jira",
    "token": "${{ secrets.JIRA_API_TOKEN }}",
    "team": "PROJ",
    "labels": ["bug", "sentry"],
    "jira_base_url": "https://yourcompany.atlassian.net"
  }
}
```

---

## Environment Variables Reference

### Repository Secrets (GitHub Actions)

| Secret | Required | Used by | Description |
|--------|----------|---------|-------------|
| `DONMERGE_API_KEY` | Yes | Both workflows | DonMerge API key (`dm_live_*` or `dm_test_*`) |
| `SENTRY_AUTH_TOKEN` | Sentry triage | Sentry triage | Sentry auth token with `org:read`, `project:read` |
| `GITHUB_TOKEN` | Automatic | Both workflows | Provided automatically by GitHub Actions |
| `LINEAR_API_KEY` | Optional | Sentry triage | Linear API key (only if using Linear tracker) |
| `JIRA_API_KEY` | Optional | Sentry triage | Jira API token (only if using Jira tracker) |

### Repository Variables (GitHub Actions)

| Variable | Default | Description |
|----------|---------|-------------|
| `DONMERGE_API_URL` | `https://donmerge.dev` | Override the API base URL |
| `DONMERGE_TRACKER_TEAM` | `eng` | Team label for tracker issues |
| `DONMERGE_TRACKER_LABELS` | `bug,sentry` | Comma-separated labels for tracker issues |

---

## Troubleshooting

### `401 Unauthorized`

**Symptom:** API returns `{"error":"Unauthorized","message":"Invalid or missing API key"}`

**Causes and fixes:**
- Secret `DONMERGE_API_KEY` is not set in the repository → Add it under Settings → Secrets
- API key doesn't match format `dm_live_*` or `dm_test_*` → Verify the key value
- Typo in secret name → Ensure it's exactly `DONMERGE_API_KEY` (case-sensitive)

### `429 Rate limit exceeded`

**Symptom:** API returns `{"error":"Rate limit exceeded",...}`

**Causes and fixes:**
- Too many requests in a short time → Wait until `reset_at` and retry
- Using `dm_test_*` key in a busy CI pipeline → Switch to `dm_live_*` for higher limits
- Multiple workflows hitting the same key → Use separate keys per workflow

### Review completes but no comment appears

**Symptom:** Status endpoint returns `complete` but no PR comment is posted.

**Causes and fixes:**
- Workflow doesn't have `pull-requests: write` permission → Add to the workflow's `permissions:` block
- `GITHUB_TOKEN` lacks repo scope → This is automatic in Actions; check org-level restrictions

### Triage times out (5 min polling limit)

**Symptom:** Workflow reports timeout but the job is still running.

**Causes and fixes:**
- Large codebase or complex issue → Increase `MAX_ATTEMPTS` in the polling step (each attempt = 10s)
- Cold start on first request → Expected; subsequent requests are faster
- LLM under heavy load → Retry the workflow

### Auto-fix creates no PR

**Symptom:** Triage result has `fix_pr_url: null`.

**Causes and fixes:**
- LLM couldn't confidently generate a fix → This is normal for complex issues; check `suggested_fix` for manual guidance
- Affected file not found in the repo at the specified SHA → Verify the `sha` parameter matches the branch where the code exists
- `auto_fix` is set to `false` → Remove or set to `true`

### Sentry issue URL rejected

**Symptom:** `400 Invalid Sentry issue URL`

**Fix:** The URL must contain `sentry.io` and `/issues/`. Valid format:
```
https://sentry.io/organizations/{org-slug}/issues/{issue-id}/
```
Check the URL from your Sentry dashboard and use the full URL.
