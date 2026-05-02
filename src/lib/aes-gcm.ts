/**
 * AES-256-GCM encryption/decryption for tenant secrets.
 *
 * Uses the Web Crypto API (available in Cloudflare Workers runtime).
 * The encryption key is derived from a base64-encoded 256-bit key
 * stored in the `TENANT_ENCRYPTION_KEY` env var.
 *
 * Encrypted output format: `base64(iv):base64(ciphertext)` where IV is 12 bytes.
 */

const ALGORITHM = 'AES-GCM';
const IV_LENGTH = 12; // 96 bits, recommended for AES-GCM

/**
 * Import a base64-encoded 256-bit key for AES-GCM.
 */
async function importKey(base64Key: string): Promise<CryptoKey> {
  const rawKey = Uint8Array.from(atob(base64Key), (c) => c.charCodeAt(0));
  if (rawKey.length !== 32) {
    throw new Error(
      `TENANT_ENCRYPTION_KEY must be 32 bytes (256 bits), got ${rawKey.length} bytes. ` +
        'Generate with: openssl rand -base64 32'
    );
  }
  return crypto.subtle.importKey('raw', rawKey, { name: ALGORITHM }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 *
 * @returns `base64(iv):base64(ciphertext+authTag)` string
 */
export async function encrypt(
  base64Key: string,
  plaintext: string,
): Promise<string> {
  const key = await importKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new TextEncoder().encode(plaintext);

  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    key,
    encoded,
  );

  const ivB64 = btoa(String.fromCharCode(...iv));
  const ctB64 = btoa(String.fromCharCode(...new Uint8Array(ciphertext)));

  return `${ivB64}:${ctB64}`;
}

/**
 * Decrypt a value encrypted by `encrypt()`.
 *
 * @param base64Key - Same base64-encoded key used for encryption
 * @param encrypted - `base64(iv):base64(ciphertext+authTag)` string
 * @returns The original plaintext string
 * @throws Error if decryption fails (wrong key, tampered data, etc.)
 */
export async function decrypt(
  base64Key: string,
  encrypted: string,
): Promise<string> {
  const colonIdx = encrypted.indexOf(':');
  if (colonIdx === -1) {
    throw new Error('Invalid encrypted format: expected "iv:ciphertext"');
  }

  const ivB64 = encrypted.slice(0, colonIdx);
  const ctB64 = encrypted.slice(colonIdx + 1);

  const iv = Uint8Array.from(atob(ivB64), (c) => c.charCodeAt(0));
  const ciphertext = Uint8Array.from(atob(ctB64), (c) => c.charCodeAt(0));

  if (iv.length !== IV_LENGTH) {
    throw new Error(`Invalid IV length: expected ${IV_LENGTH}, got ${iv.length}`);
  }

  const key = await importKey(base64Key);

  const plaintext = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv },
    key,
    ciphertext,
  );

  return new TextDecoder().decode(plaintext);
}

/**
 * Generate a new random 256-bit key suitable for TENANT_ENCRYPTION_KEY.
 * Useful for bootstrapping; in production, use `openssl rand -base64 32`.
 */
export function generateKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes));
}
