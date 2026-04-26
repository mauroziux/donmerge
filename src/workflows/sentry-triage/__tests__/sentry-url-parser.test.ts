/**
 * Tests for sentry-url-parser.ts
 */

import { describe, it, expect } from 'vitest';
import { parseSentryUrl } from '../sentry-url-parser';

describe('parseSentryUrl', () => {
  // ── Organizations pattern ──────────────────────────────────────────

  describe('organizations/{org}/issues/{id}/ pattern', () => {
    it('should parse with trailing slash', () => {
      const result = parseSentryUrl('https://sentry.io/organizations/acme/issues/12345/');
      expect(result).toEqual({
        org: 'acme',
        issueId: '12345',
        originalUrl: 'https://sentry.io/organizations/acme/issues/12345/',
      });
    });

    it('should parse without trailing slash', () => {
      const result = parseSentryUrl('https://sentry.io/organizations/acme/issues/12345');
      expect(result).toEqual({
        org: 'acme',
        issueId: '12345',
        originalUrl: 'https://sentry.io/organizations/acme/issues/12345',
      });
    });

    it('should parse with hyphenated org name', () => {
      const result = parseSentryUrl('https://sentry.io/organizations/my-org/issues/99/');
      expect(result.org).toBe('my-org');
      expect(result.issueId).toBe('99');
    });

    it('should parse with underscored org name', () => {
      const result = parseSentryUrl('https://sentry.io/organizations/my_org/issues/42/');
      expect(result.org).toBe('my_org');
    });
  });

  // ── Subdomain pattern ──────────────────────────────────────────────

  describe('{org}.sentry.io/issues/{id}/ pattern', () => {
    it('should parse with trailing slash', () => {
      const result = parseSentryUrl('https://acme.sentry.io/issues/67890/');
      expect(result).toEqual({
        org: 'acme',
        issueId: '67890',
        originalUrl: 'https://acme.sentry.io/issues/67890/',
      });
    });

    it('should parse without trailing slash', () => {
      const result = parseSentryUrl('https://acme.sentry.io/issues/67890');
      expect(result).toEqual({
        org: 'acme',
        issueId: '67890',
        originalUrl: 'https://acme.sentry.io/issues/67890',
      });
    });

    it('should parse with hyphenated org name', () => {
      const result = parseSentryUrl('https://my-team.sentry.io/issues/111/');
      expect(result.org).toBe('my-team');
    });

    it('should parse with underscored org name', () => {
      const result = parseSentryUrl('https://my_team.sentry.io/issues/222/');
      expect(result.org).toBe('my_team');
    });
  });

  // ── Whitespace handling ─────────────────────────────────────────────

  it('should trim leading whitespace', () => {
    const result = parseSentryUrl('  https://sentry.io/organizations/acme/issues/12345/');
    expect(result.org).toBe('acme');
    expect(result.issueId).toBe('12345');
  });

  it('should trim trailing whitespace', () => {
    const result = parseSentryUrl('https://sentry.io/organizations/acme/issues/12345/  ');
    expect(result.org).toBe('acme');
    expect(result.issueId).toBe('12345');
  });

  it('should trim both leading and trailing whitespace', () => {
    const result = parseSentryUrl('  https://acme.sentry.io/issues/99/  ');
    expect(result.org).toBe('acme');
    expect(result.issueId).toBe('99');
  });

  // ── URL with query parameters ───────────────────────────────────────

  it('should handle URLs with query parameters (organizations pattern)', () => {
    // The regex has no $ anchor, so query params after trailing slash are ignored
    const result = parseSentryUrl('https://sentry.io/organizations/acme/issues/12345/?referrer=alert');
    expect(result.org).toBe('acme');
    expect(result.issueId).toBe('12345');
  });

  it('should handle URLs with query parameters (subdomain pattern)', () => {
    const result = parseSentryUrl('https://acme.sentry.io/issues/67890/?referrer=alert');
    expect(result.org).toBe('acme');
    expect(result.issueId).toBe('67890');
  });

  // ── Invalid URLs ────────────────────────────────────────────────────

  describe('invalid URLs', () => {
    it('should throw for empty string', () => {
      expect(() => parseSentryUrl('')).toThrow('Invalid Sentry issue URL');
    });

    it('should throw for whitespace-only string', () => {
      expect(() => parseSentryUrl('   ')).toThrow('Invalid Sentry issue URL');
    });

    it('should throw for non-Sentry URL', () => {
      expect(() => parseSentryUrl('https://example.com/foo')).toThrow(
        'Invalid Sentry issue URL'
      );
    });

    it('should throw for Sentry URL without org/issues pattern', () => {
      expect(() => parseSentryUrl('https://sentry.io/settings/')).toThrow(
        'Invalid Sentry issue URL'
      );
    });

    it('should throw for URL with http (not https)', () => {
      expect(() => parseSentryUrl('http://sentry.io/organizations/acme/issues/12345/')).toThrow(
        'Invalid Sentry issue URL'
      );
    });

    it('should include the input URL in the error message', () => {
      expect(() => parseSentryUrl('not-a-url')).toThrow('"not-a-url"');
    });

    it('should include expected format in the error message', () => {
      expect(() => parseSentryUrl('bad')).toThrow('Expected format');
    });
  });
});
