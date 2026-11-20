import type { WorkerEnv } from './types';
import { isRepoAllowed, resolveGitHubTokenForRepo } from './github-auth';

// Worst case per target: two GitHub App auth requests, one reactions page,
// one D1 batch and one cursor update. Eight stays below the free-tier limit.
const MAX_TARGETS_PER_RUN = 8;
const PAGE_SIZE = 100;

export interface ReactionTarget {
  owner: string;
  repo: string;
  pr_number: number;
  comment_id: number;
  fingerprint: string;
  next_page: number;
}

interface GitHubReaction {
  id?: unknown;
  content?: unknown;
  user?: { login?: unknown; type?: unknown } | null;
}

export interface ReactionSignal {
  id: number;
  user: string;
  type: 'accept' | 'dismiss';
}

/** Record the event and feedback atomically; redeliveries and concurrent polls are idempotent. */
export async function recordReactionSignals(db: D1Database, target: ReactionTarget, signals: ReactionSignal[]): Promise<void> {
  if (!signals.length) return;
  const statements: D1PreparedStatement[] = [];
  for (const signal of signals) {
    statements.push(db.prepare(`INSERT OR IGNORE INTO scoped_learning_events
      (owner, repo, pr_number, source_type, source_id) VALUES (?, ?, ?, 'reaction', ?)`)
      .bind(target.owner, target.repo, target.pr_number, String(signal.id)));
    statements.push(db.prepare(`INSERT INTO feedback
      (owner, repo, pr_number, fingerprint, feedback_type, feedback_source, github_user, github_comment_id)
      SELECT ?, ?, ?, ?, ?, 'reaction', ?, ? WHERE changes() = 1`)
      .bind(target.owner, target.repo, target.pr_number, target.fingerprint, signal.type, signal.user, target.comment_id));
  }
  await db.batch(statements);
}

async function fetchReactionPage(target: ReactionTarget, token: string): Promise<GitHubReaction[]> {
  const owner = encodeURIComponent(target.owner);
  const repo = encodeURIComponent(target.repo);
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/comments/${target.comment_id}/reactions?per_page=${PAGE_SIZE}&page=${target.next_page}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'codex-review-worker',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`GitHub reaction lookup failed (${response.status})`);
  const data: unknown = await response.json();
  if (!Array.isArray(data) || data.length > PAGE_SIZE) throw new Error('GitHub returned an invalid reactions page');
  return data as GitHubReaction[];
}

/** Fair, bounded periodic polling. A failed target is retried without blocking others. */
export async function syncReactionFeedback(env: WorkerEnv): Promise<{ attempted: number; failed: number; skipped: number }> {
  if (!env.DB) throw new Error('D1 is required to sync reaction feedback');
  const db = env.DB;
  const result = await db.prepare(`SELECT owner, repo, pr_number, comment_id, fingerprint, next_page
    FROM reaction_poll_targets
    ORDER BY last_attempted_at ASC, owner ASC, repo ASC, comment_id ASC LIMIT ?`)
    .bind(MAX_TARGETS_PER_RUN).all<ReactionTarget>();
  const tokens = new Map<string, Promise<string>>();
  let failed = 0;
  let skipped = 0;
  for (const target of result.results ?? []) {
    let nextPage = target.next_page;
    try {
      if (!isRepoAllowed(target.owner, target.repo, env.REPO_CONFIGS)) {
        skipped++;
        continue;
      }
      const key = `${target.owner.toLowerCase()}/${target.repo.toLowerCase()}`;
      let token = tokens.get(key);
      if (!token) {
        token = resolveGitHubTokenForRepo(env, target.owner, target.repo);
        tokens.set(key, token);
      }
      const page = await fetchReactionPage(target, await token);
      const signals: ReactionSignal[] = page.flatMap(reaction => {
        const type = reaction.content === '+1' ? 'accept' : reaction.content === '-1' ? 'dismiss' : null;
        if (!type || typeof reaction.id !== 'number' || !Number.isSafeInteger(reaction.id) || reaction.id <= 0 ||
            reaction.user?.type !== 'User' || typeof reaction.user.login !== 'string' || !reaction.user.login) return [];
        return [{ id: reaction.id, type, user: reaction.user.login }];
      });
      await recordReactionSignals(db, target, signals);
      nextPage = page.length === PAGE_SIZE ? target.next_page + 1 : 1;
    } catch {
      failed++;
      console.warn('[reaction-sync] Could not sync review comment reactions', {
        owner: target.owner, repo: target.repo, prNumber: target.pr_number, commentId: target.comment_id,
      });
    } finally {
      // Leave the page cursor unchanged after a failure; rotating the target
      // prevents a deleted/inaccessible comment from starving the queue.
      await db.prepare(`UPDATE reaction_poll_targets SET next_page = ?, last_attempted_at = datetime('now')
        WHERE owner = ? AND repo = ? AND comment_id = ? AND next_page = ?`)
        .bind(nextPage, target.owner, target.repo, target.comment_id, target.next_page).run();
    }
  }
  return { attempted: result.results?.length ?? 0, failed, skipped };
}
