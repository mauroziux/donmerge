import type { AuthenticatedRequest } from './types';

/**
 * Validates API key from Authorization header.
 * Keys are stored in DONMERGE_API_KEYS env var (comma-separated).
 * Format: dm_live_* for production, dm_test_* for test.
 */
export function validateApiKey(
  authHeader: string | undefined,
  envApiKey: string | undefined
): AuthenticatedRequest | null {
  if (!authHeader || !envApiKey) return null;

  const match = authHeader.match(/^Bearer\s+(dm_(live|test)_[a-zA-Z0-9]+)$/i);
  if (!match) return null;

  const token = match[1];
  const type = match[2].toLowerCase() as 'live' | 'test';

  const validKeys = envApiKey.split(',').map((k) => k.trim());
  if (!validKeys.includes(token)) return null;

  return { apiKey: token, keyType: type };
}
