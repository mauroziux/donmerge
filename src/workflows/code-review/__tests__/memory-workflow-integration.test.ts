import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  review: vi.fn(async (_options: { prompt: string }) => ({
    approved: true,
    summary: 'Considered learning #1.',
    prSummary: {
      overview: 'Fixture review.',
      keyChanges: ['Changed code'],
      codeQuality: 'Fine.',
      testingNotes: 'Covered.',
      riskAssessment: 'Low.',
    },
    lineComments: [],
    criticalIssues: [],
    suggestions: [],
  })),
}));

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class {
    constructor(readonly state: unknown, readonly env: unknown) {}
  },
}));
vi.mock('cloudflare:workflows', () => ({ NonRetryableError: class extends Error {} }));
vi.mock('@cloudflare/sandbox', () => ({
  getSandbox: () => ({ setEnvVars: async () => {}, destroy: async () => {} }),
}));
vi.mock('@flue/cloudflare', () => ({
  FlueRuntime: class {
    client = { prompt: async () => '' };
    async setup() {}
  },
}));
vi.mock('../review-model-runner', () => ({
  runReviewModels: mocks.review,
  DEFAULT_REVIEW_TOTAL_BUDGET_MS: 60_000,
  AllModelsFailedError: class extends Error {
    hasTransientSandboxFailures() { return false; }
  },
}));

import { CodeReviewWorkflow } from '../code-review-workflow';

/** SQLite-backed D1 adapter: bind returns independent statements, as in D1. */
function sqliteD1(sqlite: DatabaseSync): D1Database {
  class Statement {
    constructor(readonly sql: string, readonly values: any[] = []) {}
    bind(...values: any[]) { return new Statement(this.sql, values); }
    async all() { return { results: sqlite.prepare(this.sql).all(...this.values) }; }
    async first() { return sqlite.prepare(this.sql).get(...this.values) ?? null; }
    async run() { return sqlite.prepare(this.sql).run(...this.values); }
  }
  return {
    prepare: (sql: string) => new Statement(sql),
    batch: async (statements: Statement[]) => {
      sqlite.exec('BEGIN');
      try {
        const result = statements.map(statement => sqlite.prepare(statement.sql).run(...statement.values));
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
}

describe('memory in the review workflow', () => {
  it('sends only eligible file rules and records exact prompt text and citations per run', async () => {
    const sqlite = new DatabaseSync(':memory:');
    try {
      for (const name of ['0004_create_memory_tables.sql', '0007_scoped_review_memory.sql', '0009_link_legacy_review_memory.sql']) {
        sqlite.exec(readFileSync(`migrations/${name}`, 'utf8'));
      }
      const insert = sqlite.prepare(`INSERT INTO scoped_learnings
        (id, owner, repo, learning_text, category, scope_type, scope_path, state, source_pr, source_user)
        VALUES (?, ?, ?, ?, 'focus', 'file', ?, 'active', 1, 'maintainer')`);
      insert.run(1, 'org', 'repo', 'Check the first guard', 'src/a.ts');
      insert.run(2, 'org', 'repo', 'Check the second guard', 'src/a.ts');
      insert.run(3, 'org', 'repo', 'Check the other file', 'src/b.ts');
      insert.run(4, 'other', 'repo', 'Do not cross tenants', 'src/a.ts');
      const env = {
        DB: sqliteD1(sqlite),
        Sandbox: {},
        CODEX_MODEL: 'openai/gpt-4o',
        OPENAI_API_KEY: 'test',
        DONMERGE_SCOPED_MEMORY: 'true',
        DONMERGE_SCOPED_MEMORY_REPOS: 'org/repo',
      };
      const workflow = new CodeReviewWorkflow({} as never, env as never) as unknown as {
        runLlmReview(prepared: unknown, runId: string): Promise<unknown>;
      };
      const prepared = (filename: string) => ({
        prData: {
          owner: 'org', repo: 'repo', prNumber: 42, headSha: 'head',
          checkRunId: 777, githubToken: 'fixture', retrigger: false,
        },
        diffText: `FILE: ${filename}\n+changed`,
        repoContext: {},
        activePreviousComments: [],
        filePatches: [{ filename, patch: '@@ -1 +1 @@\n+changed' }],
      });
      const snapshots = (run: string) => sqlite.prepare(`SELECT learning_id, learning_text, scope_type, scope_path, cited
        FROM review_learning_snapshots WHERE owner = 'org' AND repo = 'repo' AND pr_number = 42 AND run_id = ?
        ORDER BY learning_id`).all(run);

      mocks.review.mockClear();
      await workflow.runLlmReview(prepared('src/a.ts'), 'run-a');
      const promptA = mocks.review.mock.calls.at(-1)![0].prompt;
      expect(promptA).toContain('[learning #1] (scope: file "src/a.ts") Check the first guard');
      expect(promptA).toContain('[learning #2] (scope: file "src/a.ts") Check the second guard');
      expect(promptA).not.toContain('Check the other file');
      expect(promptA).not.toContain('Do not cross tenants');
      expect(snapshots('run-a')).toEqual([
        { learning_id: 1, learning_text: 'Check the first guard', scope_type: 'file', scope_path: 'src/a.ts', cited: 1 },
        { learning_id: 2, learning_text: 'Check the second guard', scope_type: 'file', scope_path: 'src/a.ts', cited: 0 },
      ]);

      await workflow.runLlmReview(prepared('src/b.ts'), 'run-b');
      const promptB = mocks.review.mock.calls.at(-1)![0].prompt;
      expect(promptB).toContain('[learning #3] (scope: file "src/b.ts") Check the other file');
      expect(promptB).not.toContain('Check the first guard');
      expect(snapshots('run-b')).toEqual([
        { learning_id: 3, learning_text: 'Check the other file', scope_type: 'file', scope_path: 'src/b.ts', cited: 0 },
      ]);

      sqlite.exec("UPDATE scoped_learnings SET state = 'revoked' WHERE id = 1");
      await workflow.runLlmReview(prepared('src/a.ts'), 'run-revoked');
      expect(mocks.review.mock.calls.at(-1)![0].prompt).not.toContain('Check the first guard');
      expect(snapshots('run-revoked').map(row => row.learning_id)).toEqual([2]);
      expect(snapshots('run-a').map(row => row.learning_id)).toEqual([1, 2]);

      env.DONMERGE_SCOPED_MEMORY = 'false';
      await workflow.runLlmReview(prepared('src/a.ts'), 'run-disabled');
      expect(mocks.review.mock.calls.at(-1)![0].prompt).not.toContain('Check the second guard');
      expect(snapshots('run-disabled')).toEqual([]);
    } finally {
      sqlite.close();
    }
  });
});
