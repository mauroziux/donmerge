# ADR-001: Wrangler secrets and plaintext variables

## Status: Partially superseded

The Push API decision below supersedes the original decision to keep its bearer keys in plaintext Wrangler variables. The existing Sentry webhook configuration is a separate, unresolved migration: staging still has a webhook secret in `wrangler.jsonc`. Its presence here does not make that secret safe to reuse; rotate it with the affected Sentry integrations before moving it to a Worker secret.

## Context

A bearer key or webhook signing secret authenticates requests that may start work and lead to external writes. Publishing one exposes that capability even when the credential does not itself identify a GitHub user. Source control and CI logs are unsuitable places for those values.

The original ADR treated multi-client HMAC and API credentials as ordinary variables for operational convenience. That decision was incorrect for Push API keys and is superseded below. Existing Git history may still contain retired values and must not be treated as a credential store.

## Decision

- Keep non-sensitive settings such as `CODEX_MODEL`, `REPO_CONFIGS`, review limits, and `SENTRY_REPO_MAP` in Wrangler `vars`.
- Store Push API keys in the encrypted Worker secret `DONMERGE_PUSH_API_KEYS`, separately for production and staging. Use a distinct credential per client and environment; keep recoverable client credentials in an appropriate secret manager.
- Store provider credentials, GitHub credentials, and new webhook signing secrets as encrypted secrets, not source-controlled variables. Never print secret values or write them to deployment logs.
- `DONMERGE_API_KEYS` is retired. Neither its values nor the new secret belong in `vars` or repository history. CI checks the Wrangler configuration for these names under `vars`.

The legacy Sentry webhook secret still present in staging requires a coordinated rotation with its installed integrations. Migrating its binding without rotating the exposed value would not revoke it; removing it without updating the senders would interrupt webhook delivery.

## Rotation and recovery

1. Inventory clients and active jobs. Job status is scoped to the hash of the key that created it, so allow outstanding jobs to finish before retiring a key or agree on a bounded overlap.
2. Provision new per-client credentials and update the corresponding consumer secrets. Test creation and status lookup, rejection of a retired key, and rejection of credentials from the other environment. Remove overlap at its agreed end.
3. For a failed deployment, **roll forward** with a compatible Worker version using `DONMERGE_PUSH_API_KEYS`. Do not deploy an older version that reads the retired `DONMERGE_API_KEYS` variable: it can reactivate credentials already exposed in history. Keep the retired credentials revoked during recovery.
4. Verify the active Worker version and bindings after any deployment or rollback. A successful health check alone does not prove that API clients can authenticate or that old keys remain rejected.

## Consequences

Adding or rotating a Push API client requires updating the encrypted allowed-key list and the client's own secret. Because Worker secrets are not readable back, the source credentials must be maintained in an authorized secret manager or deliberately replaced together. Revoked values must not be reintroduced for convenience.
