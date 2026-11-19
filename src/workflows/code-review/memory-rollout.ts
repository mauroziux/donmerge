import type { WorkerEnv } from './types';

/** The global switch always wins; an explicitly configured list limits rollout. */
export function scopedMemoryEnabledForRepo(
  env: Pick<WorkerEnv, 'DONMERGE_SCOPED_MEMORY' | 'DONMERGE_SCOPED_MEMORY_REPOS'>,
  owner: string,
  repo: string,
): boolean {
  if (env.DONMERGE_SCOPED_MEMORY === 'false') return false;
  if (env.DONMERGE_SCOPED_MEMORY_REPOS === undefined) return true;
  const fullName = `${owner}/${repo}`.toLowerCase();
  return env.DONMERGE_SCOPED_MEMORY_REPOS.split(',')
    .some(entry => entry.trim().toLowerCase() === fullName);
}
