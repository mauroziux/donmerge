/**
 * Tests for issue-store.ts
 */

import { describe, it, expect, vi } from 'vitest';
import { loadTrackedIssues, saveTrackedIssues } from '../issue-store';
import { createTrackedIssue } from './helpers';

function createMockStorage(): DurableObjectStorage {
  const store = new Map<string, unknown>();
  return {
    get: vi.fn(<T>(key: string) => Promise.resolve(store.get(key) as T | undefined)),
    put: vi.fn((key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    delete: vi.fn((key: string) => {
      store.delete(key);
      return Promise.resolve();
    }),
    list: vi.fn(() => Promise.resolve({ keys: [], done: true })),
    getAlarm: vi.fn(() => Promise.resolve(null)),
    setAlarm: vi.fn(() => Promise.resolve()),
    deleteAlarm: vi.fn(() => Promise.resolve()),
    transaction: vi.fn((_ctx, fn) => fn(store as DurableObjectStorage)),
    sync: vi.fn(() => Promise.resolve()),
  };
}

describe('loadTrackedIssues', () => {
  it('should return empty array when nothing is stored', async () => {
    const storage = createMockStorage();
    const result = await loadTrackedIssues(storage);
    expect(result).toEqual([]);
  });

  it('should return stored issues', async () => {
    const storage = createMockStorage();
    const issues = [createTrackedIssue()];
    await saveTrackedIssues(storage, issues);

    const result = await loadTrackedIssues(storage);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(issues[0].id);
  });

  it('should return empty array when stored value is not an array', async () => {
    const storage = createMockStorage();
    await (storage as any).put('trackedIssues', 'not an array');

    const result = await loadTrackedIssues(storage);
    expect(result).toEqual([]);
  });
});

describe('saveTrackedIssues', () => {
  it('should save issues to storage', async () => {
    const storage = createMockStorage();
    const issues = [createTrackedIssue(), createTrackedIssue()];

    await saveTrackedIssues(storage, issues);

    expect(storage.put).toHaveBeenCalledWith('trackedIssues', issues);
  });

  it('should save empty array', async () => {
    const storage = createMockStorage();

    await saveTrackedIssues(storage, []);

    expect(storage.put).toHaveBeenCalledWith('trackedIssues', []);
  });
});
