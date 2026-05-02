/**
 * Tenant configuration lookup via D1.
 *
 * Resolves Sentry org/project slugs to project configuration + decrypted secrets.
 * Falls back gracefully when D1 is unavailable or no matching row exists.
 *
 * Security note: decrypted secrets are never logged.
 */

import { decrypt } from './aes-gcm';

// ── D1 row types ────────────────────────────────────────────────────────────

interface TenantRow {
  id: number;
  sentry_org_slug: string;
  name: string;
}

interface ProjectRow {
  id: number;
  tenant_id: number;
  sentry_project_slug: string | null;
  github_repo: string;
  github_branch: string;
  github_installation_id: number | null;
  tracker_config: string | null;
}

interface SecretRow {
  id: number;
  project_id: number;
  key: string;
  value_encrypted: string;
}

// ── Encrypted format detection ───────────────────────────────────────────────

const AES_GCM_IV_LENGTH = 12;

/**
 * Detect whether a stored value is in the AES-GCM encrypted format.
 *
 * Encrypted format (from aes-gcm.ts): `base64(iv):base64(ciphertext)`
 * where the IV is exactly 12 bytes.
 *
 * Returns true only if the value matches this format.
 */
export function isEncryptedFormat(value: string): boolean {
  const colonIdx = value.indexOf(':');
  if (colonIdx === -1) return false;

  const ivB64 = value.slice(0, colonIdx);
  const ctB64 = value.slice(colonIdx + 1);
  if (!ivB64 || !ctB64) return false;

  try {
    const ivBytes = Uint8Array.from(atob(ivB64), (c) => c.charCodeAt(0));
    return ivBytes.length === AES_GCM_IV_LENGTH;
  } catch {
    return false;
  }
}

// ── Resolved config ─────────────────────────────────────────────────────────

export interface ResolvedSentryProjectConfig {
  /** GitHub repo in "owner/repo" format */
  githubRepo: string;
  /** Git branch to target */
  githubBranch: string;
  /** GitHub App installation ID (if configured) */
  githubInstallationId: number | null;
  /** Decrypted GitHub PAT from D1 secrets (null if not stored or decrypt failed) */
  githubPat: string | null;
  /** Decrypted Sentry webhook secret from D1 secrets */
  webhookSecret: string;
  /** Parsed tracker config JSON (null if not configured) */
  trackerConfig: unknown;
  /** Decrypted tracker token from D1 secrets (null if not stored or decrypt failed) */
  trackerToken: string | null;
}

// ── Discriminated resolution result ─────────────────────────────────────────

/**
 * Result of resolving a Sentry project config from D1.
 *
 * - `not_found` — no matching D1 row; env-var fallback is allowed.
 * - `found`     — valid D1 config resolved; use it directly.
 * - `invalid`   — D1 row exists but is unusable (e.g. webhook secret
 *                  missing or failed to decrypt); env-var fallback is NOT allowed.
 */
export type SentryProjectResolution =
  | { status: 'not_found' }
  | { status: 'found'; config: ResolvedSentryProjectConfig }
  | { status: 'invalid'; reason: string };

// ── Minimal D1 type ─────────────────────────────────────────────────────────

// Reuse the D1Database/D1Result types from env.d.ts (global ambient declarations).
// No need to re-declare here — the types are available globally in the project.

// ── Lookup function ─────────────────────────────────────────────────────────

/** Secrets whose decryption failure is fatal for the D1 config. */
const CRITICAL_SECRETS = new Set(['sentry_webhook_secret']);

/**
 * Resolve Sentry project config from D1.
 *
 * Lookup order:
 * 1. Exact match: org slug + project slug
 * 2. Org-level default: org slug + NULL project slug
 *
 * @returns A discriminated result:
 *   - `not_found` if DB unavailable or no matching row (env fallback OK)
 *   - `invalid`   if D1 row exists but webhook secret is missing/corrupt (no fallback)
 *   - `found`     with the resolved config
 */
export async function resolveSentryProjectConfig(params: {
  db: D1Database | undefined;
  encryptionKey: string | undefined;
  orgSlug: string;
  projectSlug?: string;
  /** Allow plaintext (unencrypted) secrets in D1. For staging/dev only. */
  allowPlaintext?: boolean;
}): Promise<SentryProjectResolution> {
  const { db, encryptionKey, orgSlug, projectSlug, allowPlaintext } = params;

  // D1 binding not available → fallback to env vars
  if (!db) {
    return { status: 'not_found' };
  }

  // Encryption key not available → only proceed if plaintext mode is enabled
  if (!encryptionKey && !allowPlaintext) {
    return { status: 'not_found' };
  }

  try {
    // 1. Find tenant by org slug
    const tenant = await db
      .prepare('SELECT id, sentry_org_slug, name FROM tenants WHERE sentry_org_slug = ?')
      .bind(orgSlug)
      .first<TenantRow>();

    if (!tenant) {
      return { status: 'not_found' };
    }

    // 2. Find project: exact org+project match, then org-level default
    let project: ProjectRow | null = null;

    if (projectSlug) {
      project = await db
        .prepare(
          'SELECT id, tenant_id, sentry_project_slug, github_repo, github_branch, github_installation_id, tracker_config ' +
          'FROM projects WHERE tenant_id = ? AND sentry_project_slug = ?'
        )
        .bind(tenant.id, projectSlug)
        .first<ProjectRow>();
    }

    if (!project) {
      project = await db
        .prepare(
          'SELECT id, tenant_id, sentry_project_slug, github_repo, github_branch, github_installation_id, tracker_config ' +
          'FROM projects WHERE tenant_id = ? AND sentry_project_slug IS NULL'
        )
        .bind(tenant.id)
        .first<ProjectRow>();
    }

    if (!project) {
      return { status: 'not_found' };
    }

    // 3. Fetch all secrets for this project
    const secretsResult = await db
      .prepare('SELECT key, value_encrypted FROM secrets WHERE project_id = ?')
      .bind(project.id)
      .all<SecretRow>();

    const secretMap = new Map<string, string>();
    for (const row of (secretsResult.results ?? [])) {
      const rawValue = row.value_encrypted;

      if (isEncryptedFormat(rawValue)) {
        // Value is encrypted — require encryption key to decrypt
        if (!encryptionKey) {
          const msg = `Encrypted secret "${row.key}" found but no TENANT_ENCRYPTION_KEY provided`;
          console.error(msg);
          if (CRITICAL_SECRETS.has(row.key)) {
            return { status: 'invalid', reason: msg };
          }
          // Non-critical encrypted secret without key — skip
          continue;
        }
        try {
          const decrypted = await decrypt(encryptionKey, rawValue);
          secretMap.set(row.key, decrypted);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : 'unknown error';
          console.error(
            `Failed to decrypt secret "${row.key}" for project ${project.id}: ${errMsg}`
          );
          if (CRITICAL_SECRETS.has(row.key)) {
            return { status: 'invalid', reason: `Failed to decrypt critical secret "${row.key}"` };
          }
          // Non-critical secret — continue without it.
        }
      } else {
        // Value is plaintext
        if (allowPlaintext) {
          console.warn(
            `Plaintext secret "${row.key}" used for project ${project.id} — encrypt before production`
          );
          secretMap.set(row.key, rawValue);
        } else {
          // Plaintext not allowed
          if (CRITICAL_SECRETS.has(row.key)) {
            return { status: 'invalid', reason: `Secret "${row.key}" is plaintext but encryption is required` };
          }
          // Non-critical plaintext secret — skip with warning
          console.warn(
            `Skipping plaintext secret "${row.key}" for project ${project.id} — encryption required`
          );
        }
      }
    }

    // 4. Build resolved config
    const webhookSecret = secretMap.get('sentry_webhook_secret');
    if (!webhookSecret) {
      // Webhook secret is required for D1-managed tenants
      return { status: 'invalid', reason: 'sentry_webhook_secret not found in D1 secrets' };
    }

    let trackerConfig: unknown = null;
    if (project.tracker_config) {
      try {
        trackerConfig = JSON.parse(project.tracker_config);
      } catch {
        console.error(`Invalid tracker_config JSON for project ${project.id}`);
      }
    }

    return {
      status: 'found',
      config: {
        githubRepo: project.github_repo,
        githubBranch: project.github_branch,
        githubInstallationId: project.github_installation_id,
        githubPat: secretMap.get('github_pat') ?? null,
        webhookSecret,
        trackerConfig,
        trackerToken: secretMap.get('tracker_token') ?? null,
      },
    };
  } catch (err) {
    // D1 query error — log and fall back to env vars
    console.error(
      `D1 lookup failed for org "${orgSlug}": ${
        err instanceof Error ? err.message : 'unknown error'
      }`
    );
    return { status: 'not_found' };
  }
}
