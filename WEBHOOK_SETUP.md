# Webhook Setup (Cloudflare Worker + GitHub App)

This worker is a centralized webhook reviewer for external repositories.
Entrypoint: `src/app.ts`
Webhook endpoint: `POST /webhook/github`

## 1) Wrangler Configuration Checklist

- `wrangler.jsonc` must include:
  - `main: "src/app.ts"`
  - Durable Object binding for `Sandbox`
  - `vars` for non-secret config (`BASE_BRANCH`, `CODEX_MODEL`, `MAX_REVIEW_FILES`)
- Use Wrangler secrets for sensitive values:

```bash
wrangler secret put OPENAI_API_KEY
wrangler secret put GITHUB_WEBHOOK_SECRET
wrangler secret put GITHUB_APP_ID
wrangler secret put GITHUB_APP_PRIVATE_KEY
```

- Optional non-secret vars (already in `wrangler.jsonc` defaults):

```jsonc
"vars": {
  "BASE_BRANCH": "main",
  "CODEX_MODEL": "codex-5.3",
  "MAX_REVIEW_FILES": "50",
  "ALLOWED_REPOS": "my-org/private-repo,my-org/another-repo",
  "REVIEW_TRIGGER": "@donmerge"
}
```

- `ALLOWED_REPOS` is a comma-separated allowlist of `owner/repo`.
  - If empty, any repository can trigger (subject to signature + PAT access).
  - If set, repositories not in the list are rejected with `403`.

## 2) GitHub App Configuration

Create a GitHub App and install it on source repositories.

### App Permissions

- Repository permissions:
  - `Pull requests: Read and write`
  - `Checks: Read and write`
  - `Contents: Read-only`
  - `Issues: Read-only`

These are required for line comments and check runs.

### Webhook Events

- `Pull request`
- `Issue comment`
- `Pull request review comment`

### Webhook URL / Secret

- Payload URL:

```text
https://<your-worker-domain>/webhook/github
```

- Content type: `application/json`
- Secret: same value as `GITHUB_WEBHOOK_SECRET`

## 3) Install App on Target Private Repositories

- Install the app on each private repository to review.
- Webhook deliveries include `installation.id`, used by the worker to mint installation tokens at runtime.

## 4) Trigger Rules Implemented

- Auto trigger:
  - `pull_request` actions: `opened`, `synchronize`, `reopened`
- Manual retrigger:
  - `issue_comment` with `@donmerge` on a PR thread
  - `pull_request_review_comment` with `@donmerge` on inline review comments
- Base branch filter:
  - PR is skipped unless `pull_request.base.ref == BASE_BRANCH`

## 5) Quick Validation

1. Deploy worker:

```bash
wrangler deploy
```

2. Check health:

```bash
curl "https://<your-worker-domain>/health"
```

3. Open PR in webhook-enabled repo targeting `main`.
4. Verify on PR:
   - Review comments appear (line-specific when available)
   - Check run `Codex Code Review` appears
   - Review state uses PR review (`COMMENT` or `REQUEST_CHANGES`)

5. Re-trigger by adding comment:

```text
@donmerge
```

## 6) Troubleshooting

- `401 invalid signature`
  - Webhook secret does not match `GITHUB_WEBHOOK_SECRET`.
- `403/404 from GitHub API`
  - App is missing permissions or not installed on the target repository.
- No review on comment
  - Must be PR comment event and include `@donmerge`.
