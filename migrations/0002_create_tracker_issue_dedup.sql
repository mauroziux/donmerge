-- Tracker issue deduplication table.
-- Prevents creating duplicate tracker tickets for the same Sentry issue.
-- The UNIQUE constraint on (sentry_issue_id, tracker_type, tracker_team) enforces one tracker
-- issue per (Sentry issue, tracker, team) combination.
-- sentry_issue_id is issue-level (same for all events in an issue), unlike web_url which is
-- event-specific.

CREATE TABLE IF NOT EXISTS tracker_issue_dedup (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sentry_issue_id TEXT NOT NULL,
  tracker_type TEXT NOT NULL,
  tracker_team TEXT NOT NULL,
  tracker_issue_id TEXT NOT NULL,
  tracker_issue_url TEXT NOT NULL,
  tracker_issue_key TEXT NOT NULL,
  source_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(sentry_issue_id, tracker_type, tracker_team)
);

-- No explicit index needed: SQLite creates an implicit index for the UNIQUE
-- constraint on (sentry_issue_id, tracker_type, tracker_team).
