-- Make historical exceptions visible for maintainer review without applying them.
INSERT OR IGNORE INTO scoped_learnings
  (owner, repo, learning_text, category, scope_type, scope_path, state,
   confidence, sample_size, source_pr, source_user)
SELECT owner, repo, learning_text, category, 'repo', '', 'pending',
       confidence, sample_size, 0, 'historical'
FROM learnings
WHERE category = 'ignore';
