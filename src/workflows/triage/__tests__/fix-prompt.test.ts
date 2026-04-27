/**
 * Tests for prompts/fix-builder.ts
 */

import { describe, it, expect } from 'vitest';
import { FixPromptBuilder, buildFixPrompt } from '../prompts/fix-builder';
import type { FixPromptContext } from '../prompts/fix-builder';
import { createValidTriageOutput } from './helpers';

function createFixPromptContext(overrides: Partial<FixPromptContext> = {}): FixPromptContext {
  return {
    triageOutput: createValidTriageOutput({
      root_cause: 'Null pointer dereference in handleRequest',
      suggested_fix: 'Add null check before accessing property',
      confidence: 'high',
      severity: 'error',
      affected_files: ['src/index.ts'],
      stack_trace_summary: 'TypeError at src/index.ts:42 in handleRequest',
    }),
    targetFile: 'src/index.ts',
    fileContent: 'export function handleRequest() {\n  return data.foo;\n}',
    allAffectedFiles: ['src/index.ts'],
    errorTitle: 'TypeError: Cannot read property',
    errorDescription: 'Null pointer dereference in handleRequest',
    ...overrides,
  };
}

describe('FixPromptBuilder', () => {
  it('should throw when build() is called without context', () => {
    const builder = new FixPromptBuilder();
    expect(() => builder.build()).toThrow('context is required');
  });

  // ── All sections present ────────────────────────────────────────────

  it('should include system prompt', () => {
    const prompt = new FixPromptBuilder()
      .withContext(createFixPromptContext())
      .build();
    expect(prompt).toContain('DonMerge');
    expect(prompt).toContain('Fix Engineer');
    expect(prompt).toContain('COMPLETE patched file content');
  });

  it('should include critical rules', () => {
    const prompt = new FixPromptBuilder()
      .withContext(createFixPromptContext())
      .build();
    expect(prompt).toContain('CRITICAL RULES');
    expect(prompt).toContain('Fix ONLY the bug');
  });

  it('should include triage analysis context', () => {
    const prompt = new FixPromptBuilder()
      .withContext(createFixPromptContext())
      .build();
    expect(prompt).toContain('TRIAGE ANALYSIS');
  });

  it('should include root cause in context section', () => {
    const prompt = new FixPromptBuilder()
      .withContext(createFixPromptContext())
      .build();
    expect(prompt).toContain('Root Cause: Null pointer dereference in handleRequest');
  });

  it('should include suggested fix in context section', () => {
    const prompt = new FixPromptBuilder()
      .withContext(createFixPromptContext())
      .build();
    expect(prompt).toContain('Suggested Fix: Add null check before accessing property');
  });

  it('should include confidence and severity', () => {
    const prompt = new FixPromptBuilder()
      .withContext(createFixPromptContext())
      .build();
    expect(prompt).toContain('Confidence: high');
    expect(prompt).toContain('Severity: error');
  });

  it('should include affected files', () => {
    const prompt = new FixPromptBuilder()
      .withContext(createFixPromptContext())
      .build();
    expect(prompt).toContain('Affected Files: src/index.ts');
  });

  it('should include error title', () => {
    const prompt = new FixPromptBuilder()
      .withContext(createFixPromptContext())
      .build();
    expect(prompt).toContain('Error: TypeError: Cannot read property');
  });

  it('should include source code of target file', () => {
    const prompt = new FixPromptBuilder()
      .withContext(createFixPromptContext())
      .build();
    expect(prompt).toContain('FILE TO FIX (src/index.ts)');
    expect(prompt).toContain('export function handleRequest()');
    expect(prompt).toContain('return data.foo');
  });

  it('should include output schema', () => {
    const prompt = new FixPromptBuilder()
      .withContext(createFixPromptContext())
      .build();
    expect(prompt).toContain('Produce your fix as JSON');
    expect(prompt).toContain('file_path');
    expect(prompt).toContain('description');
    expect(prompt).toContain('patched_content');
  });

  // ── Edge cases ──────────────────────────────────────────────────────

  it('should truncate large file content', () => {
    const largeContent = 'x'.repeat(20000);
    const prompt = new FixPromptBuilder()
      .withContext(createFixPromptContext({ fileContent: largeContent }))
      .build();
    const longRun = 'x'.repeat(16000);
    expect(prompt).not.toContain(longRun);
  });

  it('should be re-usable (build can be called multiple times)', () => {
    const builder = new FixPromptBuilder()
      .withContext(createFixPromptContext());
    const prompt1 = builder.build();
    const prompt2 = builder.build();
    expect(prompt1).toBe(prompt2);
  });

  it('should handle multiple affected files', () => {
    const prompt = new FixPromptBuilder()
      .withContext(createFixPromptContext({
        allAffectedFiles: ['src/index.ts', 'src/utils.ts', 'src/types.ts'],
      }))
      .build();
    expect(prompt).toContain('Affected Files: src/index.ts, src/utils.ts, src/types.ts');
  });
});

describe('buildFixPrompt (convenience function)', () => {
  it('should build a prompt with all sections', () => {
    const prompt = buildFixPrompt(createFixPromptContext());
    expect(prompt).toContain('DonMerge');
    expect(prompt).toContain('CRITICAL RULES');
    expect(prompt).toContain('TRIAGE ANALYSIS');
    expect(prompt).toContain('FILE TO FIX');
    expect(prompt).toContain('Produce your fix as JSON');
  });

  it('should include target file content', () => {
    const prompt = buildFixPrompt(createFixPromptContext({
      targetFile: 'src/app.ts',
      fileContent: 'const app = () => {};',
    }));
    expect(prompt).toContain('FILE TO FIX (src/app.ts)');
    expect(prompt).toContain('const app = () => {}');
  });
});
