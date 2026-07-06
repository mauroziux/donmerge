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
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const batch = outcomes.map(o => stmt.bind(
    o.owner, o.repo, o.pr_number, o.head_sha,
    o.fingerprint, o.logical_key, o.rule_id,
    o.file_path, o.line, o.severity, o.body,
    o.status, o.outcome, o.outcome_source ?? null,
    o.previous_severity ?? null, o.new_severity ?? null,
    o.github_comment_id ?? null, o.reviewer_type
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

export async function upsertLearning(
  db: D1Database,
  learning: Omit<Learning, 'id' | 'created_at' | 'updated_at'>
): Promise<void> {
  // Try to find existing learning with same text and category
  const existing = await db.prepare(`
    SELECT id FROM learnings
    WHERE owner = ? AND repo = ? AND learning_text = ? AND category = ?
  `).bind(learning.owner, learning.repo, learning.learning_text, learning.category).first<{ id: number }>();

  if (existing) {
    // Read current confidence to compute correct increment
    const existingRow = await db.prepare(`
      SELECT confidence FROM learnings WHERE id = ?
    `).bind(existing.id).first<{ confidence: number }>();

    const currentConfidence = existingRow?.confidence ?? learning.confidence;
    const increment = Math.min(20, Math.max(0, 100 - currentConfidence));

    await db.prepare(`
      UPDATE learnings
      SET confidence = MIN(100, confidence + ?),
          sample_size = sample_size + 1,
          last_applied_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ?
    `).bind(increment, existing.id).run();
  } else {
    // Insert new learning
    await db.prepare(`
      INSERT INTO learnings (owner, repo, learning_text, source, category, confidence, sample_size)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).bind(
      learning.owner, learning.repo, learning.learning_text,
      learning.source, learning.category, learning.confidence
    ).run();
  }
}

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
    ORDER BY confidence DESC
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

export async function buildMemoryContext(
  db: D1Database,
  owner: string,
  repo: string
): Promise<MemoryContext> {
  const minConfidence = 50;

  // Get ignore learnings
  const ignoreResult = await db.prepare(`
    SELECT learning_text FROM learnings
    WHERE ((owner = ? AND repo = ?) OR (owner IS NULL AND repo IS NULL))
    AND category = 'ignore' AND confidence >= ?
    ORDER BY confidence DESC LIMIT 10
  `).bind(owner, repo, minConfidence).all<{ learning_text: string }>();

  // Get focus learnings
  const focusResult = await db.prepare(`
    SELECT learning_text FROM learnings
    WHERE ((owner = ? AND repo = ?) OR (owner IS NULL AND repo IS NULL))
    AND category = 'focus' AND confidence >= ?
    ORDER BY confidence DESC LIMIT 10
  `).bind(owner, repo, minConfidence).all<{ learning_text: string }>();

  // Get preference learnings
  const prefResult = await db.prepare(`
    SELECT learning_text FROM learnings
    WHERE ((owner = ? AND repo = ?) OR (owner IS NULL AND repo IS NULL))
    AND category = 'style' AND confidence >= ?
    ORDER BY confidence DESC LIMIT 10
  `).bind(owner, repo, minConfidence).all<{ learning_text: string }>();

  // Get high-confidence patterns
  const patternsResult = await db.prepare(`
    SELECT rule_id, confidence FROM pattern_weights
    WHERE owner = ? AND repo = ? AND confidence > 0.7 AND total_findings >= 5
    ORDER BY confidence DESC LIMIT 20
  `).bind(owner, repo).all<{ rule_id: string; confidence: number }>();

  return {
    ignorePatterns: (ignoreResult.results ?? []).map((r: { learning_text: string }) => r.learning_text),
    focusAreas: (focusResult.results ?? []).map((r: { learning_text: string }) => r.learning_text),
    preferences: (prefResult.results ?? []).map((r: { learning_text: string }) => r.learning_text),
    highConfidenceRules: (patternsResult.results ?? []).map((r: { rule_id: string; confidence: number }) => ({
      ruleId: r.rule_id,
      confidence: r.confidence,
    })),
  };
}
