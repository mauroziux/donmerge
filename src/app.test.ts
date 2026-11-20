/**
 * Regression tests for the GitHub webhook PRODUCER path in src/app.ts.
 *
 * Bug being guarded against: PR tableoltd/rms#3646 — the webhook returned HTTP
 * 202 but no check run was ever created. Root cause was
 * `c.executionCtx.waitUntil(processGitHubCodeReviewWebhook(...))` being killed
 * by Cloudflare's 30s cap before `env.CODE_REVIEW_WORKFLOW.create()` completed.
 *
 * The fix replaced waitUntil with `await c.env.CODE_REVIEW_QUEUE.send(...)`,
 * giving the pipeline a 15-min Queue budget. These tests lock that contract in:
 *
 *   1. Valid webhook (shouldProcess=true) → queue.send called exactly once
 *      with the validation context, response is 202.
 *   2. Invalid/skipped webhook (shouldProcess=false) → queue.send NOT called,
 *      the validation body/status pass through unchanged.
 *   3. waitUntil is NEVER invoked for processing — a future regression that
 *      re-introduces `c.executionCtx.waitUntil(...)` will trip this.
 *
 * The FlueWorker HTTP layer is mocked so we can invoke the registered POST
 * handler directly with a hand-built context `c`, mirroring the pattern in
 * src/webhooks/__tests__/sentry.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock FlueWorker so we can capture the handler registered at the route ────
// vi.hoisted() runs before vi.mock hoisting, so the registry is stable.
const { routeHandlers, FlueWorkerMock } = vi.hoisted(() => {
  // method + ' ' + path → handler
  const routeHandlers = new Map<string, (...args: unknown[]) => unknown>();
  class FlueWorkerMock<Env = unknown> {
    get(path: string, handler: (...args: unknown[]) => unknown) {
      routeHandlers.set(`GET ${path}`, handler);
    }
    post(path: string, handler: (...args: unknown[]) => unknown) {
      routeHandlers.set(`POST ${path}`, handler);
    }
    // app.fetch is bound in the default export but never exercised here.
    fetch() {
      return Promise.resolve(undefined);
    }
  }
  return { routeHandlers, FlueWorkerMock };
});

vi.mock('@flue/cloudflare/worker', () => ({ FlueWorker: FlueWorkerMock }));

// ── Mock the heavy imports so app.ts loads without cloudflare:workers ────────
vi.mock('./workflows/code-review', () => ({
  // The only symbol app.ts calls before queue.send — controlled per-test below.
  validateWebhookFast: vi.fn(),
}));

vi.mock('./workflows/code-review/processor', () => ({
  ReviewProcessor: class {},
}));

vi.mock('./workflows/code-review/code-review-workflow', () => ({
  CodeReviewWorkflow: class {},
}));

vi.mock('./workflows/triage/processor', () => ({
  TriageProcessor: class {},
}));

vi.mock('./api/routes', () => ({
  handlePushReview: vi.fn(),
  handleTriage: vi.fn(),
  handleJobStatus: vi.fn(),
}));

vi.mock('./api/rate-limit', () => ({
  RateLimiter: class {},
}));

vi.mock('./webhooks/sentry', () => ({
  handleSentryWebhook: vi.fn(),
}));

vi.mock('./queues/code-review-consumer', () => ({
  handleCodeReviewQueue: vi.fn(),
}));

vi.mock('./workflows/code-review/reaction-feedback-sync', () => ({
  syncReactionFeedback: vi.fn().mockResolvedValue({ attempted: 0, failed: 0, skipped: 0 }),
}));

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class {},
}));

// Import AFTER mocks are in place. Importing app.ts runs the route registration
// at module load, so the POST handler is captured in `routeHandlers`.
import app from './app';
import { syncReactionFeedback } from './workflows/code-review/reaction-feedback-sync';
import { validateWebhookFast } from './workflows/code-review';
import type { WebhookContext } from './workflows/code-review';

const mockedValidate = vi.mocked(validateWebhookFast);

describe('provider diagnostics authorization', () => {
  it('rejects a model probe before trying to create a sandbox when authentication is missing', async () => {
    const handler = routeHandlers.get('POST /api/v1/debug/providers')!;
    const json = vi.fn((_body: unknown, status: number) => ({ status }));
    const result = await handler({
      req: { url: 'https://example.test/api/v1/debug/providers?model=dynamic/test', header: () => undefined },
      env: { DONMERGE_PUSH_API_KEYS: 'dm_live_testkey123' },
      json,
    }) as { status: number };
    expect(result.status).toBe(401);
  });

  it('rejects a model outside the configured allowlist', async () => {
    const handler = routeHandlers.get('POST /api/v1/debug/providers')!;
    const json = vi.fn((_body: unknown, status: number) => ({ status }));
    const result = await handler({
      req: { url: 'https://example.test/api/v1/debug/providers?model=unconfigured', header: () => 'Bearer dm_live_testkey123' },
      env: { DONMERGE_PUSH_API_KEYS: 'dm_live_testkey123', CODEX_MODEL: 'dynamic/configured' },
      json,
    }) as { status: number };
    expect(result.status).toBe(400);
  });
});

// ── Build a mock Flue context `c` (same shape as sentry.test.ts) ─────────────

function makeContext(overrides: {
  body?: string;
  headers?: Record<string, string>;
  env?: Record<string, unknown>;
} = {}) {
  const body = overrides.body ?? '{}';
  const headers: Record<string, string> = {
    'x-hub-signature-256': 'sha256=abc',
    'x-github-event': 'pull_request',
    ...overrides.headers,
  };
  const queueSend = vi.fn(() => Promise.resolve('queued-msg-id'));
  const waitUntil = vi.fn();
  const env: Record<string, unknown> = {
    CODE_REVIEW_QUEUE: { send: queueSend },
    ...overrides.env,
  };
  return {
    c: {
      req: {
        text: vi.fn(() => Promise.resolve(body)),
        header: (name: string) => headers[name] ?? null,
      },
      env,
      json: vi.fn(
        (responseBody: unknown, status?: number) => ({ body: responseBody, status }) as never
      ),
      executionCtx: { waitUntil },
    },
    queueSend,
    waitUntil,
  };
}

const validContext: WebhookContext = {
  owner: 'tableoltd',
  repo: 'rms',
  prNumber: 3646,
  retrigger: false,
  installationId: 12345,
};

beforeEach(() => {
  vi.clearAllMocks();
});

function getPostGithubWebhookHandler(): (c: unknown) => Promise<unknown> {
  const handler = routeHandlers.get('POST /webhook/github');
  if (!handler) {
    throw new Error('POST /webhook/github handler was not registered by app.ts');
  }
  return handler as (c: unknown) => Promise<unknown>;
}

describe('POST /webhook/github — producer path (regression: waitUntil → queue)', () => {
  it('enqueues to CODE_REVIEW_QUEUE and returns 202 when validation passes', async () => {
    // Simulate a passing validation that yields a processable context.
    mockedValidate.mockResolvedValue({
      shouldProcess: true,
      status: 202,
      body: { ok: true },
      context: validContext,
    });

    const { c, queueSend, waitUntil } = makeContext();
    const handler = getPostGithubWebhookHandler();
    const result = (await handler(c)) as { body: Record<string, unknown>; status: number };

    // The context MUST be handed to the queue, exactly once.
    expect(queueSend).toHaveBeenCalledTimes(1);
    expect(queueSend).toHaveBeenCalledWith(validContext);

    // 202 Accepted, with the expected body shape.
    expect(result.status).toBe(202);
    expect(result.body).toEqual(
      expect.objectContaining({
        ok: true,
        accepted: true,
        prNumber: 3646,
      })
    );

    // Critical regression guard: processing must NOT go through waitUntil.
    // The 30s cap on waitUntil is the original bug.
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('does NOT enqueue when validation says shouldProcess=false', async () => {
    // E.g. signature failure (401), repo not allowed (403), or trigger skip (200).
    mockedValidate.mockResolvedValue({
      shouldProcess: false,
      status: 403,
      body: { error: 'repository not allowed' },
    });

    const { c, queueSend } = makeContext();
    const handler = getPostGithubWebhookHandler();
    const result = (await handler(c)) as { body: Record<string, unknown>; status: number };

    expect(queueSend).not.toHaveBeenCalled();
    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: 'repository not allowed' });
  });

  it('forwards the validation context payload verbatim to the queue', async () => {
    // Lock in that the handler passes `validation.context!` straight through,
    // without mutation — a future change that drops the `!` or reshapes the
    // payload would break the consumer silently.
    const ctx: WebhookContext = {
      owner: 'tableoltd',
      repo: 'tableo-s3-browser-app',
      prNumber: 7,
      retrigger: true,
      commentId: 99,
      commentType: 'issue',
      installationId: 98765,
      instruction: 'focus on auth',
      focusFiles: ['src/auth.ts'],
    };
    mockedValidate.mockResolvedValue({
      shouldProcess: true,
      status: 202,
      body: { ok: true },
      context: ctx,
    });

    const { c, queueSend } = makeContext();
    const handler = getPostGithubWebhookHandler();
    await handler(c);

    expect(queueSend).toHaveBeenCalledWith(ctx);
  });

  it('never calls c.executionCtx.waitUntil for the webhook path', async () => {
    // Dedicated, explicitly-named regression test. The original failure (PR
    // tableoltd/rms#3646) was caused by waitUntil cancellation at the 30s
    // Cloudflare cap. If anyone re-introduces
    // `c.executionCtx.waitUntil(processGitHubCodeReviewWebhook(...))`, the
    // spy below will record the call and this test fails.
    mockedValidate.mockResolvedValue({
      shouldProcess: true,
      status: 202,
      body: { ok: true },
      context: validContext,
    });

    const { c, waitUntil } = makeContext();
    const handler = getPostGithubWebhookHandler();
    await handler(c);

    expect(waitUntil).not.toHaveBeenCalled();
  });
});

describe('scheduled reaction feedback collection', () => {
  const controller = { scheduledTime: 0, cron: '*/15 * * * *', noRetry() {} };

  it('runs the bounded collector only when explicitly enabled', async () => {
    vi.clearAllMocks();
    const pending: Promise<unknown>[] = [];
    const ctx: ExecutionContext = { waitUntil: (work: Promise<unknown>) => { pending.push(work); }, passThroughOnException() {} };
    const env = { DONMERGE_REACTION_SYNC: 'true' } as Parameters<typeof app.scheduled>[1];
    app.scheduled(controller, env, ctx);
    await Promise.all(pending);
    expect(syncReactionFeedback).toHaveBeenCalledWith(env);
    expect(pending).toHaveLength(1);
  });

  it('does not run when disabled or absent', () => {
    vi.clearAllMocks();
    const ctx: ExecutionContext = { waitUntil: vi.fn(), passThroughOnException() {} };
    for (const flag of [undefined, 'false', 'invalid']) {
      app.scheduled(controller, { DONMERGE_REACTION_SYNC: flag } as Parameters<typeof app.scheduled>[1], ctx);
    }
    expect(syncReactionFeedback).not.toHaveBeenCalled();
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });
});
