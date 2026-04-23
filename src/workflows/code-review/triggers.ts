/**
 * Trigger parsing logic for code review webhooks.
 */

import type { WebhookPayload, TriggerResult } from './types';

/**
 * Parse webhook event to determine if a review should be triggered.
 */
export function parseTrigger(
  event: string,
  payload: WebhookPayload,
  triggerTag?: string
): TriggerResult {
  const triggerRegex = getTriggerRegex(triggerTag);
  const triggerTagNormalized = (triggerTag ?? '@donmerge').trim();

  if (event === 'pull_request') {
    const valid =
      payload.action === 'opened' ||
      payload.action === 'synchronize' ||
      payload.action === 'reopened';
    if (!valid || !payload.pull_request) {
      return { shouldRun: false, prNumber: 0, retrigger: false, reason: 'ignored pull_request action' };
    }
    const retrigger = payload.action === 'synchronize';
    return { shouldRun: true, prNumber: payload.pull_request.number, retrigger };
  }

  // Handle "Re-run" button in GitHub UI
  if (event === 'check_run') {
    if (payload.action !== 'rerequested' || !payload.check_run?.pull_requests?.length) {
      return { shouldRun: false, prNumber: 0, retrigger: false, reason: 'ignored check_run action' };
    }
    // Use the first PR associated with the check run
    const prNumber = payload.check_run.pull_requests[0].number;
    return { shouldRun: true, prNumber, retrigger: true };
  }

  if (event === 'issue_comment') {
    const body = payload.comment?.body ?? '';
    const isPrComment = Boolean(payload.issue?.pull_request);
    const shouldRun = payload.action === 'created' && isPrComment && triggerRegex.test(body);
    if (!shouldRun || !payload.issue) {
      return {
        shouldRun: false,
        prNumber: 0,
        retrigger: false,
        reason: 'comment does not trigger review',
      };
    }
    const instructionResult = parseInstruction(body, triggerTagNormalized);
    if (instructionResult.action === 'ignore') {
      return {
        shouldRun: false,
        prNumber: payload.issue.number,
        retrigger: false,
        reason: 'comment marked as non-actionable',
      };
    }
    return {
      shouldRun: true,
      prNumber: payload.issue.number,
      retrigger: true,
      commentId: payload.comment?.id,
      commentType: 'issue',
      instruction: instructionResult.instruction,
      focusFiles: instructionResult.focusFiles,
    };
  }

  if (event === 'pull_request_review_comment') {
    const body = payload.comment?.body ?? '';
    const shouldRun = payload.action === 'created' && triggerRegex.test(body);
    if (!shouldRun || !payload.pull_request) {
      return {
        shouldRun: false,
        prNumber: 0,
        retrigger: false,
        reason: 'review comment does not trigger review',
      };
    }
    const instructionResult = parseInstruction(body, triggerTagNormalized);
    if (instructionResult.action === 'ignore') {
      return {
        shouldRun: false,
        prNumber: payload.pull_request.number,
        retrigger: false,
        reason: 'comment marked as non-actionable',
      };
    }
    return {
      shouldRun: true,
      prNumber: payload.pull_request.number,
      retrigger: true,
      commentId: payload.comment?.id,
      commentType: 'review',
      instruction: instructionResult.instruction,
      focusFiles: instructionResult.focusFiles,
    };
  }

  return { shouldRun: false, prNumber: 0, retrigger: false, reason: `unsupported event: ${event}` };
}

/**
 * Extract instruction from comment after the trigger tag.
 * Example: "@donmerge focus on security" -> "focus on security"
 */
export function extractInstruction(body: string, triggerTag: string): string | undefined {
  // Create regex to find trigger tag and capture everything after it
  const escaped = triggerTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`${escaped}\\s+(.+)$`, 'im');
  const match = body.match(regex);

  if (match && match[1]) {
    const instruction = match[1].trim();
    // Return only if there's actual content
    return instruction.length > 0 ? instruction : undefined;
  }

  return undefined;
}

type InstructionAction = 'ignore' | 'run';

function parseInstruction(
  body: string,
  triggerTag: string
): { action: InstructionAction; instruction?: string; focusFiles?: string[] } {
  const instruction = extractInstruction(body, triggerTag);
  if (!instruction) {
    return { action: 'run' };
  }

  const normalized = instruction.trim();
  const normalizedLower = normalized.toLowerCase();

  if (isNonActionableInstruction(normalizedLower)) {
    return { action: 'ignore' };
  }

  const focus = extractFocusFiles(normalized);
  if (focus.files.length > 0) {
    return {
      action: 'run',
      instruction: focus.instruction,
      focusFiles: focus.files,
    };
  }

  return { action: 'run', instruction: normalized };
}

function isNonActionableInstruction(instruction: string): boolean {
  const cleaned = instruction.replace(/[^a-z0-9\s']/gi, '').trim();
  if (!cleaned) return true;

  const ignorePatterns = [
    /^thanks?$/,
    /^thank you$/,
    /^thx$/,
    /^appreciate it$/,
    /^ignore$/,
    /^not applicable$/,
    /^does not apply$/,
    /^doesn't apply$/,
    /^wont fix$/,
    /^won't fix$/,
    /^n\/a$/,
  ];

  return ignorePatterns.some((pattern) => pattern.test(cleaned));
}

function extractFocusFiles(instruction: string): { files: string[]; instruction: string } {
  const focusPrefix = instruction.match(/^(recheck|check|focus|review)\s+(.+)$/i);
  if (!focusPrefix) {
    return { files: [], instruction };
  }

  const remainder = focusPrefix[2].trim();
  const files: string[] = [];

  const backtickMatches = [...remainder.matchAll(/`([^`]+)`/g)];
  for (const match of backtickMatches) {
    if (match[1]) {
      files.push(match[1].trim());
    }
  }

  const cleaned = remainder.replace(/`[^`]+`/g, ' ');
  cleaned
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .forEach((token) => {
      if (token.includes('/') || token.includes('.')) {
        files.push(token);
      }
    });

  const unique = Array.from(new Set(files));
  if (unique.length === 0) {
    return { files: [], instruction };
  }

  const focusInstruction = `Focus ONLY on these files: ${unique.join(', ')}. ${instruction}`;
  return { files: unique, instruction: focusInstruction };
}

/**
 * Get a regex for matching the trigger tag.
 */
export function getTriggerRegex(triggerTag?: string): RegExp {
  const normalized = (triggerTag ?? '@donmerge').trim();
  if (!normalized) {
    return /@donmerge/i;
  }
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped, 'i');
}
