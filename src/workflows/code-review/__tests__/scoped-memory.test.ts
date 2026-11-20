import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { buildMemoryContext, isMissingMemorySchema, recordScopedPreference, recordScopedReply, selectScopedLearnings, type ScopedLearning } from '../memory-store';
import { scopedMemoryEnabledForRepo } from '../memory-rollout';

function learning(id: number, scope_type: ScopedLearning['scope_type'], scope_path: string, text: string): ScopedLearning {
  return { id, scope_type, scope_path, learning_text: text, confidence: 60, category: 'focus' };
}

function sqliteD1(sqlite: DatabaseSync): D1Database {
  class Statement {
    values: any[] = [];
    constructor(readonly sql: string) {}
    bind(...values: any[]) { this.values = values; return this; }
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

describe('scoped review memory', () => {
  it('distinguishes a missing migration from a transient D1 failure', () => {
    expect(isMissingMemorySchema(new Error('D1_ERROR: no such table: legacy_learning_links: SQLITE_ERROR'))).toBe(true);
    expect(isMissingMemorySchema(new Error('D1 failed', { cause: new Error('no such table: main.legacy_learning_links') }))).toBe(true);
    expect(isMissingMemorySchema(new Error('D1 request timed out'))).toBe(false);
    expect(isMissingMemorySchema(new Error('no such table: some_other_table'))).toBe(false);
  });

  it('limits an enabled rollout to explicitly listed repositories and honors the global kill switch', () => {
    const pilot = { DONMERGE_SCOPED_MEMORY: 'true', DONMERGE_SCOPED_MEMORY_REPOS: ' Org/Repo , other/project ' };
    expect(scopedMemoryEnabledForRepo(pilot, 'ORG', 'repo')).toBe(true);
    expect(scopedMemoryEnabledForRepo(pilot, 'other', 'project')).toBe(true);
    expect(scopedMemoryEnabledForRepo(pilot, 'org', 'repo-fork')).toBe(false);
    expect(scopedMemoryEnabledForRepo(pilot, 'elsewhere', 'repo')).toBe(false);
    expect(scopedMemoryEnabledForRepo({ ...pilot, DONMERGE_SCOPED_MEMORY: 'false' }, 'org', 'repo')).toBe(false);
    expect(scopedMemoryEnabledForRepo({ ...pilot, DONMERGE_SCOPED_MEMORY: ' FALSE ' }, 'org', 'repo')).toBe(false);
    expect(scopedMemoryEnabledForRepo({ ...pilot, DONMERGE_SCOPED_MEMORY: 'not-true' }, 'org', 'repo')).toBe(false);
    expect(scopedMemoryEnabledForRepo({ ...pilot, DONMERGE_SCOPED_MEMORY: ' TRUE ' }, 'org', 'repo')).toBe(true);
    expect(scopedMemoryEnabledForRepo({ DONMERGE_SCOPED_MEMORY: 'true' }, 'org', 'repo')).toBe(false);
    expect(scopedMemoryEnabledForRepo({ DONMERGE_SCOPED_MEMORY_REPOS: 'org/repo' }, 'org', 'repo')).toBe(false);
    expect(scopedMemoryEnabledForRepo({ DONMERGE_SCOPED_MEMORY_REPOS: '' }, 'org', 'repo')).toBe(false);
    expect(scopedMemoryEnabledForRepo({}, 'org', 'repo')).toBe(false);
  });

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
  sqlite.exec(readFileSync('migrations/0009_link_legacy_review_memory.sql', 'utf8'));
  const db = sqliteD1(sqlite);
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
    await recordScopedReply(db, { ...reply, repo: 'another-repo', commentId: 9, learningText: 'A different exception' });
    sqlite.prepare("UPDATE scoped_learnings SET state = 'active' WHERE repo = 'another-repo'").run();
    expect((await buildMemoryContext(db, 'org', 'repo', ['src/a.ts'])).ignorePatterns).toEqual(['[learning #1] Do not flag this']);
    expect((await buildMemoryContext(db, 'org', 'another-repo', ['src/a.ts'])).ignorePatterns).toEqual(['[learning #2] A different exception']);
    const pilot = { DONMERGE_SCOPED_MEMORY: 'true', DONMERGE_SCOPED_MEMORY_REPOS: 'org/repo' };
    expect((await buildMemoryContext(db, 'org', 'repo', ['src/a.ts'], scopedMemoryEnabledForRepo(pilot, 'org', 'repo'))).ignorePatterns)
      .toEqual(['[learning #1] Do not flag this']);
    expect((await buildMemoryContext(db, 'org', 'another-repo', ['src/a.ts'], scopedMemoryEnabledForRepo(pilot, 'org', 'another-repo'))).ignorePatterns)
      .toEqual([]);
    expect((await buildMemoryContext(db, 'org', 'repo', ['src/a.ts'], scopedMemoryEnabledForRepo({ ...pilot, DONMERGE_SCOPED_MEMORY: 'false' }, 'org', 'repo'))).ignorePatterns)
      .toEqual([]);
    sqlite.prepare("UPDATE scoped_learnings SET state = 'revoked' WHERE repo = 'repo'").run();
    await recordScopedReply(db, { ...reply, commentId: 8 });
    expect((await buildMemoryContext(db, 'org', 'repo', ['src/a.ts'])).ignorePatterns).toEqual([]);
    expect((await buildMemoryContext(db, 'org', 'another-repo', ['src/a.ts'])).ignorePatterns).toEqual(['[learning #2] A different exception']);
  } finally {
    sqlite.close();
  }
});

it('links historical rules without reviving a revoked or narrowed exception', async () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec(readFileSync('migrations/0004_create_memory_tables.sql', 'utf8'));
    sqlite.exec(`INSERT INTO learnings(owner, repo, learning_text, source, category, confidence) VALUES
      ('org', 'repo', 'historical exception', 'feedback', 'ignore', 75),
      ('org', 'repo', 'historical focus', 'feedback', 'focus', 75),
      ('org', 'repo', 'historical focus', 'feedback', 'focus', 75)`);
    sqlite.exec(readFileSync('migrations/0007_scoped_review_memory.sql', 'utf8'));
    sqlite.exec(readFileSync('migrations/0008_import_legacy_review_memory.sql', 'utf8'));
    sqlite.exec("UPDATE scoped_learnings SET state = 'revoked', scope_type = 'file', scope_path = 'src/a.ts' WHERE category = 'ignore'");
    sqlite.exec(readFileSync('migrations/0009_link_legacy_review_memory.sql', 'utf8'));
    const db = sqliteD1(sqlite);
    expect(sqlite.prepare('SELECT count(*) AS n FROM legacy_learning_links').get()).toMatchObject({ n: 3 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM scoped_learnings WHERE category = 'ignore'").get()).toMatchObject({ n: 1 });
    expect(sqlite.prepare("SELECT state, scope_type FROM scoped_learnings WHERE category = 'ignore'").get()).toMatchObject({ state: 'revoked', scope_type: 'file' });
    expect((await buildMemoryContext(db, 'org', 'repo', ['src/a.ts'], false)).focusAreas)
      .toEqual(['[learning #2] historical focus']);
    sqlite.exec("UPDATE scoped_learnings SET state = 'revoked' WHERE category = 'focus'");
    expect((await buildMemoryContext(db, 'org', 'repo', ['src/a.ts'], false)).focusAreas).toEqual([]);
    expect((await buildMemoryContext(db, 'org', 'repo', ['src/a.ts'], true)).focusAreas).toEqual([]);
    sqlite.exec("UPDATE scoped_learnings SET state = 'active', scope_type = 'file', scope_path = 'src/a.ts' WHERE category = 'focus'");
    sqlite.exec(readFileSync('migrations/0009_link_legacy_review_memory.sql', 'utf8'));
    expect(sqlite.prepare("SELECT count(*) AS n FROM scoped_learnings WHERE category = 'focus'").get()).toMatchObject({ n: 1 });
    expect((await buildMemoryContext(db, 'org', 'repo', ['src/a.ts'], false)).focusAreas).toEqual([]);
    expect((await buildMemoryContext(db, 'org', 'repo', ['src/b.ts'], true)).focusAreas).toEqual([]);
    expect((await buildMemoryContext(db, 'org', 'repo', ['src/a.ts'], true)).focusAreas)
      .toEqual(['[learning #2] historical focus']);
  } finally {
    sqlite.close();
  }
});

it('records preference commands once, keeps exceptions pending, and honors revocation after rollback', async () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec(readFileSync('migrations/0004_create_memory_tables.sql', 'utf8'));
    sqlite.exec(readFileSync('migrations/0007_scoped_review_memory.sql', 'utf8'));
    sqlite.exec(readFileSync('migrations/0009_link_legacy_review_memory.sql', 'utf8'));
    const db = sqliteD1(sqlite);
    const pref = { owner: 'org', repo: 'repo', prNumber: 7, commentId: 8, user: 'maintainer', text: 'Focus on auth', category: 'focus' as const };
    await Promise.all([recordScopedPreference(db, pref), recordScopedPreference(db, pref)]);
    expect(sqlite.prepare('SELECT count(*) AS n FROM feedback').get()).toMatchObject({ n: 1 });
    expect(sqlite.prepare('SELECT sample_size, source_pr, source_comment_id, source_user, confirmed_by FROM scoped_learnings').get())
      .toMatchObject({ sample_size: 1, source_pr: 7, source_comment_id: 8, source_user: 'maintainer', confirmed_by: 'maintainer' });
    expect((await buildMemoryContext(db, 'org', 'repo', ['src/a.ts'], false)).focusAreas).toEqual(['[learning #1] Focus on auth']);
    await recordScopedPreference(db, { ...pref, commentId: 9, text: "Don't comment on noise", category: 'ignore' });
    expect(sqlite.prepare("SELECT state, confirmed_by FROM scoped_learnings WHERE category = 'ignore'").get())
      .toMatchObject({ state: 'pending', confirmed_by: null });
    expect((await buildMemoryContext(db, 'org', 'repo', ['src/a.ts'], true)).ignorePatterns).toEqual([]);
    sqlite.exec("UPDATE scoped_learnings SET state = 'active', confirmed_by = 'maintainer' WHERE category = 'ignore'");
    expect((await buildMemoryContext(db, 'org', 'repo', ['src/a.ts'], true)).ignorePatterns).toEqual(["[learning #2] Don't comment on noise"]);
    expect((await buildMemoryContext(db, 'org', 'repo', ['src/a.ts'], false)).ignorePatterns).toEqual([]);
    sqlite.exec("UPDATE scoped_learnings SET state = 'revoked' WHERE category = 'focus'");
    await recordScopedPreference(db, { ...pref, commentId: 10 });
    sqlite.exec("UPDATE scoped_learnings SET scope_type = 'file', scope_path = 'src/a.ts' WHERE category = 'focus'");
    sqlite.exec(readFileSync('migrations/0009_link_legacy_review_memory.sql', 'utf8'));
    expect(sqlite.prepare("SELECT count(*) AS n FROM scoped_learnings WHERE category = 'focus'").get()).toMatchObject({ n: 1 });
    expect((await buildMemoryContext(db, 'org', 'repo', ['src/a.ts'], false)).focusAreas).toEqual([]);
    expect(sqlite.prepare("SELECT state FROM scoped_learnings WHERE category = 'focus'").get()).toMatchObject({ state: 'revoked' });
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
