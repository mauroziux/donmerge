/**
 * Deterministic PR risk assessment (plan 003-U4).
 *
 * Decides when an adaptive review should escalate: a high-risk change whose
 * first pass comes back clean gets an independent second search; everything
 * else gets the normal pass. Explorable signals only — no model calls, no
 * magic scores. `unknown` (not `low`) when there is nothing to assess, so a
 * lack of data can never silently downgrade depth.
 */

export type RiskLevel = 'low' | 'high' | 'unknown';

export interface RiskAssessment {
  level: RiskLevel;
  /** Why this level — surfaced in logs and coverage notes. */
  reasons: string[];
}

/** Path fragments that historically carry cross-cutting blast radius. */
const HIGH_RISK_PATH_PATTERNS: Array<[RegExp, string]> = [
  [/auth|permission|polic|middleware|guard/i, 'auth/authorization surface'],
  [/migrat|schema|database/i, 'schema or data migration'],
  [/payment|billing|invoice|charge|refund|money|wallet/i, 'money-handling path'],
  [/webhook|callback|consumer|queue|job|worker|cron|scheduler/i, 'async delivery/processing path'],
  [/scope|tenant|organization|account/i, 'tenant isolation/scoping'],
  [/transaction|locking|concurren|idempoten/i, 'transaction/concurrency logic'],
  [/config|provider|env/i, 'provider/runtime configuration'],
];

/** Patch-content signals that make seemingly innocuous paths risky. */
const HIGH_RISK_PATCH_PATTERNS: Array<[RegExp, string]> = [
  [/\btransaction\b|\bbegin\(\)|\bcommit\(\)|\brollback\b|DB::transaction/i, 'transaction semantics'],
  [/\block|mutex|atomic|race\b/i, 'locking/concurrency'],
  [/idempoten|retry|at-least-once|duplicate/i, 'retry/idempotency'],
  [/password|secret|token|credential|api[_-]?key|signing/i, 'credential handling'],
  [/authorize|can\(|policy|ability|scope/i, 'authorization checks'],
  [/delete|truncate|drop\b|destroy|purge/i, 'destructive operation'],
  [/whereRaw|orderByRaw|DB::raw|query\(|exec\(|eval\(/i, 'raw query/execution'],
  [/dispatch|emit|publish|broadcast/i, 'event dispatch'],
];

/**
 * Assess the risk of the reviewed change set from its file list + patches.
 * Any single high-risk signal escalates the whole review; reasons dedupe.
 */
export function assessPrRisk(files: Array<{ filename: string; patch?: string }>): RiskAssessment {
  if (files.length === 0) {
    return { level: 'unknown', reasons: ['no files to assess'] };
  }

  const reasons = new Set<string>();

  for (const file of files) {
    for (const [pattern, reason] of HIGH_RISK_PATH_PATTERNS) {
      if (pattern.test(file.filename)) reasons.add(reason);
    }
    if (file.patch) {
      for (const [pattern, reason] of HIGH_RISK_PATCH_PATTERNS) {
        if (pattern.test(file.patch)) reasons.add(reason);
      }
    }
  }

  if (reasons.size > 0) {
    return { level: 'high', reasons: Array.from(reasons) };
  }
  return { level: 'low', reasons: ['no high-risk signals matched'] };
}

/**
 * Whether a clean first pass on a high-risk change warrants the independent
 * second search (plan 003-U4). Unknown risk never downgrades to "skip".
 */
export function shouldRunSecondPass(
  risk: RiskAssessment,
  hasBlockingFindings: boolean
): boolean {
  if (hasBlockingFindings) return false; // findings already gate the merge
  return risk.level === 'high' || risk.level === 'unknown';
}
