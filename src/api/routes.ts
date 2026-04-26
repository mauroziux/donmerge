/**
 * Push API route handlers.
 *
 * All routes use FlueWorker's context pattern (c.req, c.env, c.json).
 * Auth middleware validates API keys and enforces rate limits.
 */

import { validateApiKey } from './auth';
import type {
  PushReviewRequest,
  PushReviewResponse,
  SentryTriageRequest,
  SentryTriageResponse,
  JobStatusResponse,
  AuthenticatedRequest,
  RateLimitInfo,
  TrackerConfig,
} from './types';
import { getReviewProcessor } from '../workflows/code-review/processor';
import { getSentryTriageProcessor } from '../workflows/sentry-triage/processor';

// ── Helpers ────────────────────────────────────────────────────────────────────

/** SHA-256 hash truncated to 16 hex chars — used as rate-limit storage key. */
async function hashKey(apiKey: string): Promise<string> {
  const data = new TextEncoder().encode(apiKey);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .substring(0, 16);
}

async function checkRateLimit(
  rateLimiterNs: DurableObjectNamespace,
  auth: AuthenticatedRequest
): Promise<RateLimitInfo> {
  const keyHash = await hashKey(auth.apiKey);
  const id = rateLimiterNs.idFromName(keyHash);
  const stub = rateLimiterNs.get(id);

  const response = await stub.fetch(
    new Request('https://internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'check', keyHash, keyType: auth.keyType }),
    })
  );

  return (await response.json()) as RateLimitInfo;
}

/** Build the job_id that maps 1:1 to the ReviewProcessor DO name. */
function buildReviewJobId(owner: string, repo: string, prNumber: number): string {
  return `review/${owner}/${repo}/${prNumber}`;
}

/** Build the job_id for a Sentry triage job. */
function buildSentryTriageJobId(): string {
  const uuid = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  return `sentry-triage/${uuid}`;
}

/**
 * Parse a job_id to determine its type and DO routing info.
 *
 * Returns:
 * - `{type: 'review', doName: string}` for review jobs
 * - `{type: 'sentry-triage', doName: string}` for sentry triage jobs
 * - `null` for unrecognized formats
 */
function parseJobId(
  jobId: string
): { type: 'review' | 'sentry-triage'; doName: string } | null {
  if (jobId.startsWith('review/')) {
    return { type: 'review', doName: jobId.slice('review/'.length) };
  }
  if (jobId.startsWith('sentry-triage/')) {
    // The full jobId IS the DO name (used as idFromName)
    return { type: 'sentry-triage', doName: jobId };
  }
  return null;
}

// ── Auth middleware ────────────────────────────────────────────────────────────

type AuthenticatedHandler = (c: any, auth: AuthenticatedRequest) => Promise<Response>;

function withAuth(handler: AuthenticatedHandler) {
  return async (c: any): Promise<Response> => {
    const authHeader = c.req.header('Authorization');
    const auth = validateApiKey(authHeader, c.env.DONMERGE_API_KEYS);

    if (!auth) {
      return c.json(
        { error: 'Unauthorized', message: 'Invalid or missing API key' },
        401
      );
    }

    // Rate limiting (graceful — if RateLimiter DO isn't bound, skip)
    if (c.env.RateLimiter) {
      const rateLimitInfo = await checkRateLimit(c.env.RateLimiter, auth);
      if (!rateLimitInfo.allowed) {
        return c.json(
          {
            error: 'Rate limit exceeded',
            message: 'Too many requests. Please try again later.',
            reset_at: rateLimitInfo.reset_at,
          },
          429
        );
      }
    }

    return handler(c, auth);
  };
}

// ── POST /api/v1/review — Trigger a code review ───────────────────────────────

export const handlePushReview = withAuth(async (c, auth) => {
  let body: PushReviewRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Bad request', message: 'Invalid JSON body' }, 400);
  }

  // Validate required fields
  if (!body.github_token || !body.owner || !body.repo || !body.pr_number) {
    return c.json(
      {
        error: 'Bad request',
        message: 'Missing required fields: github_token, owner, repo, pr_number',
      },
      400
    );
  }

  // Validate owner/repo format and pr_number
  if (!/^[a-zA-Z0-9_.-]+$/.test(body.owner) || !/^[a-zA-Z0-9_.-]+$/.test(body.repo)) {
    return c.json({ error: 'Bad request', message: 'Invalid owner or repo format' }, 400);
  }
  if (!Number.isInteger(body.pr_number) || body.pr_number < 1) {
    return c.json({ error: 'Bad request', message: 'pr_number must be a positive integer' }, 400);
  }

  // Get or create ReviewProcessor DO for this PR
  const processorStub = getReviewProcessor(
    c.env.ReviewProcessor,
    body.owner,
    body.repo,
    body.pr_number
  );

  // Compute the caller's key hash for authorization scoping on status queries
  const callerKeyHash = await hashKey(auth.apiKey);

  // Start review with caller-provided token
  // DurableObjectStub proxies methods as unknown — cast for type safety
  await (processorStub.startReview as (ctx: {
    githubToken: string;
    owner: string;
    repo: string;
    prNumber: number;
    model?: string;
    maxFiles?: number;
    retrigger: boolean;
    initiatorKeyHash?: string;
  }) => Promise<void>)({
    githubToken: body.github_token,
    owner: body.owner,
    repo: body.repo,
    prNumber: body.pr_number,
    model: body.model,
    maxFiles: body.max_files,
    retrigger: false,
    initiatorKeyHash: callerKeyHash,
  });

  const jobId = buildReviewJobId(body.owner, body.repo, body.pr_number);
  const response: PushReviewResponse = {
    job_id: jobId,
    status: 'pending',
    message: `Review queued for ${body.owner}/${body.repo}#${body.pr_number}`,
  };

  return c.json(response, 202);
});

// ── POST /api/v1/sentry/triage — Trigger Sentry triage ────────────────────────

export const handleSentryTriage = withAuth(async (c, auth) => {
  let body: SentryTriageRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Bad request', message: 'Invalid JSON body' }, 400);
  }

  // Validate required fields
  if (!body.repo || !body.sentry_issue_url || !body.sentry_auth_token || !body.github_token || !body.sha) {
    return c.json(
      {
        error: 'Bad request',
        message: 'Missing required fields: repo, sentry_issue_url, sentry_auth_token, github_token, sha',
      },
      400
    );
  }

  // Validate repo format (owner/repo)
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(body.repo)) {
    return c.json({ error: 'Bad request', message: 'Invalid repo format. Expected "owner/repo"' }, 400);
  }

  // Validate tracker sub-fields only if tracker is provided
  if (body.tracker) {
    if (!body.tracker.type || !body.tracker.token || !body.tracker.team) {
      return c.json(
        { error: 'Bad request', message: 'Tracker requires: type, token, team' },
        400
      );
    }

    if (!['github', 'linear', 'jira'].includes(body.tracker.type)) {
      return c.json(
        { error: 'Bad request', message: 'Tracker type must be: github, linear, or jira' },
        400
      );
    }
  }

  // Basic Sentry URL check
  if (!body.sentry_issue_url.includes('sentry.io') || !body.sentry_issue_url.includes('/issues/')) {
    return c.json(
      { error: 'Bad request', message: 'Invalid Sentry issue URL' },
      400
    );
  }

  // Generate job ID and get DO stub
  const jobId = buildSentryTriageJobId();
  const processorStub = getSentryTriageProcessor(c.env.SentryTriageProcessor, jobId);

  // Compute the caller's key hash for authorization scoping on status queries
  const callerKeyHash = await hashKey(auth.apiKey);

  // Start triage with caller-provided context
  // DurableObjectStub proxies methods as unknown — cast for type safety
  await (processorStub.startTriage as (ctx: {
    jobId: string;
    repo: string;
    sentryIssueUrl: string;
    sentryAuthToken: string;
    githubToken: string;
    sha: string;
    tracker?: TrackerConfig;
    options?: { auto_fix?: boolean };
    initiatorKeyHash?: string;
  }) => Promise<void>)({
    jobId,
    repo: body.repo,
    sentryIssueUrl: body.sentry_issue_url,
    sentryAuthToken: body.sentry_auth_token,
    githubToken: body.github_token,
    sha: body.sha,
    tracker: body.tracker,
    options: body.options ?? { auto_fix: true },
    initiatorKeyHash: callerKeyHash,
  });

  const response: SentryTriageResponse = {
    job_id: jobId,
    status: 'pending',
    message: `Sentry triage queued for ${body.repo}`,
  };

  return c.json(response, 202);
});

// ── GET /api/v1/status/:job_id — Check job status ─────────────────────────────

export const handleJobStatus = withAuth(async (c, auth) => {
  const url = new URL(c.req.url);
  const prefix = '/api/v1/status/';
  const jobId = decodeURIComponent(url.pathname.slice(prefix.length));

  if (!jobId) {
    return c.json({ error: 'Bad request', message: 'Missing job_id' }, 400);
  }

  const parsed = parseJobId(jobId);
  if (!parsed) {
    return c.json(
      { error: 'Not found', message: `Unknown job type: ${jobId}` },
      404
    );
  }

  let stub: DurableObjectStub;
  let callerKeyHash: string | undefined;

  if (parsed.type === 'review') {
    // Look up the ReviewProcessor DO by the same name format getReviewProcessor uses
    const id = c.env.ReviewProcessor.idFromName(parsed.doName);
    stub = c.env.ReviewProcessor.get(id);
    callerKeyHash = await hashKey(auth.apiKey);
  } else {
    // Sentry triage — look up by jobId (which is the DO name)
    const id = c.env.SentryTriageProcessor.idFromName(parsed.doName);
    stub = c.env.SentryTriageProcessor.get(id);
    callerKeyHash = await hashKey(auth.apiKey);
  }

  try {
    const status = (await (stub.getStatus as (callerKeyHash?: string) => Promise<{
      state: string;
      error?: string;
      startedAt?: string;
      completedAt?: string;
      result?: unknown;
    } | null>)(callerKeyHash));

    if (!status) {
      return c.json(
        { error: 'Not found', message: `Job ${jobId} not found` },
        404
      );
    }

    const response: JobStatusResponse = {
      job_id: jobId,
      status: status.state as JobStatusResponse['status'],
      result: status.result as JobStatusResponse['result'],
      error: status.error,
      created_at: status.startedAt ?? new Date().toISOString(),
      updated_at: status.completedAt ?? new Date().toISOString(),
    };

    return c.json(response);
  } catch (e: unknown) {
    // Distinguish between "not found" and internal errors
    if (e instanceof Error && (e.message.includes('not found') || e.message.includes('No state'))) {
      return c.json(
        { error: 'Not found', message: `Job ${jobId} not found` },
        404
      );
    }
    // Transient or internal errors
    return c.json({ error: 'Internal error', message: 'Failed to retrieve job status' }, 500);
  }
});
