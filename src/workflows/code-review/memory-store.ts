import type { ReviewOutcome, Feedback, Learning, PatternWeight, MemoryContext } from './types';

// ── Review Outcomes ──────────────────────────────────────────────────────────

export async function recordReviewOutcome(
  db: D1Database,
  outcome: Omit<ReviewOutcome, 'id' | 'created_at' | 'updated_at'>
): Promise<void> {
  await db.prepare(`
    INSERT INTO review_outcomes (owner, repo, pr_number, head_sha, fingerprint, logical_key, rule_id, file_path, line, severity, body, status, outcome, outcome_source, previous_severity, new_severity, github_comment_id, reviewer_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    outcome.owner, outcome.repo, outcome.pr_number, outcome.head_sha,
    outcome.fingerprint, outcome.logical_key, outcome.rule_id,
    outcome.file_path, outcome.line, outcome.severity, outcome.body,
    outcome.status, outcome.outcome, outcome.outcome_source ?? null,
    outcome.previous_severity ?? null, outcome.new_severity ?? null,
    outcome.github_comment_id ?? null, outcome.reviewer_type
  ).run();
}

export async function recordReviewOutcomes(
  db: D1Database,
  outcomes: Omit<ReviewOutcome, 'id' | 'created_at' | 'updated_at'>[]
): Promise<void> {
  if (outcomes.length === 0) return;
  const stmt = db.prepare(`
    INSERT INTO review_outcomes (owner, repo, pr_number, head_sha, fingerprint, logical_key, rule_id, file_path, line, severity, body, status, outcome, outcome_source, previous_severity, new_severity, github_comment_id, reviewer_type)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM review_outcomes
      WHERE owner = ? AND repo = ? AND pr_number = ? AND head_sha = ?
        AND fingerprint = ? AND github_comment_id IS ?
    )
  `);
  const batch = outcomes.map(o => stmt.bind(
    o.owner, o.repo, o.pr_number, o.head_sha,
    o.fingerprint, o.logical_key, o.rule_id,
    o.file_path, o.line, o.severity, o.body,
    o.status, o.outcome, o.outcome_source ?? null,
    o.previous_severity ?? null, o.new_severity ?? null,
    o.github_comment_id ?? null, o.reviewer_type,
    o.owner, o.repo, o.pr_number, o.head_sha, o.fingerprint, o.github_comment_id ?? null
  ));
  await db.batch(batch);
}

// ── Feedback ─────────────────────────────────────────────────────────────────

export async function recordFeedback(
  db: D1Database,
  feedback: Omit<Feedback, 'id' | 'created_at'>
): Promise<void> {
  await db.prepare(`
    INSERT INTO feedback (owner, repo, pr_number, fingerprint, feedback_type, feedback_source, feedback_text, previous_severity, new_severity, github_user, github_comment_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    feedback.owner, feedback.repo, feedback.pr_number,
    feedback.fingerprint, feedback.feedback_type, feedback.feedback_source,
    feedback.feedback_text ?? null, feedback.previous_severity ?? null,
    feedback.new_severity ?? null, feedback.github_user,
    feedback.github_comment_id ?? null
  ).run();
}

// ── Learnings ────────────────────────────────────────────────────────────────

export async function getLearnings(
  db: D1Database,
  owner: string,
  repo: string,
  minConfidence: number = 50
): Promise<Learning[]> {
  const results = await db.prepare(`
    SELECT * FROM learnings
    WHERE ((owner = ? AND repo = ?) OR (owner IS NULL AND repo IS NULL))
    AND confidence >= ?
    ORDER BY confidence DESC, learning_text ASC
  `).bind(owner, repo, minConfidence).all<Learning>();
  return results.results ?? [];
}

// ── Pattern Weights ──────────────────────────────────────────────────────────

export async function getPatternWeights(
  db: D1Database,
  owner: string,
  repo: string
): Promise<Map<string, PatternWeight>> {
  const results = await db.prepare(`
    SELECT * FROM pattern_weights
    WHERE owner = ? AND repo = ?
  `).bind(owner, repo).all<PatternWeight>();

  const map = new Map<string, PatternWeight>();
  for (const row of results.results ?? []) {
    map.set(row.rule_id, row);
  }
  return map;
}

export async function getPatternWeight(
  db: D1Database,
  owner: string,
  repo: string,
  ruleId: string
): Promise<PatternWeight | null> {
  return db.prepare(`
    SELECT * FROM pattern_weights
    WHERE owner = ? AND repo = ? AND rule_id = ?
  `).bind(owner, repo, ruleId).first<PatternWeight>();
}

export async function upsertPatternWeight(
  db: D1Database,
  weight: Omit<PatternWeight, 'id' | 'created_at' | 'updated_at'>
): Promise<void> {
  const existing = await getPatternWeight(db, weight.owner, weight.repo, weight.rule_id);

  if (existing) {
    await db.prepare(`
      UPDATE pattern_weights
      SET confidence = ?,
          total_findings = ?,
          dismissed_count = ?,
          accepted_count = ?,
          fixed_count = ?,
          ignored_count = ?,
          last_calculation_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ?
    `).bind(
      weight.confidence, weight.total_findings,
      weight.dismissed_count, weight.accepted_count,
      weight.fixed_count, weight.ignored_count,
      existing.id
    ).run();
  } else {
    await db.prepare(`
      INSERT INTO pattern_weights (owner, repo, rule_id, pattern_type, confidence, total_findings, dismissed_count, accepted_count, fixed_count, ignored_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      weight.owner, weight.repo, weight.rule_id, weight.pattern_type,
      weight.confidence, weight.total_findings,
      weight.dismissed_count, weight.accepted_count,
      weight.fixed_count, weight.ignored_count
    ).run();
  }
}

// ── Memory Context (for prompt injection) ────────────────────────────────────

/** A missing migration is a deployment error, not a transient D1 outage. */
export function isMissingMemorySchema(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current != null && !seen.has(current)) {
    seen.add(current);
    const message = current instanceof Error ? current.message : String(current);
    if (/no such table:\s*(?:["'`]?\w+["'`]?\.)?["'`]?legacy_learning_links["'`]?/i.test(message)) return true;
    current = current instanceof Error ? current.cause : null;
  }
  return false;
}

export async function buildMemoryContext(
  db: D1Database,
  owner: string,
  repo: string,
  reviewedPaths: string[] = [],
  scopedEnabled = true
): Promise<MemoryContext> {
  const minConfidence = 50;

  // Legacy rows retain their previous eligibility, but linked scoped rules
  // govern revocation and scope even when the scoped rollout is disabled.
  const legacyQuery = (category: 'ignore' | 'focus' | 'style') => db.prepare(`
    SELECT l.learning_text, l.category, s.id AS scoped_id, s.scope_type, s.scope_path, s.confidence
    FROM learnings l
    LEFT JOIN legacy_learning_links link ON link.legacy_learning_id = l.id
    LEFT JOIN scoped_learnings s ON s.id = link.scoped_learning_id
    WHERE ((l.owner = ? AND l.repo = ?) OR (l.owner IS NULL AND l.repo IS NULL))
      AND l.category = ? AND l.review_state = 'active' AND l.confidence >= ?
      AND (link.legacy_learning_id IS NULL OR (s.state = 'active' AND s.scope_type = 'repo'))
    ORDER BY l.confidence DESC, l.learning_text ASC LIMIT 10
  `).bind(owner, repo, category, minConfidence).all<{
    learning_text: string; category: 'ignore' | 'focus' | 'style'; scoped_id: number | null;
    scope_type: ScopedLearning['scope_type'] | null; scope_path: string | null; confidence: number | null;
  }>();
  const [ignoreResult, focusResult, prefResult] = await Promise.all([
    legacyQuery('ignore'), legacyQuery('focus'), legacyQuery('style'),
  ]);

  // Get high-confidence patterns
  const patternsResult = await db.prepare(`
    SELECT rule_id, confidence FROM pattern_weights
    WHERE owner = ? AND repo = ? AND confidence > 0.7 AND total_findings >= 5
    ORDER BY confidence DESC, rule_id ASC LIMIT 20
  `).bind(owner, repo).all<{ rule_id: string; confidence: number }>();

  const scopedResult = await db.prepare(`
    SELECT id, learning_text, category, scope_type, scope_path, confidence
    FROM scoped_learnings
    WHERE owner = ? AND repo = ? AND state = 'active' AND confidence >= ?
  `).bind(owner, repo, minConfidence).all<ScopedLearning>();
  const scoped = scopedEnabled ? selectScopedLearnings(scopedResult.results ?? [], reviewedPaths) : [];
  const candidates: Array<{ text: string; category: 'ignore' | 'focus' | 'style'; scoped?: ScopedLearning }> = [
    ...scoped.map(rule => ({ text: rule.learning_text, category: rule.category, scoped: rule })),
    ...[...(ignoreResult.results ?? []), ...(focusResult.results ?? []), ...(prefResult.results ?? [])].map(row => ({
      text: row.learning_text,
      category: row.category,
      scoped: row.scoped_id != null ? {
        id: row.scoped_id, learning_text: row.learning_text, category: row.category,
        scope_type: row.scope_type!, scope_path: row.scope_path ?? '', confidence: row.confidence ?? 0,
      } : undefined,
    })),
  ];
  const selected: typeof candidates = [];
  const seen = new Set<string>();
  let characters = 0;
  for (const candidate of candidates) {
    if (seen.has(candidate.text) || characters + candidate.text.length > 8000) continue;
    selected.push(candidate);
    seen.add(candidate.text);
    characters += candidate.text.length;
    if (selected.length === 30) break;
  }
  const texts = (category: 'ignore' | 'focus' | 'style') => selected
    .filter(item => item.category === category)
    .map(item => item.scoped ? `[learning #${item.scoped.id}] ${item.text}` : item.text);

  return {
    ignorePatterns: texts('ignore'),
    focusAreas: texts('focus'),
    preferences: texts('style'),
    scopedLearnings: selected.flatMap(item => item.scoped ? [item.scoped] : []),
    highConfidenceRules: (patternsResult.results ?? []).map((r: { rule_id: string; confidence: number }) => ({
      ruleId: r.rule_id,
      confidence: r.confidence,
    })),
  };
}

export interface ScopedLearning {
  id: number;
  learning_text: string;
  category: 'ignore' | 'focus' | 'style';
  scope_type: 'file' | 'directory' | 'repo';
  scope_path: string;
  confidence: number;
}

/** Record an explicit repository preference after the caller verifies maintainer permission. */
export async function recordScopedPreference(
  db: D1Database,
  input: {
    owner: string; repo: string; prNumber: number; commentId: number;
    user: string; text: string; category: 'ignore' | 'focus' | 'style';
  },
): Promise<void> {
  const state = input.category === 'ignore' ? 'pending' : 'active';
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO scoped_learning_events
      (owner, repo, pr_number, source_type, source_id) VALUES (?, ?, ?, 'command', ?)`)
      .bind(input.owner, input.repo, input.prNumber, String(input.commentId)),
    db.prepare(`INSERT INTO feedback
      (owner, repo, pr_number, fingerprint, feedback_type, feedback_source, feedback_text, github_user, github_comment_id)
      SELECT ?, ?, ?, ?, 'preference', 'command', ?, ?, ? WHERE changes() = 1`)
      .bind(input.owner, input.repo, input.prNumber, `preference:${input.commentId}`, input.text.slice(0, 2000), input.user, input.commentId),
    db.prepare(`INSERT INTO scoped_learnings
      (owner, repo, learning_text, category, scope_type, scope_path, state, confidence, source_pr, source_comment_id, source_user, confirmed_by)
      SELECT ?, ?, ?, ?, 'repo', '', ?, 70, ?, ?, ?, ? WHERE changes() = 1
      ON CONFLICT(owner, repo, category, scope_type, scope_path, learning_text) DO UPDATE SET
        sample_size = scoped_learnings.sample_size + 1,
        confirmed_by = CASE WHEN scoped_learnings.state = 'active' THEN COALESCE(scoped_learnings.confirmed_by, excluded.confirmed_by) ELSE scoped_learnings.confirmed_by END,
        updated_at = datetime('now')`)
      .bind(input.owner, input.repo, input.text, input.category, state, input.prNumber, input.commentId, input.user,
        state === 'active' ? input.user : null),
    // Preserve old behavior for explicit non-suppressive repo preferences
    // while the scoped rollout is disabled. Exceptions stay pending.
    db.prepare(`INSERT INTO learnings (owner, repo, learning_text, source, category, confidence, sample_size, review_state)
      SELECT ?, ?, ?, 'feedback', ?, 70, 1, ? WHERE changes() = 1 AND NOT EXISTS (
        SELECT 1 FROM learnings WHERE owner = ? AND repo = ? AND learning_text = ? AND category = ?
      )`)
      .bind(input.owner, input.repo, input.text, input.category, state,
        input.owner, input.repo, input.text, input.category),
    db.prepare(`INSERT OR IGNORE INTO legacy_learning_links (legacy_learning_id, scoped_learning_id)
      SELECT l.id, s.id FROM learnings l JOIN scoped_learnings s
        ON s.owner = l.owner AND s.repo = l.repo AND s.category = l.category AND s.learning_text = l.learning_text
      WHERE l.owner = ? AND l.repo = ? AND l.category = ? AND l.learning_text = ?
        AND s.scope_type = 'repo' AND s.scope_path = ''`)
      .bind(input.owner, input.repo, input.category, input.text),
  ]);
}

/** Store the triggering comment, feedback, and learning in one D1 transaction. */
export async function recordScopedReply(
  db: D1Database,
  input: {
    owner: string; repo: string; prNumber: number; commentId: number;
    user: string; fingerprint: string; replyText: string; learningText: string;
    type: 'dismiss' | 'accept'; filePath?: string; source?: 'reply' | 'command';
  }
): Promise<void> {
  const category = input.type === 'dismiss' ? 'ignore' : 'focus';
  const scopeType = input.filePath ? 'file' : 'repo';
  // Suppression and unscoped inferences require maintainer confirmation.
  const state = category === 'ignore' || !input.filePath ? 'pending' : 'active';
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO scoped_learning_events
      (owner, repo, pr_number, source_type, source_id) VALUES (?, ?, ?, ?, ?)`)
      .bind(input.owner, input.repo, input.prNumber, input.source ?? 'reply', String(input.commentId)),
    db.prepare(`INSERT INTO feedback
      (owner, repo, pr_number, fingerprint, feedback_type, feedback_source, feedback_text, github_user, github_comment_id)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`)
      .bind(input.owner, input.repo, input.prNumber, input.fingerprint, input.type, input.source ?? 'reply', input.replyText.slice(0, 2000), input.user, input.commentId),
    db.prepare(`INSERT INTO scoped_learnings
      (owner, repo, learning_text, category, scope_type, scope_path, state, source_pr, source_comment_id, source_user)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1
      ON CONFLICT(owner, repo, category, scope_type, scope_path, learning_text) DO UPDATE SET
        sample_size = scoped_learnings.sample_size + 1,
        updated_at = datetime('now')`)
      .bind(input.owner, input.repo, input.learningText, category, scopeType, input.filePath ?? '', state,
        input.prNumber, input.commentId, input.user),
  ]);
}

/** Rank applicable rules by path specificity and apply a shared prompt budget. */
export function selectScopedLearnings(learnings: ScopedLearning[], paths: string[]): ScopedLearning[] {
  const ranked = learnings.flatMap(learning => {
    const scope = learning.scope_path.replace(/\/+$/, '');
    let rank = 0;
    if (learning.scope_type === 'file' && paths.includes(scope)) rank = 10000 + scope.length;
    if (learning.scope_type === 'directory' && scope && paths.some(path => path.startsWith(scope + '/'))) {
      rank = 1000 + scope.split('/').length;
    }
    if (learning.scope_type === 'repo') rank = 1;
    return rank ? [{ learning, rank }] : [];
  });
  ranked.sort((a, b) => b.rank - a.rank || b.learning.confidence - a.learning.confidence || a.learning.id - b.learning.id);
  const seen = new Set<string>();
  const selected: ScopedLearning[] = [];
  let characters = 0;
  for (const { learning } of ranked) {
    if (seen.has(learning.learning_text) || characters + learning.learning_text.length > 8000) continue;
    seen.add(learning.learning_text);
    selected.push(learning);
    characters += learning.learning_text.length;
    if (selected.length === 30) break;
  }
  return selected;
}
