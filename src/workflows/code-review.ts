import { getSandbox } from '@cloudflare/sandbox';
import { FlueRuntime } from '@flue/cloudflare';
import * as v from 'valibot';

export interface WorkerEnv {
  Sandbox: unknown;
  OPENAI_API_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_TOKEN_PAT?: string;
  BASE_BRANCH?: string;
  CODEX_MODEL?: string;
  MAX_REVIEW_FILES?: string;
  ALLOWED_REPOS?: string;
  REVIEW_TRIGGER?: string;
}

interface GitHubRepository {
  owner: { login: string };
  name: string;
}

interface PullRequestPayload {
  number: number;
}

interface WebhookPayload {
  action?: string;
  installation?: { id: number };
  repository?: GitHubRepository;
  pull_request?: PullRequestPayload;
  issue?: {
    number: number;
    pull_request?: Record<string, unknown>;
  };
  comment?: { body?: string; id?: number };
}

interface ReviewComment {
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  body: string;
  severity: 'critical' | 'suggestion';
}

```

interface PreviousComment {
  id: number;
  path: string;
  line: number;
  body: string;
  inReplyToId?: number;
}

interface PreviousComment {
  id: number;
  path: string;
  line: number;
  body: string;
  inReplyToId?: number;
}

interface ReviewResult {
  approved: boolean;
  summary: string;
  lineComments: ReviewComment[];
  criticalIssues: string[];
  suggestions: string[];
  resolvedComments?: number[];
  fileSummaries?: FileSummary[]; // Brief summary of changes per file
}

interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

interface WebhookContext {
  owner: string;
  repo: string;
  prNumber: number;
  retrigger: boolean;
  commentId?: number;
  commentType?: 'issue' | 'review';
  installationId?: number;
  instruction?: string; // Custom instruction from the user
}

interface FastValidationResult {
  shouldProcess: boolean;
  status: number;
  body: Record<string, unknown>;
  context?: WebhookContext;
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
  rawBody: string,
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

  if (!isRepoAllowed(owner, repo, env.ALLOWED_REPOS)) {
    return {
      shouldProcess: false,
      status: 403,
      body: {
        error: 'repository not allowed',
        repository: `${owner}/${repo}`,
      },
    };
  }

  const trigger = parseTrigger(event, payload, env.REVIEW_TRIGGER);
  if (!trigger.shouldRun) {
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
    },
  };
}

/**
 * Background processing of the code review.
 * Called via waitUntil() after responding 202 to GitHub.
 */
export async function processGitHubCodeReviewWebhook(
  env: WorkerEnv,
  context: WebhookContext,
): Promise<void> {
  const { owner, repo, prNumber, retrigger, commentId, commentType, installationId, instruction } = context;

  console.log('Starting background review', { owner, repo, prNumber, retrigger, hasInstruction: !!instruction });

  let githubToken: string;
  try {
    githubToken = await resolveGitHubToken(env, installationId);
  } catch (error) {
    console.error('Failed to resolve GitHub token', {
      owner,
      repo,
      error: error instanceof Error ? error.message : error,
    });
    return;
  }

  // Add eyes reaction to comment if triggered by @donmerge mention
  if (commentId && commentType) {
    await addCommentReaction(owner, repo, commentId, commentType, githubToken);
  }

  const pr = await githubFetch<{ base: { ref: string }; head: { sha: string }; body?: string; title?: string }>(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
    githubToken,
  );

  const baseBranch = env.BASE_BRANCH ?? 'main';
  if (pr.base.ref !== baseBranch) {
    console.log('PR skipped - wrong base branch', {
      owner,
      repo,
      prNumber,
      expected: baseBranch,
      actual: pr.base.ref,
    });
    return;
  }

  const checkRun = await createCheckRun(owner, repo, pr.head.sha, githubToken);

  // On retrigger, fetch previous DonMerge comments to potentially resolve them
  let previousComments: PreviousComment[] = [];
  if (retrigger) {
    previousComments = await fetchPreviousDonMergeComments(owner, repo, prNumber, githubToken);
    console.log('Found previous comments to check', { count: previousComments.length });
  }

  try {
    const review = await runReviewWithFlue({
      env,
      githubToken,
      owner,
      repo,
      prNumber,
      retrigger,
      instruction,
      previousComments,
    });

    // Resolve comments that are now fixed
    if (review.resolvedComments && review.resolvedComments.length > 0) {
      await resolveFixedComments(owner, repo, review.resolvedComments, githubToken);
    }

    await publishReview(owner, repo, prNumber, pr.head.sha, review, githubToken);
    await completeCheckRun(owner, repo, checkRun.id, review, githubToken);
    await updatePRDescription(owner, repo, prNumber, review, githubToken);

    console.log('Review completed successfully', {
      owner,
      repo,
      prNumber,
      approved: review.approved,
      criticalIssues: review.criticalIssues.length,
      suggestions: review.suggestions.length,
      resolvedComments: review.resolvedComments?.length ?? 0,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    await failCheckRun(owner, repo, checkRun.id, message, githubToken);
    console.error('code-review webhook failed', {
      owner,
      repo,
      prNumber,
      model: env.CODEX_MODEL ?? 'codex-5.3',
      error: message,
    });
  }
}

function parseTrigger(event: string, payload: WebhookPayload, triggerTag?: string): {
  shouldRun: boolean;
  prNumber: number;
  retrigger: boolean;
  commentId?: number;
  commentType?: 'issue' | 'review';
  instruction?: string;
  reason?: string;
} {
  const triggerRegex = getTriggerRegex(triggerTag);
  const triggerTagNormalized = (triggerTag ?? '@donmerge').trim();

  if (event === 'pull_request') {
    const valid = payload.action === 'opened' || payload.action === 'synchronize' || payload.action === 'reopened';
    if (!valid || !payload.pull_request) {
      return { shouldRun: false, prNumber: 0, retrigger: false, reason: 'ignored pull_request action' };
    }
    return { shouldRun: true, prNumber: payload.pull_request.number, retrigger: false };
  }

  if (event === 'issue_comment') {
    const body = payload.comment?.body ?? '';
    const isPrComment = Boolean(payload.issue?.pull_request);
    const shouldRun = payload.action === 'created' && isPrComment && triggerRegex.test(body);
    if (!shouldRun || !payload.issue) {
      return { shouldRun: false, prNumber: 0, retrigger: false, reason: 'comment does not trigger review' };
    }
    const instruction = extractInstruction(body, triggerTagNormalized);
    return {
      shouldRun: true,
      prNumber: payload.issue.number,
      retrigger: true,
      commentId: payload.comment?.id,
      commentType: 'issue',
      instruction,
    };
  }

  if (event === 'pull_request_review_comment') {
    const body = payload.comment?.body ?? '';
    const shouldRun = payload.action === 'created' && triggerRegex.test(body);
    if (!shouldRun || !payload.pull_request) {
      return {
        shouldRun: false,
        prNumber: 0,
        retrigger: false,
        reason: 'review comment does not trigger review',
      };
    }
    const instruction = extractInstruction(body, triggerTagNormalized);
    return {
      shouldRun: true,
      prNumber: payload.pull_request.number,
      retrigger: true,
      commentId: payload.comment?.id,
      commentType: 'review',
      instruction,
    };
  }

  return { shouldRun: false, prNumber: 0, retrigger: false, reason: `unsupported event: ${event}` };
}

/**
 * Extract instruction from comment after the trigger tag.
 * Example: "@donmerge focus on security" -> "focus on security"
 */
function extractInstruction(body: string, triggerTag: string): string | undefined {
  // Create regex to find trigger tag and capture everything after it
  const escaped = triggerTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`${escaped}\\s+(.+)$`, 'im');
  const match = body.match(regex);
  
  if (match && match[1]) {
    const instruction = match[1].trim();
    // Return only if there's actual content
    return instruction.length > 0 ? instruction : undefined;
  }
  
  return undefined;
}

function getTriggerRegex(triggerTag?: string): RegExp {
  const normalized = (triggerTag ?? '@donmerge').trim();
  if (!normalized) {
    return /@donmerge/i;
  }
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped, 'i');
}

async function resolveGitHubToken(env: WorkerEnv, installationId?: number): Promise<string> {
  if (env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && installationId) {
    const appJwt = await createGitHubAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
    return createInstallationToken(installationId, appJwt);
  }

  if (env.GITHUB_TOKEN_PAT) {
    return env.GITHUB_TOKEN_PAT;
  }

  throw new Error('Missing GitHub credentials: configure GitHub App (GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY) or GITHUB_TOKEN_PAT');
}

function isRepoAllowed(owner: string, repo: string, allowedReposVar?: string): boolean {
  const configured = (allowedReposVar ?? '').trim();
  if (!configured) {
    return true;
  }

  const requested = `${owner}/${repo}`.toLowerCase();
  const allowed = configured
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);

  return allowed.includes(requested);
}

async function runReviewWithFlue(input: {
  env: WorkerEnv;
  githubToken: string;
  owner: string;
  repo: string;
  prNumber: number;
  retrigger: boolean;
  instruction?: string;
  previousComments?: PreviousComment[];
}): Promise<ReviewResult> {
  const sessionId = `review-${input.owner}-${input.repo}-${input.prNumber}-${Date.now()}`;
  const sandbox = getSandbox(input.env.Sandbox, sessionId, { sleepAfter: '30m' });
  const flue = new FlueRuntime({ sandbox, sessionId, workdir: '/home/user' });

  await sandbox.setEnvVars({
    OPENAI_API_KEY: input.env.OPENAI_API_KEY,
    GITHUB_TOKEN: input.githubToken,
  });
  await flue.setup();

  const filesResponse = await githubFetch<Array<{ filename: string; patch?: string }>>(
    `https://api.github.com/repos/${input.owner}/${input.repo}/pulls/${input.prNumber}/files?per_page=100`,
    input.githubToken,
  );

  const maxFiles = Number.parseInt(input.env.MAX_REVIEW_FILES ?? '50', 10);
  const filesToReview = filesResponse.slice(0, maxFiles);
  const diffText = filesToReview
    .map((file) => `FILE: ${file.filename}\n${file.patch ?? '[no patch available]'}\n`)
    .join('\n');

  const model = parseModelConfig(input.env.CODEX_MODEL);

  // Build prompt with optional instruction and previous comments
  const promptParts: string[] = [
    'You are DonMerge 🤠, a friendly senior code reviewer.',
    '',
    'PERSONALITY (subtle touches only):',
    '- Occasionally start comments with: "Compadre...", "Che...", "Ojo...", "Mira..."',
    '- Keep it professional but warm, like a helpful senior dev',
    '',
    'CRITICAL RULES:',
    '1. If you find ANY issues, you MUST provide lineComments - do NOT just list them in criticalIssues',
    '2. Each lineComment MUST include the exact line number from the diff',
    '3. If no issues found, set approved=true and lineComments=[]',
    '',
    'COMMENT FORMAT (required for each issue):',
    'Each lineComment body must follow this exact format:',
    '',
    '🔴 **Issue:** [clear description of the problem]',
    '',
    '💡 **Suggestion:** [specific code or approach to fix it]',
    '',
    '🤖 **AI Prompt:**',
    '```',
    '[copy-pasteable prompt for an AI assistant to fix this]',
    '```',
    '',
    'EXAMPLE COMMENT:',
    '"🔴 **Issue:** This SQL query is vulnerable to injection attacks - user input is directly concatenated.',
    '',
    '💡 **Suggestion:** Use parameterized queries with prepared statements.',
    '',
    '🤖 **AI Prompt:**',
    '```',
    'Refactor this database query to use parameterized statements. Replace string concatenation with placeholders and bind the user input parameter.',
    '```"',
    '',
    'IMPORTANT: Write ALL comments in English. Only sprinkle in Spanish expressions occasionally (like "Compadre", "Che").',
    'A developer who speaks no Spanish should understand everything.',
  ];

  // Add custom instruction if provided
  if (input.instruction) {
    promptParts.push('');
    promptParts.push('📝 CUSTOM INSTRUCTION FROM DEVELOPER:');
    promptParts.push(`"${input.instruction}"`);
    promptParts.push('Focus your review based on this instruction.');
  }

  // Add previous comments to check if retrigger
  if (input.retrigger && input.previousComments && input.previousComments.length > 0) {
    promptParts.push('');
    promptParts.push('🔄 PREVIOUS COMMENTS TO CHECK:');
    promptParts.push('You previously left these comments. Check if they have been addressed in the new diff.');
    promptParts.push('If an issue is FIXED, include its ID in the "resolvedComments" array.');
    promptParts.push('');
    input.previousComments.forEach((comment, index) => {
      promptParts.push(`[${index + 1}] ID:${comment.id} | File:${comment.path}:${comment.line}`);
      promptParts.push(`    ${comment.body.substring(0, 200)}${comment.body.length > 200 ? '...' : ''}`);
    });
  }

  promptParts.push('');
  promptParts.push('Return ONLY valid JSON (no markdown, no code blocks) with this schema:');
  promptParts.push('{');
  promptParts.push('  "approved": boolean,');
  promptParts.push('  "summary": "1-2 sentence summary of the review",');
  promptParts.push('  "fileSummaries": [');
  promptParts.push('    {');
  promptParts.push('      "path": "exact file path from diff",');
  promptParts.push('      "changeType": "added" or "modified" or "deleted" or "renamed",');
  promptParts.push('      "summary": "1 sentence describing what changed in this file"');
  promptParts.push('    }');
  promptParts.push('  ],');
  promptParts.push('  "lineComments": [');
  promptParts.push('    {');
  promptParts.push('      "path": "exact file path from diff",');
  promptParts.push('      "line": number (exact line from diff),');
  promptParts.push('      "side": "LEFT" or "RIGHT",');
  promptParts.push('      "body": "Full comment with Issue, Suggestion, and AI Prompt sections",');
  promptParts.push('      "severity": "critical" or "suggestion"');
  promptParts.push('    }');
  promptParts.push('  ],');
  if (input.retrigger && input.previousComments && input.previousComments.length > 0) {
    promptParts.push('  "resolvedComments": [list of previous comment IDs that are now fixed],');
  }
  promptParts.push('  "criticalIssues": ["brief summary of each critical issue"],');
  promptParts.push('  "suggestions": ["brief summary of each suggestion"]');
  promptParts.push('}');
  promptParts.push('');
  promptParts.push('RULES:');
  promptParts.push('- approved=false if ANY critical issues exist');
  promptParts.push('- ALWAYS provide lineComments for issues - do NOT skip them');
  promptParts.push('- ALWAYS provide fileSummaries for ALL files in the diff');
  promptParts.push('- Only comment on lines that exist in the patches');
  promptParts.push('- If no issues, return approved=true with empty arrays');
  promptParts.push(`Repository: ${input.owner}/${input.repo}`);
  promptParts.push(`PR Number: ${input.prNumber}`);
  promptParts.push(`Is Retrigger: ${input.retrigger}`);
  promptParts.push('');
  promptParts.push('DIFF TO REVIEW:');
  promptParts.push(diffText);

  const reviewPrompt = promptParts.join('\n');

  let response: string;
  try {
    response = await flue.client.prompt(reviewPrompt, { model, result: v.string() });
  } catch (error) {
    throw new Error(formatPromptError(error, `${model.providerID}/${model.modelID}`));
  }
  const parsed = safeJsonParse<ReviewResult>(response);
  return normalizeReviewResult(parsed, input.previousComments);
}

function normalizeReviewResult(
  result: ReviewResult,
  previousComments?: PreviousComment[],
): ReviewResult {
  // Validate resolvedComments against actual previous comment IDs
  const resolvedComments: number[] = [];
  if (result.resolvedComments && previousComments && previousComments.length > 0) {
    const validIds = new Set(previousComments.map((c) => c.id));
    resolvedComments = result.resolvedComments.filter((id) => validIds.has(id));
  }

  return {
    approved: (result.criticalIssues?.length ?? 0) === 0 && result.approved,
    summary: result.summary ?? 'Review completed.',
    lineComments: Array.isArray(result.lineComments) ? result.lineComments : [],
    criticalIssues: Array.isArray(result.criticalIssues) ? result.criticalIssues : [],
    suggestions: Array.isArray(result.suggestions) ? result.suggestions : [],
    resolvedComments,
    fileSummaries: Array.isArray(result.fileSummaries) ? result.fileSummaries : [],
  };
}

/**
 * Fetch previous DonMerge review comments from the PR.
 * These will be checked against the new diff to see if issues are resolved.
 */
async function fetchPreviousDonMergeComments(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
): Promise<PreviousComment[]> {
  try {
    // Fetch all review comments on the PR
    const comments = await githubFetch<
      Array<{
        id: number;
        path: string;
        line: number;
        body: string;
        user: { login: string } | null;
        in_reply_to_id?: number;
      }>
    >(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/comments?per_page=100`,
      token,
    );

    // Filter to only DonMerge's comments (exclude replies/acknowledgments)
    const donmergeComments = comments.filter(
      (c) =>
        c.user?.login &&
        (c.user.login.includes('donmerge') || c.user.login.includes('DonMerge')) &&
        !c.body.includes('✅ Fixed') && // Exclude our resolution replies
        !c.in_reply_to_id, // Only original comments, not replies
    );

    return donmergeComments.map((c) => ({
      id: c.id,
      path: c.path,
      line: c.line,
      body: c.body,
    }));
  } catch (error) {
    console.error('Failed to fetch previous comments', {
      owner,
      repo,
      prNumber,
      error: error instanceof Error ? error.message : error,
    });
    return [];
  }
}

/**
 * Reply to resolved comments acknowledging the fix.
 * GitHub doesn't have a "resolve thread" API, so we reply with a confirmation.
 */
async function resolveFixedComments(
  owner: string,
  repo: string,
  commentIds: number[],
  token: string,
): Promise<void> {
  for (const commentId of commentIds) {
    try {
      // Reply to the comment thread acknowledging the fix
      await githubFetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls/comments/${commentId}/replies`,
        token,
        'POST',
        {
          body: '✅ **Fixed!** Thanks for addressing this, compadre! 🤠',
        },
      );
    } catch (error) {
      // Log but don't fail - this is a nice-to-have
      console.error('Failed to reply to resolved comment', {
        owner,
        repo,
        commentId,
        error: error instanceof Error ? error.message : error,
      });
    }
  }
}

async function publishReview(
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  review: ReviewResult,
  token: string,
): Promise<void> {
  const comments = review.lineComments.slice(0, 40).map((comment) => ({
    path: comment.path,
    body: comment.body,
    line: comment.line,
    side: comment.side,
  }));

  const payload = {
    commit_id: headSha,
    body: review.summary,
    event: review.approved ? 'COMMENT' : 'REQUEST_CHANGES',
    comments,
  };

  await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
    token,
    'POST',
    payload,
  );
}

async function createCheckRun(owner: string, repo: string, headSha: string, token: string): Promise<{ id: number }> {
  return githubFetch<{ id: number }>(
    `https://api.github.com/repos/${owner}/${repo}/check-runs`,
    token,
    'POST',
    {
      name: 'DonMerge 🤠 Review',
      head_sha: headSha,
      status: 'in_progress',
      started_at: new Date().toISOString(),
    },
  );
}

async function addCommentReaction(
  owner: string,
  repo: string,
  commentId: number,
  commentType: 'issue' | 'review',
  token: string,
): Promise<void> {
  const url =
    commentType === 'issue'
      ? `https://api.github.com/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`
      : `https://api.github.com/repos/${owner}/${repo}/pulls/comments/${commentId}/reactions`;

  try {
    await githubFetch(
      url,
      token,
      'POST',
      { content: 'eyes' },
    );
  } catch (error) {
    console.error('Failed to add reaction', { owner, repo, commentId, error: error instanceof Error ? error.message : error });
  }
}

async function updatePRDescription(
  owner: string,
  repo: string,
  prNumber: number,
  review: ReviewResult,
  token: string,
): Promise<void> {
  const pr = await githubFetch<{ body: string; title: string }>(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
    token,
  );

  const donmergeSection = buildDonmergeSection(review);
  const separator = '<!-- donmerge-review -->';
  
  let newBody = pr.body ?? '';
  
  // Remove existing donmerge section if present
  const separatorIndex = newBody.indexOf(separator);
  if (separatorIndex !== -1) {
    newBody = newBody.substring(0, separatorIndex).trimEnd();
  }

  // Append new donmerge section
  newBody = `${newBody}\n\n${separator}\n${donmergeSection}`;

  await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
    token,
    'PATCH',
    { body: newBody },
  );
}

function buildDonmergeSection(review: ReviewResult): string {
  const statusEmoji = review.approved ? '✅' : '⚠️';
  const statusText = review.approved ? 'All good, compadre!' : 'Ojo, some things need attention';
  const timestamp = new Date().toISOString();

  const greeting = review.approved
    ? '¡Nada que objetar! This PR is ready to merge.'
    : 'Check the comments on the files above for details on what needs to be fixed.';

  let section = `
## DonMerge 🤠 Code Review

> ${greeting}

**Status:** ${statusEmoji} ${statusText}

${review.summary}
`;

  // Only add issue lists if there are issues
  if (review.criticalIssues.length > 0) {
    section += `\n### 🔴 Critical Issues\n${review.criticalIssues.map((i) => `- ${i}`).join('\n')}\n`;
  }
  
  if (review.suggestions.length > 0) {
    section += `\n### 💡 Suggestions\n${review.suggestions.map((s) => `- ${s}`).join('\n')}\n`;
  }

  section += `\n---\n*Reviewed by DonMerge 🤠 — ${timestamp}*\n`;

  return section;
}

async function completeCheckRun(
  owner: string,
  repo: string,
  checkRunId: number,
  review: ReviewResult,
  token: string,
): Promise<void> {
  const title = review.approved ? '✅ All good, compadre!' : '⚠️ Ojo, some things need attention';
  const critical = review.criticalIssues.length > 0 ? review.criticalIssues.map((issue) => `- ${issue}`).join('\n') : '- None, ¡nada que objetar!';
  const suggestions = review.suggestions.length > 0 ? review.suggestions.map((issue) => `- ${issue}`).join('\n') : '- All clean!';

  await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/check-runs/${checkRunId}`,
    token,
    'PATCH',
    {
      status: 'completed',
      conclusion: review.approved ? 'success' : 'failure',
      completed_at: new Date().toISOString(),
      output: {
        title,
        summary: review.summary,
        text: `🔴 Critical Issues:\n${critical}\n\n💡 Suggestions:\n${suggestions}`,
      },
    },
  );
}

async function failCheckRun(owner: string, repo: string, checkRunId: number, message: string, token: string): Promise<void> {
  await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/check-runs/${checkRunId}`,
    token,
    'PATCH',
    {
      status: 'completed',
      conclusion: 'failure',
      completed_at: new Date().toISOString(),
      output: {
        title: '🤠 DonMerge hit a snag',
        summary: 'Something went wrong during the review. Check the logs.',
        text: message,
      },
    },
  );
}

async function createInstallationToken(installationId: number, appJwt: string): Promise<string> {
  const tokenResponse = await githubFetch<{ token: string }>(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    appJwt,
    'POST',
  );
  return tokenResponse.token;
}

async function createGitHubAppJwt(appId: string, privateKeyPem: string): Promise<string> {
  // Validate inputs
  if (!appId || !privateKeyPem) {
    throw new Error('Missing GitHub App credentials: appId or privateKey is empty');
  }

  // Check if PEM looks valid (basic sanity check)
  if (!privateKeyPem.includes('PRIVATE KEY')) {
    throw new Error(
      'Invalid GitHub App private key: PEM must contain "PRIVATE KEY" header. ' +
      'Ensure you copied the full key including -----BEGIN PRIVATE KEY----- and -----END PRIVATE KEY-----'
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64UrlEncode(
    JSON.stringify({
      iat: now - 60,
      exp: now + 9 * 60,
      iss: appId,
    }),
  );

  const signingInput = `${header}.${payload}`;
  
  let keyData: ArrayBuffer;
  try {
    keyData = pemToArrayBuffer(privateKeyPem);
  } catch (error) {
    throw new Error(
      `Failed to parse GitHub App private key: ${error instanceof Error ? error.message : 'unknown error'}. ` +
      'Make sure the key is in PEM format (base64 encoded).'
    );
  }

  const key = await crypto.subtle.importKey(
    'pkcs8',
    keyData,
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
    },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64UrlFromBuffer(signature)}`;
}

async function verifyWebhookSignature(secret: string, body: string, header: string): Promise<boolean> {
  if (!header.startsWith('sha256=')) {
    return false;
  }
  const expectedHex = header.slice('sha256='.length);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const digestHex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return timingSafeEqual(digestHex, expectedHex);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return mismatch === 0;
}

async function githubFetch<T>(
  url: string,
  token: string,
  method: 'GET' | 'POST' | 'PATCH' = 'GET',
  body?: unknown,
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'codex-review-worker',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`GitHub API error ${response.status}: ${errorBody}`);
  }

  return (await response.json()) as T;
}

function safeJsonParse<T>(jsonText: string): T {
  if (typeof jsonText !== 'string') {
    throw new Error(`Expected prompt response to be string, received ${typeof jsonText}`);
  }
  const cleaned = jsonText.trim().replace(/^```json\s*/i, '').replace(/^```/, '').replace(/```$/, '').trim();
  return JSON.parse(cleaned) as T;
}

function parseModelConfig(raw?: string): { providerID: string; modelID: string } {
  const value = (raw ?? 'openai/gpt-5.3-codex').trim();
  if (!value.includes('/')) {
    return { providerID: 'openai', modelID: value };
  }

  const [providerID, ...rest] = value.split('/');
  const modelID = rest.join('/').trim();
  if (!providerID.trim() || !modelID) {
    return { providerID: 'openai', modelID: 'gpt-5.3-codex' };
  }

  return { providerID: providerID.trim(), modelID };
}

function formatPromptError(error: unknown, model: string): string {
  if (!(error instanceof Error)) {
    return `Flue prompt failed for model '${model}': unknown error`;
  }

  const details = extractErrorDetails(error);
  return details
    ? `Flue prompt failed for model '${model}': ${error.message}. details=${details}`
    : `Flue prompt failed for model '${model}': ${error.message}`;
}

function extractErrorDetails(error: Error): string | null {
  const maybeStructured = error as Error & { cause?: unknown; data?: unknown };
  const candidates = [maybeStructured.cause, maybeStructured.data]
    .filter((value) => value !== undefined)
    .map((value) => safeStringify(value));

  if (candidates.length > 0) {
    return candidates.join(' | ');
  }

  const message = error.message;
  const jsonStart = message.indexOf('{');
  if (jsonStart === -1) {
    return null;
  }

  const jsonCandidate = message.slice(jsonStart);
  try {
    const parsed = JSON.parse(jsonCandidate);
    return safeStringify(parsed);
  } catch {
    return null;
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable error details]';
  }
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  // Handle various PEM formats and normalize
  let normalized = pem
    // Handle escaped newlines from different sources
    .replace(/\\n/g, '\n')
    .replace(/\\r\\n/g, '\n')
    .replace(/\r\n/g, '\n')
    // Remove PEM headers/footers (handle variations)
    .replace(/-----BEGIN[^-]*PRIVATE KEY[^-]*-----/gi, '')
    .replace(/-----END[^-]*PRIVATE KEY[^-]*-----/gi, '')
    // Remove all whitespace (newlines, spaces, tabs, etc.)
    .replace(/\s+/g, '');

  // Validate base64 characters only
  const base64Regex = /^[A-Za-z0-9+/=]+$/;
  if (!base64Regex.test(normalized)) {
    // Try to clean up any remaining invalid characters
    normalized = normalized.replace(/[^A-Za-z0-9+/=]/g, '');
  }

  // Add padding if needed
  const paddingNeeded = (4 - (normalized.length % 4)) % 4;
  normalized += '='.repeat(paddingNeeded);

  try {
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes.buffer;
  } catch (error) {
    throw new Error(
      `Failed to parse PEM key: ${error instanceof Error ? error.message : 'invalid base64'}. ` +
      `Key length: ${pem.length}, normalized length: ${normalized.length}`
    );
  }
}

function base64UrlEncode(value: string): string {
  return base64UrlFromBuffer(new TextEncoder().encode(value).buffer);
}

function base64UrlFromBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
