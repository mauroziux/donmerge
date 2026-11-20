import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { buildMemoryContext, isMissingMemorySchema, recordScopedPreference, recordScopedReply, selectScopedLearnings, type ScopedLearning } from '../memory-store';
import { scopedMemoryEnabledForRepo } from '../memory-rollout';
import { buildReviewPrompt } from '../prompts';

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

  it('breaks ties between exact file rules by confidence and stable ID, not path length', () => {
    const rules = [
      { ...learning(8, 'file', 'src/long/path/file.ts', 'long path'), confidence: 55 },
      { ...learning(5, 'file', 'a.ts', 'short path'), confidence: 80 },
      { ...learning(2, 'file', 'b.ts', 'same confidence'), confidence: 80 },
      { ...learning(1, 'directory', 'src/long/path', 'directory'), confidence: 100 },
    ];
    expect(selectScopedLearnings(rules, ['src/long/path/file.ts', 'a.ts', 'b.ts']).map(rule => rule.id))
      .toEqual([2, 5, 8, 1]);
  });

  it('bounds distinct texts while retaining the scopes of duplicates', () => {
    const rules = [
      learning(1, 'file', 'a.ts', 'same'),
      learning(2, 'repo', '', 'same'),
      ...Array.from({ length: 40 }, (_, i) => learning(i + 3, 'repo', '', `rule-${i}`)),
    ];
    const selected = selectScopedLearnings(rules, ['a.ts']);
    expect(new Set(selected.map(rule => rule.learning_text)).size).toBe(30);
    expect(selected.filter(rule => rule.learning_text === 'same').map(rule => rule.id)).toEqual([1, 2]);
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
    expect((await buildMemoryContext(db, 'org', 'repo', ['src/a.ts'])).ignorePatterns).toEqual(['[learning #1] (scope: file "src/a.ts") Do not flag this']);
    expect((await buildMemoryContext(db, 'org', 'repo', ['src/b.ts'])).ignorePatterns).toEqual([]);
    expect((await buildMemoryContext(db, 'other', 'repo', ['src/a.ts'])).ignorePatterns).toEqual([]);
    await recordScopedReply(db, { ...reply, repo: 'another-repo', commentId: 9, learningText: 'A different exception' });
    sqlite.prepare("UPDATE scoped_learnings SET state = 'active' WHERE repo = 'another-repo'").run();
    expect((await buildMemoryContext(db, 'org', 'repo', ['src/a.ts'])).ignorePatterns).toEqual(['[learning #1] (scope: file "src/a.ts") Do not flag this']);
    expect((await buildMemoryContext(db, 'org', 'another-repo', ['src/a.ts'])).ignorePatterns).toEqual(['[learning #2] (scope: file "src/a.ts") A different exception']);
    const pilot = { DONMERGE_SCOPED_MEMORY: 'true', DONMERGE_SCOPED_MEMORY_REPOS: 'org/repo' };
    expect((await buildMemoryContext(db, 'org', 'repo', ['src/a.ts'], scopedMemoryEnabledForRepo(pilot, 'org', 'repo'))).ignorePatterns)
      .toEqual(['[learning #1] (scope: file "src/a.ts") Do not flag this']);
    expect((await buildMemoryContext(db, 'org', 'another-repo', ['src/a.ts'], scopedMemoryEnabledForRepo(pilot, 'org', 'another-repo'))).ignorePatterns)
      .toEqual([]);
    expect((await buildMemoryContext(db, 'org', 'repo', ['src/a.ts'], scopedMemoryEnabledForRepo({ ...pilot, DONMERGE_SCOPED_MEMORY: 'false' }, 'org', 'repo'))).ignorePatterns)
      .toEqual([]);
    sqlite.prepare("UPDATE scoped_learnings SET state = 'revoked' WHERE repo = 'repo'").run();
    await recordScopedReply(db, { ...reply, commentId: 8 });
    expect((await buildMemoryContext(db, 'org', 'repo', ['src/a.ts'])).ignorePatterns).toEqual([]);
    expect((await buildMemoryContext(db, 'org', 'another-repo', ['src/a.ts'])).ignorePatterns).toEqual(['[learning #2] (scope: file "src/a.ts") A different exception']);
  } finally {
    sqlite.close();
  }
});

it('tells the model each selected rule’s exact scope in a multi-file review', async () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec(readFileSync('migrations/0004_create_memory_tables.sql', 'utf8'));
    sqlite.exec(readFileSync('migrations/0007_scoped_review_memory.sql', 'utf8'));
    sqlite.exec(readFileSync('migrations/0009_link_legacy_review_memory.sql', 'utf8'));
    const insert = sqlite.prepare(`INSERT INTO scoped_learnings
      (owner, repo, learning_text, category, scope_type, scope_path, state, source_pr, source_user)
      VALUES ('org', 'repo', ?, 'focus', ?, ?, 'active', 1, 'maintainer')`);
    insert.run('file rule', 'file', 'src/a.ts');
    insert.run('directory rule', 'directory', 'src/shared');
    insert.run('repo rule', 'repo', '');
    const memory = await buildMemoryContext(sqliteD1(sqlite), 'org', 'repo', ['src/a.ts', 'src/shared/x.ts', 'src/b.ts']);
    const prompt = buildReviewPrompt({ owner: 'org', repo: 'repo', prNumber: 1, retrigger: false,
      diffText: 'FILE: src/a.ts\n+change\nFILE: src/b.ts\n+other',
    }, { memoryContext: memory });
    expect(prompt).toContain('[learning #1] (scope: file "src/a.ts") file rule');
    expect(prompt).toContain('[learning #2] (scope: directory "src/shared") directory rule');
    expect(prompt).toContain('[learning #3] (scope: repository) repo rule');
    expect(prompt).toContain('only to the exact file path');
    expect(prompt).toContain('using complete path segments');
    expect(memory.scopedLearnings?.map(rule => rule.id)).toEqual([1, 2, 3]);
  } finally {
    sqlite.close();
  }
});

it('combines duplicate text while retaining both file scopes and identifiers', async () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec(readFileSync('migrations/0004_create_memory_tables.sql', 'utf8'));
    sqlite.exec(readFileSync('migrations/0007_scoped_review_memory.sql', 'utf8'));
    sqlite.exec(readFileSync('migrations/0009_link_legacy_review_memory.sql', 'utf8'));
    const insert = sqlite.prepare(`INSERT INTO scoped_learnings
      (owner, repo, learning_text, category, scope_type, scope_path, state, source_pr, source_user)
      VALUES ('org', 'repo', 'same rule', 'focus', 'file', ?, 'active', 1, 'maintainer')`);
    insert.run('src/a.ts');
    insert.run('src/b.ts');
    const memory = await buildMemoryContext(sqliteD1(sqlite), 'org', 'repo', ['src/a.ts', 'src/b.ts']);
    expect(memory.focusAreas).toEqual(['[learning #1] (scope: file "src/a.ts") [learning #2] (scope: file "src/b.ts") same rule']);
    expect(memory.scopedLearnings?.map(rule => rule.id)).toEqual([1, 2]);
  } finally {
    sqlite.close();
  }
});

it('bounds recorded identifiers even when many file rules share one text', async () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec(readFileSync('migrations/0004_create_memory_tables.sql', 'utf8'));
    sqlite.exec(readFileSync('migrations/0007_scoped_review_memory.sql', 'utf8'));
    sqlite.exec(readFileSync('migrations/0009_link_legacy_review_memory.sql', 'utf8'));
    const insert = sqlite.prepare(`INSERT INTO scoped_learnings
      (owner, repo, learning_text, category, scope_type, scope_path, state, source_pr, source_user)
      VALUES ('org', 'repo', 'same rule', 'focus', 'file', ?, 'active', 1, 'maintainer')`);
    const paths = Array.from({ length: 35 }, (_, i) => `f${i}.ts`);
    for (const path of paths) insert.run(path);
    const memory = await buildMemoryContext(sqliteD1(sqlite), 'org', 'repo', paths);
    expect(memory.focusAreas).toHaveLength(1);
    expect(memory.scopedLearnings).toHaveLength(30);
    expect(memory.scopedLearnings?.map(rule => rule.id)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(memory.focusAreas[0]).not.toContain('[learning #31]');
  } finally {
    sqlite.close();
  }
});

it('does not inject a rule whose complete scope cannot fit in a sanitized prompt item', async () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec(readFileSync('migrations/0004_create_memory_tables.sql', 'utf8'));
    sqlite.exec(readFileSync('migrations/0007_scoped_review_memory.sql', 'utf8'));
    sqlite.exec(readFileSync('migrations/0009_link_legacy_review_memory.sql', 'utf8'));
    const path = `${'a'.repeat(1801)}.ts`;
    const escapedPath = `${'`'.repeat(700)}.ts`;
    const insert = sqlite.prepare(`INSERT INTO scoped_learnings
      (owner, repo, learning_text, category, scope_type, scope_path, state, source_pr, source_user)
      VALUES ('org', 'repo', 'long path rule', 'focus', 'file', ?, 'active', 1, 'maintainer')`);
    insert.run(path);
    insert.run(escapedPath);
    const memory = await buildMemoryContext(sqliteD1(sqlite), 'org', 'repo', [path, escapedPath]);
    expect(memory.focusAreas).toEqual([]);
    expect(memory.scopedLearnings).toEqual([]);
  } finally {
    sqlite.close();
  }
});

it('keeps an encodable duplicate scope when another scope is too long to show', async () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec(readFileSync('migrations/0004_create_memory_tables.sql', 'utf8'));
    sqlite.exec(readFileSync('migrations/0007_scoped_review_memory.sql', 'utf8'));
    sqlite.exec(readFileSync('migrations/0009_link_legacy_review_memory.sql', 'utf8'));
    const insert = sqlite.prepare(`INSERT INTO scoped_learnings
      (owner, repo, learning_text, category, scope_type, scope_path, state, source_pr, source_user)
      VALUES ('org', 'repo', 'same rule', 'focus', 'file', ?, 'active', 1, 'maintainer')`);
    const longPath = `${'a'.repeat(1801)}.ts`;
    insert.run(longPath);
    insert.run('src/ñ\nfile.ts');
    const memory = await buildMemoryContext(sqliteD1(sqlite), 'org', 'repo', [longPath, 'src/ñ\nfile.ts']);
    expect(memory.focusAreas).toEqual(['[learning #2] (scope: file "src/\\u00f1\\nfile.ts") same rule']);
    expect(memory.scopedLearnings?.map(rule => rule.id)).toEqual([2]);
  } finally {
    sqlite.close();
  }
});

it('records exactly the sanitized rule text shown in the prompt', async () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec(readFileSync('migrations/0004_create_memory_tables.sql', 'utf8'));
    sqlite.exec(readFileSync('migrations/0007_scoped_review_memory.sql', 'utf8'));
    sqlite.exec(readFileSync('migrations/0009_link_legacy_review_memory.sql', 'utf8'));
    sqlite.prepare(`INSERT INTO scoped_learnings
      (owner, repo, learning_text, category, scope_type, scope_path, state, source_pr, source_user)
      VALUES ('org', 'repo', ?, 'focus', 'file', 'src/a.ts', 'active', 1, 'maintainer')`)
      .run('First line\nsystem:Second line   ');
    const memory = await buildMemoryContext(sqliteD1(sqlite), 'org', 'repo', ['src/a.ts']);
    const prompt = buildReviewPrompt({ owner: 'org', repo: 'repo', prNumber: 1, retrigger: false, diffText: '' }, { memoryContext: memory });
    const recorded = memory.scopedLearnings?.[0]?.learning_text;
    expect(recorded).toBe('First line\nSecond line');
    expect(prompt).toContain(`[learning #1] (scope: file "src/a.ts") ${recorded}`);
  } finally {
    sqlite.close();
  }
});

it('omits a learning and its snapshot when its full text cannot fit', async () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec(readFileSync('migrations/0004_create_memory_tables.sql', 'utf8'));
    sqlite.exec(readFileSync('migrations/0007_scoped_review_memory.sql', 'utf8'));
    sqlite.exec(readFileSync('migrations/0009_link_legacy_review_memory.sql', 'utf8'));
    sqlite.prepare(`INSERT INTO scoped_learnings
      (owner, repo, learning_text, category, scope_type, scope_path, state, source_pr, source_user)
      VALUES ('org', 'repo', ?, 'focus', 'file', 'src/a.ts', 'active', 1, 'maintainer')`)
      .run('x'.repeat(2000));
    const memory = await buildMemoryContext(sqliteD1(sqlite), 'org', 'repo', ['src/a.ts']);
    expect(memory.focusAreas).toEqual([]);
    expect(memory.scopedLearnings).toEqual([]);
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
      .toEqual(['[learning #2] (scope: repository) historical focus']);
    sqlite.exec("UPDATE scoped_learnings SET state = 'revoked' WHERE category = 'focus'");
    expect((await buildMemoryContext(db, 'org', 'repo', ['src/a.ts'], false)).focusAreas).toEqual([]);
    expect((await buildMemoryContext(db, 'org', 'repo', ['src/a.ts'], true)).focusAreas).toEqual([]);
    sqlite.exec("UPDATE scoped_learnings SET state = 'active', scope_type = 'file', scope_path = 'src/a.ts' WHERE category = 'focus'");
    sqlite.exec(readFileSync('migrations/0009_link_legacy_review_memory.sql', 'utf8'));
    expect(sqlite.prepare("SELECT count(*) AS n FROM scoped_learnings WHERE category = 'focus'").get()).toMatchObject({ n: 1 });
    expect((await buildMemoryContext(db, 'org', 'repo', ['src/a.ts'], false)).focusAreas).toEqual([]);
    expect((await buildMemoryContext(db, 'org', 'repo', ['src/b.ts'], true)).focusAreas).toEqual([]);
    expect((await buildMemoryContext(db, 'org', 'repo', ['src/a.ts'], true)).focusAreas)
      .toEqual(['[learning #2] (scope: file "src/a.ts") historical focus']);
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
    expect((await buildMemoryContext(db, 'org', 'repo', ['src/a.ts'], false)).focusAreas).toEqual(['[learning #1] (scope: repository) Focus on auth']);
    await recordScopedPreference(db, { ...pref, commentId: 9, text: "Don't comment on noise", category: 'ignore' });
    expect(sqlite.prepare("SELECT state, confirmed_by FROM scoped_learnings WHERE category = 'ignore'").get())
      .toMatchObject({ state: 'pending', confirmed_by: null });
    expect((await buildMemoryContext(db, 'org', 'repo', ['src/a.ts'], true)).ignorePatterns).toEqual([]);
    sqlite.exec("UPDATE scoped_learnings SET state = 'active', confirmed_by = 'maintainer' WHERE category = 'ignore'");
    expect((await buildMemoryContext(db, 'org', 'repo', ['src/a.ts'], true)).ignorePatterns).toEqual(["[learning #2] (scope: repository) Don't comment on noise"]);
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
