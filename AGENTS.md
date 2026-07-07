# AGENTS.md — DonMerge

DonMerge is a Cloudflare Worker that runs AI code review on GitHub PRs via the `donmerge` GitHub App.

## Stack
- Runtime: Cloudflare Workers (TypeScript)
- Framework: @flue/cloudflare
- Storage: D1 (multi-tenant config), Durable Objects (ReviewProcessor, RateLimiter, TriageProcessor, Sandbox)
- Workflows: Cloudflare Workflows (CodeReviewWorkflow)
- Queues: Cloudflare Queues (code-review-jobs)
- Tests: vitest

## Verification commands
- `npm run typecheck` — TypeScript check (tsc --noEmit)
- `npm run test` — Run all tests (vitest run)
- `npm run test:watch` — Watch mode
- `npm run test:coverage` — Coverage

These MUST pass before any commit.

## Conventions
- Worker name: `tableo-assitant-worker` (note: existing typo, intentional — do not "fix")
- Webhook flow: GitHub → /webhook/github → validateWebhookFast → CODE_REVIEW_QUEUE.send → consumer → CodeReviewWorkflow
- Multi-tenant: D1-backed tenant configs (per-org LLM keys, repo mappings)
- Memory: persist architecture decisions to Engram with topic_key

## Deploy
- Production: `wrangler deploy` (worker name: tableo-assitant-worker)
- Staging: `wrangler deploy --env staging` (worker name: tableo-assitant-worker-staging)
- Queue creation (one-time): `wrangler queues create code-review-jobs`
