import type { WorkerEnv } from './types';

/** Scoped memory is an explicit, repository-limited opt-in. */
export function scopedMemoryEnabledForRepo(
  env: Pick<WorkerEnv, 'DONMERGE_SCOPED_MEMORY' | 'DONMERGE_SCOPED_MEMORY_REPOS'>,
  owner: string,
  repo: string,
): boolean {
  if (env.DONMERGE_SCOPED_MEMORY?.trim().toLowerCase() !== 'true') return false;
  if (!env.DONMERGE_SCOPED_MEMORY_REPOS) return false;
  const fullName = `${owner}/${repo}`.toLowerCase();
  return env.DONMERGE_SCOPED_MEMORY_REPOS.split(',')
    .some(entry => entry.trim().toLowerCase() === fullName);
}
