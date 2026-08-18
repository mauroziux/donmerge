/**
 * Container lifecycle policy shared by review and triage workflows.
 *
 * A Sandbox is useful only while its workflow is active.  Keeping the
 * container around for the provider's idle timeout makes every completed
 * review pay for an unnecessary tail of provisioned memory/disk, so callers
 * should destroy it in their finally path.
 */
export const SANDBOX_SLEEP_AFTER = '5m';

export interface DestroyableSandbox {
  destroy?: () => Promise<unknown>;
}

export async function destroySandbox(
  sandbox: DestroyableSandbox,
  operation: string,
): Promise<void> {
  if (typeof sandbox.destroy !== 'function') return;

  try {
    await sandbox.destroy();
  } catch (error) {
    // Cleanup must not turn a successful review/triage into a failure. The
    // provider may already have removed the instance after a timeout.
    console.warn('[sandbox] cleanup failed', {
      operation,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
