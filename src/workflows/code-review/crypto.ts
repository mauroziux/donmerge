/**
 * Cryptographic utilities for GitHub App authentication and webhook verification.
 */

/**
 * Convert a PEM-formatted private key to an ArrayBuffer for Web Crypto API.
 */
export function pemToArrayBuffer(pem: string): ArrayBuffer {
  // Handle various PEM formats and normalize
  let normalized = pem
    // Handle escaped newlines from different sources
    .replace(/\\n/g, '\n')
    .replace(/\\r\\n/g, '\n')
    .replace(/\r\n/g, '\n')
    // Remove PEM headers/footers (handle variations)
    .replace(/-----BEGIN[^-]*PRIVATE KEY[^-]*-----/gi, '')
    .replace(/-----END[^-]*PRIVATE KEY[^-]*-----/gi, '')
    // Remove all whitespace (newlines, spaces, tabs, etc.)
    .replace(/\s+/g, '');

  // Validate base64 characters only
  const base64Regex = /^[A-Za-z0-9+/=]+$/;
  if (!base64Regex.test(normalized)) {
    // Try to clean up any remaining invalid characters
    normalized = normalized.replace(/[^A-Za-z0-9+/=]/g, '');
  }

  // Add padding if needed
  const paddingNeeded = (4 - (normalized.length % 4)) % 4;
  normalized += '='.repeat(paddingNeeded);

  try {
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes.buffer;
  } catch (error) {
    throw new Error(
      `Failed to parse PEM key: ${error instanceof Error ? error.message : 'invalid base64'}. ` +
        `Key length: ${pem.length}, normalized length: ${normalized.length}`
    );
  }
}

/**
 * Convert an ArrayBuffer to base64 URL encoding.
 */
export function base64UrlFromBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/**
 * Timing-safe string comparison to prevent timing attacks.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return mismatch === 0;
}
