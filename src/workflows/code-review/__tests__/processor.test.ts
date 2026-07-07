/**
 * Tests for ReviewProcessor.startReview() stale-state recovery.
 *
 * Covers the STALE_PENDING_THRESHOLD_MS (5 min) logic: a 'pending' or 'running'
 * status older than the threshold is overwritten; one younger than the threshold
 * is preserved (early return).
 *
 * The ReviewProcessor class is a DurableObject subclass, so we instantiate it
 * with an in-memory mock storage that mirrors the real DurableObjectStorage
 * get/put surface used by startReview().
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub the cloudflare:workers runtime module — Vite can't resolve it natively,
// and processor.ts imports DurableObject from it. The stub provides a minimal
// base class whose constructor matches the real DurableObject signature.
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(state: unknown, env: unknown) {
      // Mirror real DO: expose state/env on the instance. processor.ts assigns
      // this.state/this.env itself in its constructor, so no-op here.
    }
  },
}));

import { ReviewProcessor } from '../processor';

// ── In-memory DO storage mock ────────────────────────────────────────────────

interface StoredStatus {
  state: 'pending' | 'running' | 'complete' | 'failed';
  attempts: number;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  result?: unknown;
}

function createMockStorage() {
  const store = new Map<string, unknown>();
  return {
    store,
    storage: {
      async get<T>(key: string): Promise<T | undefined> {
        return store.get(key) as T | undefined;
      },
      async put<T>(key: string, value: T): Promise<void> {
        store.set(key, value);
      },
    },
  };
}

function createMockState(storage: { get: (k: string) => Promise<unknown>; put: (k: string, v: unknown) => Promise<void> }) {
  return { storage } as unknown as DurableObjectState;
}

const baseContext = {
  owner: 'tableoltd',
  repo: 'test-repo',
  prNumber: 42,
  retrigger: false,
};

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('ReviewProcessor.startReview — stale-state recovery', () => {
  it('overwrites a pending status older than the 5-min threshold', async () => {
    const { store, storage } = createMockStorage();
    // Seed a stale 'pending' status: startedAt = 10 minutes ago
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    store.set('reviewStatus', {
      state: 'pending',
      attempts: 0,
      startedAt: tenMinAgo,
    } as StoredStatus);

    const processor = new ReviewProcessor(createMockState(storage), {} as never);
    await processor.startReview(baseContext);

    const finalStatus = (await storage.get<StoredStatus>('reviewStatus'))!;
    // Must have been overwritten: startedAt should now be ~now, not 10 min ago
    expect(finalStatus.state).toBe('pending');
    expect(finalStatus.startedAt).not.toBe(tenMinAgo);
    // New startedAt should be within the last few seconds
    const ageMs = Date.now() - Date.parse(finalStatus.startedAt!);
    expect(ageMs).toBeLessThan(5000);

    // Context must also be (re)stored
    const ctx = await storage.get('reviewContext');
    expect(ctx).toEqual(baseContext);
  });

  it('overwrites a running status older than the 5-min threshold', async () => {
    const { store, storage } = createMockStorage();
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    store.set('reviewStatus', {
      state: 'running',
      attempts: 1,
      startedAt: tenMinAgo,
    } as StoredStatus);

    const processor = new ReviewProcessor(createMockState(storage), {} as never);
    await processor.startReview(baseContext);

    const finalStatus = (await storage.get<StoredStatus>('reviewStatus'))!;
    expect(finalStatus.startedAt).not.toBe(tenMinAgo);
    // attempts reset to 0 on a fresh start
    expect(finalStatus.attempts).toBe(0);
  });

  it('early-returns for a pending status younger than the threshold', async () => {
    const { store, storage } = createMockStorage();
    const oneMinAgo = new Date(Date.now() - 60 * 1000).toISOString();
    const original: StoredStatus = {
      state: 'pending',
      attempts: 2,
      startedAt: oneMinAgo,
    };
    store.set('reviewStatus', original);

    const processor = new ReviewProcessor(createMockState(storage), {} as never);
    await processor.startReview(baseContext);

    const finalStatus = (await storage.get<StoredStatus>('reviewStatus'))!;
    // Untouched: same startedAt, same attempts
    expect(finalStatus.startedAt).toBe(oneMinAgo);
    expect(finalStatus.attempts).toBe(2);

    // Context must NOT have been overwritten
    const ctx = await storage.get('reviewContext');
    expect(ctx).toBeUndefined();
  });

  it('early-returns for a running status younger than the threshold', async () => {
    const { store, storage } = createMockStorage();
    const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    store.set('reviewStatus', {
      state: 'running',
      attempts: 1,
      startedAt: twoMinAgo,
    } as StoredStatus);

    const processor = new ReviewProcessor(createMockState(storage), {} as never);
    await processor.startReview(baseContext);

    const finalStatus = (await storage.get<StoredStatus>('reviewStatus'))!;
    expect(finalStatus.startedAt).toBe(twoMinAgo);
    expect(finalStatus.attempts).toBe(1);
  });

  it('overwrites at exactly the boundary case (status missing startedAt)', async () => {
    // If startedAt is missing, ageMs defaults to Date.now() - 0 = huge → stale.
    // This is the recovery path for legacy/corrupt state.
    const { store, storage } = createMockStorage();
    store.set('reviewStatus', { state: 'pending', attempts: 0 } as StoredStatus);

    const processor = new ReviewProcessor(createMockState(storage), {} as never);
    await processor.startReview(baseContext);

    const finalStatus = (await storage.get<StoredStatus>('reviewStatus'))!;
    expect(finalStatus.startedAt).toBeDefined();
  });

  it('starts a fresh review when no prior status exists', async () => {
    const { storage } = createMockStorage();

    const processor = new ReviewProcessor(createMockState(storage), {} as never);
    await processor.startReview(baseContext);

    const status = (await storage.get<StoredStatus>('reviewStatus'))!;
    expect(status.state).toBe('pending');
    expect(status.attempts).toBe(0);
    expect(status.startedAt).toBeDefined();

    const ctx = await storage.get('reviewContext');
    expect(ctx).toEqual(baseContext);
  });

  it('starts a fresh review when prior status is complete', async () => {
    const { store, storage } = createMockStorage();
    store.set('reviewStatus', {
      state: 'complete',
      attempts: 1,
      completedAt: new Date().toISOString(),
    } as StoredStatus);

    const processor = new ReviewProcessor(createMockState(storage), {} as never);
    await processor.startReview(baseContext);

    const finalStatus = (await storage.get<StoredStatus>('reviewStatus'))!;
    expect(finalStatus.state).toBe('pending');
    expect(finalStatus.attempts).toBe(0);
  });

  it('starts a fresh review when prior status is failed', async () => {
    const { store, storage } = createMockStorage();
    store.set('reviewStatus', {
      state: 'failed',
      attempts: 3,
      error: 'previous failure',
    } as StoredStatus);

    const processor = new ReviewProcessor(createMockState(storage), {} as never);
    await processor.startReview(baseContext);

    const finalStatus = (await storage.get<StoredStatus>('reviewStatus'))!;
    expect(finalStatus.state).toBe('pending');
    expect(finalStatus.attempts).toBe(0);
    expect(finalStatus.error).toBeUndefined();
  });
});
