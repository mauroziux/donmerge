# Pullfrog Gap Closures + Cloudflare AI Gateway

This document records a substantive hardening and modernization effort on DonMerge's code-review pipeline, performed 2026-08-13/14. It has two parts: closing gaps identified by comparing DonMerge to the open-source [pullfrog/pullfrog](https://github.com/pullfrog/pullfrog) project, and integrating a Cloudflare AI Gateway as the LLM routing layer.

**Branch:** `feat/pullfrog-gap-closures` (merged to `main`).
**Commits:** `aa97ec9` (gap closures), `d88fb3a` + `581e45c` (AI Gateway).
**Verified in production** on `tableoltd/rms#3837` (DeepSeek-via-gateway review approved a clean refactor and caught a real DST-label bug).

---

## Part 1 — Pullfrog gap closures (publish-path robustness)

A deep comparison against pullfrog surfaced eight concrete gaps where pullfrog is mechanically more robust. Seven were closed inside DonMerge's existing architecture (the structured-JSON LLM contract and fingerprint dedup are unchanged). The eighth — agent-driven specialist subagent fanout — is an architectural migration and was intentionally deferred.

### What was built

| Module | Closes | What it does |
|---|---|---|
| `comment-anchors.ts` | Anchor validation | `validateInlineComments` drops inline comments whose line is outside a diff hunk **before** the POST, so a single bad anchor can no longer 422-sink the whole review. Dropped comments are reported. |
| `github-retry.ts` | Transient 422 retry | `GitHubApiError` + `withBoundedRetry` retry only GitHub's transient "internal error" 422 (bail predicate scopes retries); validation 422s fail fast. Idempotency-safe (throws before 2xx). |
| `review-body-guard.ts` | Degenerate body + empty submit | `isDegenerateReviewBody` substitutes a safe fallback for placeholder/empty LLM summaries. `reviewSkipDecision` skips empty `COMMENT` reviews (which GitHub 422s) while still posting empty `APPROVE`. |
| `approval-gate.ts` | Outstanding-threads gate | `applyApprovalGate` never sets `approved=true` while prior DonMerge-originated threads are unresolved. Degrades (`approved`→`false`, blocking `REQUEST_CHANGES`) rather than throwing. |
| `github-api.ts` (publishReview) | Wiring + metadata | Anchors validated, retry wrapped, body guarded, skip checked, and a `DONMERGE_REVIEW` metadata HTML comment (headSha + baseRef) prepended to every review body. |
| `code-review-workflow.ts` | Patch cache + gate | PR file patches thread from step 2 → step 4 (no redundant `listFiles`); approval gate applied before publish. |

### Key technical decisions

- **Adapt, don't port.** Pullfrog's reference uses Octokit + GraphQL + arktype. DonMerge uses raw `fetch` + REST. The logic was rewritten in DonMerge's idiom — no new dependencies.
- **The approval gate degrades, never blocks.** It overrides `approved`→`false` and posts a non-approving review rather than throwing, so valid new findings are never lost to a gating decision.
- **DonMerge's event mapping is inverted vs pullfrog:** `approved=true`→`COMMENT` (non-binding), `approved=false`→`REQUEST_CHANGES` (blocking). So the gate's downgrade produces a blocking review — the correct intent ("don't merge while our threads are open").
- **Skip decision runs before the body guard.** Otherwise the fallback substitution makes the skip check see a non-empty body and never skip the empty-COMMENT case.

### Testing

- 6 new test files (comment-anchors, github-retry, review-body-guard, approval-gate + integration tests on `publishReview`).
- **1086 tests pass**, typecheck clean.

---

## Part 2 — Cloudflare AI Gateway integration

Replaces DonMerge's application-layer LLM fallback (Kimi→GLM→OpenAI, resolved in code) with an infrastructure-layer routing config on a Cloudflare AI Gateway. The gateway owns the fallback chain, retries, and caching.

### The chain (production)

```
DeepSeek v4 Flash ──fail──▶ GLM 5.2 ──fail──▶ Gemini Flash 3.6
(deepseek)                 (custom-zai-code-plan)  (google-ai-studio)
```

Gateway-level config: **3 retries, exponential backoff (1s base), 300s cache, authentication on.**

### What changed in code

`src/lib/llm-providers.ts` gained gateway functions: `aiGatewayEnabled`, `aiGatewayCompatUrl`, `aiGatewayModelId`, `buildAiGatewayOpencodeConfig`, `resolveDirectFetchBaseURL`. When the gateway env vars are set, the code-review and triage workflows register a **single** `aigateway` provider (instead of separate kimi/glm) and use a **single** model — no app-layer fallback (the gateway handles it). **Backward compatible:** without the gateway env vars, existing per-provider behavior is unchanged.

### Invocation format (critical)

The correct way to call a CF AI Gateway Dynamic Routing route:

```
POST https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/compat/chat/completions
Authorization: Bearer {cf_token}        (standard OpenAI auth works on compat)
Content-Type: application/json
{ "model": "dynamic/{routeName}", "messages": [...] }
```

- **Endpoint:** `/compat/chat/completions` (NOT `/route/{id}`)
- **Auth:** `Authorization: Bearer` works (also accepts `cf-aig-authorization`)
- **Model:** must be `dynamic/{routeName}` (the route selector; the gateway ignores the upstream model name)
- **baseURL for OpenAI-compatible SDKs:** `{gatewayUrl}/compat` (they append `/chat/completions`)
- **Diagnostics:** response headers `cf-aig-provider`, `cf-aig-model`, `cf-aig-step` show which upstream served

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `CF_AI_GATEWAY_URL` | Gateway mode | `https://gateway.ai.cloudflare.com/v1/{account}/{gateway}` |
| `CF_AI_GATEWAY_TOKEN` | Gateway mode | CF API token with gateway invocation perms |
| `CF_AI_GATEWAY_ROUTE` | Gateway mode | Route **name** (e.g. `donmerge-text-fallback`) — used in `dynamic/{name}` |

When all three are set → gateway mode (DeepSeek-primary). When absent → existing Kimi/GLM/OpenAI flow.

### Gateway provisioning (reference)

Gateway `donmerge-production` + route `donmerge-text-fallback` were created via the CF AI Gateway API. Key API gotchas:

1. **Create route:** `POST /accounts/{a}/ai-gateway/gateways/{gw}/routes` with `{name, gateway_id, elements:[DAG]}`. Elements use `type: start|model|end` with `outputs.{success|fallback|next}.elementId`.
2. **Update route = new version:** `POST /routes/{rid}/versions {elements}` then **deploy** via `POST /routes/{rid}/deployments {version_id}`. A new version is NOT active until deployed.
3. **Provider naming:** built-ins use their slug (`deepseek`, `google-ai-studio`, `workers-ai`); custom providers are prefixed `custom-` (e.g. `custom-zai-code-plan`). Custom providers carry their API key; built-ins need a key bound (else code 2008 "Invalid provider").
4. **wrangler OAuth token has NO AI Gateway perms** — use a dedicated API token (Account → AI Gateway).

---

## Production validation

Verified end-to-end on `tableoltd/rms#3837` (a business-hours timezone refactor, +161/-50) via the webhook flow:

- Check-run `DonMerge 🤠 Review` → `success`, "✅ All good, compadre!"
- Review posted by `donmerge[bot]` (GitHub App flow works via webhook `installationId`)
- **Approved correctly** (clean refactor, no false-positive blocking)
- **Found a real bug:** `hoursLabel` hardcodes the `'CET'` string even though the logic now uses DST-aware `Europe/Berlin` — the label is wrong during summer (CEST). Concrete fix suggested (Carbon `format('T')`).
- `DONMERGE_REVIEW` metadata marker present in the review body (Part 1, U8)
- `cf-aig-provider: deepseek` — DeepSeek served the request

**Latency note:** ~6.5 min per review via the gateway vs ~60-90s for direct Kimi. The gateway adds routing overhead; the quality (substantive findings, no noise) justifies the tradeoff.

### Why push-API validation can't create check-runs

Check-runs require GitHub App authentication (an installation token). The push-API path provides a caller PAT, which can do everything **except** create check-runs. The webhook flow provides `installationId` → App installation token → check-runs work. Full e2e validation therefore requires the webhook flow.

---

## Rollback

**To revert production from DeepSeek-gateway back to Kimi-primary** (no redeploy needed — code is backward compatible):

```bash
wrangler secret delete CF_AI_GATEWAY_URL
wrangler secret delete CF_AI_GATEWAY_TOKEN
wrangler secret delete CF_AI_GATEWAY_ROUTE
```

`KIMI_API_KEY` / `GLM_API_KEY` / `OPENAI_API_KEY` remain set as production secrets and are the automatic fallback when gateway mode is off.

---

## Sources

- Deep comparison analysis: Engram observation #7094 (`donmerge-pullfrog-comparison`)
- Gap-closure implementation: Engram #7100
- AI Gateway integration: Engram #7113
- Production enablement: Engram #7116
- Reference implementation: `pullfrog/pullfrog` (`mcp/review.ts`, `mcp/reviewComments.ts`)
- Plan document: `docs/plans/2026-08-13-001-fix-pullfrog-gap-closures-plan.md`
