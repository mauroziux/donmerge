-- Memory system tables (Phase 1 & 2).
-- Tracks review outcomes, feedback, learnings, and pattern weights
-- for DonMerge's adaptive code review memory.

-- Review outcomes: one row per finding per PR review.
-- Records what was found and what happened to it (dismissed, accepted, fixed, etc.)
CREATE TABLE IF NOT EXISTS review_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  logical_key TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  line INTEGER NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'suggestion', 'low')),
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('new', 'open', 'fixed', 'reintroduced', 'dismissed')),
  outcome TEXT NOT NULL CHECK (outcome IN ('new', 'dismissed', 'accepted', 'fixed', 'ignored', 'overridden')),
  outcome_source TEXT CHECK (outcome_source IN ('reaction', 'reply', 'command', 'implicit')),
  previous_severity TEXT CHECK (previous_severity IN ('critical', 'suggestion', 'low')),
  new_severity TEXT CHECK (new_severity IN ('critical', 'suggestion', 'low')),
  github_comment_id INTEGER,
  reviewer_type TEXT NOT NULL CHECK (reviewer_type IN ('human', 'ai')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index for fast lookup by repo + fingerprint (feedback correlation).
CREATE INDEX IF NOT EXISTS idx_review_outcomes_fingerprint
  ON review_outcomes(owner, repo, fingerprint);

-- Index for fast lookup by repo + rule_id (pattern weight calculation).
CREATE INDEX IF NOT EXISTS idx_review_outcomes_rule
  ON review_outcomes(owner, repo, rule_id);

-- Feedback: one row per user action (reaction, comment, command).
-- Source of truth for learning what users dismiss, accept, or override.
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  feedback_type TEXT NOT NULL CHECK (feedback_type IN ('dismiss', 'accept', 'override', 'preference')),
  feedback_source TEXT NOT NULL CHECK (feedback_source IN ('reaction', 'reply', 'command', 'api')),
  feedback_text TEXT,
  previous_severity TEXT CHECK (previous_severity IN ('critical', 'suggestion', 'low')),
  new_severity TEXT CHECK (new_severity IN ('critical', 'suggestion', 'low')),
  github_user TEXT NOT NULL,
  github_comment_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index for fast lookup by fingerprint (feedback → outcome correlation).
CREATE INDEX IF NOT EXISTS idx_feedback_fingerprint
  ON feedback(owner, repo, fingerprint);

-- Learnings: aggregated insights derived from feedback.
-- Category determines how the learning is applied (ignore rules, focus areas, style preferences).
CREATE TABLE IF NOT EXISTS learnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  learning_text TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('feedback', 'inferred', 'manual')),
  category TEXT NOT NULL CHECK (category IN ('scope', 'focus', 'ignore', 'style', 'severity')),
  confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 100),
  sample_size INTEGER NOT NULL DEFAULT 1,
  last_applied_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Index for fast lookup by repo + category (memory context building).
CREATE INDEX IF NOT EXISTS idx_learnings_repo_category
  ON learnings(owner, repo, category);

-- Pattern weights: per-rule confidence scores.
-- Updated after each feedback cycle to reflect how much a rule should be trusted.
CREATE TABLE IF NOT EXISTS pattern_weights (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  pattern_type TEXT NOT NULL CHECK (pattern_type IN ('style', 'advisory', 'critical', 'vulnerability')),
  confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 100),
  total_findings INTEGER NOT NULL DEFAULT 0,
  dismissed_count INTEGER NOT NULL DEFAULT 0,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  fixed_count INTEGER NOT NULL DEFAULT 0,
  ignored_count INTEGER NOT NULL DEFAULT 0,
  last_calculation_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(owner, repo, rule_id)
);

-- Index for fast lookup by repo (memory context building).
CREATE INDEX IF NOT EXISTS idx_pattern_weights_repo
  ON pattern_weights(owner, repo);
