/**
 * Push-debounce (cost control).
 *
 * Previously every `pull_request.synchronize` webhook started a full review, so
 * a PR with 10 pushes was reviewed 10 times, each time with the whole
 * accumulated diff. Now synchronize deliveries wait a debounce window in the
 * queue and the consumer drops any message whose head SHA is no longer the
 * PR's head — a burst of pushes produces exactly one review (the last push).
 *
 * Producer side: `debounceSendOptions` adds the queue delay.
 * Consumer side: `isDebounceEnabled` + a `fetchPrHeadSha` comparison decide
 * whether a delayed message is still current.
 */

import type { WebhookContext, WorkerEnv } from '../workflows/code-review/types';

export const DEFAULT_PUSH_DEBOUNCE_SECONDS = 600;
/** Cloudflare Queues per-message delay cap. */
export const MAX_QUEUE_DELAY_SECONDS = 3600;

export function parseDebounceSeconds(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_PUSH_DEBOUNCE_SECONDS;
  return parsed;
}

export function isDebounceEnabled(env: Pick<WorkerEnv, 'REVIEW_PUSH_DEBOUNCE_SECONDS'>): boolean {
  return parseDebounceSeconds(env.REVIEW_PUSH_DEBOUNCE_SECONDS) > 0;
}

/**
 * Only automatic pushes are debounced: opened (immediate first feedback),
 * reopened/base retarget (rare, semantic), and any explicit human request
 * (comment trigger → commentId/instruction) run without delay.
 */
export function isDebouncedPush(context: WebhookContext | undefined): boolean {
  return Boolean(
    context &&
    context.triggerAction === 'synchronize' &&
    context.retrigger &&
    !context.commentId &&
    !context.instruction &&
    !context.focusFiles?.length &&
    context.headSha
  );
}

export function debounceSendOptions(
  env: Pick<WorkerEnv, 'REVIEW_PUSH_DEBOUNCE_SECONDS'>,
  event: string,
  context?: WebhookContext
): { delaySeconds: number } | undefined {
  if (event !== 'pull_request') return undefined;
  if (!isDebounceEnabled(env)) return undefined;
  if (!isDebouncedPush(context)) return undefined;
  const seconds = parseDebounceSeconds(env.REVIEW_PUSH_DEBOUNCE_SECONDS);
  return { delaySeconds: Math.min(seconds, MAX_QUEUE_DELAY_SECONDS) };
}
