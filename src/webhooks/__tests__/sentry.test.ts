/**
 * Tests for Sentry webhook handler.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock getTriageProcessor before importing the module under test
vi.mock('../../workflows/triage/processor', () => ({
  getTriageProcessor: vi.fn(() => ({
    startTriage: vi.fn(() => Promise.resolve()),
  })),
}));

import {
  verifySentrySignature,
  extractSentryErrorContext,
  parseRepoMap,
  handleSentryWebhook,
  validateTrackerConfig,
} from '../sentry';
import { getTriageProcessor } from '../../workflows/triage/processor';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Create a valid HMAC-SHA256 signature for a body string. */
async function createSignature(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** Build a sample Sentry event_alert payload. */
function buildSentryPayload(overrides?: Record<string, unknown>) {
  return {
    action: 'created',
    data: {
      event: {
        title: 'TypeError: Cannot read property "name" of undefined',
        message: 'TypeError: Cannot read property "name" of undefined',
        web_url: 'https://sentry.io/organizations/acme-inc/issues/12345/',
        platform: 'javascript',
        event_id: 'abc123def456',
        exception: {
          values: [
            {
              type: 'TypeError',
              value: 'Cannot read property "name" of undefined',
              stacktrace: {
                frames: [
                  {
                    filename: '/app/src/utils.ts',
                    function: 'processUser',
                    lineno: 42,
                    colno: 15,
                    in_app: true,
                  },
                  {
                    filename: '/app/src/index.ts',
                    function: 'handleRequest',
                    lineno: 10,
                    colno: 5,
                    in_app: true,
                  },
                  {
                    filename: 'node_modules/express/router.js',
                    function: 'Layer.handle',
                    lineno: 100,
                    colno: 3,
                    in_app: false,
                  },
                ],
              },
            },
          ],
        },
        tags: [['environment', 'production']],
      },
    },
    ...overrides,
  };
}

/** Build a mock Hono context (loosely typed for test convenience). */
function buildContext(overrides?: {
  body?: string;
  headers?: Record<string, string>;
  env?: Record<string, unknown>;
}) {
  const body = overrides?.body ?? JSON.stringify(buildSentryPayload());
  const headers: Record<string, string> = overrides?.headers ?? {};
  const env: Record<string, unknown> = {
    SENTRY_WEBHOOK_SECRET: 'test-secret',
    SENTRY_REPO_MAP: 'acme-inc:acme/web-app:main',
    SENTRY_GITHUB_TOKEN: 'ghp_test123',
    TriageProcessor: {
      idFromName: vi.fn((name: string) => ({ name })),
      get: vi.fn(() => ({
        startTriage: vi.fn(() => Promise.resolve()),
      })),
    },
    ...overrides?.env,
  };

  return {
    req: {
      text: vi.fn(() => Promise.resolve(body)),
      header: (name: string) => headers[name],
    },
    env,
    json: vi.fn((body: unknown, status?: number) => ({ body, status }) as unknown as Response),
    executionCtx: { waitUntil: vi.fn() },
  };
}

// ── verifySentrySignature ────────────────────────────────────────────────────

describe('verifySentrySignature', () => {
  it('should verify a valid signature', async () => {
    const secret = 'my-secret';
    const body = '{"action":"created"}';
    const signature = await createSignature(secret, body);
    const result = await verifySentrySignature(secret, body, signature);
    expect(result).toBe(true);
  });

  it('should reject an invalid signature', async () => {
    const result = await verifySentrySignature('secret', 'body', 'badsignature');
    expect(result).toBe(false);
  });

  it('should reject an empty signature header', async () => {
    const result = await verifySentrySignature('secret', 'body', '');
    expect(result).toBe(false);
  });
});

// ── extractSentryErrorContext ────────────────────────────────────────────────

describe('extractSentryErrorContext', () => {
  it('should extract all fields from a full payload', () => {
    const payload = buildSentryPayload();
    const ctx = extractSentryErrorContext(payload);

    expect(ctx.title).toBe('TypeError: Cannot read property "name" of undefined');
    expect(ctx.description).toBe('Cannot read property "name" of undefined');
    expect(ctx.stack_trace).toContain('at handleRequest (/app/src/index.ts:10:5)');
    expect(ctx.stack_trace).toContain('at processUser (/app/src/utils.ts:42:15)');
    expect(ctx.affected_files).toEqual(['/app/src/utils.ts', '/app/src/index.ts']);
    expect(ctx.environment).toBe('production');
    expect(ctx.source_url).toBe('https://sentry.io/organizations/acme-inc/issues/12345/');
    expect(ctx.metadata).toEqual({ event_id: 'abc123def456', platform: 'javascript' });
  });

  it('should stack trace with frames in correct order (reversed)', () => {
    const payload = buildSentryPayload();
    const ctx = extractSentryErrorContext(payload);
    const lines = ctx.stack_trace.split('\n');
    // Frames are reversed from Sentry's bottom-to-top order
    // Original order: [processUser, handleRequest, Layer.handle]
    // After reversal: [Layer.handle, handleRequest, processUser]
    expect(lines[0]).toContain('Layer.handle');
    expect(lines[1]).toContain('handleRequest');
    expect(lines[2]).toContain('processUser');
  });

  it('should fallback to unknown when no in_app frames', () => {
    const payload = buildSentryPayload({
      data: {
        event: {
          title: 'Error',
          exception: {
            values: [
              {
                value: 'something broke',
                stacktrace: {
                  frames: [
                    {
                      filename: 'node_modules/foo.js',
                      function: 'foo',
                      in_app: false,
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    const ctx = extractSentryErrorContext(payload);
    expect(ctx.affected_files).toEqual(['unknown']);
    // Stack trace should still contain the frame
    expect(ctx.stack_trace).toContain('foo');
  });

  it('should handle payload without exception', () => {
    const payload = buildSentryPayload({
      data: {
        event: {
          title: 'Some error',
          message: 'Something went wrong',
        },
      },
    });
    const ctx = extractSentryErrorContext(payload);
    expect(ctx.title).toBe('Some error');
    expect(ctx.description).toBe('Something went wrong');
    expect(ctx.stack_trace).toBe('');
    expect(ctx.affected_files).toEqual(['unknown']);
  });

  it('should handle missing environment tag', () => {
    const payload = buildSentryPayload({
      data: {
        event: {
          title: 'Error',
          tags: [],
        },
      },
    });
    const ctx = extractSentryErrorContext(payload);
    expect(ctx.environment).toBeUndefined();
  });

  it('should extract source_url from subdomain-based URL', () => {
    const payload = buildSentryPayload({
      data: {
        event: {
          web_url: 'https://mantto.sentry.io/issues/67890/',
        },
      },
    });
    const ctx = extractSentryErrorContext(payload);
    expect(ctx.source_url).toBe('https://mantto.sentry.io/issues/67890/');
  });
});

// ── parseRepoMap ─────────────────────────────────────────────────────────────

describe('parseRepoMap', () => {
  it('should parse org-only mapping', () => {
    const lookup = parseRepoMap('acme-inc:acme/web-app:main');
    const result = lookup('acme-inc');
    expect(result).toEqual({ repo: 'acme/web-app', branch: 'main' });
  });

  it('should parse org/project specific mapping', () => {
    const lookup = parseRepoMap('acme-inc/api:acme/api-service:develop');
    const result = lookup('acme-inc', 'api');
    expect(result).toEqual({ repo: 'acme/api-service', branch: 'develop' });
  });

  it('should prefer specific project match over org-only', () => {
    const lookup = parseRepoMap(
      'acme-inc:acme/default-app:main,acme-inc/api:acme/api-service:develop',
    );
    // Org-only match
    expect(lookup('acme-inc')).toEqual({ repo: 'acme/default-app', branch: 'main' });
    // Specific project match takes priority
    expect(lookup('acme-inc', 'api')).toEqual({ repo: 'acme/api-service', branch: 'develop' });
  });

  it('should return null for unknown org', () => {
    const lookup = parseRepoMap('acme-inc:acme/web-app:main');
    expect(lookup('unknown-org')).toBeNull();
  });

  it('should default branch to main if not specified', () => {
    const lookup = parseRepoMap('acme-inc:acme/web-app');
    const result = lookup('acme-inc');
    expect(result).toEqual({ repo: 'acme/web-app', branch: 'main' });
  });

  it('should handle empty and whitespace entries', () => {
    const lookup = parseRepoMap('acme-inc:acme/web-app:main, ,other:other/repo:dev');
    expect(lookup('acme-inc')).toEqual({ repo: 'acme/web-app', branch: 'main' });
    expect(lookup('other')).toEqual({ repo: 'other/repo', branch: 'dev' });
  });
});

// ── handleSentryWebhook ──────────────────────────────────────────────────────

describe('handleSentryWebhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return 200 + job_id for valid signature and payload', async () => {
    const body = JSON.stringify(buildSentryPayload());
    const signature = await createSignature('test-secret', body);

    const ctx = buildContext({
      body,
      headers: {
        'Sentry-Hook-Signature': signature,
        'Sentry-Hook-Resource': 'event_alert',
      },
    });

    await handleSentryWebhook(ctx as any);

    expect(ctx.json).toHaveBeenCalledTimes(1);
    const call = ctx.json.mock.calls[0];
    const responseBody = call[0] as Record<string, unknown>;
    const status = call[1];
    expect(status).toBe(200);
    expect(responseBody.ok).toBe(true);
    expect(responseBody.job_id).toMatch(/^sentry-webhook\/[a-f0-9]{12}$/);
  });

  it('should return 401 for invalid signature', async () => {
    const ctx = buildContext({
      headers: {
        'Sentry-Hook-Signature': 'invalid-signature',
        'Sentry-Hook-Resource': 'event_alert',
      },
    });

    await handleSentryWebhook(ctx as any);

    expect(ctx.json).toHaveBeenCalledWith(
      { error: 'Unauthorized', message: 'Invalid signature' },
      401,
    );
  });

  it('should return 401 for missing signature header', async () => {
    const ctx = buildContext({
      headers: {
        'Sentry-Hook-Resource': 'event_alert',
      },
    });

    await handleSentryWebhook(ctx as any);

    expect(ctx.json).toHaveBeenCalledWith(
      { error: 'Unauthorized', message: 'Invalid signature' },
      401,
    );
  });

  it('should return 200 (ignored) for non-event_alert resource', async () => {
    const body = JSON.stringify(buildSentryPayload());
    const signature = await createSignature('test-secret', body);

    const ctx = buildContext({
      body,
      headers: {
        'Sentry-Hook-Signature': signature,
        'Sentry-Hook-Resource': 'issue',
      },
    });

    await handleSentryWebhook(ctx as any);

    expect(ctx.json).toHaveBeenCalledWith(
      { ok: true, ignored: true, resource: 'issue' },
      200,
    );
  });

  it('should return 400 for malformed JSON body', async () => {
    const invalidBody = 'not json at all';
    const signature = await createSignature('test-secret', invalidBody);

    const ctx = buildContext({
      body: invalidBody,
      headers: {
        'Sentry-Hook-Signature': signature,
        'Sentry-Hook-Resource': 'event_alert',
      },
    });

    await handleSentryWebhook(ctx as any);

    expect(ctx.json).toHaveBeenCalledWith(
      { error: 'Bad request', message: 'Invalid JSON body' },
      400,
    );
  });

  it('should return 500 when SENTRY_REPO_MAP is not configured', async () => {
    const body = JSON.stringify(buildSentryPayload());
    const signature = await createSignature('test-secret', body);

    const ctx = buildContext({
      body,
      headers: {
        'Sentry-Hook-Signature': signature,
        'Sentry-Hook-Resource': 'event_alert',
      },
      env: {
        SENTRY_WEBHOOK_SECRET: 'test-secret',
        SENTRY_REPO_MAP: undefined,
        SENTRY_GITHUB_TOKEN: 'ghp_test123',
      },
    });

    await handleSentryWebhook(ctx as any);

    expect(ctx.json).toHaveBeenCalledWith(
      { error: 'Server misconfigured', message: 'Repo map not configured' },
      500,
    );
  });

  it('should return 400 for unknown Sentry org', async () => {
    const body = JSON.stringify(
      buildSentryPayload({
        data: {
          event: {
            title: 'Error',
            web_url: 'https://sentry.io/organizations/unknown-org/issues/999/',
          },
        },
      }),
    );
    const signature = await createSignature('test-secret', body);

    const ctx = buildContext({
      body,
      headers: {
        'Sentry-Hook-Signature': signature,
        'Sentry-Hook-Resource': 'event_alert',
      },
    });

    await handleSentryWebhook(ctx as any);

    expect(ctx.json).toHaveBeenCalledWith(
      { error: 'Bad request', message: 'No repo mapping for Sentry org "unknown-org"' },
      400,
    );
  });

  it('should return 400 for unknown Sentry org (subdomain URL)', async () => {
    const body = JSON.stringify(
      buildSentryPayload({
        data: {
          event: {
            title: 'Error',
            web_url: 'https://unknown-org.sentry.io/issues/999/',
          },
        },
      }),
    );
    const signature = await createSignature('test-secret', body);

    const ctx = buildContext({
      body,
      headers: {
        'Sentry-Hook-Signature': signature,
        'Sentry-Hook-Resource': 'event_alert',
      },
    });

    await handleSentryWebhook(ctx as any);

    expect(ctx.json).toHaveBeenCalledWith(
      { error: 'Bad request', message: 'No repo mapping for Sentry org "unknown-org"' },
      400,
    );
  });

  it('should resolve org from subdomain-based URL', async () => {
    const body = JSON.stringify(
      buildSentryPayload({
        data: {
          event: {
            web_url: 'https://mantto.sentry.io/issues/12345/',
          },
        },
      }),
    );
    const signature = await createSignature('test-secret', body);

    const startTriageMock = vi.fn(() => Promise.resolve());
    vi.mocked(getTriageProcessor).mockReturnValue({
      startTriage: startTriageMock,
    } as unknown as ReturnType<typeof getTriageProcessor>);

    const ctx = buildContext({
      body,
      headers: {
        'Sentry-Hook-Signature': signature,
        'Sentry-Hook-Resource': 'event_alert',
      },
      env: {
        SENTRY_WEBHOOK_SECRET: 'test-secret',
        SENTRY_REPO_MAP: 'mantto:mantto/web-app:main',
        SENTRY_GITHUB_TOKEN: 'ghp_test123',
      },
    });

    await handleSentryWebhook(ctx as any);

    const call = ctx.json.mock.calls[0];
    expect(call[1]).toBe(200);
    expect((call[0] as Record<string, unknown>).ok).toBe(true);
    expect(startTriageMock).toHaveBeenCalledTimes(1);
    const triageCtx = (startTriageMock.mock.calls as unknown as [Record<string, unknown>][])[0][0];
    expect(triageCtx.repo).toBe('mantto/web-app');
    expect(triageCtx.sha).toBe('main');
  });

  it('should call TriageProcessor.startTriage with correct context', async () => {
    const body = JSON.stringify(buildSentryPayload());
    const signature = await createSignature('test-secret', body);

    const startTriageMock = vi.fn(() => Promise.resolve());
    vi.mocked(getTriageProcessor).mockReturnValue({
      startTriage: startTriageMock,
    } as unknown as ReturnType<typeof getTriageProcessor>);

    const ctx = buildContext({
      body,
      headers: {
        'Sentry-Hook-Signature': signature,
        'Sentry-Hook-Resource': 'event_alert',
      },
    });

    await handleSentryWebhook(ctx as any);

    expect(getTriageProcessor).toHaveBeenCalledTimes(1);
    expect(startTriageMock).toHaveBeenCalledTimes(1);
    const triageCtx = (startTriageMock.mock.calls as unknown as [Record<string, unknown>][])[0][0];
    expect(triageCtx).toBeDefined();
    expect(triageCtx.repo).toBe('acme/web-app');
    expect(triageCtx.sha).toBe('main');
    expect(triageCtx.githubToken).toBe('ghp_test123');
    const ec = triageCtx.errorContext as Record<string, unknown>;
    expect(ec.title).toBe('TypeError: Cannot read property "name" of undefined');
    expect(triageCtx.options).toEqual({ auto_fix: true });
    expect(triageCtx.jobId).toMatch(/^sentry-webhook\/[a-f0-9]{12}$/);
    expect(triageCtx.tracker).toBeUndefined();
  });

  it('should return 500 when SENTRY_GITHUB_TOKEN is not configured', async () => {
    const body = JSON.stringify(buildSentryPayload());
    const signature = await createSignature('test-secret', body);

    const ctx = buildContext({
      body,
      headers: {
        'Sentry-Hook-Signature': signature,
        'Sentry-Hook-Resource': 'event_alert',
      },
      env: {
        SENTRY_WEBHOOK_SECRET: 'test-secret',
        SENTRY_REPO_MAP: 'acme-inc:acme/web-app:main',
        SENTRY_GITHUB_TOKEN: undefined,
      },
    });

    await handleSentryWebhook(ctx as any);

    expect(ctx.json).toHaveBeenCalledWith(
      { error: 'Server misconfigured', message: 'GitHub token not configured' },
      500,
    );
  });

  it('should return 500 when SENTRY_WEBHOOK_SECRET is not configured', async () => {
    const body = JSON.stringify(buildSentryPayload());
    const signature = await createSignature('test-secret', body);

    const ctx = buildContext({
      body,
      headers: {
        'Sentry-Hook-Signature': signature,
        'Sentry-Hook-Resource': 'event_alert',
      },
      env: {
        SENTRY_WEBHOOK_SECRET: undefined,
        SENTRY_REPO_MAP: 'acme-inc:acme/web-app:main',
        SENTRY_GITHUB_TOKEN: 'ghp_test123',
      },
    });

    await handleSentryWebhook(ctx as any);

    expect(ctx.json).toHaveBeenCalledWith(
      { error: 'Server misconfigured', message: 'Webhook secret not set' },
      500,
    );
  });

  it('should accept multiple secrets — first matches', async () => {
    const body = JSON.stringify(buildSentryPayload());
    const signature = await createSignature('secret1', body);

    const ctx = buildContext({
      body,
      headers: {
        'Sentry-Hook-Signature': signature,
        'Sentry-Hook-Resource': 'event_alert',
      },
      env: {
        SENTRY_WEBHOOK_SECRET: 'secret1,secret2,secret3',
        SENTRY_REPO_MAP: 'acme-inc:acme/web-app:main',
        SENTRY_GITHUB_TOKEN: 'ghp_test123',
      },
    });

    await handleSentryWebhook(ctx as any);

    const call = ctx.json.mock.calls[0];
    expect(call[1]).toBe(200);
    expect((call[0] as Record<string, unknown>).ok).toBe(true);
  });

  it('should accept multiple secrets — second matches', async () => {
    const body = JSON.stringify(buildSentryPayload());
    const signature = await createSignature('secret2', body);

    const ctx = buildContext({
      body,
      headers: {
        'Sentry-Hook-Signature': signature,
        'Sentry-Hook-Resource': 'event_alert',
      },
      env: {
        SENTRY_WEBHOOK_SECRET: 'secret1,secret2,secret3',
        SENTRY_REPO_MAP: 'acme-inc:acme/web-app:main',
        SENTRY_GITHUB_TOKEN: 'ghp_test123',
      },
    });

    await handleSentryWebhook(ctx as any);

    const call = ctx.json.mock.calls[0];
    expect(call[1]).toBe(200);
    expect((call[0] as Record<string, unknown>).ok).toBe(true);
  });

  it('should accept multiple secrets — third matches', async () => {
    const body = JSON.stringify(buildSentryPayload());
    const signature = await createSignature('secret3', body);

    const ctx = buildContext({
      body,
      headers: {
        'Sentry-Hook-Signature': signature,
        'Sentry-Hook-Resource': 'event_alert',
      },
      env: {
        SENTRY_WEBHOOK_SECRET: 'secret1,secret2,secret3',
        SENTRY_REPO_MAP: 'acme-inc:acme/web-app:main',
        SENTRY_GITHUB_TOKEN: 'ghp_test123',
      },
    });

    await handleSentryWebhook(ctx as any);

    const call = ctx.json.mock.calls[0];
    expect(call[1]).toBe(200);
    expect((call[0] as Record<string, unknown>).ok).toBe(true);
  });

  it('should reject when none of the multiple secrets match', async () => {
    const body = JSON.stringify(buildSentryPayload());
    const signature = await createSignature('wrong-secret', body);

    const ctx = buildContext({
      body,
      headers: {
        'Sentry-Hook-Signature': signature,
        'Sentry-Hook-Resource': 'event_alert',
      },
      env: {
        SENTRY_WEBHOOK_SECRET: 'secret1,secret2,secret3',
        SENTRY_REPO_MAP: 'acme-inc:acme/web-app:main',
        SENTRY_GITHUB_TOKEN: 'ghp_test123',
      },
    });

    await handleSentryWebhook(ctx as any);

    expect(ctx.json).toHaveBeenCalledWith(
      { error: 'Unauthorized', message: 'Invalid signature' },
      401,
    );
  });

  it('should accept secrets with surrounding whitespace', async () => {
    const body = JSON.stringify(buildSentryPayload());
    const signature = await createSignature('secret2', body);

    const ctx = buildContext({
      body,
      headers: {
        'Sentry-Hook-Signature': signature,
        'Sentry-Hook-Resource': 'event_alert',
      },
      env: {
        SENTRY_WEBHOOK_SECRET: ' secret1 , secret2 ',
        SENTRY_REPO_MAP: 'acme-inc:acme/web-app:main',
        SENTRY_GITHUB_TOKEN: 'ghp_test123',
      },
    });

    await handleSentryWebhook(ctx as any);

    const call = ctx.json.mock.calls[0];
    expect(call[1]).toBe(200);
    expect((call[0] as Record<string, unknown>).ok).toBe(true);
  });

  it('should return 400 when web_url is missing', async () => {
    const body = JSON.stringify(
      buildSentryPayload({
        data: {
          event: {
            title: 'Error',
            web_url: '',
          },
        },
      }),
    );
    const signature = await createSignature('test-secret', body);

    const ctx = buildContext({
      body,
      headers: {
        'Sentry-Hook-Signature': signature,
        'Sentry-Hook-Resource': 'event_alert',
      },
    });

    await handleSentryWebhook(ctx as any);

    expect(ctx.json).toHaveBeenCalledWith(
      { error: 'Bad request', message: 'Cannot determine Sentry org from event URL' },
      400,
    );
  });
});

// ── validateTrackerConfig ──────────────────────────────────────────────────────

describe('validateTrackerConfig', () => {
  it('should validate a valid github config', () => {
    const result = validateTrackerConfig({ type: 'github', team: 'acme', labels: ['bug'] });
    expect(result).toEqual({ type: 'github', team: 'acme', labels: ['bug'] });
  });

  it('should validate a valid linear config without labels', () => {
    const result = validateTrackerConfig({ type: 'linear', team: 'ENG' });
    expect(result).toEqual({ type: 'linear', team: 'ENG' });
  });

  it('should validate a valid jira config with jira_base_url', () => {
    const result = validateTrackerConfig({ type: 'jira', team: 'PROJ', jira_base_url: 'https://acme.atlassian.net' });
    expect(result).toEqual({ type: 'jira', team: 'PROJ', jira_base_url: 'https://acme.atlassian.net' });
  });

  it('should reject jira config without jira_base_url', () => {
    const result = validateTrackerConfig({ type: 'jira', team: 'PROJ' });
    expect(result).toBeNull();
  });

  it('should reject config with unknown type', () => {
    const result = validateTrackerConfig({ type: 'asana', team: 'acme' });
    expect(result).toBeNull();
  });

  it('should reject config with missing team', () => {
    const result = validateTrackerConfig({ type: 'github' });
    expect(result).toBeNull();
  });

  it('should reject config with empty team', () => {
    const result = validateTrackerConfig({ type: 'github', team: '  ' });
    expect(result).toBeNull();
  });

  it('should reject config with non-string labels', () => {
    const result = validateTrackerConfig({ type: 'github', team: 'acme', labels: [123] });
    expect(result).toBeNull();
  });

  it('should reject null input', () => {
    expect(validateTrackerConfig(null)).toBeNull();
  });

  it('should reject undefined input', () => {
    expect(validateTrackerConfig(undefined)).toBeNull();
  });

  it('should reject non-object input', () => {
    expect(validateTrackerConfig('string')).toBeNull();
    expect(validateTrackerConfig(42)).toBeNull();
  });
});
