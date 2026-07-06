import type { Feedback, ReviewOutcome } from './types';
import { recordFeedback, recordReviewOutcomes, upsertLearning, upsertPatternWeight } from './memory-store';

// ── Parse @donmerge commands ─────────────────────────────────────────────────

export interface ParsedCommand {
  type: 'dismiss' | 'accept' | 'override' | 'preference';
  fingerprint?: string;
  text?: string;
  newSeverity?: 'critical' | 'suggestion' | 'low';
}

export function parseDonmergeCommand(text: string): ParsedCommand | null {
  const lower = text.toLowerCase().trim();

  // @donmerge dismiss <fingerprint>
  const dismissMatch = lower.match(/@donmerge\s+dismiss\s+([a-zA-Z0-9_-]+)/);
  if (dismissMatch) {
    return { type: 'dismiss', fingerprint: dismissMatch[1] };
  }

  // @donmerge accept <fingerprint>
  const acceptMatch = lower.match(/@donmerge\s+accept\s+([a-zA-Z0-9_-]+)/);
  if (acceptMatch) {
    return { type: 'accept', fingerprint: acceptMatch[1] };
  }

  // @donmerge override <fingerprint> <severity>
  const overrideMatch = lower.match(/@donmerge\s+override\s+([a-zA-Z0-9_-]+)\s+(critical|suggestion|low)/);
  if (overrideMatch) {
    return {
      type: 'override',
      fingerprint: overrideMatch[1],
      newSeverity: overrideMatch[2] as 'critical' | 'suggestion' | 'low',
    };
  }

  // @donmerge preference <text>
  const prefMatch = text.match(/@donmerge\s+preference\s+(.+)/i);
  if (prefMatch) {
    return { type: 'preference', text: prefMatch[1].trim() };
  }

  // @donmerge ignore <pattern description>
  const ignoreMatch = text.match(/@donmerge\s+ignore\s+(.+)/i);
  if (ignoreMatch) {
    return { type: 'preference', text: `Don't comment on: ${ignoreMatch[1].trim()}` };
  }

  // @donmerge focus <area description>
  const focusMatch = text.match(/@donmerge\s+focus\s+(.+)/i);
  if (focusMatch) {
    return { type: 'preference', text: `Focus on: ${focusMatch[1].trim()}` };
  }

  return null;
}

// ── Store feedback from GitHub comment ───────────────────────────────────────

export async function handleCommentFeedback(
  db: D1Database,
  params: {
    owner: string;
    repo: string;
    prNumber: number;
    githubUser: string;
    commentBody: string;
    commentId: number;
    inReplyToId?: number;
  }
): Promise<boolean> {
  const command = parseDonmergeCommand(params.commentBody);
  if (!command) return false;

  // For dismiss/accept/override, we need the fingerprint from the parent comment
  if (command.fingerprint && params.inReplyToId) {
    await recordFeedback(db, {
      owner: params.owner,
      repo: params.repo,
      pr_number: params.prNumber,
      fingerprint: command.fingerprint,
      feedback_type: command.type as 'dismiss' | 'accept' | 'override',
      feedback_source: 'command',
      feedback_text: params.commentBody,
      new_severity: command.newSeverity,
      github_user: params.githubUser,
      github_comment_id: params.commentId,
    });

    // Also create a learning from dismiss — use human-readable text, not fingerprint hash
    if (command.type === 'dismiss') {
      await upsertLearning(db, {
        owner: params.owner,
        repo: params.repo,
        learning_text: `A finding in this codebase was dismissed — similar findings may be false positives`,
        source: 'feedback',
        category: 'ignore',
        confidence: 60,
        sample_size: 1,
      });
    }

    return true;
  }

  // For preference/ignore/focus commands
  if (command.type === 'preference' && command.text) {
    const category = command.text.toLowerCase().startsWith("don't comment on") ? 'ignore'
      : command.text.toLowerCase().startsWith('focus on') ? 'focus'
      : 'style';

    await upsertLearning(db, {
      owner: params.owner,
      repo: params.repo,
      learning_text: command.text,
      source: 'feedback',
      category,
      confidence: 70,
      sample_size: 1,
    });

    return true;
  }

  return false;
}

// ── Store feedback from GitHub reaction ──────────────────────────────────────

export async function handleReactionFeedback(
  db: D1Database,
  params: {
    owner: string;
    repo: string;
    prNumber: number;
    githubUser: string;
    reaction: string; // thumbsup, thumbsdown, etc.
    commentId: number;
    commentFingerprint?: string; // from DONMERGE_META in parent comment
  }
): Promise<boolean> {
  if (!params.commentFingerprint) return false;

  const feedbackType = params.reaction === 'thumbsdown' ? 'dismiss'
    : params.reaction === 'thumbsup' ? 'accept'
    : null;

  if (!feedbackType) return false;

  await recordFeedback(db, {
    owner: params.owner,
    repo: params.repo,
    pr_number: params.prNumber,
    fingerprint: params.commentFingerprint,
    feedback_type: feedbackType as 'dismiss' | 'accept',
    feedback_source: 'reaction',
    github_user: params.githubUser,
  });

  // Create a learning from thumbsdown (dismiss) with human-readable text
  if (feedbackType === 'dismiss') {
    const outcome = await db.prepare(`
      SELECT body FROM review_outcomes
      WHERE owner = ? AND repo = ? AND fingerprint = ?
      LIMIT 1
    `).bind(params.owner, params.repo, params.commentFingerprint).first<{ body: string }>();

    const learningText = outcome?.body
      ? `Finding dismissed: "${outcome.body.slice(0, 200)}"`
      : `A finding was dismissed — similar findings may be false positives`;

    await upsertLearning(db, {
      owner: params.owner,
      repo: params.repo,
      learning_text: learningText,
      source: 'feedback',
      category: 'ignore',
      confidence: 60,
      sample_size: 1,
    });
  }

  return true;
}

// ── Record review outcomes ───────────────────────────────────────────────────

export async function recordReviewFindings(
  db: D1Database,
  params: {
    owner: string;
    repo: string;
    prNumber: number;
    headSha: string;
    findings: Array<{
      fingerprint: string;
      logicalKey: string;
      ruleId: string;
      filePath: string;
      line: number;
      severity: 'critical' | 'suggestion' | 'low';
      body: string;
      status: string;
      githubCommentId?: number;
    }>;
  }
): Promise<void> {
  const outcomes: Omit<ReviewOutcome, 'id' | 'created_at' | 'updated_at'>[] = params.findings.map(f => ({
    owner: params.owner,
    repo: params.repo,
    pr_number: params.prNumber,
    head_sha: params.headSha,
    fingerprint: f.fingerprint,
    logical_key: f.logicalKey,
    rule_id: f.ruleId,
    file_path: f.filePath,
    line: f.line,
    severity: f.severity,
    body: f.body,
    status: f.status as ReviewOutcome['status'],
    outcome: 'new',
    reviewer_type: 'ai',
    github_comment_id: f.githubCommentId,
  }));

  await recordReviewOutcomes(db, outcomes);
}

// ── Update outcomes from lifecycle transitions ───────────────────────────────

export async function updateOutcomeFromTransition(
  db: D1Database,
  params: {
    owner: string;
    repo: string;
    fingerprint: string;
    newStatus: string;
    outcomeSource?: string;
  }
): Promise<void> {
  const outcome = params.newStatus === 'fixed' ? 'fixed'
    : params.newStatus === 'dismissed' ? 'dismissed'
    : params.newStatus === 'open' ? 'accepted'
    : null;

  if (!outcome) return;

  await db.prepare(`
    UPDATE review_outcomes
    SET outcome = ?, outcome_source = ?, updated_at = datetime('now')
    WHERE owner = ? AND repo = ? AND fingerprint = ?
    AND outcome = 'new'
  `).bind(outcome, params.outcomeSource ?? 'implicit', params.owner, params.repo, params.fingerprint).run();
}
