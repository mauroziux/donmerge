# ADR-001: Wrangler Secrets vs Plaintext Vars

## Status: Accepted

## Context

Cloudflare Workers supports two ways to configure environment variables:
- **`vars` in `wrangler.jsonc`**: Plaintext, visible in dashboard, editable anytime
- **`wrangler secret put`**: Encrypted at rest, can't be read back, must overwrite to change

We have variables that fall into different sensitivity levels:
1. **Non-sensitive config** (model name, limits, repo lists) → always `vars`
2. **High-severity secrets** (API keys for OpenAI/Anthropic, GitHub private keys) → always `wrangler secret`
3. **Medium-severity shared secrets** (webhook HMAC keys, multi-client secrets) → **`vars`** for operability

## Decision

### Rule 1: Use `vars` (plaintext) for:
- Non-sensitive configuration: `CODEX_MODEL`, `MAX_REVIEW_FILES`, `REVIEW_TRIGGER`, `REPO_CONFIGS`, `SENTRY_REPO_MAP`
- Multi-client aggregated secrets: `SENTRY_WEBHOOK_SECRET`, `DONMERGE_API_KEYS`
- Any value that needs to be **readable** when adding new entries

**Justification:** These are HMAC verification keys or API auth tokens. They don't grant access to user data — they authenticate webhook senders or API callers. The operational cost of `wrangler secret` (can't read back, must re-enter all values when adding a client) outweighs the security benefit for this category.

### Rule 2: Use `wrangler secret put` for:
- Provider API keys: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`
- GitHub credentials: `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_ID`, `SENTRY_GITHUB_TOKEN`
- Any value that grants **data access** or **write capabilities** to external services

**Justification:** These tokens can access user data, write to repositories, or make API calls on our behalf. Compromise = data breach. The inability to read them back is a feature, not a bug.

### The litmus test:
> **If someone reads this value, can they access user data or make write actions on external services?**
> - Yes → `wrangler secret`
> - No (only verifies identity of sender) → `vars`

## Consequences

- `SENTRY_WEBHOOK_SECRET` and `DONMERGE_API_KEYS` are visible in Cloudflare dashboard
- Adding a new Sentry org: edit `wrangler.jsonc`, append comma + new secret, deploy
- Adding a new API client: edit `wrangler.jsonc`, append comma + new key, deploy
- No need to remember/re-enter existing values when adding new ones

## Examples

| Variable | Type | Why |
|----------|------|-----|
| `CODEX_MODEL` | `vars` | Non-sensitive config |
| `REPO_CONFIGS` | `vars` | Org/repo allowlist |
| `SENTRY_REPO_MAP` | `vars` | Non-sensitive mapping |
| `DONMERGE_API_KEYS` | `vars` | Multi-client auth tokens (aggregated) |
| `SENTRY_WEBHOOK_SECRET` | `vars` | Multi-client HMAC keys (aggregated) |
| `OPENAI_API_KEY` | `wrangler secret` | Bills us money, accesses AI APIs |
| `ANTHROPIC_API_KEY` | `wrangler secret` | Bills us money, accesses AI APIs |
| `GITHUB_WEBHOOK_SECRET` | `wrangler secret` | Validates GitHub identity |
| `GITHUB_APP_PRIVATE_KEY` | `wrangler secret` | Write access to GitHub repos |
| `SENTRY_GITHUB_TOKEN` | `wrangler secret` | Write access to GitHub repos |
