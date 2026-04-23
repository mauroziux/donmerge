/**
 * Utilities for deriving stable issue keys from review comments.
 */

export function deriveIssueKey(comment: { issueKey?: string; body: string }): string | undefined {
  const normalizedProvided = normalizeIssueKey(comment.issueKey);
  const derivedFromBody = normalizeIssueKey(extractIssueSentence(comment.body));

  return derivedFromBody ?? normalizedProvided;
}

export function extractIssueSentence(body: string): string | undefined {
  const issueMatch = body.match(/\*\*Issue:\*\*\s*([^\n]+)/i);
  if (!issueMatch?.[1]) {
    return undefined;
  }

  return issueMatch[1]
    .replace(/`[^`]*`/g, ' ')
    .replace(/\b(compadre|che|ojo|mira)\b[:,.!]?/gi, ' ')
    .replace(/\b(this|that|the|a|an|so|now|which|when|on|in|at|to|for|of|and|or|it|is|are)\b/gi, ' ')
    .replace(/[^a-z0-9\s-]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeIssueKey(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter((segment) => segment.length > 1)
    .slice(0, 8)
    .join('-');

  return normalized || undefined;
}

export function buildIssueIdentity(path: string, issueKey: string | undefined): string | undefined {
  const normalizedIssueKey = normalizeIssueKey(issueKey);
  if (!normalizedIssueKey) {
    return undefined;
  }

  return `${path.trim().toLowerCase()}|${normalizedIssueKey}`;
}

export function extractIssueTerms(body: string): string[] {
  const sentence = extractIssueSentence(body);
  if (!sentence) {
    return [];
  }

  return sentence
    .toLowerCase()
    .replace(/`[^`]*`/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((term) => term.length > 2)
    .filter((term) => !STOP_WORDS.has(term));
}

const STOP_WORDS = new Set([
  'compadre',
  'che',
  'ojo',
  'mira',
  'this',
  'that',
  'with',
  'from',
  'into',
  'when',
  'will',
  'would',
  'could',
  'should',
  'there',
  'their',
  'about',
  'only',
  'through',
  'while',
  'because',
  'original',
  'condition',
  'comment',
  'value',
  'logic',
  'issue',
  'suggestion',
  'file',
]);
