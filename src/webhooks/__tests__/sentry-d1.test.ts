/**
 * Tests for Sentry webhook D1 integration path.
 *
 * Tests the D1-first flow + env var fallback behavior.
 * The existing env-var tests remain in sentry.test.ts and must continue to pass.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { encrypt, generateKey } from '../../lib/aes-gcm';
import { resolveSentryProjectConfig } from '../../lib/tenant-config';

// Mock getTriageProcessor before importing the module under test
vi.mock('../../workflows/triage/processor', () => ({
  getTriageProcessor: vi.fn(() => ({
    startTriage: vi.fn(() => Promise.resolve()),
  })),
}));

// Mock resolveGitHubToken — we don't want to make actual GitHub API calls
vi.mock('../../workflows/code-review/github-auth', () => ({
  resolveGitHubToken: vi.fn(async (_env: any, installationId: number) => {
    return `gh_installation_${installationId}_token`;
  }),
}));

// Mock resolveSentryProjectConfig — controlled per test
vi.mock('../../lib/tenant-config', () => ({
  resolveSentryProjectConfig: vi.fn(),
  SentryProjectResolution: undefined, // type-only export
}));

import { handleSentryWebhook } from '../sentry';
import { getTriageProcessor } from '../../workflows/triage/processor';
import { resolveGitHubToken } from '../../workflows/code-review/github-auth';

// ── Helpers ──────────────────────────────────────────────────────────────────

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

// ── D1 webhook tests ─────────────────────────────────────────────────────────

describe('handleSentryWebhook — D1 path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: D1 lookup returns not_found (no D1 tenant)
    vi.mocked(resolveSentryProjectConfig).mockResolvedValue({ status: 'not_found' });
  });

  it('should use D1 config when tenant found in D1', async () => {
    const d1WebhookSecret = 'd1-webhook-secret';
    const body = JSON.stringify(buildSentryPayload());
    const signature = await createSignature(d1WebhookSecret, body);

    const startTriageMock = vi.fn(() => Promise.resolve());
    vi.mocked(getTriageProcessor).mockReturnValue({
      startTriage: startTriageMock,
    } as unknown as ReturnType<typeof getTriageProcessor>);

    // Mock D1 lookup to return a config
    vi.mocked(resolveSentryProjectConfig).mockResolvedValue({
      status: 'found',
      config: {
        githubRepo: 'acme/api-service',
        githubBranch: 'develop',
        githubInstallationId: null,
        githubPat: 'ghp_d1_pat',
        webhookSecret: d1WebhookSecret,
        trackerConfig: null,
        trackerToken: null,
      },
    });

    const ctx = buildContext({
      body,
      headers: {
        'Sentry-Hook-Signature': signature,
        'Sentry-Hook-Resource': 'event_alert',
      },
      env: {
        DB: {},
        TENANT_ENCRYPTION_KEY: generateKey(),
      },
    });

    await handleSentryWebhook(ctx as any);

    const call = ctx.json.mock.calls[0];
    expect(call[1]).toBe(200);
    expect((call[0] as Record<string, unknown>).ok).toBe(true);

    // Verify D1 lookup was called
    expect(resolveSentryProjectConfig).toHaveBeenCalledWith(
      expect.objectContaining({ orgSlug: 'acme-inc' })
    );

    // Verify triage was started with D1 config
    expect(startTriageMock).toHaveBeenCalledTimes(1);
    const triageCtx = (startTriageMock.mock.calls as unknown as [Record<string, unknown>][])[0][0];
    expect(triageCtx.repo).toBe('acme/api-service');
    expect(triageCtx.sha).toBe('develop');
    expect(triageCtx.githubToken).toBe('ghp_d1_pat');
  });

  it('should return 401 when D1 tenant exists but signature is invalid', async () => {
    vi.mocked(resolveSentryProjectConfig).mockResolvedValue({
      status: 'found',
      config: {
        githubRepo: 'acme/api',
        githubBranch: 'main',
        githubInstallationId: null,
        githubPat: null,
        webhookSecret: 'correct-d1-secret',
        trackerConfig: null,
        trackerToken: null,
      },
    });

    const body = JSON.stringify(buildSentryPayload());
    const signature = await createSignature('wrong-secret', body);

    const ctx = buildContext({
      body,
      headers: {
        'Sentry-Hook-Signature': signature,
        'Sentry-Hook-Resource': 'event_alert',
      },
      env: {
        DB: {},
        TENANT_ENCRYPTION_KEY: generateKey(),
      },
    });

    await handleSentryWebhook(ctx as any);

    expect(ctx.json).toHaveBeenCalledWith(
      { error: 'Unauthorized', message: 'Invalid signature' },
      401,
    );
  });

  it('should use GitHub App installation token when D1 project has installation_id', async () => {
    const d1WebhookSecret = 'd1-wh-secret';
    const body = JSON.stringify(buildSentryPayload());
    const signature = await createSignature(d1WebhookSecret, body);

    const startTriageMock = vi.fn(() => Promise.resolve());
    vi.mocked(getTriageProcessor).mockReturnValue({
      startTriage: startTriageMock,
    } as unknown as ReturnType<typeof getTriageProcessor>);

    vi.mocked(resolveSentryProjectConfig).mockResolvedValue({
      status: 'found',
      config: {
        githubRepo: 'acme/api',
        githubBranch: 'main',
        githubInstallationId: 42,
        githubPat: 'ghp_fallback_pat',
        webhookSecret: d1WebhookSecret,
        trackerConfig: null,
        trackerToken: null,
      },
    });

    const ctx = buildContext({
      body,
      headers: {
        'Sentry-Hook-Signature': signature,
        'Sentry-Hook-Resource': 'event_alert',
      },
      env: {
        DB: {},
        TENANT_ENCRYPTION_KEY: generateKey(),
        GITHUB_APP_ID: '12345',
        GITHUB_APP_PRIVATE_KEY: 'test-key',
      },
    });

    await handleSentryWebhook(ctx as any);

    // Should have called resolveGitHubToken for the installation
    expect(resolveGitHubToken).toHaveBeenCalledWith(
      expect.objectContaining({ GITHUB_APP_ID: '12345' }),
      42,
    );

    const triageCtx = (startTriageMock.mock.calls as unknown as [Record<string, unknown>][])[0][0];
    expect(triageCtx.githubToken).toBe('gh_installation_42_token');
  });

  it('should fall back to env SENTRY_GITHUB_TOKEN when D1 has no token source', async () => {
    const d1WebhookSecret = 'd1-wh-secret';
    const body = JSON.stringify(buildSentryPayload());
    const signature = await createSignature(d1WebhookSecret, body);

    const startTriageMock = vi.fn(() => Promise.resolve());
    vi.mocked(getTriageProcessor).mockReturnValue({
      startTriage: startTriageMock,
    } as unknown as ReturnType<typeof getTriageProcessor>);

    vi.mocked(resolveSentryProjectConfig).mockResolvedValue({
      status: 'found',
      config: {
        githubRepo: 'acme/api',
        githubBranch: 'main',
        githubInstallationId: null,
        githubPat: null, // No D1 PAT
        webhookSecret: d1WebhookSecret,
        trackerConfig: null,
        trackerToken: null,
      },
    });

    const ctx = buildContext({
      body,
      headers: {
        'Sentry-Hook-Signature': signature,
        'Sentry-Hook-Resource': 'event_alert',
      },
      env: {
        DB: {},
        TENANT_ENCRYPTION_KEY: generateKey(),
        SENTRY_GITHUB_TOKEN: 'ghp_env_fallback',
      },
    });

    await handleSentryWebhook(ctx as any);

    const triageCtx = (startTriageMock.mock.calls as unknown as [Record<string, unknown>][])[0][0];
    expect(triageCtx.githubToken).toBe('ghp_env_fallback');
  });

  it('should return 500 when D1 tenant has no GitHub token at all', async () => {
    const d1WebhookSecret = 'd1-wh-secret';
    const body = JSON.stringify(buildSentryPayload());
    const signature = await createSignature(d1WebhookSecret, body);

    vi.mocked(resolveSentryProjectConfig).mockResolvedValue({
      status: 'found',
      config: {
        githubRepo: 'acme/api',
        githubBranch: 'main',
        githubInstallationId: null,
        githubPat: null,
        webhookSecret: d1WebhookSecret,
        trackerConfig: null,
        trackerToken: null,
      },
    });

    const ctx = buildContext({
      body,
      headers: {
        'Sentry-Hook-Signature': signature,
        'Sentry-Hook-Resource': 'event_alert',
      },
      env: {
        DB: {},
        TENANT_ENCRYPTION_KEY: generateKey(),
        SENTRY_GITHUB_TOKEN: '', // Empty env token
      },
    });

    await handleSentryWebhook(ctx as any);

    expect(ctx.json).toHaveBeenCalledWith(
      { error: 'Server misconfigured', message: 'GitHub token not configured' },
      500,
    );
  });

  it('should fall back to env vars when D1 lookup returns not_found', async () => {
    vi.mocked(resolveSentryProjectConfig).mockResolvedValue({ status: 'not_found' });

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
      env: {
        SENTRY_WEBHOOK_SECRET: 'test-secret',
        SENTRY_REPO_MAP: 'acme-inc:acme/web-app:main',
        SENTRY_GITHUB_TOKEN: 'ghp_env_token',
      },
    });

    await handleSentryWebhook(ctx as any);

    const call = ctx.json.mock.calls[0];
    expect(call[1]).toBe(200);
    expect((call[0] as Record<string, unknown>).ok).toBe(true);

    const triageCtx = (startTriageMock.mock.calls as unknown as [Record<string, unknown>][])[0][0];
    expect(triageCtx.repo).toBe('acme/web-app');
    expect(triageCtx.githubToken).toBe('ghp_env_token');
  });

  it('should ignore non-event_alert resources in D1 path', async () => {
    const d1WebhookSecret = 'd1-wh-secret';
    const body = JSON.stringify(buildSentryPayload());
    const signature = await createSignature(d1WebhookSecret, body);

    vi.mocked(resolveSentryProjectConfig).mockResolvedValue({
      status: 'found',
      config: {
        githubRepo: 'acme/api',
        githubBranch: 'main',
        githubInstallationId: null,
        githubPat: null,
        webhookSecret: d1WebhookSecret,
        trackerConfig: null,
        trackerToken: null,
      },
    });

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

  it('should return 500 and NOT fall back to env vars when D1 config is invalid', async () => {
    // Simulate D1 tenant exists but webhook secret is corrupted
    vi.mocked(resolveSentryProjectConfig).mockResolvedValue({
      status: 'invalid',
      reason: 'Failed to decrypt critical secret "sentry_webhook_secret"',
    });

    const body = JSON.stringify(buildSentryPayload());
    // Sign with the env var secret — this proves the handler does NOT use it
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
        SENTRY_GITHUB_TOKEN: 'ghp_env_token',
      },
    });

    await handleSentryWebhook(ctx as any);

    // Must NOT fall back to env vars — must return 500
    expect(ctx.json).toHaveBeenCalledWith(
      { error: 'Server error', message: 'Tenant configuration invalid' },
      500,
    );
  });

  it('should pass allowPlaintext=true to resolver when ALLOW_PLAINTEXT_SECRETS is "true"', async () => {
    vi.mocked(resolveSentryProjectConfig).mockResolvedValue({ status: 'not_found' });

    const body = JSON.stringify(buildSentryPayload());
    const signature = await createSignature('test-secret', body);

    const ctx = buildContext({
      body,
      headers: {
        'Sentry-Hook-Signature': signature,
        'Sentry-Hook-Resource': 'event_alert',
      },
      env: {
        ALLOW_PLAINTEXT_SECRETS: 'true',
        SENTRY_WEBHOOK_SECRET: 'test-secret',
      },
    });

    await handleSentryWebhook(ctx as any);

    expect(resolveSentryProjectConfig).toHaveBeenCalledWith(
      expect.objectContaining({ allowPlaintext: true })
    );
  });

  it('should pass allowPlaintext=false when ALLOW_PLAINTEXT_SECRETS is unset', async () => {
    vi.mocked(resolveSentryProjectConfig).mockResolvedValue({ status: 'not_found' });

    const body = JSON.stringify(buildSentryPayload());
    const signature = await createSignature('test-secret', body);

    const ctx = buildContext({
      body,
      headers: {
        'Sentry-Hook-Signature': signature,
        'Sentry-Hook-Resource': 'event_alert',
      },
      env: {
        // ALLOW_PLAINTEXT_SECRETS intentionally not set
        SENTRY_WEBHOOK_SECRET: 'test-secret',
      },
    });

    await handleSentryWebhook(ctx as any);

    expect(resolveSentryProjectConfig).toHaveBeenCalledWith(
      expect.objectContaining({ allowPlaintext: false })
    );
  });

  it('should pass allowPlaintext=false when ALLOW_PLAINTEXT_SECRETS is not "true"', async () => {
    vi.mocked(resolveSentryProjectConfig).mockResolvedValue({ status: 'not_found' });

    const body = JSON.stringify(buildSentryPayload());
    const signature = await createSignature('test-secret', body);

    const ctx = buildContext({
      body,
      headers: {
        'Sentry-Hook-Signature': signature,
        'Sentry-Hook-Resource': 'event_alert',
      },
      env: {
        ALLOW_PLAINTEXT_SECRETS: 'false',
        SENTRY_WEBHOOK_SECRET: 'test-secret',
      },
    });

    await handleSentryWebhook(ctx as any);

    expect(resolveSentryProjectConfig).toHaveBeenCalledWith(
      expect.objectContaining({ allowPlaintext: false })
    );
  });

  // ── Tracker integration tests ──────────────────────────────────────────────

  it('should inject valid github tracker config into TriageContext with token', async () => {
    const d1WebhookSecret = 'd1-wh-secret';
    const body = JSON.stringify(buildSentryPayload());
    const signature = await createSignature(d1WebhookSecret, body);

    const startTriageMock = vi.fn(() => Promise.resolve());
    vi.mocked(getTriageProcessor).mockReturnValue({
      startTriage: startTriageMock,
    } as unknown as ReturnType<typeof getTriageProcessor>);

    vi.mocked(resolveSentryProjectConfig).mockResolvedValue({
      status: 'found',
      config: {
        githubRepo: 'acme/api',
        githubBranch: 'main',
        githubInstallationId: null,
        githubPat: 'ghp_test',
        webhookSecret: d1WebhookSecret,
        trackerConfig: { type: 'github', team: 'acme', labels: ['bug', 'sentry'] },
        trackerToken: 'ghp_tracker_token',
      },
    });

    const ctx = buildContext({
      body,
      headers: {
        'Sentry-Hook-Signature': signature,
        'Sentry-Hook-Resource': 'event_alert',
      },
      env: { DB: {}, TENANT_ENCRYPTION_KEY: generateKey() },
    });

    await handleSentryWebhook(ctx as any);

    expect(startTriageMock).toHaveBeenCalledTimes(1);
    const triageCtx = (startTriageMock.mock.calls as unknown as [Record<string, unknown>][])[0][0];
    expect(triageCtx.tracker).toEqual({
      type: 'github',
      team: 'acme',
      labels: ['bug', 'sentry'],
      token: 'ghp_tracker_token',
    });
  });

  it('should inject valid linear tracker config into TriageContext', async () => {
    const d1WebhookSecret = 'd1-wh-secret';
    const body = JSON.stringify(buildSentryPayload());
    const signature = await createSignature(d1WebhookSecret, body);

    const startTriageMock = vi.fn(() => Promise.resolve());
    vi.mocked(getTriageProcessor).mockReturnValue({
      startTriage: startTriageMock,
    } as unknown as ReturnType<typeof getTriageProcessor>);

    vi.mocked(resolveSentryProjectConfig).mockResolvedValue({
      status: 'found',
      config: {
        githubRepo: 'acme/api',
        githubBranch: 'main',
        githubInstallationId: null,
        githubPat: 'ghp_test',
        webhookSecret: d1WebhookSecret,
        trackerConfig: { type: 'linear', team: 'ENG' },
        trackerToken: 'lin_api_token',
      },
    });

    const ctx = buildContext({
      body,
      headers: {
        'Sentry-Hook-Signature': signature,
        'Sentry-Hook-Resource': 'event_alert',
      },
      env: { DB: {}, TENANT_ENCRYPTION_KEY: generateKey() },
    });

    await handleSentryWebhook(ctx as any);

    expect(startTriageMock).toHaveBeenCalledTimes(1);
    const triageCtx = (startTriageMock.mock.calls as unknown as [Record<string, unknown>][])[0][0];
    expect(triageCtx.tracker).toEqual({
      type: 'linear',
      team: 'ENG',
      token: 'lin_api_token',
    });
  });

  it('should skip tracker when config is invalid', async () => {
    const d1WebhookSecret = 'd1-wh-secret';
    const body = JSON.stringify(buildSentryPayload());
    const signature = await createSignature(d1WebhookSecret, body);

    const startTriageMock = vi.fn(() => Promise.resolve());
    vi.mocked(getTriageProcessor).mockReturnValue({
      startTriage: startTriageMock,
    } as unknown as ReturnType<typeof getTriageProcessor>);

    vi.mocked(resolveSentryProjectConfig).mockResolvedValue({
      status: 'found',
      config: {
        githubRepo: 'acme/api',
        githubBranch: 'main',
        githubInstallationId: null,
        githubPat: 'ghp_test',
        webhookSecret: d1WebhookSecret,
        // Invalid: missing 'team', wrong 'type'
        trackerConfig: { type: 'asana', foo: 'bar' },
        trackerToken: 'some_token',
      },
    });

    const ctx = buildContext({
      body,
      headers: {
        'Sentry-Hook-Signature': signature,
        'Sentry-Hook-Resource': 'event_alert',
      },
      env: { DB: {}, TENANT_ENCRYPTION_KEY: generateKey() },
    });

    await handleSentryWebhook(ctx as any);

    expect(startTriageMock).toHaveBeenCalledTimes(1);
    const triageCtx = (startTriageMock.mock.calls as unknown as [Record<string, unknown>][])[0][0];
    // tracker should be undefined when config is invalid
    expect(triageCtx.tracker).toBeUndefined();
  });

  it('should hard-fail with 500 when tracker_config exists but tracker_token is missing', async () => {
    const d1WebhookSecret = 'd1-wh-secret';
    const body = JSON.stringify(buildSentryPayload());
    const signature = await createSignature(d1WebhookSecret, body);

    const startTriageMock = vi.fn(() => Promise.resolve());
    vi.mocked(getTriageProcessor).mockReturnValue({
      startTriage: startTriageMock,
    } as unknown as ReturnType<typeof getTriageProcessor>);

    vi.mocked(resolveSentryProjectConfig).mockResolvedValue({
      status: 'found',
      config: {
        githubRepo: 'acme/api',
        githubBranch: 'main',
        githubInstallationId: null,
        githubPat: 'ghp_test',
        webhookSecret: d1WebhookSecret,
        trackerConfig: { type: 'github', team: 'acme' },
        trackerToken: null, // Token missing/decrypt-failed
      },
    });

    const ctx = buildContext({
      body,
      headers: {
        'Sentry-Hook-Signature': signature,
        'Sentry-Hook-Resource': 'event_alert',
      },
      env: { DB: {}, TENANT_ENCRYPTION_KEY: generateKey() },
    });

    await handleSentryWebhook(ctx as any);

    // Must NOT silently skip tracker — must hard-fail
    expect(startTriageMock).not.toHaveBeenCalled();
    expect(ctx.json).toHaveBeenCalledWith(
      {
        error: 'Server error',
        message: 'Tracker configured but token unavailable — cannot proceed without tracker for this tenant',
      },
      500,
    );
  });
});
