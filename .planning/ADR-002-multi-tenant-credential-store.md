# ADR-002: Multi-Tenant Credential Store (D1)

## Status: Accepted

## Context

DonMerge currently supports only one Sentry org (or a hard-coded list) via env vars:
- `SENTRY_WEBHOOK_SECRET` — comma-separated HMAC secrets in `wrangler.jsonc` vars
- `SENTRY_REPO_MAP` — plaintext org→repo mapping in `wrangler.jsonc` vars
- `SENTRY_GITHUB_TOKEN` — a single GitHub token via `wrangler secret`

To onboard multiple tenants (different Sentry orgs, each with their own repos, GitHub credentials, and tracker integrations), we need per-tenant configuration stored in a database rather than env vars.

### Requirements
1. Each Sentry org (tenant) may have one or more projects, each mapping to a GitHub repo.
2. Secrets (webhook HMAC keys, GitHub PATs, tracker tokens) must be encrypted at rest.
3. The existing env-var flow must continue to work as fallback during migration.
4. Webhook secrets are treated as secrets (per security review) — NOT stored plaintext in the projects table.
5. GitHub auth resolution: GitHub App installation token > encrypted PAT > env fallback.

## Decision

### Store tenant config in Cloudflare D1 (SQLite)

Three tables:

```sql
tenants    — one row per Sentry org
projects   — one row per Sentry project (or org-level default)
secrets    — encrypted key-value pairs per project
```

### Schema

| Table | Key Columns | Notes |
|-------|-------------|-------|
| `tenants` | `id`, `sentry_org_slug` (UNIQUE) | Top-level org |
| `projects` | `tenant_id`, `sentry_project_slug`, `github_repo`, `github_branch`, `github_installation_id`, `tracker_config` | `sentry_project_slug` NULL = org-level default |
| `secrets` | `project_id`, `key`, `value_encrypted` | AES-256-GCM encrypted; key is e.g. `sentry_webhook_secret`, `github_pat`, `tracker_token` |

### Encryption

- Algorithm: AES-256-GCM (Web Crypto API, available in Workers runtime).
- Key source: `TENANT_ENCRYPTION_KEY` env var (base64-encoded 256-bit key).
- Each encryption generates a random 12-byte IV; the stored value is `base64(iv):base64(ciphertext)`.
- The key must be set via `wrangler secret put TENANT_ENCRYPTION_KEY`.

### Auth Resolution Order

1. **Webhook verification**: D1 lookup → decrypt `sentry_webhook_secret` from secrets table → verify HMAC. If D1 config exists but signature invalid → 401 (no fallback to prevent bypass). If no D1 config → fallback to `SENTRY_WEBHOOK_SECRET` env var.

2. **GitHub token**:
   - If D1 project has `github_installation_id` AND env has `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` → use GitHub App installation token (existing `resolveGitHubToken` helper).
   - Else if D1 secret `github_pat` exists → decrypt and use.
   - Else fallback to env `SENTRY_GITHUB_TOKEN`.

3. **Repo/branch**: D1 project `github_repo` + `github_branch` → else fallback to `SENTRY_REPO_MAP` env var.

### Tracker Integration (Implemented)

The `projects.tracker_config` JSON column + `secrets.tracker_token` support Linear/Jira/GitHub issue creation.

**How it works:**
1. When a D1 tenant has `tracker_config` (JSON) and a `tracker_token` secret, the webhook handler validates the config shape at runtime via `validateTrackerConfig()`.
2. If both are present and valid, the tracker is injected into `TriageContext.tracker` and the triage engine creates an issue automatically.
3. **Hard-fail guard**: if `tracker_config` exists but `tracker_token` is missing or failed to decrypt, the webhook returns HTTP 500 instead of silently skipping. This prevents a tenant from expecting tracker issues that never get created.
4. If `tracker_config` is invalid (wrong type, missing required fields), the tracker is skipped with a warning log and triage proceeds without it.

**Supported tracker types**: `github`, `linear`, `jira` (same as the push API).

### Env Var Fallback

The existing env-var flow (`SENTRY_WEBHOOK_SECRET`, `SENTRY_REPO_MAP`, `SENTRY_GITHUB_TOKEN`) continues to work when:
- `DB` D1 binding is not configured.
- No matching tenant/project row exists in D1.
- Secrets cannot be decrypted (key mismatch).

This ensures zero-downtime migration: deploy the code, create D1 tables, insert tenant rows, set `TENANT_ENCRYPTION_KEY` secret — tenants switch to D1, others stay on env vars.

## Consequences

### Positive
- Per-tenant secrets encrypted at rest (not in wrangler.jsonc).
- Adding a new tenant is a DB insert, not a deploy.
- Existing single-tenant setup continues to work unchanged.
- GitHub App auth reused from existing `resolveGitHubToken` helper.

### Negative
- New dependency on D1 binding and `TENANT_ENCRYPTION_KEY` secret.
- D1 lookups add ~1-5ms latency per webhook.
- Secret rotation requires re-encryption (or a key-versioning scheme later).

### Migration Steps
1. `wrangler d1 create donmerge-db` → get `database_id`.
2. `wrangler d1 execute donmerge-db --file=migrations/0001_create_tenants_projects_secrets.sql`.
3. Insert tenant + project rows; encrypt secrets with `TENANT_ENCRYPTION_KEY`.
4. Update `wrangler.jsonc` with D1 binding `database_id`.
5. Deploy. Tenants in D1 use D1 flow; others fall back to env vars.

## Examples

### D1 Lookup (org "acme", project "api")
```
tenants: { sentry_org_slug: "acme" } → tenant_id: 1
projects: { tenant_id: 1, sentry_project_slug: "api" } → github_repo: "acme/api", github_branch: "main"
secrets: { project_id: 2, key: "sentry_webhook_secret" } → decrypt → HMAC key
secrets: { project_id: 2, key: "github_pat" } → decrypt → GitHub token
```

### Fallback (no D1 or no matching row)
```
SENTRY_WEBHOOK_SECRET env var → comma-separated HMAC keys
SENTRY_REPO_MAP env var → org→repo mapping
SENTRY_GITHUB_TOKEN env var → single GitHub token
```

---

## Appendix A: Temporary Plaintext Staging Mode

### Context

During early staging testing, setting `TENANT_ENCRYPTION_KEY` via `wrangler secret put` may be impractical or not yet set up. To unblock staging, a temporary plaintext secrets mode allows D1 secrets to be stored without encryption when the environment variable `ALLOW_PLAINTEXT_SECRETS` is set to `"true"`.

### Mechanism

1. **Detection**: Each secret value is inspected to determine if it is encrypted. The AES-GCM encrypted format is `base64(iv):base64(ciphertext)` with a 12-byte IV. Values that don't match this pattern are considered plaintext.

2. **Resolution behavior**:
   - If value is encrypted → `TENANT_ENCRYPTION_KEY` is required to decrypt; failure to decrypt a critical secret returns `invalid`.
   - If value is plaintext and `ALLOW_PLAINTEXT_SECRETS=true` → value is used as-is; a warning is logged with the key name (never the value).
   - If value is plaintext and plaintext mode is not enabled → critical secrets return `invalid`; non-critical secrets are skipped with a warning.

3. **Configuration**: `ALLOW_PLAINTEXT_SECRETS` is set ONLY in `env.staging.vars` in `wrangler.jsonc`. It must NOT appear in top-level (production) vars.

4. **Missing `TENANT_ENCRYPTION_KEY`**: When the encryption key is absent:
   - If `ALLOW_PLAINTEXT_SECRETS=true` → D1 lookup proceeds; only plaintext secrets can be resolved.
   - If `ALLOW_PLAINTEXT_SECRETS` is unset/false → D1 lookup is skipped entirely (returns `not_found`), falling back to env vars.

### Security Guarantees

- Plaintext mode never exposes secret values in logs (only key names).
- `sentry_webhook_secret` remains critical: plaintext without the flag → `invalid`.
- Production is unaffected: `ALLOW_PLAINTEXT_SECRETS` is not set in the top-level `vars` block.

### Migration Back to Encryption

1. Generate `TENANT_ENCRYPTION_KEY`: `openssl rand -base64 32`
2. Set via: `wrangler secret put TENANT_ENCRYPTION_KEY --env staging`
3. Encrypt all plaintext secrets using the `encrypt()` function from `src/lib/aes-gcm.ts`.
4. Update D1 rows with encrypted values.
5. Verify staging works with encrypted secrets.
6. Remove `ALLOW_PLAINTEXT_SECRETS` from `env.staging.vars` in `wrangler.jsonc`.
7. Deploy.
