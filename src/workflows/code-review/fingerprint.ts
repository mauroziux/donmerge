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
 * Compute a stable fingerprint for a review comment.
 */
export async function computeFingerprint(input: {
  path: string;
  issueKey?: string;
  line: number;
  side?: string;
  severity?: string;
}): Promise<string> {
  const pieces = [input.path.trim().toLowerCase()];
  if (input.issueKey) {
    pieces.push(input.issueKey.trim().toLowerCase());
  } else {
    pieces.push(String(input.line));
    if (input.side) pieces.push(input.side.trim().toLowerCase());
    if (input.severity) pieces.push(input.severity.trim().toLowerCase());
  }
  const text = pieces.join('|');
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlFromBuffer(digest);
}
