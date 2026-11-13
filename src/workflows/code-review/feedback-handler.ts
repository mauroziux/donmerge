import type { Feedback, ReviewOutcome } from './types';
import { recordFeedback, recordReviewOutcomes, upsertLearning, upsertPatternWeight } from './memory-store';
import { recalculatePatternWeights } from './pattern-recalculator';
import {
  classifyReply,
  type ReplyClassification,
  type ReplyClassifierEnv,
} from './reply-classifier';

// ── Parse @donmerge commands ─────────────────────────────────────────────────

export interface ParsedCommand {
  type: 'dismiss' | 'accept' | 'override' | 'preference';
  fingerprint?: string;
  text?: string;
  newSeverity?: 'critical' | 'suggestion' | 'low';
}

export function parseDonmergeCommand(text: string): ParsedCommand | null {
  // Parse the first mention only; a later quoted command is part of its text.
  const mention = text.search(/@donmerge\b/i);
  if (mention < 0) return null;
  text = text.slice(mention);
  // Fingerprints are case-sensitive; only command matching is case-insensitive.

  // @donmerge dismiss [fingerprint]
  // The fingerprint is optional: bare replies ("@donmerge dismiss") are
  // correlated with the parent DonMerge comment by the webhook layer.
  const dismissMatch = text.match(/^@donmerge\s+dismiss(?:\s+([a-zA-Z0-9_-]+))?\b/i);
  if (dismissMatch) {
    return { type: 'dismiss', fingerprint: dismissMatch[1] };
  }

  // @donmerge accept [fingerprint]
  const acceptMatch = text.match(/^@donmerge\s+accept(?:\s+([a-zA-Z0-9_-]+))?\b/i);
  if (acceptMatch) {
    return { type: 'accept', fingerprint: acceptMatch[1] };
  }

  // @donmerge override <fingerprint> <severity>
  const overrideMatch = text.match(/^@donmerge\s+override\s+([a-zA-Z0-9_-]+)\s+(critical|suggestion|low)/i);
  if (overrideMatch) {
    return {
      type: 'override',
      fingerprint: overrideMatch[1],
      newSeverity: overrideMatch[2].toLowerCase() as 'critical' | 'suggestion' | 'low',
    };
  }

  // @donmerge preference <text>
  const prefMatch = text.match(/^@donmerge\s+preference\s+([\s\S]+)/i);
  if (prefMatch) {
    return { type: 'preference', text: prefMatch[1].trim() };
  }

  // @donmerge ignore <pattern description>
  const ignoreMatch = text.match(/^@donmerge\s+ignore\s+([\s\S]+)/i);
  if (ignoreMatch) {
    return { type: 'preference', text: `Don't comment on: ${ignoreMatch[1].trim()}` };
  }

  // @donmerge focus <area description>
  const focusMatch = text.match(/^@donmerge\s+focus\s+([\s\S]+)/i);
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

    // Also create a learning from dismiss — use the actual finding body so the
    // stored rule is actionable, not a generic "something was dismissed".
    if (command.type === 'dismiss' || command.type === 'accept') {
      const outcome = await db.prepare(`
        SELECT body, file_path FROM review_outcomes
        WHERE owner = ? AND repo = ? AND pr_number = ? AND github_comment_id = ? AND fingerprint = ?
        ORDER BY id DESC LIMIT 1
      `).bind(params.owner, params.repo, params.prNumber, params.inReplyToId, command.fingerprint).first<{ body: string; file_path: string }>();

      const finding = outcome?.body ? stripHtmlComments(outcome.body).slice(0, 200) : null;
      const learningText = command.type === 'dismiss'
        ? finding
          ? `Don't flag findings like: ${finding} (dismissed by ${params.githubUser})`
          : `A finding in this codebase was dismissed — similar findings may be false positives`
        : finding
          ? `Confirmed valid: ${finding}`
          : `A finding in this codebase was accepted as valid`;

      await upsertLearning(db, {
        owner: params.owner,
        repo: params.repo,
        learning_text: learningText,
        source: 'feedback',
        category: command.type === 'dismiss' ? 'ignore' : 'focus',
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

// ── Natural-language reply learning ──────────────────────────────────────────

/** Acknowledgment payload returned when a reply produced a learning. */
export interface NaturalReplyAck {
  classification: ReplyClassification;
  /** Ready-to-post reply body for the thread. */
  ackBody: string;
}

const ACK_MARKER = '<!-- DONMERGE:ACK -->';


/** Remove HTML comments (fingerprint metadata, GitHub anchors) from a body. */
function stripHtmlComments(body: string): string {
  let result = '';
  let cursor = 0;
  while (cursor < body.length) {
    const start = body.indexOf('<!--', cursor);
    if (start < 0) {
      result += body.slice(cursor);
      break;
    }
    result += body.slice(cursor, start);
    const end = body.indexOf('-->', start + 4);
    if (end < 0) break;
    cursor = end + 3;
  }
  return result.replace(/\s+/g, ' ').trim();
}

/**
 * Learn from a natural-language reply to a DonMerge review comment.
 *
 * The parent comment is already correlated by the caller (fingerprint parsed
 * from its DONMERGE marker). This classifies the reply, records the feedback,
 * stores an actionable learning with the human's reason, updates the finding
 * outcome, and refreshes pattern weights. Returns the ack to post when a
 * learning was registered; null when the reply taught nothing (no ack).
 */
export async function handleNaturalReply(
  db: D1Database,
  env: ReplyClassifierEnv,
  params: {
    owner: string;
    repo: string;
    prNumber: number;
    githubUser: string;
    replyText: string;
    parentFingerprint: string;
    parentCommentId?: number;
    parentBody: string;
    filePath?: string;
  }
): Promise<NaturalReplyAck | null> {
  const findingBody = stripHtmlComments(params.parentBody).slice(0, 500);

  const classification = await classifyReply(env, {
    findingBody,
    replyText: params.replyText,
    filePath: params.filePath,
  });

  if (!classification || (classification.type !== 'dismiss' && classification.type !== 'accept')) {
    return null;
  }

  await recordFeedback(db, {
    owner: params.owner,
    repo: params.repo,
    pr_number: params.prNumber,
    fingerprint: params.parentFingerprint,
    feedback_type: classification.type,
    feedback_source: 'reply',
    feedback_text: params.replyText.slice(0, 2000),
    github_user: params.githubUser,
  });

  const learningText =
    classification.type === 'dismiss'
      ? classification.learning ??
        `Don't flag findings like: ${findingBody.slice(0, 200)} — reason: ${classification.reason}`
      : classification.learning ??
        `Confirmed valid: ${findingBody.slice(0, 200)}`;

  await upsertLearning(db, {
    owner: params.owner,
    repo: params.repo,
    learning_text: learningText,
    source: 'feedback',
    category: classification.type === 'dismiss' ? 'ignore' : 'focus',
    confidence: 65,
    sample_size: 1,
  });

  // Update the finding outcome (best-effort — rows may not exist for old findings).
  try {
    if (params.parentCommentId) await updateOutcomeFromTransition(db, {
      owner: params.owner,
      repo: params.repo,
      prNumber: params.prNumber,
      commentId: params.parentCommentId,
      fingerprint: params.parentFingerprint,
      newStatus: classification.type === 'dismiss' ? 'dismissed' : 'open',
      outcomeSource: 'reply',
    });
    await recalculatePatternWeights(db, params.owner, params.repo);
  } catch (error) {
    console.warn('[reply-learning] outcome/weight update failed (non-fatal):', error);
  }

  const ackLine =
    classification.type === 'dismiss'
      ? '**Learned.** I will stop flagging this pattern in future reviews of this repo.'
      : '**Confirmed.** Findings like this are valid here — I will keep prioritizing them.';

  // Do not let quoted user text trigger the review webhook or inject hidden
  // metadata into our acknowledgment comment.
  const safeReason = stripHtmlComments(classification.reason)
    .replace(/@donmerge/gi, '@ donmerge')
    .replace(/[\r\n]+/g, ' ')
    .trim();
  const ackBody = `${ACK_MARKER}\n🤖 ${ackLine}${safeReason ? `\n\n> ${safeReason}` : ''}`;

  return { classification, ackBody };
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
      WHERE owner = ? AND repo = ? AND pr_number = ? AND github_comment_id = ? AND fingerprint = ?
      LIMIT 1
    `).bind(params.owner, params.repo, params.prNumber, params.commentId, params.commentFingerprint).first<{ body: string }>();

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
    prNumber: number;
    commentId: number;
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
    WHERE owner = ? AND repo = ? AND pr_number = ? AND github_comment_id = ? AND fingerprint = ?
    AND outcome = 'new'
  `).bind(outcome, params.outcomeSource ?? 'implicit', params.owner, params.repo, params.prNumber, params.commentId, params.fingerprint).run();
}
