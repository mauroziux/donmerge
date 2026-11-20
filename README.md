# DonMerge

AI-powered code review and Sentry triage as a service. DonMerge runs as a Cloudflare Worker and provides two integration modes for your team.

## Features

- **AI Code Review** — Automatic PR reviews with inline comments, issue tracking, and severity grading
- **Error Triage** — Root cause analysis for production errors (Sentry, Datadog, Rollbar, or any source) with auto-fix PRs and tracker integration
- **Push API** — Trigger reviews and triage from any CI/CD pipeline via simple HTTP calls
- **Sentry Webhook** — Receive Sentry alerts directly via `POST /webhook/sentry` (no bridge or GitHub Actions required)
- **GitHub App (Webhook)** — Zero-config reviews when installed as a GitHub App

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         DonMerge                            │
│                   (Cloudflare Worker)                        │
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │  GitHub   │  │  Push    │  │  Sentry  │  │ /health  │   │
│  │  Webhook  │  │  API     │  │  Webhook │  │ (ready)  │   │
│  │  /webhook │  │  /api/v1 │  │ /webhook │  │          │   │
│  │  /github  │  │          │  │ /sentry  │  │          │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────────┘   │
│       │              │              │                        │
│       ▼              ▼              ▼                        │
│  ┌───────────────────────────────────────────────────┐      │
│  │              Durable Objects                      │      │
│  │  ┌─────────────┐  ┌──────────────────────┐       │      │
│  │  │ Review      │  │ TriageProcessor      │       │      │
│  │  │ Processor   │  │ (error triage)       │       │      │
│  │  └──────┬──────┘  └──────────────────────┘       │      │
│  │  ┌──────┴──────┐  ┌──────────────────────┐       │      │
│  │  │ RateLimiter │  │ Sandbox (Container)  │       │      │
│  │  └─────────────┘  └──────────────────────┘       │      │
│  └───────────────────────┬───────────────────────────┘      │
│                          │                                  │
│                          ▼                                  │
│  ┌───────────────────────────────────────────────────┐      │
│  │         Cloudflare Workflows                      │      │
│  │  ┌─────────────────────────────────────────────┐  │      │
│  │  │  CodeReviewWorkflow (4-step pipeline)       │  │      │
│  │  │  1. Fetch PR Data    2. Prepare Files       │  │      │
│  │  │  3. Run LLM Review   4. Publish Review      │  │      │
│  │  └──────────────────────┬──────────────────────┘  │      │
│  │                         │                         │      │
│  │                         ▼                         │      │
│  │  ┌─────────────────────────────────────────────┐  │      │
│  │  │  Quality Gate                               │  │      │
│  │  │  Filter → 🔴 Critical (blocks)              │  │      │
│  │  │           🟡 Suggestion (non-blocking)       │  │      │
│  │  │           ❌ Style/noise (dropped)           │  │      │
│  │  └─────────────────────────────────────────────┘  │      │
│  └───────────────────────────────────────────────────┘      │
│       │              │                                      │
│       ▼              ▼                                      │
│  ┌──────────┐   ┌──────────┐                                │
│  │ GitHub   │   │ LLM      │                                │
│  │ API      │   │ Kimi K3  │                                │
│  │          │   │ → OpenAI │                                │
│  └──────────┘   └──────────┘                                │
│       │                                                     │
│       ▼                                                     │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐                │
│  │ GitHub   │   │ Linear   │   │ Jira     │                │
│  │ Issues   │   │          │   │          │                │
│  └──────────┘   └──────────┘   └──────────┘                │
└─────────────────────────────────────────────────────────────┘
```

For detailed architecture diagrams (Mermaid), see [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

## Two Integration Modes

### Webhook Mode (GitHub App)

DonMerge installs as a GitHub App and automatically reviews PRs in configured repositories. No CI changes needed.

- Triggered by `pull_request` events and `@donmerge` comments
- Repository allowlist configured in `wrangler.jsonc`
- See [WEBHOOK_SETUP.md](./WEBHOOK_SETUP.md) for setup instructions

#### Cost controls (automatic reviews)

| Behavior | Default | Override |
|----------|---------|----------|
| **Push debounce** — a burst of pushes to an open PR produces ONE review: `synchronize` deliveries wait in the queue and superseded ones are dropped at consume time. `opened`, `reopened`, base retargets and comment triggers are never delayed. | 600s | `REVIEW_PUSH_DEBOUNCE_SECONDS` (`0` disables) |
| **Incremental re-reviews** — after a fully-reviewed commit, a push reviews only the files changed since that SHA. Falls back to the full diff on force-push, base change, compare failure or if the previous review was partial. | on | `DONMERGE_INCREMENTAL_REVIEW=false` |
| **Trivial skip** — PRs made only of docs/metadata/lockfiles complete a neutral check ("Trivial change — review skipped") without an LLM pass. Any high-risk signal (e.g. `.github/webhook-*.yml`) or explicit `@donmerge` request overrides the skip. | on | `DONMERGE_SKIP_TRIVIAL=false` |

Incremental state lives in D1 (`review_state`, migration 0005) and records the last fully-reviewed SHA per PR; the check-run/PR-description coverage notes say explicitly when a review was incremental. Prompt sections above the diff are deterministic (stable ordering, tie-broken memory queries) so provider-side prompt caching stays effective.

Scoped review memory is disabled by default until its quality has been evaluated. For a controlled pilot, set `DONMERGE_SCOPED_MEMORY=true` and `DONMERGE_SCOPED_MEMORY_REPOS` to a comma-separated list of exact `owner/repo` names. Matching is case-insensitive; a missing or empty switch or list enables no repositories. Set `DONMERGE_SCOPED_MEMORY=false` to stop injecting new scoped memory everywhere, regardless of the list. Previously active repository-wide legacy preferences remain eligible, but their revocations and scope changes are honored even after rollback. These settings do not change stored rules or their revocation state.

Maintainers can use `@donmerge memory list` on a PR to inspect rules and the rules recorded for its runs, then use `@donmerge memory approve <id>`, `@donmerge memory revoke <id>`, or `@donmerge memory scope <id> <file|directory|repo> [path]`. Explicit preferences are recorded with their source; exceptions remain pending until approved. Apply D1 migration `0009` before deploying the code that uses it; production and staging CI deployments check the migration and links table before publishing, and a review fails explicitly if a manual deployment lacks that table. Transient D1 read failures still fall back to the base policy. The migration is additive and can be run again to link legacy rows created while the old Worker was still active. Production and staging currently share the same D1 database.

GitHub does not deliver review-comment reaction webhooks. Production instead polls
reactions on recorded DonMerge review comments every 15 minutes, up to eight
comments per run in rotation. Each human thumbs-up or thumbs-down is recorded
once by reaction ID; a reaction does not create an exception or silence a
finding. Poll latency grows with the number of tracked comments. Removing a
reaction does not erase the historical feedback record. Apply additive D1
migration `0010` before deploying this collector; staging does not run the cron
because it shares production's database. Set `DONMERGE_REACTION_SYNC=false` to
stop polling without deleting feedback or cursors.

### Push API

Trigger reviews and Sentry triage from any CI/CD pipeline via HTTP POST calls.

- **Code Review:** `POST /api/v1/review`
- **Sentry Triage:** `POST /api/v1/triage`
- **Job Status:** `GET /api/v1/status/{job_id}`
- Auth via `Authorization: Bearer dm_live_*` or `dm_test_*` API keys

See the full API reference at [docs/push-api.md](./docs/push-api.md).

## Quick Start

### 1. Code Review (GitHub Actions)

Add the workflow to your repo:

```bash
mkdir -p .github/workflows
cp templates/donmerge-review.yml .github/workflows/
```

Add your API key as a repository secret:

```
Settings → Secrets → DONMERGE_API_KEY = dm_live_your_key_here
```

Open a PR — the review appears as a comment automatically.

### 2. Sentry Triage (GitHub Actions)

Add the workflow and configure Sentry:

```bash
cp templates/donmerge-sentry-triage.yml .github/workflows/
```

Add secrets: `DONMERGE_API_KEY` and `SENTRY_AUTH_TOKEN`.

For direct Sentry integration, configure the `POST /webhook/sentry` endpoint (see [docs/setup-guide.md](./docs/setup-guide.md)).

## Documentation

| Document | Description |
|----------|-------------|
| [Push API Reference](./docs/push-api.md) | Full endpoint documentation, request/response schemas, error codes |
| [Setup Guide](./docs/setup-guide.md) | Step-by-step onboarding for new teams |
| [External Repository Onboarding](./docs/external-repository-onboarding.md) | Connect repositories outside Tableo through the Push API |
| [Webhook Setup](./WEBHOOK_SETUP.md) | GitHub App / webhook mode configuration |
| [Code Review Process](./README-CODE-REVIEW.md) | Detailed code review workflow and configuration |

## CI/CD Templates

| Template | Description |
|----------|-------------|
| [`templates/donmerge-review.yml`](./templates/donmerge-review.yml) | PR-triggered code review |
| [`templates/donmerge-sentry-triage.yml`](./templates/donmerge-sentry-triage.yml) | Sentry-triggered triage with GitHub Issue creation |

## Development

### Prerequisites

- Node.js 20+
- Wrangler CLI (`npm install -g wrangler`)

### Setup

```bash
npm install
cp .env.example .env
# Fill in .env with your values
```

### Type check

```bash
npm run typecheck
```

### Run tests

```bash
npm test
```

### Deploy

```bash
wrangler deploy                # production
wrangler deploy --env staging  # staging
```

CI applies a temporary, bounded readback retry workaround to the exact pinned
Wrangler 4.105.0 bundle for [Cloudflare issue 16717](https://github.com/cloudflare/workers-sdk/issues/16717).
It retries only error 100146 for the same uploaded version, and fails closed if
the bundle changes. It does not skip container deployment; direct manual
Wrangler commands do not apply the workaround. Remove or reassess it when
upgrading Wrangler or when the upstream issue is fixed.

### Configure LLM secrets

Kimi K3 is the primary model and OpenAI is the automatic fallback. Configure
both secrets before deploying; never put them in `wrangler.jsonc`:

```bash
wrangler secret put KIMI_API_KEY
wrangler secret put OPENAI_API_KEY

wrangler secret put KIMI_API_KEY --env staging
wrangler secret put OPENAI_API_KEY --env staging
```

After a deploy that rebuilds the Sandbox container, wait for the Cloudflare
Containers rollout to settle before triggering a review. A review started
mid-rollout can be reset before OpenCode starts.

## Environment Variables

See [.env.example](./.env.example) for the full list with documentation.

Key variables:

| Variable | Required | Description |
|----------|----------|-------------|
| `CF_AI_GATEWAY_URL` | Gateway mode | CF AI Gateway base (`https://gateway.ai.cloudflare.com/v1/{acct}/{gw}`). When set with the two below, ALL LLM traffic routes through the gateway (DeepSeek→GLM→Gemini). See [docs/PULLFROG-GAP-CLOSURES.md](./docs/PULLFROG-GAP-CLOSURES.md). |
| `CF_AI_GATEWAY_TOKEN` | Gateway mode | CF API token for gateway invocation |
| `CF_AI_GATEWAY_ROUTE` | Gateway mode | Gateway route **name** (e.g. `donmerge-text-fallback`) |
| `KIMI_API_KEY` | Non-gateway | Kimi Code API key for the primary `kimi/k3` reviewer (unused when gateway mode is on) |
| `OPENAI_API_KEY` | Non-gateway | OpenAI API key for automatic fallback (`openai/gpt-4o` by default) |
| `CODEX_MODEL` | No | Primary model in `provider/model` format (default: `kimi/k3`) |
| `FALLBACK_MODEL` | No | Fallback model attempted if the primary provider fails (default: `openai/gpt-4o`) |
| `ANTHROPIC_API_KEY` | No | Anthropic API key (enables Claude models for auto-fix V2) |
| `DONMERGE_PUSH_API_KEYS` | Push API | Comma-separated API keys (`dm_live_*`, `dm_test_*`) |
| `REVIEW_PUSH_DEBOUNCE_SECONDS` | No | Push-debounce window in seconds for `synchronize` reviews (default `600`, `0` disables). See [Cost controls](#cost-controls-automatic-reviews). |
| `DONMERGE_INCREMENTAL_REVIEW` | No | `false` disables incremental re-reviews (default on). See [Cost controls](#cost-controls-automatic-reviews). |
| `DONMERGE_SKIP_TRIVIAL` | No | `false` reviews docs/lockfile-only PRs like any other (default: skip with a neutral check). See [Cost controls](#cost-controls-automatic-reviews). |
| `GITHUB_WEBHOOK_SECRET` | Webhook mode | Webhook signature validation |
| `GITHUB_APP_ID` | Webhook mode | GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | Webhook mode | GitHub App private key (PEM) |
| `SENTRY_WEBHOOK_SECRET` | Sentry webhook | Comma-separated HMAC secrets for verifying Sentry webhook signatures |
| `SENTRY_REPO_MAP` | Sentry webhook | Maps Sentry org slugs to GitHub repos (e.g. `"org:owner/repo:branch"`) |
| `SENTRY_GITHUB_TOKEN` | Sentry webhook | GitHub token for fetching repo code during Sentry-triggered triage |

## License

Private — All rights reserved.
