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

### ⚠️ Important: GITHUB_APP_PRIVATE_KEY Format

The private key must be configured **with escaped newlines** (`\n` as literal characters, not actual line breaks).

**Option 1: Using `wrangler secret put` (recommended)**

When prompted, paste the key as a single line with `\n` for newlines:

```text
-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----
```

To convert your PEM file to this format:

```bash
# macOS/Linux
awk 'NF {sub(/\r/, ""); printf "%s\\n",$0;}' your-private-key.pem

# Or use this one-liner:
paste -sd '\\n' your-private-key.pem | sed 's/$/\\n/' | tr -d '\n'
```

**Option 2: Using `.dev.vars` for local development**

Create a `.dev.vars` file in the project root:

```bash
# .dev.vars (DO NOT commit this file!)
OPENAI_API_KEY=sk-...
GITHUB_WEBHOOK_SECRET=your-webhook-secret
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----"
```

**Option 3: Using wrangler secret bulk**

Create a `secrets.json` file and upload all secrets at once:

```bash
wrangler secret bulk secrets.json
```

> **Note:** Do NOT use actual newlines in the secret value. The worker expects `\n` as literal backslash-n characters.

- Optional non-secret vars (already in `wrangler.jsonc` defaults):

```jsonc
"vars": {
  "BASE_BRANCH": "main",
  "CODEX_MODEL": "codex-5.3",
  "MAX_REVIEW_FILES": "50",
  "REPO_CONFIGS": "my-org/private-repo:main,my-org/another-repo:develop",
  "REVIEW_TRIGGER": "@donmerge"
}
```

- `REPO_CONFIGS` is a comma-separated allowlist of `owner/repo[:branch]` entries.
  - If empty or unset, any repository can trigger (subject to signature + PAT access).
  - If set, repositories not in the list are rejected with `403`.
  - The optional `:branch` suffix restricts reviews to PRs targeting that branch only.

## 2) GitHub App Configuration

Create a GitHub App and install it on source repositories.

### App Permissions

- Repository permissions:
  - `Pull requests: Read and write`
  - `Checks: Read and write`
  - `Contents: Read-only`
  - `Issues: Read and write` (required for emoji reactions on comments)

These are required for line comments, check runs, and comment reactions.

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
- `InvalidCharacterError: atob() called with invalid base64-encoded data`
  - The `GITHUB_APP_PRIVATE_KEY` secret is malformed.
  - Ensure newlines are escaped as `\n` (literal backslash-n), not actual line breaks.
  - See the "Important: GITHUB_APP_PRIVATE_KEY Format" section above.
- No review on comment
  - Must be PR comment event and include `@donmerge`.
- Missing permissions for reactions
  - Ensure GitHub App has `Issues: Read and write` permission for emoji reactions.
