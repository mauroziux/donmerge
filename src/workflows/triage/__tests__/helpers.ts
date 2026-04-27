/**
 * Shared test helpers, factories, and fixtures for triage tests.
 */

import { vi } from 'vitest';

import type {
  ErrorContext,
  TriageOutput,
  TriageContext,
  TriageStatus,
  TriageResult,
  TrackerConfig,
  CallbackConfig,
  AutoFixOutput,
  AutoFixContext,
} from '../types';
import type { TriagePromptContext } from '../prompts/builder';
import type { TrackerIssueContext } from '../trackers/types';

// ─── ErrorContext Factory ─────────────────────────────────────────

let errorCounter = 0;

export function createErrorContext(
  overrides: Partial<ErrorContext> = {}
): ErrorContext {
  errorCounter += 1;
  return {
    title: `Test Error ${errorCounter}`,
    description: `Description for test error ${errorCounter}`,
    stack_trace: `Error: test\n  at handleRequest (src/index.ts:42:10)`,
    affected_files: ['src/index.ts'],
    severity: 'error',
    environment: 'production',
    metadata: { count: '42', userCount: 10 },
    source_url: 'https://sentry.io/organizations/acme/issues/12345/',
    ...overrides,
  };
}

// ─── TriageOutput Factory ──────────────────────────────────────────

export function createValidTriageOutput(
  overrides: Partial<TriageOutput> = {}
): TriageOutput {
  return {
    root_cause: 'Null pointer dereference in handleRequest',
    stack_trace_summary: 'TypeError at src/index.ts:42 in handleRequest',
    affected_files: ['src/index.ts'],
    suggested_fix: 'Add null check before accessing property',
    confidence: 'high',
    severity: 'error',
    ...overrides,
  };
}

// ─── TriagePromptContext Factory ──────────────────────────────────────

export function createTriagePromptContext(
  overrides: Partial<TriagePromptContext> = {}
): TriagePromptContext {
  return {
    errorContext: createErrorContext(),
    sourceCode: new Map([['src/index.ts', 'export function handleRequest() {}']]),
    sha: 'abc123def456',
    repo: 'tableoltd/test-repo',
    ...overrides,
  };
}

// ─── TriageContext Factory ──────────────────────────────────────────

export function createTriageContext(
  overrides: Partial<TriageContext> = {}
): TriageContext {
  return {
    jobId: 'job-123',
    repo: 'tableoltd/test-repo',
    errorContext: createErrorContext(),
    githubToken: 'github-token-xyz',
    sha: 'abc123def456',
    ...overrides,
  };
}

// ─── TriageStatus Factory ──────────────────────────────────────────

export function createTriageStatus(
  overrides: Partial<TriageStatus> = {}
): TriageStatus {
  return {
    state: 'pending',
    attempts: 0,
    startedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

// ─── TriageResult Factory ──────────────────────────────────────────

export function createTriageResult(
  overrides: Partial<TriageResult> = {}
): TriageResult {
  return {
    root_cause: 'Null pointer dereference',
    stack_trace_summary: 'TypeError at src/index.ts:42',
    affected_files: ['src/index.ts'],
    suggested_fix: 'Add null check',
    confidence: 'high',
    severity: 'error',
    fix_pr_url: null,
    tracker_issue_url: null,
    ...overrides,
  };
}

// ─── TrackerConfig Factory ────────────────────────────────────────────

export function createTrackerConfig(
  overrides: Partial<TrackerConfig> = {}
): TrackerConfig {
  return {
    type: 'linear',
    token: 'lin-api-xyz',
    team: 'ENG',
    labels: ['bug'],
    ...overrides,
  };
}

// ─── CallbackConfig Factory ───────────────────────────────────────────

export function createCallbackConfig(
  overrides: Partial<CallbackConfig> = {}
): CallbackConfig {
  return {
    callback_url: 'https://example.com/callback',
    callback_secret: 'secret123',
    ...overrides,
  };
}

// ─── AutoFixOutput Factory ─────────────────────────────────────────────

export function createAutoFixOutput(overrides: Partial<AutoFixOutput> = {}): AutoFixOutput {
  return {
    file_path: '/app/Jobs/ExampleJob.php',
    description: 'Add URL validation before HTTP request',
    patched_content: '<?php\n// fixed code\n',
    ...overrides,
  };
}

// ─── AutoFixContext Factory ─────────────────────────────────────────────

export function createAutoFixContext(overrides: Partial<AutoFixContext> = {}): AutoFixContext {
  return {
    repo: 'owner/repo',
    sha: 'abc123',
    githubToken: 'ghs_test_token',
    errorTitle: 'TypeError: Cannot read properties of undefined',
    sourceUrl: 'https://sentry.io/organizations/test/issues/12345/',
    triageOutput: createValidTriageOutput({
      affected_files: ['src/index.ts'],
    }),
    sourceCode: new Map([['src/index.ts', 'export function handleRequest() {\n  return data.foo;\n}']]),
    flue: { client: { prompt: vi.fn() } } as any,
    ...overrides,
  };
}

// ─── TrackerIssueContext Factory ─────────────────────────────────────────

export function createTrackerIssueContext(
  overrides: Partial<TrackerIssueContext> = {}
): TrackerIssueContext {
  return {
    repo: 'test-owner/test-repo',
    errorTitle: 'TypeError: Cannot read properties of undefined',
    sourceUrl: 'https://test.sentry.io/issues/12345/',
    triageOutput: createValidTriageOutput(),
    tracker: {
      type: 'github',
      token: 'ghs_testtoken',
      team: 'eng',
      labels: ['bug'],
    },
    fixPrUrl: null,
    ...overrides,
  };
}

// ─── Reset counters ───────────────────────────────────────────────────

export function resetCounters(): void {
  errorCounter = 0;
}
