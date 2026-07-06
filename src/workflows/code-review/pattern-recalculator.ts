import type { PatternWeight } from './types';
import { upsertPatternWeight } from './memory-store';

/**
 * Recalculate pattern weights for a repo based on accumulated feedback.
 * Should be called periodically or after N new feedback items.
 */
export async function recalculatePatternWeights(
  db: D1Database,
  owner: string,
  repo: string
): Promise<void> {
  // Get all distinct rule_ids with their outcomes
  const results = await db.prepare(`
    SELECT
      rule_id,
      COUNT(*) as total_findings,
      SUM(CASE WHEN outcome = 'dismissed' THEN 1 ELSE 0 END) as dismissed_count,
      SUM(CASE WHEN outcome = 'accepted' THEN 1 ELSE 0 END) as accepted_count,
      SUM(CASE WHEN outcome = 'fixed' THEN 1 ELSE 0 END) as fixed_count,
      SUM(CASE WHEN outcome = 'ignored' THEN 1 ELSE 0 END) as ignored_count
    FROM review_outcomes
    WHERE owner = ? AND repo = ?
    GROUP BY rule_id
    HAVING total_findings >= 3
  `).bind(owner, repo).all<{
    rule_id: string;
    total_findings: number;
    dismissed_count: number;
    accepted_count: number;
    fixed_count: number;
    ignored_count: number;
  }>();

  for (const row of results.results ?? []) {
    // Calculate confidence: ratio of accepted + fixed to total
    const positiveSignals = row.accepted_count + row.fixed_count;
    const negativeSignals = row.dismissed_count + row.ignored_count;
    const total = row.total_findings;

    // Confidence formula: (positive - negative) / total, clamped to [0, 1]
    // With minimum threshold: if most findings are dismissed, confidence is low
    const rawConfidence = (positiveSignals - negativeSignals) / total;
    const confidence = Math.max(0, Math.min(1, (rawConfidence + 1) / 2)); // Normalize to [0, 1]

    // Determine pattern type from rule_id
    const patternType = classifyPatternType(row.rule_id);

    await upsertPatternWeight(db, {
      owner,
      repo,
      rule_id: row.rule_id,
      pattern_type: patternType,
      confidence,
      total_findings: total,
      dismissed_count: row.dismissed_count,
      accepted_count: row.accepted_count,
      fixed_count: row.fixed_count,
      ignored_count: row.ignored_count,
      last_calculation_at: new Date().toISOString(),
    });
  }
}

function classifyPatternType(ruleId: string): PatternWeight['pattern_type'] {
  const lower = ruleId.toLowerCase();
  if (lower.includes('style') || lower.includes('format') || lower.includes('import') || lower.includes('phpdoc') || lower.includes('naming')) {
    return 'style';
  }
  if (lower.includes('security') || lower.includes('injection') || lower.includes('xss') || lower.includes('auth')) {
    return 'vulnerability';
  }
  if (lower.includes('critical') || lower.includes('error') || lower.includes('crash') || lower.includes('null')) {
    return 'critical';
  }
  return 'advisory';
}

/**
 * Check if recalibration is needed based on recent feedback count.
 */
export async function needsRecalculation(
  db: D1Database,
  owner: string,
  repo: string,
  threshold: number = 10
): Promise<boolean> {
  const result = await db.prepare(`
    SELECT COUNT(*) as count FROM feedback
    WHERE owner = ? AND repo = ?
    AND created_at > datetime('now', '-7 days')
  `).bind(owner, repo).first<{ count: number }>();

  return (result?.count ?? 0) >= threshold;
}
