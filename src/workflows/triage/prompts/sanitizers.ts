/**
 * Input sanitization for triage prompts.
 * Prevents prompt injection attacks from external data.
 */

/**
 * Sanitize raw data for prompt inclusion.
 * Strips control characters and truncates to maxLength.
 */
export function sanitizeData(data: string, maxLength = 30000): string {
  return data
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .slice(0, maxLength)
    .trim();
}

/**
 * Sanitize a title for prompt inclusion.
 * Removes injection prefixes, escapes backticks, normalizes unicode.
 */
export function sanitizeTitle(title: string): string {
  return title
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/^(system|user|assistant|instruction|ignore|override|disregard):/gim, '')
    .replace(/```/g, '\\`\\`\\`')
    .normalize('NFC')
    .slice(0, 500)
    .trim();
}

// Backward-compatible aliases (deprecated — will be removed in a future release)
export const sanitizeSentryData = sanitizeData;
export const sanitizeSentryTitle = sanitizeTitle;
