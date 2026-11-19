import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { buildMemoryContext, recordScopedReply, selectScopedLearnings, type ScopedLearning } from '../memory-store';

function learning(id: number, scope_type: ScopedLearning['scope_type'], scope_path: string, text: string): ScopedLearning {
  return { id, scope_type, scope_path, learning_text: text, confidence: 60, category: 'focus' };
}

describe('scoped review memory', () => {
  it('orders exact file, nearest directory and repository rules, with segment boundaries', () => {
    const rules = [
      learning(1, 'repo', '', 'repo'),
      learning(2, 'directory', 'src/billing', 'billing'),
      learning(3, 'directory', 'src', 'src'),
      learning(4, 'file', 'src/billing/invoice.ts', 'invoice'),
      learning(5, 'directory', 'src/billing-v2', 'other billing'),
    ];
    expect(selectScopedLearnings(rules, ['src/billing/invoice.ts']).map(rule => rule.id)).toEqual([4, 2, 3, 1]);
  });

  it('deduplicates text and bounds the amount of injected memory', () => {
    const rules = [
      learning(1, 'file', 'a.ts', 'same'),
      learning(2, 'repo', '', 'same'),
      ...Array.from({ length: 40 }, (_, i) => learning(i + 3, 'repo', '', `rule-${i}`)),
    ];
    const selected = selectScopedLearnings(rules, ['a.ts']);
    expect(selected).toHaveLength(30);
    expect(selected.filter(rule => rule.learning_text === 'same')).toHaveLength(1);
  });
});

it('persists one feedback event and applies a confirmed rule only to its file', async () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync('migrations/0004_create_memory_tables.sql', 'utf8'));
  sqlite.exec(readFileSync('migrations/0007_scoped_review_memory.sql', 'utf8'));
  class Statement {
    values: any[] = [];
    constructor(readonly sql: string) {}
    bind(...values: any[]) { this.values = values; return this; }
    async all() { return { results: sqlite.prepare(this.sql).all(...this.values) }; }
    async first() { return sqlite.prepare(this.sql).get(...this.values) ?? null; }
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
  const reply = {
    owner: 'org', repo: 'repo', prNumber: 1, commentId: 7, user: 'dev',
    fingerprint: 'fp', replyText: 'Already checked', learningText: 'Do not flag this',
    type: 'dismiss' as const, filePath: 'src/a.ts',
  };
  try {
    await Promise.all([recordScopedReply(db, reply), recordScopedReply(db, reply)]);
    expect(sqlite.prepare('SELECT count(*) AS n FROM feedback').get()).toMatchObject({ n: 1 });
    expect(sqlite.prepare('SELECT state, sample_size FROM scoped_learnings').get()).toMatchObject({ state: 'pending', sample_size: 1 });
    expect((await buildMemoryContext(db, 'org', 'repo', ['src/a.ts'])).ignorePatterns).toEqual([]);
    sqlite.prepare("UPDATE scoped_learnings SET state = 'active', confirmed_by = 'maintainer'").run();
    expect((await buildMemoryContext(db, 'org', 'repo', ['src/a.ts'])).ignorePatterns).toEqual(['[learning #1] Do not flag this']);
    expect((await buildMemoryContext(db, 'org', 'repo', ['src/b.ts'])).ignorePatterns).toEqual([]);
    expect((await buildMemoryContext(db, 'other', 'repo', ['src/a.ts'])).ignorePatterns).toEqual([]);
    sqlite.prepare("UPDATE scoped_learnings SET state = 'revoked'").run();
    await recordScopedReply(db, { ...reply, commentId: 8 });
    expect((await buildMemoryContext(db, 'org', 'repo', ['src/a.ts'])).ignorePatterns).toEqual([]);
  } finally {
    sqlite.close();
  }
});

it('imports historical exceptions as pending reviewable repository rules', () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec(readFileSync('migrations/0004_create_memory_tables.sql', 'utf8'));
    sqlite.exec(`INSERT INTO learnings(owner, repo, learning_text, source, category, confidence)
      VALUES ('org', 'repo', 'historical exception', 'feedback', 'ignore', 75)`);
    sqlite.exec(readFileSync('migrations/0007_scoped_review_memory.sql', 'utf8'));
    sqlite.exec(readFileSync('migrations/0008_import_legacy_review_memory.sql', 'utf8'));
    expect(sqlite.prepare('SELECT scope_type, state, source_pr FROM scoped_learnings').get())
      .toMatchObject({ scope_type: 'repo', state: 'pending', source_pr: 0 });
    expect(sqlite.prepare('SELECT review_state FROM learnings').get()).toMatchObject({ review_state: 'pending' });
  } finally {
    sqlite.close();
  }
});
