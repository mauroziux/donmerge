/**
 * Tests for crypto.ts
 */

import { describe, it, expect } from 'vitest';
import { pemToArrayBuffer, base64UrlFromBuffer, timingSafeEqual } from '../crypto';
import { SAMPLE_PEM_KEY, PEM_WITH_ESCAPED_NEWLINES } from './helpers';

describe('pemToArrayBuffer', () => {
  it('should convert a standard PEM key to ArrayBuffer', () => {
    const result = pemToArrayBuffer(SAMPLE_PEM_KEY);
    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(result.byteLength).toBeGreaterThan(0);
  });

  it('should handle PEM with escaped newlines (\\n)', () => {
    const result = pemToArrayBuffer(PEM_WITH_ESCAPED_NEWLINES);
    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(result.byteLength).toBeGreaterThan(0);
  });

  it('should handle PEM with CRLF line endings', () => {
    const pem = '-----BEGIN PRIVATE KEY-----\r\nMIGHAgEA\r\n-----END PRIVATE KEY-----';
    const result = pemToArrayBuffer(pem);
    expect(result).toBeInstanceOf(ArrayBuffer);
  });

  it('should handle PEM with no whitespace between header/footer and content', () => {
    const pem = '-----BEGIN PRIVATE KEY-----MIGHAgEA-----END PRIVATE KEY-----';
    const result = pemToArrayBuffer(pem);
    expect(result).toBeInstanceOf(ArrayBuffer);
  });

  it('should handle invalid base64 by stripping non-base64 chars', () => {
    // pemToArrayBuffer strips non-base64 chars then decodes - only truly
    // broken base64 (wrong padding etc.) throws
    const result = pemToArrayBuffer('not valid base64!!!');
    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(result.byteLength).toBeGreaterThan(0);
  });

  it('should throw for truly un-decodable base64 content', () => {
    // Length-1 base64 after stripping is invalid (padding won't help)
    expect(() => pemToArrayBuffer('-----BEGIN PRIVATE KEY-----\nA\n-----END PRIVATE KEY-----')).toThrow(
      /Failed to parse PEM key/
    );
  });

  it('should add base64 padding if needed', () => {
    // 'SGVsbG8' is base64 for 'Hello' without padding
    const pem = '-----BEGIN PRIVATE KEY-----\nSGVsbG8\n-----END PRIVATE KEY-----';
    const result = pemToArrayBuffer(pem);
    expect(result).toBeInstanceOf(ArrayBuffer);
    // 'Hello' = 5 bytes
    expect(result.byteLength).toBe(5);
  });
});

describe('base64UrlFromBuffer', () => {
  it('should convert an ArrayBuffer to base64url encoding', () => {
    const input = new TextEncoder().encode('hello world');
    const result = base64UrlFromBuffer(input.buffer as ArrayBuffer);
    expect(result).toBe('aGVsbG8gd29ybGQ');
  });

  it('should replace + with - and / with _', () => {
    // '\xff\xff' in base64 is '//8='
    const input = new Uint8Array([0xff, 0xff]);
    const result = base64UrlFromBuffer(input.buffer as ArrayBuffer);
    // base64: "//8=" -> base64url: "__8"
    expect(result).not.toContain('+');
    expect(result).not.toContain('/');
    expect(result).toBe('__8');
  });

  it('should strip trailing = padding', () => {
    const input = new TextEncoder().encode('hi');
    const result = base64UrlFromBuffer(input.buffer as ArrayBuffer);
    expect(result).not.toContain('=');
  });

  it('should handle empty buffer', () => {
    const input = new Uint8Array([]);
    const result = base64UrlFromBuffer(input.buffer);
    expect(result).toBe('');
  });
});

describe('timingSafeEqual', () => {
  it('should return true for equal strings', () => {
    expect(timingSafeEqual('abc123', 'abc123')).toBe(true);
  });

  it('should return false for different strings of same length', () => {
    expect(timingSafeEqual('abc123', 'abc124')).toBe(false);
  });

  it('should return false for strings of different length', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });

  it('should return false for empty vs non-empty', () => {
    expect(timingSafeEqual('', 'a')).toBe(false);
  });

  it('should return true for two empty strings', () => {
    expect(timingSafeEqual('', '')).toBe(true);
  });
});
