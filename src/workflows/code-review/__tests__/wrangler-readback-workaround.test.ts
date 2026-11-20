import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { extendReadbackRetry } from '../../../../scripts/extend-wrangler-readback.mjs';

const require = createRequire(import.meta.url);
const packagePath = require.resolve('wrangler/package.json');
const version = JSON.parse(readFileSync(packagePath, 'utf8')).version as string;
const source = readFileSync(join(dirname(packagePath), 'wrangler-dist', 'cli.js'), 'utf8');

class FakeAPIError extends Error {
  constructor(public code: number) { super(`API error ${code}`); }
}

function makeReadback(fetchVersion2: ReturnType<typeof vi.fn>, wait: ReturnType<typeof vi.fn>) {
  const patched = extendReadbackRetry(source, version);
  const start = patched.indexOf('async function fetchUploadedVersion(');
  const end = patched.indexOf('\nasync function listDurableObjects(', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return runInNewContext(`(${patched.slice(start, end)})`, {
    APIError: FakeAPIError, fetchVersion2, timersPromises: { setTimeout: wait },
  }) as (config: object, account: string, script: string, id: string) => Promise<unknown>;
}

describe('temporary Wrangler version readback workaround', () => {
  it('retries the same version after transient 100146 errors and returns its result', async () => {
    const fetchVersion = vi.fn();
    for (let i = 0; i < 6; i++) fetchVersion.mockRejectedValueOnce(new FakeAPIError(100146));
    fetchVersion.mockResolvedValueOnce({ id: 'same-version' });
    const wait = vi.fn().mockResolvedValue(undefined);
    const readback = makeReadback(fetchVersion, wait);

    await expect(readback({}, 'account', 'worker', 'same-version')).resolves.toEqual({ id: 'same-version' });
    expect(fetchVersion).toHaveBeenCalledTimes(7);
    expect(fetchVersion.mock.calls.every(call => call[3] === 'same-version')).toBe(true);
    expect(wait.mock.calls.map(call => call[0])).toEqual([500, 500, 500, 500, 10000, 20000]);
  });

  it('stops after the bounded window and propagates the last 100146', async () => {
    const error = new FakeAPIError(100146);
    const fetchVersion = vi.fn().mockRejectedValue(error);
    const wait = vi.fn().mockResolvedValue(undefined);
    await expect(makeReadback(fetchVersion, wait)({}, 'account', 'worker', 'id')).rejects.toBe(error);
    expect(fetchVersion).toHaveBeenCalledTimes(8);
    expect(wait.mock.calls.map(call => call[0])).toEqual([500, 500, 500, 500, 10000, 20000, 30000]);
  });

  it.each([new FakeAPIError(42), new Error('network failure')])('propagates unrelated failures immediately', async error => {
    const fetchVersion = vi.fn().mockRejectedValue(error);
    const wait = vi.fn();
    await expect(makeReadback(fetchVersion, wait)({}, 'account', 'worker', 'id')).rejects.toBe(error);
    expect(fetchVersion).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it('refuses an unexpected version or changed bundle', () => {
    expect(() => extendReadbackRetry(source, '0.0.0')).toThrow('Unexpected Wrangler bundle');
    expect(() => extendReadbackRetry(source + '\n', version)).toThrow('Unexpected Wrangler bundle');
  });
});
