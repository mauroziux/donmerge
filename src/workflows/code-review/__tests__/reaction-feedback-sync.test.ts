import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordReactionSignals, syncReactionFeedback } from '../reaction-feedback-sync';
import type { WorkerEnv } from '../types';

function setup(existing = false) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync('migrations/0004_create_memory_tables.sql', 'utf8'));
  sqlite.exec(readFileSync('migrations/0007_scoped_review_memory.sql', 'utf8'));
  const add = (commentId: number, repo = 'repo') => sqlite.prepare(`INSERT INTO review_outcomes
    (owner, repo, pr_number, head_sha, fingerprint, logical_key, rule_id, file_path, line, severity, body, status, outcome, github_comment_id, reviewer_type)
    VALUES ('org', ?, 5, 'head', ?, 'key', 'rule', 'src/a.ts', 1, 'critical', 'body', 'new', 'new', ?, 'ai')`)
    .run(repo, `fp-${commentId}`, commentId);
  if (existing) add(100);
  sqlite.exec(readFileSync('migrations/0010_reaction_feedback_poll.sql', 'utf8'));
  class Statement {
    values: any[] = [];
    constructor(readonly sql: string) {}
    bind(...values: any[]) { this.values = values; return this; }
    async all() { return { results: sqlite.prepare(this.sql).all(...this.values) }; }
    async run() { return sqlite.prepare(this.sql).run(...this.values); }
  }
  const db = {
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
  return { sqlite, add, env: { DB: db, GITHUB_TOKEN_PAT: 'test-token' } as WorkerEnv };
}

const reaction = (id: number, content = '+1', type = 'User') => ({ id, content, user: { login: `person-${id}`, type } });
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
afterEach(() => vi.unstubAllGlobals());

describe('GitHub reaction feedback synchronization', () => {
  it('backfills existing findings and tracks new published comments once', () => {
    const { sqlite, add } = setup(true);
    try {
      add(101); add(101);
      expect(sqlite.prepare('SELECT comment_id FROM reaction_poll_targets ORDER BY comment_id').all()).toEqual([
        { comment_id: 100 }, { comment_id: 101 },
      ]);
    } finally { sqlite.close(); }
  });

  it('records human thumbs once across repeated and concurrent polls, without creating memory rules', async () => {
    const { sqlite, add, env } = setup();
    try {
      add(101);
      const fetchMock = vi.fn().mockResolvedValue(ok([reaction(1), reaction(2, '-1'), reaction(3, 'heart'), reaction(4, '+1', 'Bot')]));
      // Each request needs its own response body.
      fetchMock.mockImplementation(async () => ok([reaction(1), reaction(2, '-1'), reaction(3, 'heart'), reaction(4, '+1', 'Bot')]));
      vi.stubGlobal('fetch', fetchMock);
      await Promise.all([syncReactionFeedback(env), syncReactionFeedback(env)]);
      await syncReactionFeedback(env);
      expect(sqlite.prepare('SELECT feedback_type, github_user, github_comment_id FROM feedback ORDER BY github_user').all()).toEqual([
        { feedback_type: 'accept', github_user: 'person-1', github_comment_id: 101 },
        { feedback_type: 'dismiss', github_user: 'person-2', github_comment_id: 101 },
      ]);
      expect(sqlite.prepare('SELECT count(*) AS n FROM scoped_learning_events WHERE source_type = \'reaction\'').get()).toMatchObject({ n: 2 });
      expect(sqlite.prepare('SELECT count(*) AS n FROM scoped_learnings').get()).toMatchObject({ n: 0 });
    } finally { sqlite.close(); }
  });

  it('rolls back the event if its feedback row cannot be recorded', async () => {
    const { sqlite, env } = setup();
    try {
      sqlite.exec("CREATE TRIGGER reject_feedback BEFORE INSERT ON feedback BEGIN SELECT RAISE(ABORT, 'test rejection'); END");
      await expect(recordReactionSignals(env.DB!, {
        owner: 'org', repo: 'repo', pr_number: 5, comment_id: 101, fingerprint: 'fp-101', next_page: 1,
      }, [{ id: 1, user: 'dev', type: 'accept' }])).rejects.toThrow('test rejection');
      expect(sqlite.prepare('SELECT count(*) AS n FROM scoped_learning_events').get()).toMatchObject({ n: 0 });
      expect(sqlite.prepare('SELECT count(*) AS n FROM feedback').get()).toMatchObject({ n: 0 });
    } finally { sqlite.close(); }
  });

  it('continues a full reactions page on the next poll and then restarts at page one', async () => {
    const { sqlite, add, env } = setup();
    try {
      add(101);
      const fetchMock = vi.fn(async (url: string) => ok(url.includes('page=2')
        ? [reaction(200, '-1')]
        : [reaction(1), ...Array.from({ length: 99 }, (_, i) => reaction(i + 2, 'heart'))]));
      vi.stubGlobal('fetch', fetchMock);
      await syncReactionFeedback(env);
      expect(sqlite.prepare('SELECT next_page FROM reaction_poll_targets').get()).toMatchObject({ next_page: 2 });
      await syncReactionFeedback(env);
      expect(sqlite.prepare('SELECT next_page FROM reaction_poll_targets').get()).toMatchObject({ next_page: 1 });
      expect(sqlite.prepare('SELECT count(*) AS n FROM feedback').get()).toMatchObject({ n: 2 });
      expect(fetchMock.mock.calls[1][0]).toContain('page=2');
    } finally { sqlite.close(); }
  });

  it('retries failed pages without starving another comment', async () => {
    const { sqlite, add, env } = setup();
    try {
      add(101); add(102);
      let fail = true;
      vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('/101/') && fail
        ? new Response('', { status: 403 }) : ok([reaction(url.includes('/101/') ? 1 : 2)])));
      expect(await syncReactionFeedback(env)).toEqual({ attempted: 2, failed: 1, skipped: 0 });
      expect(sqlite.prepare('SELECT next_page FROM reaction_poll_targets WHERE comment_id = 101').get()).toMatchObject({ next_page: 1 });
      fail = false;
      expect(await syncReactionFeedback(env)).toEqual({ attempted: 2, failed: 0, skipped: 0 });
      expect(sqlite.prepare('SELECT count(*) AS n FROM feedback').get()).toMatchObject({ n: 2 });
    } finally { sqlite.close(); }
  });

  it('rotates beyond the bounded first batch of comments', async () => {
    const { sqlite, add, env } = setup();
    try {
      for (let id = 1; id <= 11; id++) add(id);
      const fetchMock = vi.fn(async () => ok([]));
      vi.stubGlobal('fetch', fetchMock);
      expect(await syncReactionFeedback(env)).toEqual({ attempted: 8, failed: 0, skipped: 0 });
      expect(sqlite.prepare('SELECT count(*) AS n FROM reaction_poll_targets WHERE last_attempted_at IS NULL').get()).toMatchObject({ n: 3 });
      await syncReactionFeedback(env);
      expect(sqlite.prepare('SELECT count(*) AS n FROM reaction_poll_targets WHERE last_attempted_at IS NULL').get()).toMatchObject({ n: 0 });
    } finally { sqlite.close(); }
  });

  it('does not query a repository removed from the configured allowlist', async () => {
    const { sqlite, add, env } = setup();
    try {
      add(101); add(102, 'other');
      const fetchMock = vi.fn(async () => ok([]));
      vi.stubGlobal('fetch', fetchMock);
      expect(await syncReactionFeedback({ ...env, REPO_CONFIGS: 'org/repo:main' })).toEqual({ attempted: 2, failed: 0, skipped: 1 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { sqlite.close(); }
  });
});
