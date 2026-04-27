/**
 * DonMerge Sentry Webhook Bridge
 *
 * Cloudflare Worker that validates Sentry webhook signatures and forwards
 * issue events to GitHub as repository_dispatch events for automated triage.
 *
 * Required secrets (set via `wrangler secret put`):
 *   SENTRY_WEBHOOK_SECRET — HMAC-SHA256 signing secret from Sentry
 *   GITHUB_TOKEN          — GitHub PAT with `repo` scope
 *   GITHUB_REPO           — Target repository in `owner/repo` format
 *
 * Optional secret:
 *   DEFAULT_SHA           — Git ref to triage against (defaults to "main")
 */

export default {
  async fetch(request, env) {
    // Only accept POST requests
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    // Read body as text (needed for HMAC verification)
    const body = await request.text();

    // ---- Sentry signature verification ----
    const signatureHeader = request.headers.get("sentry-hook-signature");
    if (!signatureHeader) {
      console.error("Missing sentry-hook-signature header");
      return new Response("Unauthorized: missing signature", { status: 401 });
    }

    const isValid = await verifySentrySignature(
      body,
      signatureHeader,
      env.SENTRY_WEBHOOK_SECRET
    );
    if (!isValid) {
      console.error("Invalid Sentry webhook signature");
      return new Response("Unauthorized: invalid signature", { status: 401 });
    }

    // ---- Parse Sentry payload ----
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      console.error("Malformed JSON payload");
      return new Response("Bad request: malformed JSON", { status: 400 });
    }

    const issueUrl = extractIssueUrl(payload);
    if (!issueUrl) {
      console.error("Could not extract Sentry issue URL from payload");
      return new Response("Bad request: missing issue URL", { status: 400 });
    }

    // Validate that the URL looks like a Sentry issue
    if (!isValidSentryIssueUrl(issueUrl)) {
      console.error(`Invalid Sentry issue URL: ${issueUrl}`);
      return new Response("Bad request: invalid Sentry issue URL", {
        status: 400,
      });
    }

    // ---- Forward to GitHub repository_dispatch ----
    const repo = env.GITHUB_REPO;
    const token = env.GITHUB_TOKEN;
    const sha = env.DEFAULT_SHA || "main";

    if (!repo || !token) {
      console.error("Missing GITHUB_REPO or GITHUB_TOKEN environment variable");
      return new Response("Server error: misconfigured bridge", { status: 500 });
    }

    const githubApiUrl = `https://api.github.com/repos/${repo}/dispatches`;
    const dispatchBody = JSON.stringify({
      event_type: "sentry-issue",
      client_payload: {
        sentry_issue_url: issueUrl,
        sha: sha,
      },
    });

    try {
      const githubResponse = await fetch(githubApiUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "donmerge-sentry-bridge",
        },
        body: dispatchBody,
      });

      if (!githubResponse.ok) {
        const errorText = await githubResponse.text();
        console.error(
          `GitHub API error: ${githubResponse.status} — ${errorText}`
        );
        // Return 500 so we can debug, but note: Sentry will NOT retry on non-2xx
        return new Response(
          `GitHub API error: ${githubResponse.status}`,
          { status: 500 }
        );
      }

      console.log(
        `Successfully dispatched sentry-issue to ${repo}: ${issueUrl}`
      );
      return new Response("ok", { status: 200 });
    } catch (err) {
      console.error(`Network error calling GitHub API: ${err.message}`);
      return new Response("Server error: GitHub API unreachable", {
        status: 500,
      });
    }
  },
};

/**
 * Verify the Sentry webhook signature using HMAC-SHA256.
 *
 * @param {string} body          — Raw request body
 * @param {string} signature     — Value from sentry-hook-signature header
 * @param {string} secret        — Shared signing secret
 * @returns {Promise<boolean>}   — Whether the signature is valid
 */
async function verifySentrySignature(body, signature, secret) {
  if (!secret) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));

  // Convert ArrayBuffer to hex string
  const hex = [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time comparison to prevent timing attacks
  return timingSafeEqual(hex, signature.toLowerCase());
}

/**
 * Constant-time string comparison to mitigate timing attacks.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Extract the Sentry issue URL from the webhook payload.
 *
 * Tries `data.issue.url` first, then falls back to constructing one from
 * `data.issue.id` and `data.organization.slug`.
 *
 * @param {object} payload — Parsed Sentry webhook payload
 * @returns {string|null}  — Issue URL or null if not found
 */
function extractIssueUrl(payload) {
  // Primary path: data.issue.url
  if (payload?.data?.issue?.url) {
    return payload.data.issue.url;
  }

  // Fallback: construct from organization slug + issue id
  const issueId = payload?.data?.issue?.id;
  const orgSlug = payload?.data?.organization?.slug;
  if (issueId && orgSlug) {
    return `https://sentry.io/organizations/${orgSlug}/issues/${issueId}/`;
  }

  return null;
}

/**
 * Validate that a URL looks like a Sentry issue URL.
 *
 * Must contain "sentry.io" and "issues" in the path.
 *
 * @param {string} url
 * @returns {boolean}
 */
function isValidSentryIssueUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.includes("sentry.io") &&
      parsed.pathname.includes("issues");
  } catch {
    return false;
  }
}
