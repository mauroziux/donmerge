-- Phase 1: Multi-tenant credential store tables.
-- Run: wrangler d1 execute <DB_NAME> --file=migrations/0001_create_tenants_projects_secrets.sql

-- One row per Sentry organization (tenant).
CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sentry_org_slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per Sentry project (or org-level default when sentry_project_slug is NULL).
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sentry_project_slug TEXT,
  github_repo TEXT NOT NULL,
  github_branch TEXT NOT NULL DEFAULT 'main',
  github_installation_id INTEGER,
  tracker_config TEXT,  -- JSON blob: { type, team, labels?, jira_base_url? }. Validated by validateTrackerConfig().
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, sentry_project_slug)
);

-- Encrypted key-value secrets per project.
-- Stored as base64(iv):base64(ciphertext) using AES-256-GCM.
-- Known keys: sentry_webhook_secret, github_pat, tracker_token
CREATE TABLE IF NOT EXISTS secrets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value_encrypted TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, key)
);

-- Index for fast tenant lookup by org slug.
CREATE INDEX IF NOT EXISTS idx_tenants_org_slug ON tenants(sentry_org_slug);

-- Index for fast project lookup by tenant + project slug.
CREATE INDEX IF NOT EXISTS idx_projects_tenant_project ON projects(tenant_id, sentry_project_slug);

-- Index for fast secret lookup by project + key.
CREATE INDEX IF NOT EXISTS idx_secrets_project_key ON secrets(project_id, key);
