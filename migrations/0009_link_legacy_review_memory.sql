-- Keep legacy rules visible and revocable without losing their original rows.
-- A separate link table supports duplicate legacy rows mapping to one rule.
CREATE TABLE IF NOT EXISTS legacy_learning_links (
  legacy_learning_id INTEGER PRIMARY KEY REFERENCES learnings(id),
  scoped_learning_id INTEGER NOT NULL REFERENCES scoped_learnings(id)
);

-- 0008 already imported historical ignore rules. Respect their current scope
-- and state, including any later maintainer revocation or scope change.
INSERT OR IGNORE INTO scoped_learnings
  (owner, repo, learning_text, category, scope_type, scope_path, state,
   confidence, sample_size, source_pr, source_user)
SELECT l.owner, l.repo, l.learning_text, l.category, 'repo', '',
       CASE WHEN l.review_state IN ('active', 'pending', 'revoked') THEN l.review_state ELSE 'pending' END,
       l.confidence, l.sample_size, 0, 'historical'
FROM learnings l
WHERE l.category IN ('ignore', 'focus', 'style')
  AND NOT EXISTS (
    SELECT 1 FROM scoped_learnings s
    WHERE s.owner = l.owner AND s.repo = l.repo AND s.category = l.category
      AND s.learning_text = l.learning_text
  );

INSERT OR IGNORE INTO legacy_learning_links (legacy_learning_id, scoped_learning_id)
SELECT l.id, (
  SELECT s.id FROM scoped_learnings s
  WHERE s.owner = l.owner AND s.repo = l.repo AND s.category = l.category
    AND s.learning_text = l.learning_text
  ORDER BY (s.source_pr = 0 AND s.source_user = 'historical') DESC, s.id ASC
  LIMIT 1
)
FROM learnings l
WHERE l.category IN ('ignore', 'focus', 'style')
  AND EXISTS (
    SELECT 1 FROM scoped_learnings s
    WHERE s.owner = l.owner AND s.repo = l.repo AND s.category = l.category
      AND s.learning_text = l.learning_text
  );
