/**
 * Sentry webhook handler for DonMerge.
 *
 * Receives Sentry event_alert webhooks, verifies HMAC-SHA256 signatures,
 * extracts error context, resolves the target repo from D1 or SENTRY_REPO_MAP,
 * and enqueues a triage job via the TriageProcessor Durable Object.
 *
 * Resolution order:
 *   1. D1 lookup (multi-tenant) — if DB binding + tenant row exists
 *   2. Env var fallback — SENTRY_WEBHOOK_SECRET, SENTRY_REPO_MAP, SENTRY_GITHUB_TOKEN
 *
 * Sentry requires a response within 1 second.
 */

import { timingSafeEqual } from '../workflows/code-review/crypto';
import { getTriageProcessor } from '../workflows/triage/processor';
import type { ErrorContext, TriageContext, TrackerConfig } from '../workflows/triage/types';
import { resolveSentryProjectConfig, type ResolvedSentryProjectConfig, type SentryProjectResolution } from '../lib/tenant-config';
import { resolveGitHubToken } from '../workflows/code-review/github-auth';

// ── Tracker config validation ────────────────────────────────────────────────

const VALID_TRACKER_TYPES = new Set(['github', 'linear', 'jira']);

/**
 * Validate and shape a raw tracker config from D1 into a TrackerConfig.
 *
 * Returns a valid TrackerConfig (without token) or null if invalid/missing.
 * Token is validated separately since it comes from the secrets table.
 */
export function validateTrackerConfig(raw: unknown): Pick<TrackerConfig, 'type' | 'team' | 'labels' | 'jira_base_url'> | null {
  if (!raw || typeof raw !== 'object') return null;

  const cfg = raw as Record<string, unknown>;

  // type is required and must be one of the supported values
  if (typeof cfg.type !== 'string' || !VALID_TRACKER_TYPES.has(cfg.type)) {
    return null;
  }

  // team is required
  if (typeof cfg.team !== 'string' || !cfg.team.trim()) {
    return null;
  }

  // labels: optional, but if present must be string[]
  let labels: string[] | undefined;
  if (cfg.labels !== undefined) {
    if (!Array.isArray(cfg.labels) || !cfg.labels.every((l: unknown) => typeof l === 'string')) {
      return null;
    }
    labels = cfg.labels;
  }

  // jira_base_url: optional, but required for jira type
  if (cfg.type === 'jira') {
    if (typeof cfg.jira_base_url !== 'string' || !cfg.jira_base_url.trim()) {
      return null;
    }
  }
  const jiraBaseUrl = typeof cfg.jira_base_url === 'string' ? cfg.jira_base_url : undefined;

  return {
    type: cfg.type as TrackerConfig['type'],
    team: cfg.team,
    ...(labels ? { labels } : {}),
    ...(jiraBaseUrl ? { jira_base_url: jiraBaseUrl } : {}),
  };
}

// ── Signature verification ────────────────────────────────────────────────────

/**
 * Verify a Sentry webhook signature.
 *
 * Sentry sends the HMAC-SHA256 digest as raw hex in the
 * `Sentry-Hook-Signature` header (no prefix like GitHub's `sha256=`).
 */
export async function verifySentrySignature(
  secret: string,
  body: string,
  header: string,
): Promise<boolean> {
  if (!header) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const digestHex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

  return timingSafeEqual(digestHex, header);
}

// ── Sentry payload types ─────────────────────────────────────────────────────

interface SentryFrame {
  filename?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
}

interface SentryException {
  type?: string;
  value?: string;
  module?: string;
  stacktrace?: {
    frames?: SentryFrame[];
  };
}

interface SentryEvent {
  title?: string;
  message?: string;
  web_url?: string;
  platform?: string;
  event_id?: string;
  exception?: {
    values?: SentryException[];
  };
  tags?: Array<[string, string]> | string[][];
}

interface SentryEventAlertPayload {
  action: string;
  data: {
    event: SentryEvent;
    issue?: {
      url?: string;
    };
  };
}

// ── Error context extraction ─────────────────────────────────────────────────

/**
 * Extract error context from a Sentry event_alert payload.
 */
export function extractSentryErrorContext(
  payload: SentryEventAlertPayload,
): ErrorContext {
  const event = payload.data.event;

  // Title
  const title = event.title ?? 'Unknown Sentry error';

  // Description — first exception value or event message
  const firstException = event.exception?.values?.[0];
  const description =
    firstException?.value ?? event.message ?? title;

  // Stack trace — build from exception frames (reversed, bottom-to-top)
  const frames = firstException?.stacktrace?.frames;
  let stackTrace = '';
  if (frames && frames.length > 0) {
    // Sentry sends frames top-to-bottom (most recent first),
    // but stack traces conventionally show bottom-to-top
    const reversed = [...frames].reverse();
    stackTrace = reversed
      .map((frame) => {
        const fn = frame.function ?? '<anonymous>';
        const file = frame.filename ?? '<unknown>';
        const line = frame.lineno ?? '?';
        const col = frame.colno ?? '?';
        return `at ${fn} (${file}:${line}:${col})`;
      })
      .join('\n');
  }

  // Affected files — unique in_app frame filenames
  const affectedFiles: string[] = [];
  if (frames && frames.length > 0) {
    const seen = new Set<string>();
    for (const frame of frames) {
      if (frame.in_app && frame.filename && !seen.has(frame.filename)) {
        seen.add(frame.filename);
        affectedFiles.push(frame.filename);
      }
    }
  }
  if (affectedFiles.length === 0) {
    affectedFiles.push('unknown');
  }

  // Environment — from tags
  let environment: string | undefined;
  if (event.tags) {
    for (const [key, value] of event.tags) {
      if (key === 'environment') {
        environment = value;
        break;
      }
    }
  }

  // Source URL
  const sourceUrl = event.web_url;

  // Metadata
  const metadata: Record<string, unknown> = {};
  if (event.event_id) {
    metadata.event_id = event.event_id;
  }
  if (event.platform) {
    metadata.platform = event.platform;
  }

  return {
    title,
    description,
    stack_trace: stackTrace,
    affected_files: affectedFiles,
    environment,
    source_url: sourceUrl,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}

// ── Repo map parsing ─────────────────────────────────────────────────────────

interface RepoMapping {
  repo: string;
  branch: string;
}

/**
 * Parse the SENTRY_REPO_MAP environment variable.
 *
 * Format: `"org-slug:owner/repo:branch,org-slug/project:owner/repo:branch"`
 *
 * - `org-slug:owner/repo:branch` — matches all projects under that org
 * - `org-slug/project:owner/repo:branch` — matches a specific project
 *
 * Returns a lookup function: (orgSlug, projectSlug?) => RepoMapping | null
 * Specific org/project entries take priority over org-only entries.
 */
export function parseRepoMap(
  envVar: string,
): (orgSlug: string, projectSlug?: string) => RepoMapping | null {
  const orgOnly = new Map<string, RepoMapping>();
  const orgProject = new Map<string, RepoMapping>();

  for (const entry of envVar.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    // Split key from repo:branch — limit to 2 so branch colons aren't split
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx);
    const repoPart = trimmed.slice(colonIdx + 1);
    if (!key || !repoPart) continue;

    // repoPart is "owner/repo" or "owner/repo:branch"
    const repoParts = repoPart.split(':');
    const repo = repoParts[0];
    const branch = repoParts[1] ?? 'main';

    if (!repo) continue;

    const mapping: RepoMapping = { repo, branch };

    if (key.includes('/')) {
      // org-slug/project format
      orgProject.set(key, mapping);
    } else {
      // org-slug only
      orgOnly.set(key, mapping);
    }
  }

  return (orgSlug: string, projectSlug?: string): RepoMapping | null => {
    // Specific org/project match takes priority
    if (projectSlug) {
      const specific = orgProject.get(`${orgSlug}/${projectSlug}`);
      if (specific) return specific;
    }
    // Fall back to org-only match
    return orgOnly.get(orgSlug) ?? null;
  };
}

/**
 * Extract the org slug from a Sentry event web_url.
 * Supports two URL formats:
 *   - Path-based:    https://sentry.io/organizations/{org}/issues/{id}/
 *   - Subdomain-based: https://{org}.sentry.io/issues/{id}/
 */
function extractOrgSlug(webUrl: string): string | null {
  // 1. Try path-based: /organizations/{org}/
  const pathMatch = webUrl.match(/\/organizations\/([^/]+)\//);
  if (pathMatch) return pathMatch[1];

  // 2. Try subdomain-based: https://{org}.sentry.io/
  const subdomainMatch = webUrl.match(/^https?:\/\/([^.]+)\.sentry\.io\//);
  return subdomainMatch ? subdomainMatch[1] : null;
}

// ── GitHub token resolution (D1-aware) ───────────────────────────────────────

interface GithubAuthEnv {
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  SENTRY_GITHUB_TOKEN?: string;
}

/**
 * Resolve GitHub token using D1 config + env fallback.
 *
 * Resolution order:
 * 1. If D1 project has github_installation_id AND env has GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY
 *    → use GitHub App installation token (via resolveGitHubToken helper).
 * 2. Else if D1 secret github_pat exists → use decrypted PAT.
 * 3. Else fallback to env SENTRY_GITHUB_TOKEN.
 */
async function resolveGithubToken(
  d1Config: ResolvedSentryProjectConfig | null,
  env: GithubAuthEnv,
): Promise<string> {
  if (d1Config) {
    // Path 1: GitHub App installation token
    if (
      d1Config.githubInstallationId &&
      env.GITHUB_APP_ID &&
      env.GITHUB_APP_PRIVATE_KEY
    ) {
      try {
        return await resolveGitHubToken(
          {
            GITHUB_APP_ID: env.GITHUB_APP_ID,
            GITHUB_APP_PRIVATE_KEY: env.GITHUB_APP_PRIVATE_KEY,
          } as any,
          d1Config.githubInstallationId,
        );
      } catch (err) {
        console.error(
          `GitHub App token resolution failed for installation ${d1Config.githubInstallationId}: ${
            err instanceof Error ? err.message : 'unknown error'
          }`
        );
        // Fall through to PAT or env fallback
      }
    }

    // Path 2: Encrypted D1 secret github_pat
    if (d1Config.githubPat) {
      return d1Config.githubPat;
    }
  }

  // Path 3: Env var fallback
  return env.SENTRY_GITHUB_TOKEN ?? '';
}

// ── Webhook handler ──────────────────────────────────────────────────────────

interface SentryWebhookEnv {
  SENTRY_WEBHOOK_SECRET?: string;
  SENTRY_REPO_MAP?: string;
  SENTRY_GITHUB_TOKEN?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  TriageProcessor: DurableObjectNamespace;
  DB?: D1Database;
  TENANT_ENCRYPTION_KEY?: string;
  /** Dev/staging only: allow plaintext secrets in D1 when encryption key is absent. */
  ALLOW_PLAINTEXT_SECRETS?: string;
}

/**
 * Hono handler for POST /webhook/sentry.
 */
export async function handleSentryWebhook(c: {
  req: { text: () => Promise<string>; header(name: string): string | undefined };
  env: SentryWebhookEnv;
  json: (body: unknown, status?: number) => Response;
  executionCtx: { waitUntil: (promise: Promise<unknown>) => void };
}): Promise<Response> {
  // 1. Read raw body text
  const rawBody = await c.req.text();

  // 2. Parse JSON early — we need org slug for D1 lookup before signature check
  let payload: SentryEventAlertPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: 'Bad request', message: 'Invalid JSON body' }, 400);
  }

  // 3. Extract org slug from web_url (needed for D1 lookup)
  const webUrl = payload.data.event.web_url ?? '';
  const orgSlug = extractOrgSlug(webUrl);
  if (!orgSlug) {
    return c.json({ error: 'Bad request', message: 'Cannot determine Sentry org from event URL' }, 400);
  }

  // 4. Try D1 lookup (multi-tenant path)
  const resolution = await resolveSentryProjectConfig({
    db: c.env.DB,
    encryptionKey: c.env.TENANT_ENCRYPTION_KEY,
    orgSlug,
    // TODO: extract projectSlug from payload when Sentry provides it
    allowPlaintext: c.env.ALLOW_PLAINTEXT_SECRETS === 'true',
  });

  if (resolution.status === 'found') {
    // ── D1-managed tenant path ──────────────────────────────────────────────
    const d1Config = resolution.config;

    // Verify signature against decrypted D1 webhook secret (single secret, not comma-separated)
    const signatureHeader = c.req.header('Sentry-Hook-Signature') ?? '';
    const isValid = await verifySentrySignature(d1Config.webhookSecret, rawBody, signatureHeader);
    if (!isValid) {
      // D1 tenant exists but signature invalid — reject without fallback
      // to prevent bypass via missing D1 row.
      return c.json({ error: 'Unauthorized', message: 'Invalid signature' }, 401);
    }

    // Check resource type
    const resource = c.req.header('Sentry-Hook-Resource') ?? '';
    if (resource !== 'event_alert') {
      console.log(`Sentry webhook (D1 tenant ${orgSlug}): ignoring resource type "${resource}"`);
      return c.json({ ok: true, ignored: true, resource }, 200);
    }

    // Extract error context
    const errorContext = extractSentryErrorContext(payload);

    // Resolve GitHub token (App install > D1 PAT > env fallback)
    const githubToken = await resolveGithubToken(d1Config, c.env);
    if (!githubToken) {
      console.error(`No GitHub token for D1 tenant ${orgSlug} (no installation, PAT, or env token)`);
      return c.json({ error: 'Server misconfigured', message: 'GitHub token not configured' }, 500);
    }

    // Generate job ID and start triage
    const uuid = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const jobId = `sentry-webhook/${uuid}`;

    const processorStub = getTriageProcessor(c.env.TriageProcessor, jobId);

    // Hard-fail if tenant expects tracker but token is unavailable
    if (d1Config.trackerConfig && !d1Config.trackerToken) {
      console.error(`Tracker configured for D1 tenant ${orgSlug} but tracker_token is missing or failed to decrypt`);
      return c.json(
        {
          error: 'Server error',
          message: 'Tracker configured but token unavailable — cannot proceed without tracker for this tenant',
        },
        500,
      );
    }

    // Resolve tracker config — validate shape + require token
    const validatedTracker = d1Config.trackerToken && d1Config.trackerConfig
      ? (() => {
          const validated = validateTrackerConfig(d1Config.trackerConfig);
          if (!validated) {
            console.warn(`Invalid tracker_config for D1 tenant ${orgSlug} — skipping tracker`);
            return undefined;
          }
          return { ...validated, token: d1Config.trackerToken };
        })()
      : undefined;

    const context: TriageContext = {
      jobId,
      repo: d1Config.githubRepo,
      errorContext,
      githubToken,
      sha: d1Config.githubBranch,
      options: { auto_fix: true },
      tracker: validatedTracker,
    };
    await (processorStub.startTriage as (ctx: TriageContext) => Promise<void>)(context);

    return c.json({ ok: true, job_id: jobId }, 200);
  }

  if (resolution.status === 'invalid') {
    // D1 tenant/project exists but config is unusable (e.g. webhook secret
    // missing or corrupted). Must NOT fall back to env vars — that would
    // allow bypassing D1-level access control.
    console.error(
      `D1 config invalid for org "${orgSlug}": ${resolution.reason}`
    );
    return c.json(
      { error: 'Server error', message: 'Tenant configuration invalid' },
      500,
    );
  }

  // ── Env var fallback path (original behavior) ─────────────────────────────

  // 5. Verify signature using env var secrets (supports comma-separated for multiple Sentry orgs)
  const signatureHeader = c.req.header('Sentry-Hook-Signature') ?? '';
  const secrets = (c.env.SENTRY_WEBHOOK_SECRET ?? '').split(',').map(s => s.trim()).filter(Boolean);

  if (secrets.length === 0) {
    console.error('SENTRY_WEBHOOK_SECRET not configured');
    return c.json({ error: 'Server misconfigured', message: 'Webhook secret not set' }, 500);
  }

  let isValid = false;
  for (const secret of secrets) {
    if (await verifySentrySignature(secret, rawBody, signatureHeader)) {
      isValid = true;
      break;
    }
  }
  if (!isValid) {
    return c.json({ error: 'Unauthorized', message: 'Invalid signature' }, 401);
  }

  // 6. Check resource type — Sentry sends other hooks too
  const resource = c.req.header('Sentry-Hook-Resource') ?? '';
  if (resource !== 'event_alert') {
    console.log(`Sentry webhook: ignoring resource type "${resource}"`);
    return c.json({ ok: true, ignored: true, resource }, 200);
  }

  // 7. Extract error context
  const errorContext = extractSentryErrorContext(payload);

  // 8. Resolve repo from SENTRY_REPO_MAP
  const repoMapVar = c.env.SENTRY_REPO_MAP;
  if (!repoMapVar) {
    console.error('SENTRY_REPO_MAP not configured');
    return c.json({ error: 'Server misconfigured', message: 'Repo map not configured' }, 500);
  }

  const lookupRepo = parseRepoMap(repoMapVar);
  const mapping = lookupRepo(orgSlug);
  if (!mapping) {
    return c.json({ error: 'Bad request', message: `No repo mapping for Sentry org "${orgSlug}"` }, 400);
  }

  // 9. Generate job ID
  const uuid = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const jobId = `sentry-webhook/${uuid}`;

  // 10. Get TriageProcessor DO stub
  const githubToken = c.env.SENTRY_GITHUB_TOKEN ?? '';
  if (!githubToken) {
    console.error('SENTRY_GITHUB_TOKEN not configured');
    return c.json({ error: 'Server misconfigured', message: 'GitHub token not configured' }, 500);
  }

  const processorStub = getTriageProcessor(c.env.TriageProcessor, jobId);

  // 11. Start triage — this is fast (stores state + sets alarm)
  const context: TriageContext = {
    jobId,
    repo: mapping.repo,
    errorContext,
    githubToken,
    sha: mapping.branch,
    options: { auto_fix: true },
  };
  await (processorStub.startTriage as (ctx: TriageContext) => Promise<void>)(context);

  // 12. Return 200
  return c.json({ ok: true, job_id: jobId }, 200);
}
