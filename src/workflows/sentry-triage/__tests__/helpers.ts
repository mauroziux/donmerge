/**
 * Shared test helpers, factories, and fixtures for sentry-triage tests.
 */

import { vi } from 'vitest';

import type {
  SentryIssueData,
  SentryEvent,
  SentryTriageOutput,
  SentryTriageContext,
  SentryTriageStatus,
  SentryTriageResult,
  TrackerConfig,
  CallbackConfig,
  AutoFixOutput,
  AutoFixContext,
} from '../types';
import type { TriagePromptContext } from '../prompts/builder';
import type { TrackerIssueContext } from '../trackers/types';

// ─── SentryIssueData Factory ─────────────────────────────────────────

let issueCounter = 0;

export function createSentryIssueData(
  overrides: Partial<SentryIssueData> = {}
): SentryIssueData {
  issueCounter += 1;
  return {
    id: `${issueCounter}`,
    shortId: `PROJ-${issueCounter}`,
    title: `Test Error ${issueCounter}`,
    project: { slug: 'test-project', id: '1' },
    firstSeen: '2025-01-01T00:00:00Z',
    lastSeen: '2025-01-02T00:00:00Z',
    count: '42',
    userCount: 10,
    platform: 'javascript',
    environment: 'production',
    tags: [{ key: 'release', value: '1.0.0' }],
    events: undefined,
    ...overrides,
  };
}

// ─── SentryEvent Factory ─────────────────────────────────────────────

let eventCounter = 0;

export function createSentryEvent(overrides: Partial<SentryEvent> = {}): SentryEvent {
  eventCounter += 1;
  return {
    id: `event-${eventCounter}`,
    timestamp: '2025-01-01T12:00:00Z',
    exceptions: [
      {
        type: 'TypeError',
        value: `Cannot read property 'foo' of undefined`,
        stacktrace: {
          frames: [
            {
              filename: 'src/index.ts',
              function: 'handleRequest',
              lineno: 42,
              colno: 10,
              absPath: '/app/src/index.ts',
              inApp: true,
            },
          ],
        },
      },
    ],
    breadcrumbs: [
      { timestamp: '2025-01-01T11:59:00Z', category: 'nav', message: 'navigate to /dashboard', type: 'navigation' },
    ],
    tags: [{ key: 'browser', value: 'Chrome' }],
    ...overrides,
  };
}

// ─── SentryTriageOutput Factory ──────────────────────────────────────

export function createValidTriageOutput(
  overrides: Partial<SentryTriageOutput> = {}
): SentryTriageOutput {
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
    sentryData: createSentryIssueData(),
    sourceCode: new Map([['src/index.ts', 'export function handleRequest() {}']]),
    sha: 'abc123def456',
    repo: 'tableoltd/test-repo',
    ...overrides,
  };
}

// ─── SentryTriageContext Factory ──────────────────────────────────────

export function createTriageContext(
  overrides: Partial<SentryTriageContext> = {}
): SentryTriageContext {
  return {
    jobId: 'job-123',
    repo: 'tableoltd/test-repo',
    sentryIssueUrl: 'https://sentry.io/organizations/acme/issues/12345/',
    sentryAuthToken: 'sentry-token-abc',
    githubToken: 'github-token-xyz',
    sha: 'abc123def456',
    ...overrides,
  };
}

// ─── SentryTriageStatus Factory ──────────────────────────────────────

export function createTriageStatus(
  overrides: Partial<SentryTriageStatus> = {}
): SentryTriageStatus {
  return {
    state: 'pending',
    attempts: 0,
    startedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

// ─── SentryTriageResult Factory ──────────────────────────────────────

export function createTriageResult(
  overrides: Partial<SentryTriageResult> = {}
): SentryTriageResult {
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
    sentryIssueId: '12345',
    sentryIssueUrl: 'https://sentry.io/organizations/test/issues/12345/',
    sentryTitle: 'TypeError: Cannot read properties of undefined',
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
    sentryIssueUrl: 'https://test.sentry.io/issues/12345/',
    sentryTitle: 'TypeError: Cannot read properties of undefined',
    triageOutput: createValidTriageOutput(),
    tracker: {
      type: 'github',
      token: 'ghs_testtoken',
      team: 'eng',
      labels: ['bug', 'sentry'],
    },
    fixPrUrl: null,
    ...overrides,
  };
}

// ─── Reset counters ───────────────────────────────────────────────────

export function resetCounters(): void {
  issueCounter = 0;
  eventCounter = 0;
}
