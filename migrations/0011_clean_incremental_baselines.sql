-- Existing full-coverage rows may come from reviews with blocking findings.
-- They must be re-reviewed before they can serve as a clean incremental base.
CREATE TABLE IF NOT EXISTS review_incremental_baselines (
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  base_ref TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  PRIMARY KEY(owner, repo, pr_number)
);

-- Older Worker versions do not know about clean baselines. Any write through
-- their review_state SQL invalidates the marker, including a same-SHA write.
-- Current Workers recreate it in the same transaction only after a clean run.
CREATE TRIGGER IF NOT EXISTS invalidate_incremental_baseline_on_insert
AFTER INSERT ON review_state BEGIN
  DELETE FROM review_incremental_baselines
  WHERE owner = NEW.owner AND repo = NEW.repo AND pr_number = NEW.pr_number;
END;

CREATE TRIGGER IF NOT EXISTS invalidate_incremental_baseline_on_update
AFTER UPDATE ON review_state BEGIN
  DELETE FROM review_incremental_baselines
  WHERE (owner = OLD.owner AND repo = OLD.repo AND pr_number = OLD.pr_number)
     OR (owner = NEW.owner AND repo = NEW.repo AND pr_number = NEW.pr_number);
END;

CREATE TRIGGER IF NOT EXISTS invalidate_incremental_baseline_on_delete
AFTER DELETE ON review_state BEGIN
  DELETE FROM review_incremental_baselines
  WHERE owner = OLD.owner AND repo = OLD.repo AND pr_number = OLD.pr_number;
END;
