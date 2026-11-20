import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function check(input: string) {
  return spawnSync(process.execPath, ['scripts/check-review-memory-schema.mjs'], { input, encoding: 'utf8' });
}

describe('review memory deployment gate', () => {
  it('accepts a recorded migration and existing links table', () => {
    const result = check(JSON.stringify([{ results: [{ migration_applied: 1, links_table: 1 }] }]));
    expect(result.status).toBe(0);
  });

  it.each([
    JSON.stringify([{ results: [{ migration_applied: 0, links_table: 1 }] }]),
    JSON.stringify([{ results: [{ migration_applied: 1, links_table: 0 }] }]),
    'not JSON',
    '[]',
  ])('rejects incomplete or invalid schema evidence', (input) => {
    expect(check(input).status).toBe(1);
  });
});
