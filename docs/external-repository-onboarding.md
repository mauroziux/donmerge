# Use DonMerge from another GitHub repository

DonMerge can review repositories outside Tableo without adding them to the Worker configuration when they use the **Push API**. Each repository runs the included GitHub Actions workflow and supplies its own GitHub Actions token; the DonMerge API key authorizes use of the service.

## Push API setup (recommended)

1. Obtain a DonMerge API key and the correct API base URL from the service operator. Do not copy credentials from this repository or commit them.
2. In the target repository, add the secret `DONMERGE_API_KEY` under **Settings → Secrets and variables → Actions**.
3. If the service URL is not `https://donmerge.dev`, add the repository variable `DONMERGE_API_URL` with the operator-provided base URL.
4. Copy [`templates/donmerge-review.yml`](../templates/donmerge-review.yml) into `.github/workflows/donmerge-review.yml`.
5. Open or update a pull request and check the **DonMerge Code Review** workflow and resulting check/comment.

The workflow requests `contents: read`, `checks: write`, and `pull-requests: write`. Its `GITHUB_TOKEN` is scoped by GitHub to the repository running the workflow and is sent to DonMerge for the review job. For pull requests from forks, GitHub may withhold write permissions; run the workflow only in a trusted context if write access is needed.

## GitHub App webhook mode

Webhook mode is separately allowlisted. To onboard another repository, install the DonMerge GitHub App on it and add `owner/repo` to `REPO_CONFIGS` in the Worker configuration. Optionally constrain target branches with `owner/repo:main` or `owner/repo:develop+master`. Keep the allowlist enabled; do not make it empty to enable arbitrary repositories.

## Current service boundary

This repository contains the integration workflow and API implementation, not self-service account creation. API keys and service capacity are managed by the DonMerge operator; the current API key configuration does not provide per-customer key issuance, billing, or independent revocation. Adding a repository through the Push API does not require changing or deploying the Worker, but it does not make DonMerge a self-serve commercial SaaS by itself.
