/**
 * Tests for AES-256-GCM encrypt/decrypt helper.
 */

import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, generateKey } from '../aes-gcm';

describe('AES-GCM encrypt/decrypt', () => {
  it('should encrypt and decrypt a plaintext string', async () => {
    const key = generateKey();
    const plaintext = 'hello world';

    const encrypted = await encrypt(key, plaintext);
    const decrypted = await decrypt(key, encrypted);

    expect(decrypted).toBe(plaintext);
  });

  it('should produce different ciphertext for same plaintext (random IV)', async () => {
    const key = generateKey();
    const plaintext = 'same input';

    const encrypted1 = await encrypt(key, plaintext);
    const encrypted2 = await encrypt(key, plaintext);

    // Different IVs → different ciphertext
    expect(encrypted1).not.toBe(encrypted2);

    // But both decrypt to the same value
    expect(await decrypt(key, encrypted1)).toBe(plaintext);
    expect(await decrypt(key, encrypted2)).toBe(plaintext);
  });

  it('should handle empty string', async () => {
    const key = generateKey();
    const encrypted = await encrypt(key, '');
    const decrypted = await decrypt(key, encrypted);
    expect(decrypted).toBe('');
  });

  it('should handle unicode / long strings', async () => {
    const key = generateKey();
    const plaintext = '日本語テスト 🚀 '.repeat(100);

    const encrypted = await encrypt(key, plaintext);
    const decrypted = await decrypt(key, encrypted);

    expect(decrypted).toBe(plaintext);
  });

  it('should fail to decrypt with wrong key', async () => {
    const key1 = generateKey();
    const key2 = generateKey();
    const encrypted = await encrypt(key1, 'secret data');

    await expect(decrypt(key2, encrypted)).rejects.toThrow();
  });

  it('should fail to decrypt tampered ciphertext', async () => {
    const key = generateKey();
    const encrypted = await encrypt(key, 'secret data');

    // Tamper with the ciphertext part (after the colon)
    const [iv, ct] = encrypted.split(':');
    const tamperedCt = ct.slice(0, -2) + 'XX';
    const tampered = `${iv}:${tamperedCt}`;

    await expect(decrypt(key, tampered)).rejects.toThrow();
  });

  it('should fail for invalid format (no colon)', async () => {
    const key = generateKey();
    await expect(decrypt(key, 'invalid-no-colon')).rejects.toThrow(
      'Invalid encrypted format'
    );
  });

  it('should fail for key of wrong length', async () => {
    // 16-byte key instead of 32
    const shortKey = btoa(String.fromCharCode(...new Uint8Array(16)));
    await expect(encrypt(shortKey, 'test')).rejects.toThrow('32 bytes');
  });

  it('generateKey should produce a valid 256-bit key', async () => {
    const key = generateKey();
    const raw = Uint8Array.from(atob(key), (c) => c.charCodeAt(0));
    expect(raw.length).toBe(32);

    // Should be usable for encrypt/decrypt
    const encrypted = await encrypt(key, 'test');
    const decrypted = await decrypt(key, encrypted);
    expect(decrypted).toBe('test');
  });
});
