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
| `KIMI_API_KEY` | Yes | Kimi Code API key for the primary `kimi/k3` reviewer |
| `OPENAI_API_KEY` | Yes | OpenAI API key for automatic fallback (`openai/gpt-4o` by default) |
| `CODEX_MODEL` | No | Primary model in `provider/model` format (default: `kimi/k3`) |
| `FALLBACK_MODEL` | No | Fallback model attempted if the primary provider fails (default: `openai/gpt-4o`) |
| `ANTHROPIC_API_KEY` | No | Anthropic API key (enables Claude models for auto-fix V2) |
| `DONMERGE_API_KEYS` | Push API | Comma-separated API keys (`dm_live_*`, `dm_test_*`) |
| `GITHUB_WEBHOOK_SECRET` | Webhook mode | Webhook signature validation |
| `GITHUB_APP_ID` | Webhook mode | GitHub App ID |
| `GITHUB_APP_PRIVATE_KEY` | Webhook mode | GitHub App private key (PEM) |
| `SENTRY_WEBHOOK_SECRET` | Sentry webhook | Comma-separated HMAC secrets for verifying Sentry webhook signatures |
| `SENTRY_REPO_MAP` | Sentry webhook | Maps Sentry org slugs to GitHub repos (e.g. `"org:owner/repo:branch"`) |
| `SENTRY_GITHUB_TOKEN` | Sentry webhook | GitHub token for fetching repo code during Sentry-triggered triage |

## License

Private — All rights reserved.
