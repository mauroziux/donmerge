/**
 * FixPromptBuilder - Fluent API for constructing auto-fix LLM prompts.
 *
 * Mirrors TriagePromptBuilder pattern from the triage prompts.
 */

import type { SentryTriageOutput } from '../types';
import { sanitizeSentryData, sanitizeSentryTitle } from './sanitizers';
import { FIX_OUTPUT_SCHEMA } from './fix-schema';
import {
  FIX_SYSTEM_PROMPT,
  FIX_RULES,
  FIX_CONTEXT_HEADER,
  FIX_SOURCE_HEADER,
  FIX_OUTPUT_HEADER,
} from './fix-templates';

export interface FixPromptContext {
  triageOutput: SentryTriageOutput;
  targetFile: string;
  fileContent: string;
  allAffectedFiles: string[];
  sentryExceptionType: string;
  sentryExceptionValue: string;
}

export class FixPromptBuilder {
  private sections: string[] = [];
  private context?: FixPromptContext;

  withContext(context: FixPromptContext): this {
    this.context = context;
    return this;
  }

  build(): string {
    if (!this.context) {
      throw new Error('FixPromptBuilder: context is required. Call withContext() first.');
    }

    this.sections = [];

    // 1. System prompt
    this.addSection(FIX_SYSTEM_PROMPT);

    // 2. Rules
    this.addSection(FIX_RULES);

    // 3. Triage analysis context
    const { triageOutput } = this.context;
    this.addSection([
      FIX_CONTEXT_HEADER,
      '',
      `Root Cause: ${sanitizeSentryData(triageOutput.root_cause)}`,
      `Suggested Fix: ${sanitizeSentryData(triageOutput.suggested_fix)}`,
      `Confidence: ${triageOutput.confidence}`,
      `Severity: ${triageOutput.severity}`,
      `Affected Files: ${this.context.allAffectedFiles.join(', ')}`,
      `Exception: ${sanitizeSentryData(this.context.sentryExceptionType)}: ${sanitizeSentryData(this.context.sentryExceptionValue)}`,
    ].join('\n'));

    // 4. Source code of the target file
    const header = FIX_SOURCE_HEADER.replace('{file_path}', this.context.targetFile);
    this.addSection([
      header,
      '',
      sanitizeSentryData(this.context.fileContent, 15000),
    ].join('\n'));

    // 5. Output schema
    this.addSection([FIX_OUTPUT_HEADER, FIX_OUTPUT_SCHEMA].join('\n'));

    return this.sections.join('\n\n');
  }

  private addSection(section: string): void {
    this.sections.push(section);
  }
}

export function buildFixPrompt(context: FixPromptContext): string {
  return new FixPromptBuilder().withContext(context).build();
}
