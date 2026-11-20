-- GitHub does not send webhook events for comment reactions. Keep a fair,
-- paginated polling cursor for each published DonMerge review comment.
CREATE TABLE reaction_poll_targets (
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  comment_id INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  next_page INTEGER NOT NULL DEFAULT 1 CHECK (next_page >= 1),
  last_attempted_at TEXT,
  PRIMARY KEY (owner, repo, comment_id)
);
CREATE INDEX idx_reaction_poll_due ON reaction_poll_targets(last_attempted_at, owner, repo, comment_id);

-- Backfill previously published findings, including comments on closed PRs.
INSERT OR IGNORE INTO reaction_poll_targets (owner, repo, pr_number, comment_id, fingerprint, created_at)
SELECT owner, repo, pr_number, github_comment_id, fingerprint, created_at
FROM review_outcomes
WHERE github_comment_id IS NOT NULL AND reviewer_type = 'ai'
ORDER BY created_at ASC, id ASC;

CREATE TRIGGER reaction_poll_target_after_outcome
AFTER INSERT ON review_outcomes
WHEN NEW.github_comment_id IS NOT NULL AND NEW.reviewer_type = 'ai'
BEGIN
  INSERT OR IGNORE INTO reaction_poll_targets (owner, repo, pr_number, comment_id, fingerprint, created_at)
  VALUES (NEW.owner, NEW.repo, NEW.pr_number, NEW.github_comment_id, NEW.fingerprint, NEW.created_at);
END;
