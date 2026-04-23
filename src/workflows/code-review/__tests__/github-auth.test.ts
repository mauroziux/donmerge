/**
 * Tests for github-auth.ts (repo allowlist + webhook signature verification)
 *
 * Note: verifyWebhookSignature requires crypto.subtle (available in Node 15+).
 * We test the isRepoAllowed function which is pure logic.
 */

import { describe, it, expect } from 'vitest';
import { isRepoAllowed, verifyWebhookSignature } from '../github-auth';

describe('isRepoAllowed', () => {
  it('should allow all repos when config is undefined', () => {
    expect(isRepoAllowed('anyone', 'anything', undefined)).toBe(true);
  });

  it('should allow all repos when config is empty string', () => {
    expect(isRepoAllowed('anyone', 'anything', '')).toBe(true);
  });

  it('should allow a repo that is in the config', () => {
    expect(isRepoAllowed('tableoltd', 'repo1', 'tableoltd/repo1:main')).toBe(true);
  });

  it('should deny a repo that is not in the config', () => {
    expect(isRepoAllowed('other', 'repo', 'tableoltd/repo1:main')).toBe(false);
  });

  it('should be case-insensitive', () => {
    expect(isRepoAllowed('TABLEOLTD', 'REPO1', 'tableoltd/repo1:main')).toBe(true);
  });

  it('should work with multiple repos in config', () => {
    const config = 'tableoltd/repo1:main,tableoltd/repo2:develop,other/repo3';
    expect(isRepoAllowed('tableoltd', 'repo1', config)).toBe(true);
    expect(isRepoAllowed('tableoltd', 'repo2', config)).toBe(true);
    expect(isRepoAllowed('other', 'repo3', config)).toBe(true);
    expect(isRepoAllowed('unknown', 'repo', config)).toBe(false);
  });
});

describe('verifyWebhookSignature', () => {
  it('should return false for invalid header format', async () => {
    const result = await verifyWebhookSignature('secret', 'body', 'invalid-header');
    expect(result).toBe(false);
  });

  it('should return false for wrong secret', async () => {
    const result = await verifyWebhookSignature(
      'wrong-secret',
      '{"test": true}',
      'sha256=abcdef1234567890'
    );
    expect(result).toBe(false);
  });

  it('should verify a valid HMAC signature', async () => {
    const secret = 'my-webhook-secret';
    const body = '{"action":"opened"}';

    // Compute the expected HMAC
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
    const hex = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    const signature = `sha256=${hex}`;

    const result = await verifyWebhookSignature(secret, body, signature);
    expect(result).toBe(true);
  });

  it('should reject a tampered body even with correct header', async () => {
    const secret = 'my-webhook-secret';
    const body = '{"action":"opened"}';

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
    const hex = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    const signature = `sha256=${hex}`;

    // Tamper the body
    const result = await verifyWebhookSignature(secret, '{"action":"closed"}', signature);
    expect(result).toBe(false);
  });
});
