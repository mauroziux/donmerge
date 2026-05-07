-- PR deduplication table for auto-fix.
-- Prevents creating duplicate auto-fix PRs for the same underlying error across different
-- Sentry issue IDs. The UNIQUE constraint on (repo, safe_title) enforces one PR per unique
-- error signature per repo. Sentry creates different issue IDs for the same error on
-- different routes, so we dedup at the PR level using the sanitized error title.

CREATE TABLE IF NOT EXISTS pr_dedup (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  safe_title TEXT NOT NULL,
  pr_url TEXT NOT NULL DEFAULT '',
  pr_number TEXT NOT NULL DEFAULT '',
  branch_name TEXT NOT NULL DEFAULT '',
  source_urls TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(repo, safe_title)
);

-- No explicit index needed: SQLite creates an implicit index for the UNIQUE
-- constraint on (repo, safe_title).
