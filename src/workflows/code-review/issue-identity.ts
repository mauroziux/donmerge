/**
 * Issue identity utilities for tracked issues.
 */

import { base64UrlFromBuffer } from './crypto';
import type { ReviewComment } from './types';

export interface IssueIdentityInput {
  ruleId: string;
  entityType: string;
  symbolName: string;
  filePath: string;
  codeSnippet: string;
}

export function normalizeCodeSnippet(snippet: string): string {
  return snippet
    .replace(/`[^`]*`/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function normalizeRuleId(value: string | undefined): string | undefined {
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

export function normalizeSymbolName(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim();
  return normalized || undefined;
}

export function normalizeEntityType(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (!['method', 'function', 'class', 'variable', 'module'].includes(normalized)) {
    return undefined;
  }
  return normalized;
}

export function buildLogicalKey(input: IssueIdentityInput): string {
  return `${input.ruleId}|${input.entityType}|${input.symbolName}`.toLowerCase();
}

export function buildAnchorKey(input: IssueIdentityInput): string {
  return `${input.filePath}|${normalizeCodeSnippet(input.codeSnippet)}`.toLowerCase();
}

export async function hashIdentity(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlFromBuffer(digest);
}

export async function computeSnippetHash(snippet: string): Promise<string> {
  return hashIdentity(normalizeCodeSnippet(snippet));
}

export async function computeFingerprint(input: IssueIdentityInput): Promise<string> {
  const logicalKey = buildLogicalKey(input);
  const anchorKey = buildAnchorKey(input);
  return hashIdentity(`${logicalKey}|${anchorKey}`);
}

export function ensureIdentityDefaults(comment: ReviewComment): ReviewComment {
  const ruleId = normalizeRuleId(comment.ruleId);
  const entityType = normalizeEntityType(comment.entityType) ?? 'module';
  const symbolName = normalizeSymbolName(comment.symbolName) ?? comment.path;
  const codeSnippet = comment.codeSnippet ?? '';

  return {
    ...comment,
    ruleId,
    entityType,
    symbolName,
    codeSnippet,
  };
}
