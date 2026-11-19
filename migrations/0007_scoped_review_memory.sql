-- Scoped learnings are stored separately so existing feedback history is retained.
CREATE TABLE scoped_learnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  learning_text TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('ignore', 'focus', 'style')),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('file', 'directory', 'repo')),
  scope_path TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'revoked')),
  confidence REAL NOT NULL DEFAULT 60,
  sample_size INTEGER NOT NULL DEFAULT 1,
  source_pr INTEGER NOT NULL,
  source_comment_id INTEGER,
  source_user TEXT NOT NULL,
  confirmed_by TEXT,
  revoked_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(owner, repo, category, scope_type, scope_path, learning_text)
);
CREATE INDEX idx_scoped_learnings_repo ON scoped_learnings(owner, repo, state);
CREATE TABLE scoped_learning_events (
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(owner, repo, pr_number, source_type, source_id)
);
CREATE TABLE review_learning_snapshots (
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  run_id TEXT NOT NULL,
  learning_id INTEGER NOT NULL,
  learning_text TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_path TEXT NOT NULL,
  cited INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(owner, repo, pr_number, run_id, learning_id)
);

-- Historical ignore rules require confirmation before they may suppress findings.
ALTER TABLE learnings ADD COLUMN review_state TEXT NOT NULL DEFAULT 'active';
UPDATE learnings SET review_state = 'pending' WHERE category = 'ignore';
