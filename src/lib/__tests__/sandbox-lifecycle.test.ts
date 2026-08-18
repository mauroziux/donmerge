import { describe, expect, it, vi } from 'vitest';
import { destroySandbox, SANDBOX_SLEEP_AFTER } from '../sandbox-lifecycle';

describe('sandbox lifecycle policy', () => {
  it('uses a short idle timeout as a cleanup fallback', () => {
    expect(SANDBOX_SLEEP_AFTER).toBe('5m');
  });

  it('destroys the sandbox when available', async () => {
    const destroy = vi.fn().mockResolvedValue(undefined);

    await destroySandbox({ destroy }, 'test');

    expect(destroy).toHaveBeenCalledOnce();
  });

  it('does not propagate cleanup failures', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const destroy = vi.fn().mockRejectedValue(new Error('already gone'));

    await expect(destroySandbox({ destroy }, 'test')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('[sandbox] cleanup failed', {
      operation: 'test',
      error: 'already gone',
    });

    warn.mockRestore();
  });
});
