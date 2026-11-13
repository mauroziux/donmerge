import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { recordReviewOutcomes } from '../memory-store';

describe('review outcome recording', () => {
  it('does not duplicate an outcome when publication is retried', async () => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(`CREATE TABLE review_outcomes (
      owner TEXT, repo TEXT, pr_number INTEGER, head_sha TEXT, fingerprint TEXT,
      logical_key TEXT, rule_id TEXT, file_path TEXT, line INTEGER, severity TEXT,
      body TEXT, status TEXT, outcome TEXT, outcome_source TEXT, previous_severity TEXT,
      new_severity TEXT, github_comment_id INTEGER, reviewer_type TEXT
    )`);
    const db = {
      prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({ sql, values }) }),
      batch: async (statements: Array<{ sql: string; values: unknown[] }>) => {
        for (const stmt of statements) sqlite.prepare(stmt.sql).run(...stmt.values as never[]);
      },
    } as unknown as D1Database;
    const outcome = {
      owner: 'owner', repo: 'repo', pr_number: 1, head_sha: 'sha', fingerprint: 'fp',
      logical_key: 'key', rule_id: 'rule', file_path: 'a.ts', line: 1,
      severity: 'critical' as const, body: 'finding', status: 'new' as const,
      outcome: 'new' as const, reviewer_type: 'ai' as const, github_comment_id: 42,
    };
    await recordReviewOutcomes(db, [outcome]);
    await recordReviewOutcomes(db, [outcome]);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM review_outcomes').get()).toEqual({ count: 1 });
    sqlite.close();
  });
});
