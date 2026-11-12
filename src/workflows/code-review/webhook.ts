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
import { fetchCommentById, addCommentReaction, postReplyComment, isDonmergeBotAuthor } from './github-api';
import { classifyCommandIntent } from './reply-classifier';
import { parseFingerprint } from './fingerprint';
import { buildRunScopedInstanceId } from './workflow-id';

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
          commentBody: trigger.commentBody,
          installationId: payload.installation?.id,
          feedback: trigger.feedback,
          githubUser: trigger.githubUser,
          inReplyToId: trigger.inReplyToId,
        },
      };
    }
    return { shouldProcess: false, status: 200, body: { ok: true, skipped: true, reason: trigger.reason } };
  }

  // Natural-language replies to review comments — reply-learning candidates.
  // They must NOT start a review; the consumer correlates the parent comment
  // and only then decides whether the reply teaches anything.
  if (trigger.naturalReply) {
    return {
      shouldProcess: true,
      status: 202,
      body: { ok: true, accepted: true, replyLearning: true },
      context: {
        owner,
        repo,
        prNumber: trigger.prNumber,
        retrigger: false,
        commentId: trigger.commentId,
        commentType: trigger.commentType,
        installationId: payload.installation?.id,
        naturalReply: true,
        commentBody: trigger.commentBody,
        githubUser: trigger.githubUser,
        inReplyToId: trigger.inReplyToId,
      },
    };
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
      commentBody: trigger.commentBody,
      installationId: payload.installation?.id,
      instruction: trigger.instruction,
      focusFiles: trigger.focusFiles,
      headSha: trigger.headSha,
    },
  };
}

/**
 * Confirm a fetched parent comment belongs to a DonMerge finding recorded for
 * this repo. A DONMERGE HTML marker alone is forgeable by any PR contributor.
 */
async function findRecordedDonmergeParent(
  db: D1Database,
  owner: string,
  repo: string,
  parent: { id: number; user?: { login?: string; type?: string } },
  fingerprint: string
): Promise<boolean> {
  if (!isDonmergeBotAuthor(parent.user)) return false;
  const row = await db.prepare(`
    SELECT id FROM review_outcomes
    WHERE owner = ? AND repo = ? AND github_comment_id = ? AND fingerprint = ?
    LIMIT 1
  `).bind(owner, repo, parent.id, fingerprint).first<{ id: number }>();
  return Boolean(row);
}

/**
 * Process a natural-language reply to a review comment (reply learning).
 *
 * 1. Fetch the parent comment and parse its DonMerge fingerprint — replies on
 *    non-DonMerge threads are dropped silently.
 * 2. Classify the reply (heuristics + LLM). No teaching → no ack, no storage.
 * 3. Register feedback + learning, then acknowledge visibly (👍 + short reply
 *    in the same thread) so the human sees the loop closed.
 */
async function processNaturalReply(
  env: EnvWithReviewProcessor,
  context: WebhookContext
): Promise<void> {
  if (!env.DB) {
    console.warn('DB not bound — natural reply learning skipped');
    return;
  }
  if (!context.inReplyToId || !context.commentBody || !context.commentId) {
    return;
  }

  try {
    const token = await resolveGitHubToken(env, context.installationId);
    const parent = await fetchCommentById(
      context.owner,
      context.repo,
      context.inReplyToId,
      token,
      'review'
    );
    const meta = parent ? parseFingerprint(parent.body) : null;
    if (
      !parent ||
      !meta ||
      !(await findRecordedDonmergeParent(
        env.DB,
        context.owner,
        context.repo,
        parent,
        meta.fingerprint
      ))
    ) {
      // Not a recorded DonMerge finding — a copied marker is not sufficient.
      return;
    }

    const { handleNaturalReply } = await import('./feedback-handler');
    const ack = await handleNaturalReply(env.DB, env, {
      owner: context.owner,
      repo: context.repo,
      prNumber: context.prNumber,
      githubUser: context.githubUser ?? 'unknown',
      replyText: context.commentBody,
      parentFingerprint: meta.fingerprint,
      parentBody: parent.body,
      filePath: parent.path,
    });

    if (!ack) {
      // No actionable teaching in the reply — stay silent to avoid noise.
      return;
    }

    await addCommentReaction(
      context.owner,
      context.repo,
      context.commentId,
      'review',
      token,
      'thumbsup'
    );
    await postReplyComment(
      context.owner,
      context.repo,
      context.prNumber,
      context.inReplyToId,
      'review',
      ack.ackBody,
      token
    );
  } catch (error) {
    console.error('Failed to process natural reply', {
      owner: context.owner,
      repo: context.repo,
      prNumber: context.prNumber,
      error: error instanceof Error ? error.message : error,
    });
  }
}

/**
 * Start background processing of the code review.
 * Delegates to ReviewProcessor DO for status tracking and CodeReviewWorkflow for execution.
 */
export async function processGitHubCodeReviewWebhook(
  env: EnvWithReviewProcessor,
  context: WebhookContext
): Promise<void> {
  // ── Reply learning (natural-language replies to DonMerge comments) ──
  if (context.naturalReply) {
    await processNaturalReply(env, context);
    return;
  }

  // ── Feedback handling (dismiss/accept/override/preference/ignore reactions) ──
  if (context.feedback) {
    if (!env.DB) {
      console.warn('DB not bound — feedback not stored');
      return;
    }
    const { handleCommentFeedback, handleReactionFeedback } = await import('./feedback-handler');

    if (context.feedback.type === 'dismiss' || context.feedback.type === 'accept') {
      if (context.inReplyToId && context.commentId) {
        // Commands are accepted only as replies to a recorded DonMerge finding.
        // This applies equally to bare commands and explicit fingerprints.
        try {
          const token = await resolveGitHubToken(env, context.installationId);
          const parent = await fetchCommentById(
            context.owner,
            context.repo,
            context.inReplyToId,
            token,
            'review'
          );
          const meta = parent ? parseFingerprint(parent.body) : null;
          const trusted = Boolean(
            parent &&
            meta &&
            (await findRecordedDonmergeParent(
              env.DB,
              context.owner,
              context.repo,
              parent,
              meta.fingerprint
            ))
          );
          const fingerprint = context.feedback.fingerprint ?? meta?.fingerprint;

          if (trusted && fingerprint === meta!.fingerprint) {
            // A question about a command ("@donmerge dismiss?") must not mutate
            // memory — the model decides intent, not phrasing lists.
            const intent = await classifyCommandIntent(
              env,
              context.commentBody ?? `@donmerge ${context.feedback.type}`
            );
            if (intent === 'question') {
              console.log('Feedback command was a question — not executing', {
                owner: context.owner,
                repo: context.repo,
                inReplyToId: context.inReplyToId,
              });
              return;
            }
            await handleCommentFeedback(env.DB, {
              owner: context.owner,
              repo: context.repo,
              prNumber: context.prNumber,
              githubUser: context.githubUser ?? 'unknown',
              commentBody: `@donmerge ${context.feedback.type} ${fingerprint}`,
              commentId: context.commentId,
              inReplyToId: context.inReplyToId,
            });
            const ackBody = context.feedback.type === 'dismiss'
              ? '🤖 **Learned.** I will stop flagging this finding pattern in future reviews.'
              : '🤖 **Confirmed.** I will keep prioritizing findings like this.';
            await addCommentReaction(
              context.owner,
              context.repo,
              context.commentId,
              'review',
              token,
              'thumbsup'
            );
            await postReplyComment(
              context.owner,
              context.repo,
              context.prNumber,
              context.inReplyToId,
              'review',
              ackBody,
              token
            );
          } else {
            console.log('Feedback command did not match a recorded DonMerge parent — ignoring', {
              owner: context.owner,
              repo: context.repo,
              inReplyToId: context.inReplyToId,
            });
          }
        } catch (error) {
          console.error('Failed to correlate feedback reply with parent comment', {
            error: error instanceof Error ? error.message : error,
          });
        }
      } else if (context.commentId && !context.inReplyToId) {
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
            const isRecordedFinding = Boolean(
              metadata &&
              (await findRecordedDonmergeParent(
                env.DB,
                context.owner,
                context.repo,
                comment,
                metadata.fingerprint
              ))
            );
            if (!isRecordedFinding) return;
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
      // Severity overrides also require a reply to the recorded finding whose
      // fingerprint matches, rather than trusting user-supplied marker text.
      if (!context.inReplyToId || !context.commentId || !context.feedback.fingerprint) return;
      try {
        const token = await resolveGitHubToken(env, context.installationId);
        const parent = await fetchCommentById(
          context.owner,
          context.repo,
          context.inReplyToId,
          token,
          'review'
        );
        const meta = parent ? parseFingerprint(parent.body) : null;
        const trusted = Boolean(
          parent &&
          meta &&
          meta.fingerprint === context.feedback.fingerprint &&
          (await findRecordedDonmergeParent(
            env.DB,
            context.owner,
            context.repo,
            parent,
            meta.fingerprint
          ))
        );
        if (!trusted) return;

        const overrideIntent = await classifyCommandIntent(
          env,
          context.commentBody ?? `@donmerge override ${context.feedback.fingerprint}`
        );
        if (overrideIntent === 'question') {
          console.log('Severity override was a question — not executing', {
            owner: context.owner,
            repo: context.repo,
            inReplyToId: context.inReplyToId,
          });
          return;
        }

        await handleCommentFeedback(env.DB, {
          owner: context.owner,
          repo: context.repo,
          prNumber: context.prNumber,
          githubUser: context.githubUser ?? 'unknown',
          commentBody: `@donmerge override ${context.feedback.fingerprint} ${context.feedback.newSeverity ?? ''}`.trim(),
          commentId: context.commentId,
          inReplyToId: context.inReplyToId,
        });
        await addCommentReaction(
          context.owner,
          context.repo,
          context.commentId,
          'review',
          token,
          'thumbsup'
        );
        await postReplyComment(
          context.owner,
          context.repo,
          context.prNumber,
          context.inReplyToId,
          'review',
          '🤖 **Confirmed.** I will use this severity for the finding.',
          token
        );
      } catch (error) {
        console.error('Failed to validate severity override reply', {
          error: error instanceof Error ? error.message : error,
        });
      }
    } else {
      // Explicit repo preferences may be given as standalone @donmerge
      // commands. But a reply in an inline thread is accepted only when that
      // parent is a recorded DonMerge finding; unrelated threads are not a
      // route for injecting repo-wide learnings.
      // Preferences must be replies to a verified DonMerge finding; otherwise
      // any PR comment could silently set repository-wide policy.
      if (!context.inReplyToId || !context.commentId) return;
      let token: string | undefined;
      {
        try {
          token = await resolveGitHubToken(env, context.installationId);
          const parent = await fetchCommentById(
            context.owner,
            context.repo,
            context.inReplyToId,
            token,
            'review'
          );
          const meta = parent ? parseFingerprint(parent.body) : null;
          const trusted = Boolean(
            parent &&
            meta &&
            (await findRecordedDonmergeParent(
              env.DB,
              context.owner,
              context.repo,
              parent,
              meta.fingerprint
            ))
          );
          if (!trusted) return;
        } catch (error) {
          console.error('Failed to validate preference reply parent', {
            error: error instanceof Error ? error.message : error,
          });
          return;
        }
      }

      // A question about preferences must not become repository-wide policy.
      const preferenceIntent = await classifyCommandIntent(
        env,
        context.commentBody ?? `@donmerge preference`
      );
      if (preferenceIntent === 'question') {
        console.log('Preference command was a question — not executing', {
          owner: context.owner,
          repo: context.repo,
          commentId: context.commentId,
        });
        return;
      }

      const feedbackText = context.feedback.text ?? context.feedback.fingerprint ?? '';
      await handleCommentFeedback(env.DB, {
        owner: context.owner,
        repo: context.repo,
        prNumber: context.prNumber,
        githubUser: context.githubUser ?? 'unknown',
        commentBody: `@donmerge preference ${feedbackText}`,
        commentId: context.commentId ?? 0,
      });

      if (context.commentId) {
        try {
          token ??= await resolveGitHubToken(env, context.installationId);
          await addCommentReaction(
            context.owner,
            context.repo,
            context.commentId,
            context.commentType ?? 'review',
            token,
            'thumbsup'
          );
          await postReplyComment(
            context.owner,
            context.repo,
            context.prNumber,
            context.inReplyToId ?? context.commentId,
            context.commentType ?? 'review',
            '🤖 **Learned.** I will apply this preference to future reviews of this repo.',
            token
          );
        } catch (error) {
          console.warn('Failed to acknowledge preference learning:', error);
        }
      }
    }
    return;
  }

  const { owner, repo, prNumber, retrigger, commentId, commentType, installationId, instruction } =
    context;
  const focusFiles = context.focusFiles;

  // Every comment-based review trigger, including configured custom tags,
  // must clear the intent gate before starting a review.
  if (context.commentBody) {
    const intent = await classifyCommandIntent(env, context.commentBody);
    if (intent === 'question') {
      console.log('Command-shaped review trigger was a question — not starting review', {
        owner,
        repo,
        prNumber,
        commentId,
      });
      return;
    }
  }

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
  const startResult = await (processor as unknown as { startReview(ctx: {
    owner: string; repo: string; prNumber: number; retrigger: boolean;
    commentId?: number; commentType?: 'issue' | 'review';
    installationId?: number; instruction?: string; focusFiles?: string[];
    headSha?: string;
  }): Promise<{ started: boolean; reason: string; runId?: string }> }).startReview({
    owner,
    repo,
    prNumber,
    retrigger,
    commentId,
    commentType,
    installationId,
    instruction,
    focusFiles,
    headSha: context.headSha,
  });

  if (!startResult.started) {
    if (startResult.reason === 'pending_conflict') {
      // Let the queue retry rather than overwrite another caller's request.
      throw new Error('Review pending slot occupied by another caller');
    }
    if (startResult.reason === 'deferred_new_push') {
      // A newer push/intent arrived while a run is active. The DO stored it
      // as the latest deferred request and will hand it off when the active
      // run terminates — nothing else to do here (plan 004-U1).
      console.log('Review deferred: active run owns the DO; latest request queued for handoff', {
        owner,
        repo,
        prNumber,
      });
      return;
    }
    console.log('Duplicate review delivery acknowledged without restarting', {
      owner,
      repo,
      prNumber,
      reason: startResult.reason,
    });
    return;
  }

  // Comment-triggered re-reviews use a comment-specific ID so they run with
  // fresh webhook credentials/instructions rather than stale workflow params.
  if (env.CODE_REVIEW_WORKFLOW) {
    // Run-scoped instance id: THIS run gets its own instance; a restart (only
    // possible for this very delivery) replays THESE params, never a previous
    // run's stale ones (plan 004-U1).
    const instanceId = buildRunScopedInstanceId(owner, repo, prNumber, commentId, startResult.runId);
    try {
      await env.CODE_REVIEW_WORKFLOW.create({
        id: instanceId,
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
          runId: startResult.runId,
        },
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      if (errMsg.includes('already_exists')) {
        // The recovery alarm may already have created this run. Existing can
        // be queued or running; restarting it risks duplicating its effects.
        console.log('Run-scoped workflow already exists', { instanceId });
      } else {
        throw error;
      }
    }
  } else {
    console.warn('CODE_REVIEW_WORKFLOW not bound — review queued in DO but will not execute');
  }
}
