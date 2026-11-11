/**
 * Tests for ReviewProcessor.startReview() stale-state recovery.
 *
 * Pending and running owners are preserved regardless of age; age alone
 * cannot prove an old workflow has stopped producing external effects.
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
  runId?: string;
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
      async delete(key: string): Promise<boolean> {
        return store.delete(key);
      },
      setAlarm: async (_time: number) => {},
      deleteAlarm: async () => {},
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
  it('preserves a legacy pending owner even after the 5-min threshold', async () => {
    const { store, storage } = createMockStorage();
    // Seed a stale 'pending' status: startedAt = 10 minutes ago
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    store.set('reviewStatus', {
      state: 'pending',
      attempts: 0,
      startedAt: tenMinAgo,
    } as StoredStatus);

    const processor = new ReviewProcessor(createMockState(storage), {} as never);
    const result = await processor.startReview(baseContext);

    expect(result).toMatchObject({ started: false, reason: 'deferred_new_push' });
    const finalStatus = (await storage.get<StoredStatus>('reviewStatus'))!;
    expect(finalStatus.state).toBe('pending');
    expect(finalStatus.startedAt).toBe(tenMinAgo);
    expect(await storage.get('reviewPendingLatest')).toEqual(baseContext);
  });

  it('does not replace a running owner merely because 50 minutes elapsed', async () => {
    const { store, storage } = createMockStorage();
    const fiftyOneMinAgo = new Date(Date.now() - 51 * 60 * 1000).toISOString();
    store.set('reviewStatus', { state: 'running', attempts: 1, startedAt: fiftyOneMinAgo, runId: 'old' });
    store.set('reviewContext', baseContext);
    const processor = new ReviewProcessor(createMockState(storage), {} as never);
    const result = await processor.startReview({ ...baseContext, headSha: 'new' });
    expect(result).toMatchObject({ started: false, reason: 'deferred_new_push' });
    expect((await storage.get<StoredStatus>('reviewStatus'))!.runId).toBe('old');
  });

  it('early-returns for a pending status younger than the threshold (same request = duplicate)', async () => {
    const { store, storage } = createMockStorage();
    const oneMinAgo = new Date(Date.now() - 60 * 1000).toISOString();
    const original: StoredStatus = {
      state: 'pending',
      attempts: 2,
      startedAt: oneMinAgo,
    };
    store.set('reviewStatus', original);
    // Same request identity as baseContext → duplicate delivery
    store.set('reviewContext', baseContext);

    const processor = new ReviewProcessor(createMockState(storage), {} as never);
    const result = await processor.startReview(baseContext);

    expect(result).toMatchObject({ started: false, reason: 'already_running' });
    const finalStatus = (await storage.get<StoredStatus>('reviewStatus'))!;
    // Untouched: same startedAt, same attempts
    expect(finalStatus.startedAt).toBe(oneMinAgo);
    expect(finalStatus.attempts).toBe(2);

    // Context must NOT have been overwritten (still the original request)
    const ctx = await storage.get('reviewContext');
    expect(ctx).toEqual(baseContext);
  });

  it('early-returns for a running status younger than the threshold', async () => {
    const { store, storage } = createMockStorage();
    const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    store.set('reviewStatus', {
      state: 'running',
      attempts: 1,
      startedAt: twoMinAgo,
    } as StoredStatus);
    store.set('reviewContext', baseContext);

    const processor = new ReviewProcessor(createMockState(storage), {} as never);
    const result = await processor.startReview(baseContext);

    expect(result).toMatchObject({ started: false, reason: 'already_running' });
    const finalStatus = (await storage.get<StoredStatus>('reviewStatus'))!;
    expect(finalStatus.startedAt).toBe(twoMinAgo);
    expect(finalStatus.attempts).toBe(1);
  });

  it('preserves a pending owner with missing startedAt', async () => {
    // Missing timing data cannot prove that the workflow stopped.
    const { store, storage } = createMockStorage();
    store.set('reviewStatus', { state: 'pending', attempts: 0 } as StoredStatus);

    const processor = new ReviewProcessor(createMockState(storage), {} as never);
    const result = await processor.startReview(baseContext);

    expect(result).toMatchObject({ started: false, reason: 'deferred_new_push' });
    const finalStatus = (await storage.get<StoredStatus>('reviewStatus'))!;
    expect(finalStatus.startedAt).toBeUndefined();
    expect(await storage.get('reviewPendingLatest')).toEqual(baseContext);
  });

  it('starts a fresh review when no prior status exists', async () => {
    const { storage } = createMockStorage();

    const processor = new ReviewProcessor(createMockState(storage), {} as never);
    const result = await processor.startReview(baseContext);

    expect(result).toMatchObject({ started: true, reason: 'started' });
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
    const result = await processor.startReview(baseContext);

    expect(result).toMatchObject({ started: true, reason: 'started' });
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

// ─── Coordination: deferral, fencing, durable handoff (plan 004-U1) ─────────

describe('ReviewProcessor coordination', () => {
  function createMockStateWithAlarms(storage: ReturnType<typeof createMockStorage>['storage']) {
    const alarms: number[] = [];
    let alarmCleared = false;
    storage.setAlarm = async (time: number) => {
      alarms.push(time);
      alarmCleared = false;
    };
    storage.deleteAlarm = async () => {
      alarmCleared = true;
    };
    return { state: createMockState(storage), alarms, alarmCleared: () => alarmCleared };
  }

  function createWorkflowBinding() {
    const created: Array<{ id: string; params: Record<string, unknown> }> = [];
    const restarted: string[] = [];
    const binding = {
      create: vi.fn(async (opts: { id: string; params: Record<string, unknown> }) => {
        created.push({ id: opts.id, params: opts.params });
      }),
      get: vi.fn(async (id: string) => ({
        restart: vi.fn(async () => {
          restarted.push(id);
        }),
      })),
    };
    return { binding, created, restarted };
  }

  it('defers a DIFFERENT request while a run is active (pendingLatest stored, nothing dropped)', async () => {
    const { store, storage } = createMockStorage();
    const oneMinAgo = new Date(Date.now() - 60 * 1000).toISOString();
    store.set('reviewStatus', { state: 'running', attempts: 1, startedAt: oneMinAgo, runId: 'run-a' } as StoredStatus);
    store.set('reviewContext', { ...baseContext, headSha: 'aaa' });

    const processor = new ReviewProcessor(createMockState(storage), {} as never);
    const result = await processor.startReview({ ...baseContext, headSha: 'bbb' });

    expect(result).toMatchObject({ started: false, reason: 'deferred_new_push' });
    const pending = await storage.get('reviewPendingLatest');
    expect(pending).toMatchObject({ headSha: 'bbb' });
    // Active run untouched
    const status = (await storage.get<StoredStatus>('reviewStatus'))!;
    expect(status.runId).toBe('run-a');
    expect(status.state).toBe('running');
  });

  it('a duplicate of the SAME request (same head/instruction/comment) is acked, not deferred', async () => {
    const { store, storage } = createMockStorage();
    const oneMinAgo = new Date(Date.now() - 60 * 1000).toISOString();
    store.set('reviewStatus', { state: 'running', attempts: 1, startedAt: oneMinAgo, runId: 'run-a' } as StoredStatus);
    const ctx = { ...baseContext, headSha: 'aaa', instruction: 'focus on auth', focusFiles: ['src/a.ts', 'src/b.ts'] };
    store.set('reviewContext', ctx);

    const processor = new ReviewProcessor(createMockState(storage), {} as never);
    // focus order must not matter — sorted in the fingerprint
    const result = await processor.startReview({ ...ctx, focusFiles: ['src/b.ts', 'src/a.ts'] });

    expect(result).toMatchObject({ started: false, reason: 'already_running', runId: 'run-a' });
    expect(await storage.get('reviewPendingLatest')).toBeUndefined();
  });

  it.each(['initiatorKeyHash', 'githubCredentialHash', 'requestNonce'] as const)('defers requests with different %s', async (field) => {
    const { store, storage } = createMockStorage();
    store.set('reviewStatus', { state: 'running', attempts: 1, startedAt: new Date().toISOString(), runId: 'run-a' });
    const ctx = { ...baseContext, headSha: 'aaa', [field]: 'first' };
    store.set('reviewContext', ctx);
    const processor = new ReviewProcessor(createMockState(storage), {} as never);
    const result = await processor.startReview({ ...ctx, [field]: 'second' });
    expect(result.reason).toBe('deferred_new_push');
    expect(await storage.get('reviewPendingLatest')).toMatchObject({ [field]: 'second' });
  });

  it('rejects C instead of overwriting B while A is active', async () => {
    const { store, storage } = createMockStorage();
    store.set('reviewStatus', { state: 'running', attempts: 1, startedAt: new Date().toISOString(), runId: 'run-a' });
    store.set('reviewContext', { ...baseContext, headSha: 'aaa', initiatorKeyHash: 'a' });
    const processor = new ReviewProcessor(createMockState(storage), {} as never);
    const b = { ...baseContext, headSha: 'bbb', initiatorKeyHash: 'b', githubCredentialHash: 'token-b' };
    expect((await processor.startReview(b)).reason).toBe('deferred_new_push');
    expect((await processor.startReview({ ...b, initiatorKeyHash: 'c' })).reason).toBe('pending_conflict');
    expect((await processor.startReview({ ...baseContext, headSha: 'ccc' })).reason).toBe('pending_conflict');
    expect(await storage.get('reviewPendingLatest')).toEqual(b);
  });

  it('reserves a fixed reply once and fences obsolete runs', async () => {
    const { store, storage } = createMockStorage();
    store.set('reviewStatus', { state: 'running', runId: 'run-a' });
    const processor = new ReviewProcessor(createMockState(storage), {} as never);
    expect(await processor.reserveFixedReply('old', 12)).toBe(false);
    expect(await processor.reserveFixedReply('run-a', 12)).toBe(true);
    expect(await processor.reserveFixedReply('run-a', 12)).toBe(false);
    expect(await processor.reserveFixedReply('run-a', 13)).toBe(true);
  });

  it('retries a still-pending handoff with its exact saved instance id', async () => {
    const { store, storage } = createMockStorage();
    store.set('reviewStatus', { state: 'running', runId: 'run-a', instanceId: 'old' });
    store.set('reviewContext', { ...baseContext, headSha: 'aaa' });
    store.set('reviewPendingLatest', { ...baseContext, headSha: 'bbb' });
    const ids: string[] = [];
    const create = vi.fn(async ({ id }: { id: string }) => { ids.push(id); });
    const processor = new ReviewProcessor(createMockState(storage), { CODE_REVIEW_WORKFLOW: { create } } as never);
    await processor.updateFromWorkflow({ state: 'failed', runId: 'run-a' });
    await processor.alarm();
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
  });

  it('reconciles an externally terminated owner and hands off the pending request', async () => {
    const { store, storage } = createMockStorage();
    store.set('reviewStatus', { state: 'running', runId: 'run-a', instanceId: 'instance-a' });
    store.set('reviewContext', { ...baseContext, headSha: 'aaa' });
    store.set('reviewPendingLatest', { ...baseContext, headSha: 'bbb' });
    const create = vi.fn(async () => {});
    const get = vi.fn(async () => ({ status: async () => ({ status: 'terminated' }) }));
    const processor = new ReviewProcessor(createMockState(storage), { CODE_REVIEW_WORKFLOW: { get, create } } as never);
    await processor.alarm();
    expect(get).toHaveBeenCalledWith('instance-a');
    expect(create).toHaveBeenCalledOnce();
    expect(await storage.get('reviewStatus')).toMatchObject({ state: 'pending' });
    expect(await storage.get('reviewPendingLatest')).toBeUndefined();
  });

  it.each(['running', 'paused', 'waiting'])('does not replace a %s instance', async (state) => {
    const { store, storage } = createMockStorage();
    store.set('reviewStatus', { state: 'running', runId: 'run-a', instanceId: 'instance-a' });
    store.set('reviewContext', baseContext);
    store.set('reviewPendingLatest', { ...baseContext, headSha: 'bbb' });
    const create = vi.fn();
    const get = vi.fn(async () => ({ status: async () => ({ status: state }) }));
    const processor = new ReviewProcessor(createMockState(storage), { CODE_REVIEW_WORKFLOW: { get, create } } as never);
    await processor.alarm();
    expect(create).not.toHaveBeenCalled();
    expect(await storage.get('reviewStatus')).toMatchObject({ state: 'running', runId: 'run-a' });
    expect(await storage.get('reviewPendingLatest')).toMatchObject({ headSha: 'bbb' });
  });

  it('a 10-minute-old running review is NOT stale (healthy long reviews survive)', async () => {
    const { store, storage } = createMockStorage();
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    store.set('reviewStatus', { state: 'running', attempts: 0, startedAt: tenMinAgo, runId: 'run-a' } as StoredStatus);
    store.set('reviewContext', baseContext);

    const processor = new ReviewProcessor(createMockState(storage), {} as never);
    const result = await processor.startReview({ ...baseContext, headSha: 'newsha' });

    expect(result).toMatchObject({ started: false, reason: 'deferred_new_push' });
  });

  it('terminal update hands the deferred request to a fresh workflow run and keeps its watchdog armed', async () => {
    const { store, storage } = createMockStorage();
    const { binding, created } = createWorkflowBinding();
    const { state, alarms, alarmCleared } = createMockStateWithAlarms(storage);
    store.set('reviewStatus', { state: 'running', attempts: 0, startedAt: new Date().toISOString(), runId: 'run-a' } as StoredStatus);
    store.set('reviewContext', { ...baseContext, headSha: 'aaa' });
    store.set('reviewPendingLatest', { ...baseContext, headSha: 'bbb', instruction: 'check concurrency' });

    // The create call must observe the NEW owner already committed (fencing
    // can never reject the handed-off run's first write).
    let ownerAtCreate: unknown;
    binding.create.mockImplementation(async (opts: { id: string; params: Record<string, unknown> }) => {
      ownerAtCreate = await storage.get<StoredStatus>('reviewStatus');
      created.push({ id: opts.id, params: opts.params });
    });

    const processor = new ReviewProcessor(state, { CODE_REVIEW_WORKFLOW: binding } as never);
    await processor.updateFromWorkflow({ state: 'complete', completedAt: new Date().toISOString(), runId: 'run-a' });

    // The safety alarm is armed before create and remains armed for the new run.
    expect(alarms.length).toBeGreaterThanOrEqual(1);
    expect(alarmCleared()).toBe(false);
    expect(ownerAtCreate).toMatchObject({ state: 'pending' });
    expect((ownerAtCreate as StoredStatus).runId).toBeTruthy();

    expect(created).toHaveLength(1);
    expect(created[0].id).toContain('review-tableoltd-test-repo-42');
    expect(created[0].id).toContain('-auto-');
    expect(created[0].params).toMatchObject({ instruction: 'check concurrency' });
    expect(typeof created[0].params.runId).toBe('string');
    expect(created[0].params).not.toHaveProperty('headSha');
    // New run owns the DO with a fresh runId; pendingLatest consumed
    const status = (await storage.get<StoredStatus>('reviewStatus'))!;
    expect(status.state).toBe('pending');
    expect(status.runId).toBeTruthy();
    expect(status.runId).not.toBe('run-a');
    expect(await storage.get('reviewPendingLatest')).toBeUndefined();
  });

  it('updateFromWorkflow ignores terminal writes from a superseded run (fencing)', async () => {
    const { store, storage } = createMockStorage();
    const { binding, created } = createWorkflowBinding();
    store.set('reviewStatus', { state: 'running', attempts: 0, startedAt: new Date().toISOString(), runId: 'run-new' } as StoredStatus);
    store.set('reviewContext', baseContext);
    store.set('reviewPendingLatest', { ...baseContext, headSha: 'later' });

    const processor = new ReviewProcessor(createMockState(storage), { CODE_REVIEW_WORKFLOW: binding } as never);
    // The OLD run (run-old) finishes late — must not flip state nor hand off
    await processor.updateFromWorkflow({ state: 'complete', runId: 'run-old' });

    const status = (await storage.get<StoredStatus>('reviewStatus'))!;
    expect(status.state).toBe('running');
    expect(created).toHaveLength(0);
    expect(await storage.get('reviewPendingLatest')).toMatchObject({ headSha: 'later' });
  });

  it('rejects legacy (runId-less) updates while a fenced owner exists', async () => {
    const { store, storage } = createMockStorage();
    store.set('reviewStatus', { state: 'running', attempts: 0, startedAt: new Date().toISOString(), runId: 'run-a' } as StoredStatus);
    store.set('reviewContext', baseContext);

    const processor = new ReviewProcessor(createMockState(storage), {} as never);
    await processor.updateFromWorkflow({ state: 'failed', error: 'legacy crash' });

    const status = (await storage.get<StoredStatus>('reviewStatus'))!;
    expect(status.state).toBe('running'); // late legacy write could not clobber the fenced owner
  });

  it('accepts legacy updates while the stored status itself predates fencing (pure legacy session)', async () => {
    const { store, storage } = createMockStorage();
    store.set('reviewStatus', { state: 'running', attempts: 0, startedAt: new Date().toISOString() } as StoredStatus);
    store.set('reviewContext', baseContext);

    const processor = new ReviewProcessor(createMockState(storage), {} as never);
    await processor.updateFromWorkflow({ state: 'failed', error: 'legacy crash' });

    const status = (await storage.get<StoredStatus>('reviewStatus'))!;
    expect(status.state).toBe('failed');
    expect(status.error).toBe('legacy crash');
  });

  it('treats two API requests with different model/maxFiles as different requests (fingerprint)', async () => {
    const { store, storage } = createMockStorage();
    const oneMinAgo = new Date(Date.now() - 60 * 1000).toISOString();
    store.set('reviewStatus', { state: 'running', attempts: 0, startedAt: oneMinAgo, runId: 'run-a' } as StoredStatus);
    store.set('reviewContext', { ...baseContext, model: 'kimi/k3', maxFiles: 50 });

    const processor = new ReviewProcessor(createMockState(storage), {} as never);
    const result = await processor.startReview({ ...baseContext, model: 'openai/gpt-4o', maxFiles: 50 });

    expect(result).toMatchObject({ started: false, reason: 'deferred_new_push' });
  });

  it('saveTrackedIssuesRpc is fenced: a superseded run cannot rewrite the issue store', async () => {
    const { store, storage } = createMockStorage();
    store.set('reviewStatus', { state: 'running', attempts: 0, startedAt: new Date().toISOString(), runId: 'run-new' } as StoredStatus);
    store.set('reviewContext', baseContext);

    const processor = new ReviewProcessor(createMockState(storage), {} as never);
    await processor.saveTrackedIssuesRpc([{ id: 'x' } as never], 'run-old');
    expect(await storage.get('trackedIssues')).toBeUndefined();

    await processor.saveTrackedIssuesRpc([{ id: 'y' } as never], 'run-new');
    expect(await storage.get('trackedIssues')).toEqual([{ id: 'y' }]);
  });

  it('handoff create failure keeps pendingLatest and schedules an alarm retry (push never lost)', async () => {
    const { store, storage } = createMockStorage();
    const alarms: number[] = [];
    storage.setAlarm = async (time: number) => {
      alarms.push(time);
    };
    storage.deleteAlarm = async () => {};
    const binding = {
      create: vi.fn((): Promise<void> => Promise.reject(new Error('workflow api unavailable'))),
      get: vi.fn(),
    };
    store.set('reviewStatus', { state: 'complete', attempts: 1, startedAt: new Date().toISOString(), runId: 'run-a' } as StoredStatus);
    store.set('reviewContext', baseContext);
    store.set('reviewPendingLatest', { ...baseContext, headSha: 'bbb' });

    const processor = new ReviewProcessor(createMockState(storage), { CODE_REVIEW_WORKFLOW: binding } as never);
    await processor.updateFromWorkflow({ state: 'complete', runId: 'run-a' });

    // The deferred push survived the failed handoff and retries are scheduled
    // (one armed before commit + one on the failure path). Ownership was
    // committed before the create attempt, so the retry's writes are fenced-in.
    expect(await storage.get('reviewPendingLatest')).toMatchObject({ headSha: 'bbb' });
    expect(alarms.length).toBeGreaterThanOrEqual(2);

    // The alarm retries the handoff; success consumes pendingLatest
    binding.create.mockImplementation(async () => { /* success */ });
    await processor.alarm();
    expect(await storage.get('reviewPendingLatest')).toBeUndefined();
    const status = (await storage.get<StoredStatus>('reviewStatus'))!;
    expect(status.state).toBe('pending');
  });

  it('handoff instance id is deterministic per request (no duplicate instances on retry)', async () => {
    const { store, storage } = createMockStorage();
    const ids: string[] = [];
    const binding = {
      create: vi.fn(async (opts: { id: string }) => {
        ids.push(opts.id);
      }),
      get: vi.fn(),
    };
    store.set('reviewStatus', { state: 'complete', attempts: 1, startedAt: new Date().toISOString(), runId: 'run-a' } as StoredStatus);
    store.set('reviewContext', baseContext);
    const pending = { ...baseContext, headSha: 'bbb' };
    store.set('reviewPendingLatest', pending);

    const processor = new ReviewProcessor(createMockState(storage), { CODE_REVIEW_WORKFLOW: binding } as never);
    await processor.updateFromWorkflow({ state: 'complete', runId: 'run-a' });
    // Simulate crash-before-consume: restore both pending and persisted intent.
    const runId = (await storage.get<StoredStatus>('reviewStatus'))!.runId!;
    store.set('reviewPendingLatest', pending);
    store.set('reviewHandoff', { fingerprint: JSON.stringify({ headSha: 'bbb', instruction: null, focusFiles: [], retrigger: false, commentId: null, model: null, maxFiles: null, installationId: null }), runId });
    await processor.alarm();

    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it('getRunId returns the current fencing token', async () => {
    const { store, storage } = createMockStorage();
    store.set('reviewStatus', { state: 'pending', attempts: 0, startedAt: new Date().toISOString(), runId: 'run-a' } as StoredStatus);

    const processor = new ReviewProcessor(createMockState(storage), {} as never);
    expect(await processor.getRunId()).toBe('run-a');
  });
});

describe('ReviewProcessor coordination — round-4 hardening', () => {
  function alarmTrackingStorage(seedStore: Map<string, unknown>) {
    const storage = {
      async get<T>(key: string): Promise<T | undefined> {
        return seedStore.get(key) as T | undefined;
      },
      async put<T>(key: string, value: T): Promise<void> {
        seedStore.set(key, value);
      },
      async delete(key: string): Promise<boolean> {
        return seedStore.delete(key);
      },
      async setAlarm(_t: number) { /* tracked via wrapper */ },
      async deleteAlarm() { /* noop */ },
    };
    return storage;
  }

  it('drops a deferred request whose head matches the just-completed run (superseded duplicate)', async () => {
    const store = new Map<string, unknown>();
    store.set('reviewStatus', { state: 'running', attempts: 0, startedAt: new Date().toISOString(), runId: 'run-a' } as StoredStatus);
    store.set('reviewContext', { ...baseContext, headSha: 'same-head' });
    store.set('reviewPendingLatest', { ...baseContext, headSha: 'same-head' });
    const storage = alarmTrackingStorage(store);
    const created: string[] = [];
    const binding = {
      create: vi.fn(async (opts: { id: string }) => {
        created.push(opts.id);
      }),
      get: vi.fn(),
    };

    const processor = new ReviewProcessor(createMockState(storage), { CODE_REVIEW_WORKFLOW: binding } as never);
    await processor.updateFromWorkflow({ state: 'complete', runId: 'run-a' });

    expect(created).toHaveLength(0);            // no wasted run
    expect(await storage.get('reviewPendingLatest')).toBeUndefined(); // consumed as superseded
  });

  it('keeps a NEWER deferred request that replaced the one being handed off', async () => {
    const store = new Map<string, unknown>();
    store.set('reviewStatus', { state: 'complete', attempts: 1, startedAt: new Date().toISOString(), runId: 'run-a' } as StoredStatus);
    store.set('reviewContext', { ...baseContext, headSha: 'aaa' });
    store.set('reviewPendingLatest', { ...baseContext, headSha: 'bbb' });
    const storage = alarmTrackingStorage(store);
    const binding = {
      // Simulate a newer push arriving WHILE the handoff awaits create.
      create: vi.fn(async () => {
        store.set('reviewPendingLatest', { ...baseContext, headSha: 'ccc' });
      }),
      get: vi.fn(),
    };

    const processor = new ReviewProcessor(createMockState(storage), { CODE_REVIEW_WORKFLOW: binding } as never);
    await processor.updateFromWorkflow({ state: 'complete', runId: 'run-a' });

    // The newer request (ccc) survived; the handed-off one (bbb) did not clobber it
    expect(await storage.get('reviewPendingLatest')).toMatchObject({ headSha: 'ccc' });
  });

  it('coalesces when an instance for the same request is already running (no duplicate restart)', async () => {
    const store = new Map<string, unknown>();
    store.set('reviewStatus', { state: 'complete', attempts: 1, startedAt: new Date().toISOString(), runId: 'run-a' } as StoredStatus);
    store.set('reviewContext', { ...baseContext, headSha: 'aaa' });
    store.set('reviewPendingLatest', { ...baseContext, headSha: 'bbb' });
    const storage = alarmTrackingStorage(store);
    const restart = vi.fn();
    const binding = {
      create: vi.fn(async () => {
        throw new Error('already_exists');
      }),
      get: vi.fn(async () => ({
        status: async () => 'running',
        restart,
      })),
    };

    const processor = new ReviewProcessor(createMockState(storage), { CODE_REVIEW_WORKFLOW: binding } as never);
    await processor.updateFromWorkflow({ state: 'complete', runId: 'run-a' });

    expect(restart).not.toHaveBeenCalled(); // live instance coalesced, not duplicated
    expect(await storage.get('reviewPendingLatest')).toBeUndefined();
  });
});

describe('ReviewProcessor coordination — round-5 hardening', () => {
  function baseStore() {
    const store = new Map<string, unknown>();
    store.set('reviewStatus', { state: 'running', attempts: 0, startedAt: new Date().toISOString(), runId: 'run-a' } as StoredStatus);
    store.set('reviewContext', { ...baseContext, headSha: 'aaa' });
    store.set('reviewPendingLatest', { ...baseContext, headSha: 'bbb' });
    return store;
  }

  function storageFrom(store: Map<string, unknown>) {
    return {
      async get<T>(key: string): Promise<T | undefined> {
        return store.get(key) as T | undefined;
      },
      async put<T>(key: string, value: T): Promise<void> {
        store.set(key, value);
      },
      async delete(key: string): Promise<boolean> {
        return store.delete(key);
      },
      async setAlarm(_t: number) { /* noop */ },
      async deleteAlarm() { /* noop */ },
    };
  }

  it('alarm does NOT hand off while another run still owns the DO (serialization)', async () => {
    const store = baseStore();
    // Status is RUNNING under run-a — an alarm-driven handoff must wait.
    const binding = { create: vi.fn(), get: vi.fn() };
    const processor = new ReviewProcessor(createMockState(storageFrom(store)), {
      CODE_REVIEW_WORKFLOW: binding,
    } as never);

    await processor.alarm();

    expect(binding.create).not.toHaveBeenCalled();
    expect(store.get('reviewPendingLatest')).toMatchObject({ headSha: 'bbb' }); // preserved
  });

  it.each(['waiting', 'paused', 'waitingForPause', 'complete'])('never restarts an existing %s instance', async (statusValue) => {
    const store = baseStore();
    store.set('reviewStatus', { state: 'complete', attempts: 1, startedAt: new Date().toISOString(), runId: 'run-a' });
    const restart = vi.fn();
    const binding = {
      create: vi.fn(async () => { throw new Error('already_exists'); }),
      get: vi.fn(async () => ({ status: async () => ({ status: statusValue }), restart })),
    };
    const processor = new ReviewProcessor(createMockState(storageFrom(store)), { CODE_REVIEW_WORKFLOW: binding } as never);
    await processor.updateFromWorkflow({ state: 'complete', runId: 'run-a', headSha: 'aaa' });
    expect(restart).not.toHaveBeenCalled();
  });

  it.each(['terminated', 'errored'])('does not restart an externally %s handoff', async (statusValue) => {
    const store = baseStore();
    const restart = vi.fn();
    const binding = {
      create: vi.fn(async () => { throw new Error('already_exists'); }),
      get: vi.fn(async () => ({ status: async () => ({ status: statusValue }), restart })),
    };
    const processor = new ReviewProcessor(createMockState(storageFrom(store)), { CODE_REVIEW_WORKFLOW: binding } as never);
    await processor.updateFromWorkflow({ state: 'complete', runId: 'run-a', headSha: 'aaa' });
    expect(restart).not.toHaveBeenCalled();
    expect(store.get('reviewStatus')).toMatchObject({ state: 'failed' });
    expect(store.get('reviewPendingLatest')).toBeUndefined();
  });

  it('delivers a newer request after observing a terminated handoff', async () => {
    const store = baseStore();
    const restart = vi.fn();
    const created: Array<{ params: { runId: string } }> = [];
    let attempt = 0;
    const binding = {
      create: vi.fn(async (opts: { params: { runId: string } }) => {
        created.push(opts);
        if (++attempt === 1) {
          store.set('reviewPendingLatest', { ...baseContext, headSha: 'ccc' });
          throw new Error('already_exists');
        }
      }),
      get: vi.fn(async () => ({ status: async () => ({ status: 'terminated' }), restart })),
    };
    const processor = new ReviewProcessor(createMockState(storageFrom(store)), { CODE_REVIEW_WORKFLOW: binding } as never);
    await processor.updateFromWorkflow({ state: 'complete', runId: 'run-a', headSha: 'aaa' });
    expect(restart).not.toHaveBeenCalled();
    expect(created).toHaveLength(2);
    expect(created[1].params.runId).not.toBe(created[0].params.runId);
    expect(store.get('reviewContext')).toMatchObject({ headSha: 'ccc' });
    expect(store.get('reviewPendingLatest')).toBeUndefined();
  });

  it('reads the SDK status() OBJECT shape ({status}) for coalescing', async () => {
    const store = baseStore();
    store.set('reviewStatus', { state: 'complete', attempts: 1, startedAt: new Date().toISOString(), runId: 'run-a' } as StoredStatus);
    const restart = vi.fn();
    const binding = {
      create: vi.fn(async () => {
        throw new Error('already_exists');
      }),
      get: vi.fn(async () => ({
        // Real SDK shape: resolves to an OBJECT, not a string.
        status: async () => ({ status: 'running' }),
        restart,
      })),
    };
    const processor = new ReviewProcessor(createMockState(storageFrom(store)), {
      CODE_REVIEW_WORKFLOW: binding,
    } as never);

    await processor.updateFromWorkflow({ state: 'complete', runId: 'run-a', headSha: 'aaa' });

    expect(restart).not.toHaveBeenCalled(); // live instance coalesced via object shape
  });

  it('suppression uses FULL request identity: same head with different instruction still runs', async () => {
    const store = baseStore();
    store.set('reviewStatus', { state: 'complete', attempts: 1, startedAt: new Date().toISOString(), runId: 'run-a' } as StoredStatus);
    // Completed context: head aaa, no instruction. Deferred: SAME head but a
    // manual instruction — a different intent that must NOT be suppressed.
    store.set('reviewPendingLatest', { ...baseContext, headSha: 'aaa', instruction: 'focus on auth' });
    const created: string[] = [];
    const binding = {
      create: vi.fn(async (opts: { id: string }) => {
        created.push(opts.id);
      }),
      get: vi.fn(),
    };
    const processor = new ReviewProcessor(createMockState(storageFrom(store)), {
      CODE_REVIEW_WORKFLOW: binding,
    } as never);

    await processor.updateFromWorkflow({ state: 'complete', runId: 'run-a', headSha: 'aaa' });

    expect(created).toHaveLength(1); // different identity → handed off
  });
});


describe('ReviewProcessor coordination — initial create recovery', () => {
  it('retries the exact pending workflow after the caller dies before create', async () => {
    const { storage } = createMockStorage();
    const create = vi.fn(async (_options: unknown) => {});
    const processor = new ReviewProcessor(createMockState(storage), { CODE_REVIEW_WORKFLOW: { create } } as never);
    const started = await processor.startReview({ ...baseContext, headSha: 'a' });
    await processor.startReview({ ...baseContext, headSha: 'b' });
    await processor.alarm();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({ params: { runId: started.runId } });
    expect(await storage.get('reviewPendingLatest')).toMatchObject({ headSha: 'b' });
  });

  it('does not restart a queued workflow when create reports already_exists', async () => {
    const { storage } = createMockStorage();
    const create = vi.fn(async () => { throw new Error('already_exists'); });
    const restart = vi.fn();
    const get = vi.fn(async () => ({ status: async () => ({ status: 'queued' }), restart }));
    const processor = new ReviewProcessor(createMockState(storage), { CODE_REVIEW_WORKFLOW: { create, get } } as never);
    await processor.startReview(baseContext);
    await processor.alarm();
    expect(create).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledOnce();
    expect(restart).not.toHaveBeenCalled();
  });
});

describe('ReviewProcessor coordination — aged fenced pending', () => {
  it('does not replace an old pending owner or discard its newer deferred push', async () => {
    const { store, storage } = createMockStorage();
    const old = { ...baseContext, headSha: 'a' };
    store.set('reviewStatus', { state: 'pending', attempts: 0, startedAt: new Date(Date.now() - 600_000).toISOString(), runId: 'run-a' });
    store.set('reviewContext', old);
    store.set('reviewPendingLatest', { ...baseContext, headSha: 'b' });
    const processor = new ReviewProcessor(createMockState(storage), {} as never);
    await processor.startReview({ ...baseContext, headSha: 'c' });
    expect((await storage.get<StoredStatus>('reviewStatus'))!.runId).toBe('run-a');
    expect(await storage.get('reviewPendingLatest')).toMatchObject({ headSha: 'c' });
  });

  it('rejects an old owner starting after replacement', async () => {
    const { store, storage } = createMockStorage();
    store.set('reviewStatus', { state: 'pending', attempts: 0, runId: 'new' });
    const processor = new ReviewProcessor(createMockState(storage), {} as never);
    expect(await processor.updateFromWorkflow({ state: 'running', runId: 'old' })).toBe(false);
    expect((await storage.get<StoredStatus>('reviewStatus'))!.runId).toBe('new');
  });
});

describe('ReviewProcessor coordination — failed handoff recovery', () => {
  it('a latest A event replaces deferred B and avoids a redundant review after A completes', async () => {
    const { store, storage } = createMockStorage();
    const active = { ...baseContext, headSha: 'a' };
    store.set('reviewStatus', { state: 'running', attempts: 0, startedAt: new Date().toISOString(), runId: 'a' });
    store.set('reviewContext', active);
    store.set('reviewPendingLatest', { ...baseContext, headSha: 'b' });
    const create = vi.fn();
    const processor = new ReviewProcessor(createMockState(storage), { CODE_REVIEW_WORKFLOW: { create } } as never);
    await processor.alarm();
    expect(await storage.get('reviewHandoff')).toBeUndefined();
    await processor.startReview(active);
    expect(await storage.get('reviewPendingLatest')).toMatchObject({ headSha: 'a' });
    await processor.updateFromWorkflow({ state: 'complete', runId: 'a', headSha: 'a' });
    expect(create).not.toHaveBeenCalled();
    expect(await storage.get('reviewPendingLatest')).toBeUndefined();
    expect(await storage.get('reviewHandoff')).toBeUndefined();
  });

  it('delivers C if B finishes after its create response was lost', async () => {
    const { store, storage } = createMockStorage();
    store.set('reviewStatus', { state: 'running', attempts: 0, startedAt: new Date().toISOString(), runId: 'a' });
    store.set('reviewContext', { ...baseContext, headSha: 'a' });
    store.set('reviewPendingLatest', { ...baseContext, headSha: 'b' });
    const create = vi.fn().mockRejectedValueOnce(new Error('response lost')).mockResolvedValue(undefined);
    const processor = new ReviewProcessor(createMockState(storage), { CODE_REVIEW_WORKFLOW: { create } } as never);
    await processor.updateFromWorkflow({ state: 'complete', runId: 'a' });
    const bRun = (await storage.get<StoredStatus>('reviewStatus'))!.runId!;
    store.set('reviewPendingLatest', { ...baseContext, headSha: 'c' });
    await processor.updateFromWorkflow({ state: 'complete', runId: bRun, headSha: 'b' });
    expect(create).toHaveBeenCalledTimes(2);
    expect(await storage.get('reviewContext')).toMatchObject({ headSha: 'c' });
  });
  it('reconciles an ambiguous create before delivering the newer pending request', async () => {
    const { store, storage } = createMockStorage();
    store.set('reviewStatus', { state: 'running', attempts: 0, startedAt: new Date().toISOString(), runId: 'old' });
    store.set('reviewContext', { ...baseContext, headSha: 'a' });
    store.set('reviewPendingLatest', { ...baseContext, headSha: 'b' });
    const create = vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue(undefined);
    const processor = new ReviewProcessor(createMockState(storage), { CODE_REVIEW_WORKFLOW: { create } } as never);
    await processor.updateFromWorkflow({ state: 'complete', runId: 'old' });
    const handoffRun = (await storage.get<StoredStatus>('reviewStatus'))!.runId!;
    expect((await storage.get<StoredStatus>('reviewStatus'))!.state).toBe('pending');
    store.set('reviewPendingLatest', { ...baseContext, headSha: 'c' });
    await processor.alarm();
    expect(create).toHaveBeenCalledTimes(2);
    expect((await storage.get<typeof baseContext & { headSha: string }>('reviewContext'))!.headSha).toBe('b');
    expect(await storage.get('reviewPendingLatest')).toMatchObject({ headSha: 'c' });
    await processor.updateFromWorkflow({ state: 'complete', runId: handoffRun, headSha: 'b' });
    expect(create).toHaveBeenCalledTimes(3);
    expect((await storage.get<typeof baseContext & { headSha: string }>('reviewContext'))!.headSha).toBe('c');
  });
});

describe('ReviewProcessor coordination — orphaned deferred cleanup', () => {
  it('head-carrying latest event replaces an older deferred head', async () => {
    const { store, storage } = createMockStorage();
    store.set('reviewStatus', { state: 'running', attempts: 0, startedAt: new Date(Date.now() - 60_000).toISOString(), runId: 'run-a' } as StoredStatus);
    store.set('reviewContext', { ...baseContext, headSha: 'aaa' });
    store.set('reviewPendingLatest', { ...baseContext, headSha: 'bbb' });

    const processor = new ReviewProcessor(createMockState(storage), {} as never);
    // The branch head returned to 'aaa' (matches the active run) after 'bbb' was deferred
    const result = await processor.startReview({ ...baseContext, headSha: 'aaa' });

    expect(result).toMatchObject({ started: false, reason: 'already_running' });
    expect(await storage.get('reviewPendingLatest')).toMatchObject({ headSha: 'aaa' });
  });

  it('comment redelivery (no headSha) never drops a deferred push', async () => {
    const { store, storage } = createMockStorage();
    store.set('reviewStatus', { state: 'running', attempts: 0, startedAt: new Date(Date.now() - 60_000).toISOString(), runId: 'run-a' } as StoredStatus);
    store.set('reviewContext', { ...baseContext, commentId: 55 });
    store.set('reviewPendingLatest', { ...baseContext, headSha: 'bbb' });

    const processor = new ReviewProcessor(createMockState(storage), {} as never);
    const result = await processor.startReview({ ...baseContext, commentId: 55 });

    expect(result).toMatchObject({ started: false, reason: 'already_running' });
    expect(await storage.get('reviewPendingLatest')).toMatchObject({ headSha: 'bbb' }); // preserved
  });
});
