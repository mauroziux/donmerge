/**
 * ReviewPromptBuilder - Fluent API for constructing code review prompts.
 *
 * This builder provides a clean, testable way to construct prompts while:
 * - Preventing prompt injection via input sanitization
 * - Keeping prompt templates separate from business logic
 */

import type { PreviousComment, RepoContext, DonmergeResolved } from '../types';
import { sanitizePromptInput, sanitizeDiffText } from './sanitizers';
import { REVIEW_OUTPUT_SCHEMA } from './schema';
import {
  SYSTEM_PROMPT,
  PERSONALITY_SECTION,
  CRITICAL_RULES,
  COMMENT_FORMAT,
  EXAMPLE_COMMENT,
  LANGUAGE_GUIDELINES,
  CUSTOM_INSTRUCTION_TEMPLATE,
  PREVIOUS_COMMENTS_HEADER,
  DONMERGE_SKILLS_HEADER,
  DONMERGE_INSTRUCTION_TEMPLATE,
  APPROVAL_RULES,
  APPROVAL_RULES_WITH_FILE_SUMMARIES,
} from './templates';

/**
 * Context for building a review prompt.
 */
export interface ReviewPromptContext {
  owner: string;
  repo: string;
  prNumber: number;
  retrigger: boolean;
  instruction?: string;
  previousComments?: PreviousComment[];
  diffText: string;
  repoContext?: RepoContext;
}

/**
 * Options for the prompt builder.
 */
export interface PromptBuilderOptions {
  /** Include example comment in prompt (default: true) */
  includeExample?: boolean;
  /** Require fileSummaries in output (default: false) */
  requireFileSummaries?: boolean;
}

/**
 * Builder class for constructing code review prompts.
 *
 * @example
 * ```typescript
 * const prompt = new ReviewPromptBuilder()
 *   .withContext(ctx)
 *   .withCustomInstruction(instruction)
 *   .withPreviousComments(comments)
 *   .build();
 * ```
 */
export class ReviewPromptBuilder {
  private sections: string[] = [];
  private context?: ReviewPromptContext;
  private options: PromptBuilderOptions;
  private customInstruction?: string;
  private previousComments?: PreviousComment[];
  private repoContext?: RepoContext;
  private donmergeResolved?: DonmergeResolved;

  constructor(options: PromptBuilderOptions = {}) {
    this.options = {
      includeExample: true,
      requireFileSummaries: false,
      ...options,
    };
  }

  /**
   * Set the review context (owner, repo, PR number, etc.)
   */
  withContext(context: ReviewPromptContext): this {
    this.context = context;
    return this;
  }

  /**
   * Add a custom instruction from the developer.
   * Input is automatically sanitized to prevent prompt injection.
   */
  withCustomInstruction(instruction: string | undefined): this {
    if (instruction && instruction.trim()) {
      this.customInstruction = sanitizePromptInput(instruction);
    }
    return this;
  }

  /**
   * Add previous comments for retrigger reviews.
   */
  withPreviousComments(comments: PreviousComment[] | undefined): this {
    if (comments && comments.length > 0) {
      this.previousComments = comments;
    }
    return this;
  }

  /**
   * Add repository context (standards, configs, docs).
   */
  withRepoContext(context: RepoContext | undefined): this {
    this.repoContext = context;
    return this;
  }

  /**
   * Add resolved .donmerge configuration (skills content + custom instructions).
   */
  withDonmergeConfig(resolved: DonmergeResolved | undefined): this {
    this.donmergeResolved = resolved;
    return this;
  }

  /**
   * Build the complete prompt string.
   */
  build(): string {
    if (!this.context) {
      throw new Error('ReviewPromptBuilder: context is required. Call withContext() first.');
    }

    this.sections = [];

    // 1. System prompt and personality
    this.addSection(SYSTEM_PROMPT);
    this.addSection(PERSONALITY_SECTION);

    // 2. Critical rules
    this.addSection(CRITICAL_RULES);

    // 3. Comment format
    this.addSection(COMMENT_FORMAT);

    // 4. Example (optional)
    if (this.options.includeExample) {
      this.addSection(EXAMPLE_COMMENT);
    }

    // 5. Language guidelines
    this.addSection(LANGUAGE_GUIDELINES);

    // 6. Repository context (if provided) - before custom instruction
    if (this.repoContext) {
      this.addRepoContextSection();
    }

    // 6.5. .donmerge skills context (if provided)
    if (this.donmergeResolved && this.donmergeResolved.skillsContent.size > 0) {
      this.addDonmergeSkillsSection();
    }

    // 7. Custom instruction (if provided)
    if (this.customInstruction) {
      this.addSection(
        CUSTOM_INSTRUCTION_TEMPLATE.replace('{instruction}', this.customInstruction)
      );
    }

    // 7.5. .donmerge custom instructions (if provided, sanitized)
    if (this.donmergeResolved?.config.instructions?.trim()) {
      const sanitized = sanitizePromptInput(this.donmergeResolved.config.instructions);
      this.addSection(
        DONMERGE_INSTRUCTION_TEMPLATE.replace('{instruction}', sanitized)
      );
    }

    // 8. Previous comments (if retrigger)
    if (this.context.retrigger && this.previousComments && this.previousComments.length > 0) {
      this.addPreviousCommentsSection();
    }

    // 9. Output schema
    this.addOutputSchemaSection();

    // 10. Repository context
    this.addRepositoryContext();

    // 11. Diff to review
    this.addDiffSection();

    return this.sections.join('\n\n');
  }

  /**
   * Add a section to the prompt.
   */
  private addSection(section: string): void {
    this.sections.push(section);
  }

  /**
   * Add the previous comments section.
   */
  private addPreviousCommentsSection(): void {
    const lines = [PREVIOUS_COMMENTS_HEADER, ''];

    this.previousComments!.forEach((comment, index) => {
      const truncatedBody =
        comment.body.length > 200
          ? `${comment.body.substring(0, 200)}...`
          : comment.body;
      lines.push(`[${index + 1}] ID:${comment.id} | File:${comment.path}:${comment.line}`);
      lines.push(`    ${truncatedBody}`);
    });

    this.addSection(lines.join('\n'));
  }

  /**
   * Add the output schema section.
   */
  private addOutputSchemaSection(): void {
    const rules = this.options.requireFileSummaries
      ? APPROVAL_RULES_WITH_FILE_SUMMARIES
      : APPROVAL_RULES;

    const lines = [
      'Produce your review as JSON matching this schema:',
      REVIEW_OUTPUT_SCHEMA,
      '',
      rules,
    ];

    this.addSection(lines.join('\n'));
  }

  /**
   * Add repository context section.
   */
  private addRepositoryContext(): void {
    const { owner, repo, prNumber, retrigger } = this.context!;
    const lines = [
      `Repository: ${owner}/${repo}`,
      `PR Number: ${prNumber}`,
      `Is Retrigger: ${retrigger}`,
    ];
    this.addSection(lines.join('\n'));
  }

  /**
   * Add the diff section.
   */
  private addDiffSection(): void {
    const sanitizedDiff = sanitizeDiffText(this.context!.diffText);
    const lines = ['DIFF TO REVIEW:', sanitizedDiff];
    this.addSection(lines.join('\n'));
  }

  /**
   * Add the repository context section (standards, configs, docs).
   */
  private addRepoContextSection(): void {
    const sections: string[] = [];

    // Standards/Instructions
    if (this.repoContext!.agents) {
      sections.push('--- AGENTS.md (Project AI Instructions) ---');
      sections.push(this.repoContext!.agents);
    }
    if (this.repoContext!.cursorrules) {
      sections.push('--- .cursorrules (Cursor IDE Rules) ---');
      sections.push(this.repoContext!.cursorrules);
    }
    if (this.repoContext!.claude) {
      sections.push('--- CLAUDE.md (Claude AI Instructions) ---');
      sections.push(this.repoContext!.claude);
    }
    if (this.repoContext!.contributing) {
      sections.push('--- CONTRIBUTING.md ---');
      sections.push(this.repoContext!.contributing);
    }
    if (this.repoContext!.development) {
      sections.push('--- DEVELOPMENT.md ---');
      sections.push(this.repoContext!.development);
    }

    // Config files
    if (this.repoContext!.packageJson) {
      sections.push('--- package.json (Dependencies & Scripts) ---');
      sections.push(this.repoContext!.packageJson);
    }
    if (this.repoContext!.tsconfig) {
      sections.push('--- tsconfig.json (TypeScript Config) ---');
      sections.push(this.repoContext!.tsconfig);
    }
    if (this.repoContext!.eslint) {
      sections.push('--- ESLint Config ---');
      sections.push(this.repoContext!.eslint);
    }
    if (this.repoContext!.prettier) {
      sections.push('--- Prettier Config ---');
      sections.push(this.repoContext!.prettier);
    }
    if (this.repoContext!.biome) {
      sections.push('--- biome.json (Biome Linter Config) ---');
      sections.push(this.repoContext!.biome);
    }

    // Documentation
    if (this.repoContext!.readme) {
      sections.push('--- README.md ---');
      sections.push(this.repoContext!.readme);
    }

    if (sections.length === 0) {
      return;
    }

    const lines = [
      '📚 REPOSITORY CONTEXT (check code against these standards):',
      '',
      ...sections,
      '',
      'IMPORTANT: Review the code changes against the standards and patterns defined above.',
    ];
    this.addSection(lines.join('\n'));
  }

  /**
   * Add the .donmerge skills context section.
   */
  private addDonmergeSkillsSection(): void {
    const lines = [DONMERGE_SKILLS_HEADER, ''];
    const { config, skillsContent } = this.donmergeResolved!;

    for (const skill of config.skills ?? []) {
      const content = skillsContent.get(skill.path);
      if (content) {
        lines.push(`--- ${sanitizePromptInput(skill.path)} (${sanitizePromptInput(skill.description)}) ---`);
        lines.push(sanitizeDiffText(content));
      }
    }

    lines.push('');
    lines.push('IMPORTANT: Use the above project context to inform your review.');

    this.addSection(lines.join('\n'));
  }
}

/**
 * Build a review prompt using the default configuration.
 * This is a convenience function for the common case.
 *
 * @param context - The review context
 * @param options - Optional builder options
 * @returns The complete prompt string
 */
export function buildReviewPrompt(
  context: ReviewPromptContext,
  options?: PromptBuilderOptions & { donmergeResolved?: DonmergeResolved }
): string {
  return new ReviewPromptBuilder(options)
    .withContext(context)
    .withCustomInstruction(context.instruction)
    .withPreviousComments(context.previousComments)
    .withRepoContext(context.repoContext)
    .withDonmergeConfig(options?.donmergeResolved)
    .build();
}
