/**
 * Parse Sentry issue URLs into org + issueId components.
 *
 * Supports two URL formats:
 * 1. https://sentry.io/organizations/{org}/issues/{id}/
 * 2. https://{org}.sentry.io/issues/{id}/
 */

import type { ParsedSentryUrl } from './types';

/**
 * Parse a Sentry issue URL into its org and issue ID components.
 *
 * @throws Error with descriptive message if URL format is unrecognized
 */
export function parseSentryUrl(url: string): ParsedSentryUrl {
  const trimmed = url.trim();

  // Pattern 1: https://sentry.io/organizations/{org}/issues/{id}/
  const orgPattern = /^https:\/\/sentry\.io\/organizations\/([^/]+)\/issues\/(\d+)\/?/;
  const orgMatch = trimmed.match(orgPattern);
  if (orgMatch) {
    return {
      org: orgMatch[1],
      issueId: orgMatch[2],
      originalUrl: trimmed,
    };
  }

  // Pattern 2: https://{org}.sentry.io/issues/{id}/
  const subdomainPattern = /^https:\/\/([a-zA-Z0-9_-]+)\.sentry\.io\/issues\/(\d+)\/?/;
  const subdomainMatch = trimmed.match(subdomainPattern);
  if (subdomainMatch) {
    return {
      org: subdomainMatch[1],
      issueId: subdomainMatch[2],
      originalUrl: trimmed,
    };
  }

  throw new Error(
    `Invalid Sentry issue URL: "${trimmed}". ` +
    'Expected format: https://sentry.io/organizations/{org}/issues/{id}/ ' +
    'or https://{org}.sentry.io/issues/{id}/'
  );
}
