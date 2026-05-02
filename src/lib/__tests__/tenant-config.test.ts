/**
 * Tests for tenant config D1 lookup module.
 */

import { describe, it, expect, vi } from 'vitest';
import { encrypt, generateKey } from '../aes-gcm';
import { resolveSentryProjectConfig, isEncryptedFormat } from '../tenant-config';

// ── Mock D1 ─────────────────────────────────────────────────────────────────

function createMockDB(data: {
  tenants?: Array<{ id: number; sentry_org_slug: string; name: string }>;
  projects?: Array<{
    id: number;
    tenant_id: number;
    sentry_project_slug: string | null;
    github_repo: string;
    github_branch: string;
    github_installation_id: number | null;
    tracker_config: string | null;
  }>;
  secrets?: Array<{ project_id: number; key: string; value_encrypted: string }>;
}) {
  return {
    prepare: vi.fn((sql: string) => {
      const stmt = {
        bind: vi.fn(function (this: any, ..._args: unknown[]) {
          return this;
        }),
        first: vi.fn(async () => {
          // Detect which query this is based on SQL
          if (sql.includes('FROM tenants')) {
            // Tenant lookup
            return data.tenants?.[0] ?? null;
          }
          if (sql.includes('sentry_project_slug = ?')) {
            // Specific project lookup
            return data.projects?.find(
              (p) => p.sentry_project_slug !== null
            ) ?? null;
          }
          if (sql.includes('sentry_project_slug IS NULL')) {
            // Org-level default project
            return data.projects?.find(
              (p) => p.sentry_project_slug === null
            ) ?? null;
          }
          return null;
        }),
        all: vi.fn(async () => {
          if (sql.includes('FROM secrets')) {
            return { results: data.secrets ?? [] };
          }
          return { results: [] };
        }),
      };
      return stmt;
    }),
  } as any;
}

describe('resolveSentryProjectConfig', () => {
  const encryptionKey = generateKey();

  it('should return not_found when DB is undefined', async () => {
    const result = await resolveSentryProjectConfig({
      db: undefined,
      encryptionKey,
      orgSlug: 'acme',
    });
    expect(result).toEqual({ status: 'not_found' });
  });

  it('should return not_found when encryptionKey is undefined and plaintext not allowed', async () => {
    const result = await resolveSentryProjectConfig({
      db: createMockDB({}),
      encryptionKey: undefined,
      orgSlug: 'acme',
      allowPlaintext: false,
    });
    expect(result).toEqual({ status: 'not_found' });
  });

  it('should return not_found when tenant not found', async () => {
    const db = createMockDB({ tenants: [] });
    const result = await resolveSentryProjectConfig({
      db,
      encryptionKey,
      orgSlug: 'unknown-org',
    });
    expect(result).toEqual({ status: 'not_found' });
  });

  it('should resolve org-level default project when no project slug given', async () => {
    const webhookSecretEncrypted = await encrypt(encryptionKey, 'webhook-secret-123');

    const db = createMockDB({
      tenants: [{ id: 1, sentry_org_slug: 'acme', name: 'Acme Corp' }],
      projects: [{
        id: 10,
        tenant_id: 1,
        sentry_project_slug: null,
        github_repo: 'acme/web-app',
        github_branch: 'main',
        github_installation_id: null,
        tracker_config: null,
      }],
      secrets: [
        { project_id: 10, key: 'sentry_webhook_secret', value_encrypted: webhookSecretEncrypted },
      ],
    });

    const result = await resolveSentryProjectConfig({
      db,
      encryptionKey,
      orgSlug: 'acme',
    });

    expect(result).toEqual({ status: 'found', config: expect.objectContaining({
      githubRepo: 'acme/web-app',
      githubBranch: 'main',
      webhookSecret: 'webhook-secret-123',
      githubInstallationId: null,
      githubPat: null,
    })});
  });

  it('should prefer specific project match over org-level default', async () => {
    const webhookSecretEncrypted = await encrypt(encryptionKey, 'webhook-secret-api');
    const githubPatEncrypted = await encrypt(encryptionKey, 'ghp_abc123');

    const db = createMockDB({
      tenants: [{ id: 1, sentry_org_slug: 'acme', name: 'Acme Corp' }],
      projects: [{
        id: 20,
        tenant_id: 1,
        sentry_project_slug: 'api',
        github_repo: 'acme/api-service',
        github_branch: 'develop',
        github_installation_id: 99999,
        tracker_config: '{"type":"linear","team":"ENG"}',
      }],
      secrets: [
        { project_id: 20, key: 'sentry_webhook_secret', value_encrypted: webhookSecretEncrypted },
        { project_id: 20, key: 'github_pat', value_encrypted: githubPatEncrypted },
      ],
    });

    const result = await resolveSentryProjectConfig({
      db,
      encryptionKey,
      orgSlug: 'acme',
      projectSlug: 'api',
    });

    expect(result).toEqual({ status: 'found', config: expect.objectContaining({
      githubRepo: 'acme/api-service',
      githubBranch: 'develop',
      githubInstallationId: 99999,
      githubPat: 'ghp_abc123',
      webhookSecret: 'webhook-secret-api',
      trackerConfig: { type: 'linear', team: 'ENG' },
    })});
  });

  it('should return invalid when webhook secret is missing from secrets', async () => {
    const db = createMockDB({
      tenants: [{ id: 1, sentry_org_slug: 'acme', name: 'Acme Corp' }],
      projects: [{
        id: 10,
        tenant_id: 1,
        sentry_project_slug: null,
        github_repo: 'acme/web-app',
        github_branch: 'main',
        github_installation_id: null,
        tracker_config: null,
      }],
      secrets: [], // No secrets at all
    });

    const result = await resolveSentryProjectConfig({
      db,
      encryptionKey,
      orgSlug: 'acme',
    });

    expect(result).toEqual({ status: 'invalid', reason: expect.stringContaining('sentry_webhook_secret') });
  });

  it('should return invalid when webhook secret decryption fails (wrong key)', async () => {
    const otherKey = generateKey();
    const encryptedWithOtherKey = await encrypt(otherKey, 'some-secret');

    const db = createMockDB({
      tenants: [{ id: 1, sentry_org_slug: 'acme', name: 'Acme Corp' }],
      projects: [{
        id: 10,
        tenant_id: 1,
        sentry_project_slug: null,
        github_repo: 'acme/web-app',
        github_branch: 'main',
        github_installation_id: null,
        tracker_config: null,
      }],
      secrets: [
        { project_id: 10, key: 'sentry_webhook_secret', value_encrypted: encryptedWithOtherKey },
      ],
    });

    // Use a different key than the one used for encryption
    const result = await resolveSentryProjectConfig({
      db,
      encryptionKey,
      orgSlug: 'acme',
    });

    expect(result).toEqual({ status: 'invalid', reason: expect.stringContaining('sentry_webhook_secret') });
  });

  it('should return found when webhook secret decrypts but github_pat fails', async () => {
    const otherKey = generateKey();
    const webhookSecretEncrypted = await encrypt(encryptionKey, 'webhook-secret-ok');
    const githubPatEncryptedWrongKey = await encrypt(otherKey, 'ghp_wont_decrypt');

    const db = createMockDB({
      tenants: [{ id: 1, sentry_org_slug: 'acme', name: 'Acme Corp' }],
      projects: [{
        id: 10,
        tenant_id: 1,
        sentry_project_slug: null,
        github_repo: 'acme/web-app',
        github_branch: 'main',
        github_installation_id: null,
        tracker_config: null,
      }],
      secrets: [
        { project_id: 10, key: 'sentry_webhook_secret', value_encrypted: webhookSecretEncrypted },
        { project_id: 10, key: 'github_pat', value_encrypted: githubPatEncryptedWrongKey },
      ],
    });

    const result = await resolveSentryProjectConfig({
      db,
      encryptionKey,
      orgSlug: 'acme',
    });

    // Should succeed with webhookSecret but no githubPat
    expect(result).toEqual({ status: 'found', config: expect.objectContaining({
      webhookSecret: 'webhook-secret-ok',
      githubPat: null,
    })});
  });

  it('should return found when webhook secret decrypts but tracker_token fails', async () => {
    const otherKey = generateKey();
    const webhookSecretEncrypted = await encrypt(encryptionKey, 'webhook-secret-ok');
    const trackerTokenEncryptedWrongKey = await encrypt(otherKey, 'tracker-wont-decrypt');

    const db = createMockDB({
      tenants: [{ id: 1, sentry_org_slug: 'acme', name: 'Acme Corp' }],
      projects: [{
        id: 10,
        tenant_id: 1,
        sentry_project_slug: null,
        github_repo: 'acme/web-app',
        github_branch: 'main',
        github_installation_id: null,
        tracker_config: null,
      }],
      secrets: [
        { project_id: 10, key: 'sentry_webhook_secret', value_encrypted: webhookSecretEncrypted },
        { project_id: 10, key: 'tracker_token', value_encrypted: trackerTokenEncryptedWrongKey },
      ],
    });

    const result = await resolveSentryProjectConfig({
      db,
      encryptionKey,
      orgSlug: 'acme',
    });

    expect(result).toEqual({ status: 'found', config: expect.objectContaining({
      webhookSecret: 'webhook-secret-ok',
      trackerToken: null,
    })});
  });

  it('should return not_found on D1 query error', async () => {
    const db = {
      prepare: vi.fn(() => {
        throw new Error('D1 connection error');
      }),
    } as any;

    const result = await resolveSentryProjectConfig({
      db,
      encryptionKey,
      orgSlug: 'acme',
    });

    expect(result).toEqual({ status: 'not_found' });
  });

  it('should handle project without tracker config', async () => {
    const webhookSecretEncrypted = await encrypt(encryptionKey, 'wh-secret');

    const db = createMockDB({
      tenants: [{ id: 1, sentry_org_slug: 'acme', name: 'Acme Corp' }],
      projects: [{
        id: 10,
        tenant_id: 1,
        sentry_project_slug: null,
        github_repo: 'acme/web-app',
        github_branch: 'main',
        github_installation_id: null,
        tracker_config: null,
      }],
      secrets: [
        { project_id: 10, key: 'sentry_webhook_secret', value_encrypted: webhookSecretEncrypted },
      ],
    });

    const result = await resolveSentryProjectConfig({
      db,
      encryptionKey,
      orgSlug: 'acme',
    });

    expect(result).toEqual({ status: 'found', config: expect.objectContaining({
      trackerConfig: null,
      trackerToken: null,
    })});
  });

  // ── Plaintext secrets mode ────────────────────────────────────────────────

  it('should resolve plaintext webhook secret when allowPlaintext=true and no encryption key', async () => {
    const db = createMockDB({
      tenants: [{ id: 1, sentry_org_slug: 'acme', name: 'Acme Corp' }],
      projects: [{
        id: 10,
        tenant_id: 1,
        sentry_project_slug: null,
        github_repo: 'acme/web-app',
        github_branch: 'main',
        github_installation_id: null,
        tracker_config: null,
      }],
      secrets: [
        { project_id: 10, key: 'sentry_webhook_secret', value_encrypted: 'plaintext-webhook-secret' },
      ],
    });

    const result = await resolveSentryProjectConfig({
      db,
      encryptionKey: undefined,
      orgSlug: 'acme',
      allowPlaintext: true,
    });

    expect(result).toEqual({ status: 'found', config: expect.objectContaining({
      webhookSecret: 'plaintext-webhook-secret',
      githubRepo: 'acme/web-app',
    })});
  });

  it('should return invalid for plaintext webhook secret when allowPlaintext=false', async () => {
    const db = createMockDB({
      tenants: [{ id: 1, sentry_org_slug: 'acme', name: 'Acme Corp' }],
      projects: [{
        id: 10,
        tenant_id: 1,
        sentry_project_slug: null,
        github_repo: 'acme/web-app',
        github_branch: 'main',
        github_installation_id: null,
        tracker_config: null,
      }],
      secrets: [
        { project_id: 10, key: 'sentry_webhook_secret', value_encrypted: 'plaintext-webhook-secret' },
      ],
    });

    const result = await resolveSentryProjectConfig({
      db,
      encryptionKey,
      orgSlug: 'acme',
      allowPlaintext: false,
    });

    expect(result.status).toBe('invalid');
    expect((result as any).reason).toContain('sentry_webhook_secret');
  });

  it('should still decrypt encrypted secrets when encryption key is provided', async () => {
    const webhookSecretEncrypted = await encrypt(encryptionKey, 'webhook-secret-encrypted');

    const db = createMockDB({
      tenants: [{ id: 1, sentry_org_slug: 'acme', name: 'Acme Corp' }],
      projects: [{
        id: 10,
        tenant_id: 1,
        sentry_project_slug: null,
        github_repo: 'acme/web-app',
        github_branch: 'main',
        github_installation_id: null,
        tracker_config: null,
      }],
      secrets: [
        { project_id: 10, key: 'sentry_webhook_secret', value_encrypted: webhookSecretEncrypted },
      ],
    });

    const result = await resolveSentryProjectConfig({
      db,
      encryptionKey,
      orgSlug: 'acme',
      allowPlaintext: true,
    });

    expect(result).toEqual({ status: 'found', config: expect.objectContaining({
      webhookSecret: 'webhook-secret-encrypted',
    })});
  });

  it('should resolve plaintext github_pat when allowPlaintext=true', async () => {
    const db = createMockDB({
      tenants: [{ id: 1, sentry_org_slug: 'acme', name: 'Acme Corp' }],
      projects: [{
        id: 10,
        tenant_id: 1,
        sentry_project_slug: null,
        github_repo: 'acme/web-app',
        github_branch: 'main',
        github_installation_id: null,
        tracker_config: null,
      }],
      secrets: [
        { project_id: 10, key: 'sentry_webhook_secret', value_encrypted: 'plain-wh-secret' },
        { project_id: 10, key: 'github_pat', value_encrypted: 'ghp_plaintext_token' },
      ],
    });

    const result = await resolveSentryProjectConfig({
      db,
      encryptionKey: undefined,
      orgSlug: 'acme',
      allowPlaintext: true,
    });

    expect(result).toEqual({ status: 'found', config: expect.objectContaining({
      webhookSecret: 'plain-wh-secret',
      githubPat: 'ghp_plaintext_token',
    })});
  });

  it('should skip plaintext non-critical secret without invalidating config when allowPlaintext=false', async () => {
    const webhookSecretEncrypted = await encrypt(encryptionKey, 'encrypted-wh-secret');

    const db = createMockDB({
      tenants: [{ id: 1, sentry_org_slug: 'acme', name: 'Acme Corp' }],
      projects: [{
        id: 10,
        tenant_id: 1,
        sentry_project_slug: null,
        github_repo: 'acme/web-app',
        github_branch: 'main',
        github_installation_id: null,
        tracker_config: null,
      }],
      secrets: [
        { project_id: 10, key: 'sentry_webhook_secret', value_encrypted: webhookSecretEncrypted },
        { project_id: 10, key: 'github_pat', value_encrypted: 'plaintext-github-pat' },
      ],
    });

    const result = await resolveSentryProjectConfig({
      db,
      encryptionKey,
      orgSlug: 'acme',
      allowPlaintext: false,
    });

    // Webhook secret is valid (encrypted), github_pat is skipped (plaintext not allowed)
    expect(result).toEqual({ status: 'found', config: expect.objectContaining({
      webhookSecret: 'encrypted-wh-secret',
      githubPat: null,
    })});
  });

  it('should return invalid when encrypted secret found but no encryption key provided', async () => {
    const otherKey = generateKey();
    const encrypted = await encrypt(otherKey, 'some-secret');

    const db = createMockDB({
      tenants: [{ id: 1, sentry_org_slug: 'acme', name: 'Acme Corp' }],
      projects: [{
        id: 10,
        tenant_id: 1,
        sentry_project_slug: null,
        github_repo: 'acme/web-app',
        github_branch: 'main',
        github_installation_id: null,
        tracker_config: null,
      }],
      secrets: [
        { project_id: 10, key: 'sentry_webhook_secret', value_encrypted: encrypted },
      ],
    });

    const result = await resolveSentryProjectConfig({
      db,
      encryptionKey: undefined,
      orgSlug: 'acme',
      allowPlaintext: true,
    });

    // Encrypted value detected but no key → invalid
    expect(result.status).toBe('invalid');
    expect((result as any).reason).toContain('sentry_webhook_secret');
  });

  it('should skip non-critical encrypted secret when no encryption key and allowPlaintext=true', async () => {
    const otherKey = generateKey();
    const encryptedPat = await encrypt(otherKey, 'ghp_encrypted');

    const db = createMockDB({
      tenants: [{ id: 1, sentry_org_slug: 'acme', name: 'Acme Corp' }],
      projects: [{
        id: 10,
        tenant_id: 1,
        sentry_project_slug: null,
        github_repo: 'acme/web-app',
        github_branch: 'main',
        github_installation_id: null,
        tracker_config: null,
      }],
      secrets: [
        { project_id: 10, key: 'sentry_webhook_secret', value_encrypted: 'plaintext-wh' },
        { project_id: 10, key: 'github_pat', value_encrypted: encryptedPat },
      ],
    });

    const result = await resolveSentryProjectConfig({
      db,
      encryptionKey: undefined,
      orgSlug: 'acme',
      allowPlaintext: true,
    });

    // Webhook secret (plaintext) works; github_pat (encrypted, no key) is skipped
    expect(result).toEqual({ status: 'found', config: expect.objectContaining({
      webhookSecret: 'plaintext-wh',
      githubPat: null,
    })});
  });
});

// ── isEncryptedFormat ──────────────────────────────────────────────────────────

describe('isEncryptedFormat', () => {
  it('should return true for valid AES-GCM encrypted values', async () => {
    const key = generateKey();
    const encrypted = await encrypt(key, 'hello');
    expect(isEncryptedFormat(encrypted)).toBe(true);
  });

  it('should return false for plaintext strings', () => {
    expect(isEncryptedFormat('my-plaintext-secret')).toBe(false);
    expect(isEncryptedFormat('ghp_abc123')).toBe(false);
    expect(isEncryptedFormat('')).toBe(false);
  });

  it('should return false for strings with colon but non-base64 IV', () => {
    expect(isEncryptedFormat('notbase64:somevalue')).toBe(false);
  });

  it('should return false for strings with colon but wrong IV length', () => {
    // 8-byte IV encoded as base64 (not 12 bytes)
    const shortIv = btoa(String.fromCharCode(...new Uint8Array(8)));
    expect(isEncryptedFormat(`${shortIv}:somedata`)).toBe(false);
  });

  it('should return false for empty parts', () => {
    expect(isEncryptedFormat(':')).toBe(false);
    expect(isEncryptedFormat('abc:')).toBe(false);
    expect(isEncryptedFormat(':abc')).toBe(false);
  });
});
