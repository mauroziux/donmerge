/**
 * TriagePromptBuilder - Fluent API for constructing Sentry triage prompts.
 *
 * Mirrors ReviewPromptBuilder pattern from code-review workflow.
 */

import type { SentryIssueData, SentryTriageOptions } from '../types';
import { sanitizeSentryData, sanitizeSentryTitle, formatEventForPrompt } from './sanitizers';
import { TRIAGE_OUTPUT_SCHEMA } from './schema';
import {
  SYSTEM_PROMPT,
  CRITICAL_RULES,
  SENTRY_DATA_HEADER,
  SOURCE_CODE_HEADER,
  OUTPUT_SCHEMA_HEADER,
  SEVERITY_GUIDELINES,
} from './templates';

/**
 * Context for building a Sentry triage prompt.
 */
export interface TriagePromptContext {
  sentryData: SentryIssueData;
  sourceCode: Map<string, string>;
  sha: string;
  repo: string;
  options?: SentryTriageOptions;
}

/**
 * Builder class for constructing Sentry triage prompts.
 */
export class TriagePromptBuilder {
  private sections: string[] = [];
  private context?: TriagePromptContext;

  /**
   * Set the triage context.
   */
  withContext(context: TriagePromptContext): this {
    this.context = context;
    return this;
  }

  /**
   * Build the complete prompt string.
   */
  build(): string {
    if (!this.context) {
      throw new Error('TriagePromptBuilder: context is required. Call withContext() first.');
    }

    this.sections = [];

    // 1. System prompt
    this.addSection(SYSTEM_PROMPT);

    // 2. Critical rules
    this.addSection(CRITICAL_RULES);

    // 3. Sentry data section
    this.addSentryDataSection();

    // 4. Source code section
    this.addSourceCodeSection();

    // 5. Severity guidelines
    this.addSection(SEVERITY_GUIDELINES);

    // 6. Output schema
    this.addOutputSchemaSection();

    return this.sections.join('\n\n');
  }

  /**
   * Add a section to the prompt.
   */
  private addSection(section: string): void {
    this.sections.push(section);
  }

  /**
   * Build the Sentry data section with issue metadata and formatted events.
   */
  private addSentryDataSection(): void {
    const { sentryData } = this.context!;
    const lines: string[] = [SENTRY_DATA_HEADER, ''];

    lines.push(`Title: ${sanitizeSentryTitle(sentryData.title)}`);
    lines.push(`Platform: ${sentryData.platform}`);
    if (sentryData.environment) {
      lines.push(`Environment: ${sentryData.environment}`);
    }
    lines.push(`Event Count: ${sentryData.count}`);
    lines.push(`Users Affected: ${sentryData.userCount}`);
    lines.push(`First Seen: ${sentryData.firstSeen}`);
    lines.push(`Last Seen: ${sentryData.lastSeen}`);

    // Tags
    if (sentryData.tags && sentryData.tags.length > 0) {
      lines.push(`Tags: ${sentryData.tags.map((t) => `${t.key}=${t.value}`).join(', ')}`);
    }

    // Events
    if (sentryData.events && sentryData.events.length > 0) {
      lines.push('');
      lines.push('Events:');
      for (const event of sentryData.events) {
        const formatted = formatEventForPrompt(event);
        lines.push(sanitizeSentryData(formatted, 10000));
      }
    }

    this.addSection(lines.join('\n'));
  }

  /**
   * Build the source code section with file contents.
   */
  private addSourceCodeSection(): void {
    const { sourceCode, sha, repo } = this.context!;
    const header = SOURCE_CODE_HEADER.replace('{sha}', sha);

    if (sourceCode.size === 0) {
      this.addSection(`${header}\nNo relevant source code available at this commit.`);
      return;
    }

    const lines: string[] = [header, `Repository: ${repo}`, ''];

    let totalSize = 0;
    for (const [path, content] of sourceCode) {
      if (totalSize >= 25000) break;
      const truncated = content.length > 5000 ? content.slice(0, 5000) + '\n... [truncated]' : content;
      lines.push(`--- ${path} ---`);
      lines.push(sanitizeSentryData(truncated, 5000));
      lines.push('');
      totalSize += truncated.length;
    }

    this.addSection(lines.join('\n'));
  }

  /**
   * Build the output schema section.
   */
  private addOutputSchemaSection(): void {
    const lines = [
      OUTPUT_SCHEMA_HEADER,
      TRIAGE_OUTPUT_SCHEMA,
    ];
    this.addSection(lines.join('\n'));
  }
}

/**
 * Build a Sentry triage prompt using the default configuration.
 * Convenience function for the common case.
 */
export function buildTriagePrompt(context: TriagePromptContext): string {
  return new TriagePromptBuilder()
    .withContext(context)
    .build();
}
