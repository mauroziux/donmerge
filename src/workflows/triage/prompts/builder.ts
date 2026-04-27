/**
 * TriagePromptBuilder - Fluent API for constructing triage prompts.
 *
 * Mirrors ReviewPromptBuilder pattern from code-review workflow.
 */

import type { ErrorContext, TriageOptions } from '../types';
import { sanitizeData, sanitizeTitle } from './sanitizers';
import { TRIAGE_OUTPUT_SCHEMA } from './schema';
import {
  SYSTEM_PROMPT,
  CRITICAL_RULES,
  ERROR_CONTEXT_HEADER,
  SOURCE_CODE_HEADER,
  OUTPUT_SCHEMA_HEADER,
  SEVERITY_GUIDELINES,
} from './templates';

/**
 * Context for building a triage prompt.
 */
export interface TriagePromptContext {
  errorContext: ErrorContext;
  sourceCode: Map<string, string>;
  sha: string;
  repo: string;
  options?: TriageOptions;
}

/**
 * Builder class for constructing triage prompts.
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

    // 3. Error context section
    this.addErrorContextSection();

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
   * Build the error context section with title, description, stack trace, and metadata.
   */
  private addErrorContextSection(): void {
    const { errorContext } = this.context!;
    const lines: string[] = [ERROR_CONTEXT_HEADER, ''];

    lines.push(`Title: ${sanitizeTitle(errorContext.title)}`);
    lines.push(`Description: ${sanitizeData(errorContext.description, 5000)}`);
    lines.push(`Stack Trace:\n${sanitizeData(errorContext.stack_trace, 10000)}`);
    lines.push(`Affected Files: ${errorContext.affected_files.join(', ')}`);

    if (errorContext.severity) {
      lines.push(`Severity: ${errorContext.severity}`);
    }
    if (errorContext.environment) {
      lines.push(`Environment: ${errorContext.environment}`);
    }

    // Include any additional metadata
    if (errorContext.metadata) {
      const metaEntries = Object.entries(errorContext.metadata);
      if (metaEntries.length > 0) {
        lines.push('Metadata:');
        for (const [key, value] of metaEntries) {
          lines.push(`  ${key}: ${sanitizeData(String(value), 500)}`);
        }
      }
    }

    if (errorContext.source_url) {
      lines.push(`Source URL: ${errorContext.source_url}`);
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
      lines.push(sanitizeData(truncated, 5000));
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
 * Build a triage prompt using the default configuration.
 * Convenience function for the common case.
 */
export function buildTriagePrompt(context: TriagePromptContext): string {
  return new TriagePromptBuilder()
    .withContext(context)
    .build();
}
