/**
 * Webhook validation and processing for code review.
 *
 * Uses ReviewProcessor Durable Object for status tracking and concurrency control.
 * Actual review execution is handled by CodeReviewWorkflow.
 */

import type { WorkerEnv, WebhookPayload, FastValidationResult, WebhookContext } from './types';
import { verifyWebhookSignature, isRepoAllowed, resolveGitHubToken } from './github-auth';
import { parseTrigger } from './triggers';
import { getReviewProcessor } from './processor';
import { fetchCommentById } from './github-api';
import { parseFingerprint } from './fingerprint';

interface EnvWithReviewProcessor extends WorkerEnv {
  ReviewProcessor: DurableObjectNamespace;
  CODE_REVIEW_WORKFLOW?: Workflow;
}

/**
 * Fast validation that completes within GitHub's 10s timeout.
 * Validates signature, repo allowlist, and trigger conditions.
 * Returns context needed for background processing.
 */
export async function validateWebhookFast(
  env: WorkerEnv,
  event: string,
  signature: string,
  rawBody: string
): Promise<FastValidationResult> {
  const isValid = await verifyWebhookSignature(env.GITHUB_WEBHOOK_SECRET, rawBody, signature);
  if (!isValid) {
    return { shouldProcess: false, status: 401, body: { error: 'invalid signature' } };
  }

  const payload = JSON.parse(rawBody) as WebhookPayload;
  const owner = payload.repository?.owner.login;
  const repo = payload.repository?.name;

  if (!owner || !repo) {
    return { shouldProcess: false, status: 400, body: { error: 'missing repository context' } };
  }

  if (!isRepoAllowed(owner, repo, env.REPO_CONFIGS)) {
    return {
      shouldProcess: false,
      status: 403,
      body: {
        error: 'repository not allowed',
        repository: owner + '/' + repo,
      },
    };
  }

  console.log('Webhook received', {
    event,
    action: payload.action,
    owner,
    repo,
    prNumber: payload.pull_request?.number ?? payload.issue?.number ?? null,
  });

  const trigger = parseTrigger(event, payload, env.REVIEW_TRIGGER);
  if (!trigger.shouldRun) {
    // Feedback commands (dismiss/accept/override/preference/ignore) should still be processed
    if (trigger.feedback) {
      return {
        shouldProcess: true,
        status: 202,
        body: { ok: true, accepted: true, feedback: true },
        context: {
          owner,
          repo,
          prNumber: trigger.prNumber,
          retrigger: false,
          commentId: trigger.commentId,
          commentType: trigger.commentType,
          installationId: payload.installation?.id,
          feedback: trigger.feedback,
          githubUser: trigger.githubUser,
          inReplyToId: trigger.inReplyToId,
        },
      };
    }
    return { shouldProcess: false, status: 200, body: { ok: true, skipped: true, reason: trigger.reason } };
  }

  return {
    shouldProcess: true,
    status: 202,
    body: { ok: true, accepted: true },
    context: {
      owner,
      repo,
      prNumber: trigger.prNumber,
      retrigger: trigger.retrigger,
      commentId: trigger.commentId,
      commentType: trigger.commentType,
      installationId: payload.installation?.id,
      instruction: trigger.instruction,
      focusFiles: trigger.focusFiles,
    },
  };
}

/**
 * Start background processing of the code review.
 * Delegates to ReviewProcessor DO for status tracking and CodeReviewWorkflow for execution.
 */
export async function processGitHubCodeReviewWebhook(
  env: EnvWithReviewProcessor,
  context: WebhookContext
): Promise<void> {
  // ── Feedback handling (dismiss/accept/override/preference/ignore reactions) ──
  if (context.feedback) {
    if (!env.DB) {
      console.warn('DB not bound — feedback not stored');
      return;
    }
    const { handleCommentFeedback, handleReactionFeedback } = await import('./feedback-handler');

    if (context.feedback.type === 'dismiss' || context.feedback.type === 'accept') {
      if (context.feedback.fingerprint) {
        // @donmerge command (dismiss/accept) — fingerprint already parsed from command
        await handleCommentFeedback(env.DB, {
          owner: context.owner,
          repo: context.repo,
          prNumber: context.prNumber,
          githubUser: context.githubUser ?? 'unknown',
          commentBody: `@donmerge ${context.feedback.type} ${context.feedback.fingerprint}`,
          commentId: context.commentId ?? 0,
          inReplyToId: context.inReplyToId,
        });
      } else if (context.commentId) {
        // Reaction event — need to fetch comment body to get the fingerprint
        try {
          const token = await resolveGitHubToken(env, context.installationId);
          const comment = await fetchCommentById(
            context.owner,
            context.repo,
            context.commentId,
            token,
            context.commentType
          );
          if (comment) {
            const metadata = parseFingerprint(comment.body);
            await handleReactionFeedback(env.DB, {
              owner: context.owner,
              repo: context.repo,
              prNumber: context.prNumber,
              githubUser: context.githubUser ?? 'unknown',
              reaction: context.feedback.type === 'dismiss' ? 'thumbsdown' : 'thumbsup',
              commentId: context.commentId,
              commentFingerprint: metadata?.fingerprint,
            });
          }
        } catch (error) {
          console.error('Failed to handle reaction feedback', {
            error: error instanceof Error ? error.message : error,
          });
        }
      }
    } else if (context.feedback.type === 'override') {
      // @donmerge override <fingerprint> <severity>
      const feedbackText = context.feedback.fingerprint
        ? `${context.feedback.fingerprint} ${context.feedback.newSeverity ?? ''}`
        : '';
      await handleCommentFeedback(env.DB, {
        owner: context.owner,
        repo: context.repo,
        prNumber: context.prNumber,
        githubUser: context.githubUser ?? 'unknown',
        commentBody: `@donmerge override ${feedbackText}`.trim(),
        commentId: context.commentId ?? 0,
        inReplyToId: context.inReplyToId,
      });
    } else {
      // preference/ignore/focus-as-learning
      const feedbackText = context.feedback.text ?? context.feedback.fingerprint ?? '';
      await handleCommentFeedback(env.DB, {
        owner: context.owner,
        repo: context.repo,
        prNumber: context.prNumber,
        githubUser: context.githubUser ?? 'unknown',
        commentBody: `@donmerge preference ${feedbackText}`,
        commentId: context.commentId ?? 0,
      });
    }
    return;
  }

  const { owner, repo, prNumber, retrigger, commentId, commentType, installationId, instruction } =
    context;
  const focusFiles = context.focusFiles;

  console.log('Starting review via ReviewProcessor + CodeReviewWorkflow', {
    owner,
    repo,
    prNumber,
    retrigger,
    hasInstruction: !!instruction,
    focusFilesCount: focusFiles?.length ?? 0,
  });

  // Get the ReviewProcessor DO for this PR
  const processor = getReviewProcessor(env.ReviewProcessor, owner, repo, prNumber);

  // Start the review (stores context, initializes status in DO)
  await (processor as unknown as { startReview(ctx: {
    owner: string; repo: string; prNumber: number; retrigger: boolean;
    commentId?: number; commentType?: 'issue' | 'review';
    installationId?: number; instruction?: string; focusFiles?: string[];
  }): Promise<void> }).startReview({
    owner,
    repo,
    prNumber,
    retrigger,
    commentId,
    commentType,
    installationId,
    instruction,
    focusFiles,
  });

  // Create the workflow to handle execution
  if (env.CODE_REVIEW_WORKFLOW) {
    await env.CODE_REVIEW_WORKFLOW.create({
      id: `review/${owner}/${repo}/${prNumber}`,
      params: {
        owner,
        repo,
        prNumber,
        retrigger,
        commentId,
        commentType,
        installationId,
        instruction,
        focusFiles,
      },
    });
  } else {
    console.warn('CODE_REVIEW_WORKFLOW not bound — review queued in DO but will not execute');
  }
}
