-- Review state per PR: what was last reviewed and whether that review covered
-- the whole PR diff. Enables incremental re-reviews: a retrigger (push to an
-- open PR) only needs the commits since the last fully-reviewed SHA instead of
-- the whole accumulated diff.
--
-- full_coverage semantics (honesty, plan 002-U4 lineage):
--   1 → the recorded SHA had a review whose coverage manifest was scopeComplete.
--       Incremental diffs from this SHA inherit that full verdict legitimately.
--   0 → the last review was partial (budget/focus/cap). A later push must fall
--       back to a full review; incremental from a partial run would present an
--       incomplete verdict as complete.
-- Base ref is stored because a retarget invalidates what the diff means: an
-- incremental review only runs when the base matches the recorded one.

CREATE TABLE IF NOT EXISTS review_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  base_ref TEXT NOT NULL DEFAULT '',
  last_reviewed_sha TEXT NOT NULL,
  full_coverage INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(owner, repo, pr_number)
);

-- No explicit index needed: SQLite creates an implicit index for the UNIQUE
-- constraint on (owner, repo, pr_number).
