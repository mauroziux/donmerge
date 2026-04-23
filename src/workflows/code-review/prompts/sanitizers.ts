/**
 * Input sanitization for prompt construction.
 * Prevents prompt injection attacks from user-provided content.
 */

/**
 * Sanitizes user input to prevent prompt injection.
 * Removes/escapes characters that could manipulate LLM behavior.
 *
 * @param input - Raw user input
 * @param maxLength - Maximum allowed length (default 2000)
 * @returns Sanitized input safe for prompt interpolation
 */
export function sanitizePromptInput(input: string, maxLength = 2000): string {
  return (
    input
      // Remove potential prompt injection patterns
      .replace(/^(system|user|assistant|instruction|ignore|override|disregard):/gim, '')
      // Escape triple backticks that could close code blocks
      .replace(/```/g, '\\`\\`\\`')
      // Remove null bytes and control characters (except newlines and tabs)
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
      // Normalize unicode
      .normalize('NFC')
      // Limit length to prevent abuse
      .slice(0, maxLength)
      // Trim whitespace
      .trim()
  );
}

/**
 * Sanitizes a diff text for prompt inclusion.
 * Less aggressive than user input sanitization - preserves code structure.
 *
 * @param diff - Raw diff text
 * @param maxLength - Maximum allowed length (default 50000)
 * @returns Sanitized diff text
 */
export function sanitizeDiffText(diff: string, maxLength = 50000): string {
  return (
    diff
      // Remove null bytes and control characters (except newlines and tabs)
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
      // Limit length
      .slice(0, maxLength)
      .trim()
  );
}
