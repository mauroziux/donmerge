/**
 * Input sanitization for Sentry triage prompts.
 * Prevents prompt injection attacks from Sentry data.
 */

import type { SentryEvent } from '../types';

/**
 * Sanitize raw Sentry data for prompt inclusion.
 * Strips control characters and truncates to maxLength.
 */
export function sanitizeSentryData(data: string, maxLength = 30000): string {
  return data
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .slice(0, maxLength)
    .trim();
}

/**
 * Sanitize a Sentry issue title for prompt inclusion.
 * Removes injection prefixes, escapes backticks, normalizes unicode.
 */
export function sanitizeSentryTitle(title: string): string {
  return title
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/^(system|user|assistant|instruction|ignore|override|disregard):/gim, '')
    .replace(/```/g, '\\`\\`\\`')
    .normalize('NFC')
    .slice(0, 500)
    .trim();
}

/**
 * Format a Sentry event for prompt inclusion.
 * Includes exceptions with stack traces (in-app marker), context lines,
 * breadcrumbs, and tags.
 */
export function formatEventForPrompt(event: SentryEvent): string {
  const lines: string[] = [];

  lines.push(`--- Event ${event.id} (${event.timestamp}) ---`);

  // Exceptions
  if (event.exceptions) {
    for (const exc of event.exceptions) {
      lines.push(`Exception: ${exc.type}: ${exc.value}`);
      lines.push('Stack trace:');

      // Reverse frames so they're in chronological order (most recent last)
      const frames = [...exc.stacktrace.frames].reverse();
      for (const frame of frames) {
        const marker = frame.inApp ? '→' : ' ';
        const func = frame.function || '<anonymous>';
        const location = `${frame.filename}:${frame.lineno}:${frame.colno}`;
        lines.push(`  ${marker} ${func} at ${location}`);

        // Context lines (last 5)
        if (frame.context && frame.context.length > 0) {
          const contextLines = frame.context.slice(-5);
          for (const [lineNo, content] of contextLines) {
            const prefix = lineNo === frame.lineno ? '>' : ' ';
            lines.push(`    ${prefix} ${lineNo}: ${content}`);
          }
        }
      }
    }
  }

  // Breadcrumbs (last 10)
  if (event.breadcrumbs && event.breadcrumbs.length > 0) {
    lines.push('Breadcrumbs (last 10):');
    const crumbs = event.breadcrumbs.slice(-10);
    for (const crumb of crumbs) {
      lines.push(`  [${crumb.category}] ${crumb.message}`);
    }
  }

  // Tags
  if (event.tags && event.tags.length > 0) {
    lines.push(`Tags: ${event.tags.map((t) => `${t.key}=${t.value}`).join(', ')}`);
  }

  return lines.join('\n');
}
