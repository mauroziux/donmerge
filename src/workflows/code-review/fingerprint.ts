/**
 * Fingerprint utilities for DonMerge review comments.
 *
 * Provides stable, content-based identifiers to deduplicate comments
 * across re-runs and synchronize events.
 */

import { base64UrlFromBuffer } from './crypto';

const FINGERPRINT_VERSION = 1;
const MARKER_PREFIX = '<!-- DONMERGE:';

export interface CommentFingerprintMetadata {
  fingerprint: string;
  version: number;
}

/**
 * Parse fingerprint metadata from an existing comment body.
 */
export function parseFingerprint(body: string): CommentFingerprintMetadata | null {
  const markerIndex = body.indexOf(MARKER_PREFIX);
  if (markerIndex === -1) {
    return null;
  }

  const endIndex = body.indexOf('-->', markerIndex);
  if (endIndex === -1) {
    return null;
  }

  const raw = body.substring(markerIndex + MARKER_PREFIX.length, endIndex).trim();
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as { fingerprint?: unknown; version?: unknown };
    if (typeof parsed.fingerprint === 'string' && typeof parsed.version === 'number') {
      return { fingerprint: parsed.fingerprint, version: parsed.version };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Add fingerprint metadata to a comment body.
 */
export function attachFingerprint(body: string, fingerprint: string): string {
  const metadata: CommentFingerprintMetadata = {
    fingerprint,
    version: FINGERPRINT_VERSION,
  };
  return `${MARKER_PREFIX} ${JSON.stringify(metadata)} -->\n\n${body}`;
}

/**
 * Normalize a comment body for hashing.
 */
export function normalizeCommentBody(body: string): string {
  const lines = body.split('\n');
  const normalizedLines: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) {
      continue;
    }

    if (!trimmed) {
      continue;
    }

    const cleaned = trimmed
      .replace(/[`*#_>]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleaned) {
      continue;
    }

    normalizedLines.push(cleaned.toLowerCase());
  }

  return normalizedLines.join(' ');
}

/**
 * Compute a stable fingerprint for a review comment.
 */
export async function computeFingerprint(input: {
  path: string;
  body: string;
  severity?: string;
}): Promise<string> {
  const normalizedBody = normalizeCommentBody(input.body);
  const pieces = [input.path.trim().toLowerCase(), normalizedBody];
  if (input.severity) {
    pieces.push(input.severity.trim().toLowerCase());
  }
  const text = pieces.join('|');
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlFromBuffer(digest);
}
