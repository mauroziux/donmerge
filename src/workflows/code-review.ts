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
  comment?: { body?: string };
}

interface ReviewComment {
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  body: string;
  severity: 'critical' | 'suggestion';
}

interface ReviewResult {
  approved: boolean;
  summary: string;
  lineComments: ReviewComment[];
  criticalIssues: string[];
  suggestions: string[];
  stats: {
    filesReviewed: number;
    criticalIssuesFound: number;
    suggestionsProvided: number;
  };
}

interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

export async function processGitHubCodeReviewWebhook(
  env: WorkerEnv,
  event: string,
  signature: string,
  rawBody: string,
): Promise<WebhookResult> {
  const isValid = await verifyWebhookSignature(env.GITHUB_WEBHOOK_SECRET, rawBody, signature);
  if (!isValid) {
    return { status: 401, body: { error: 'invalid signature' } };
  }

  const payload = JSON.parse(rawBody) as WebhookPayload;
  const owner = payload.repository?.owner.login;
  const repo = payload.repository?.name;

  if (!owner || !repo) {
    return { status: 400, body: { error: 'missing repository context' } };
  }

  if (!isRepoAllowed(owner, repo, env.ALLOWED_REPOS)) {
    return {
      status: 403,
      body: {
        error: 'repository not allowed',
        repository: `${owner}/${repo}`,
      },
    };
  }

  const trigger = parseTrigger(event, payload, env.REVIEW_TRIGGER);
  if (!trigger.shouldRun) {
    return { status: 200, body: { ok: true, skipped: true, reason: trigger.reason } };
  }

  const githubToken = await resolveGitHubToken(env, payload.installation?.id);
  const prNumber = trigger.prNumber;
  const pr = await githubFetch<{ base: { ref: string }; head: { sha: string } }>(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
    githubToken,
  );

  const baseBranch = env.BASE_BRANCH ?? 'main';
  if (pr.base.ref !== baseBranch) {
    return {
      status: 200,
      body: {
        ok: true,
        skipped: true,
        reason: `PR base is '${pr.base.ref}', expected '${baseBranch}'`,
      },
    };
  }

  const checkRun = await createCheckRun(owner, repo, pr.head.sha, githubToken);

  try {
    const review = await runReviewWithFlue({
      env,
      githubToken,
      owner,
      repo,
      prNumber,
      retrigger: trigger.retrigger,
    });

    await publishReview(owner, repo, prNumber, pr.head.sha, review, githubToken);
    await completeCheckRun(owner, repo, checkRun.id, review, githubToken);

    return {
      status: 200,
      body: {
        ok: true,
        prNumber,
        checkRunId: checkRun.id,
        approved: review.approved,
        criticalIssues: review.stats.criticalIssuesFound,
      },
    };
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
    return { status: 500, body: { ok: false, error: message } };
  }
}

function parseTrigger(event: string, payload: WebhookPayload, triggerTag?: string): {
  shouldRun: boolean;
  prNumber: number;
  retrigger: boolean;
  reason?: string;
} {
  const triggerRegex = getTriggerRegex(triggerTag);

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
    return { shouldRun: true, prNumber: payload.issue.number, retrigger: true };
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
    return { shouldRun: true, prNumber: payload.pull_request.number, retrigger: true };
  }

  return { shouldRun: false, prNumber: 0, retrigger: false, reason: `unsupported event: ${event}` };
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
  const reviewPrompt = [
    'You are a senior code reviewer.',
    'Return only JSON with this schema:',
    '{"approved":boolean,"summary":string,"lineComments":[{"path":string,"line":number,"side":"LEFT"|"RIGHT","body":string,"severity":"critical"|"suggestion"}],"criticalIssues":[string],"suggestions":[string],"stats":{"filesReviewed":number,"criticalIssuesFound":number,"suggestionsProvided":number}}',
    'Rules:',
    '- mark approved=false if any critical issue exists',
    '- provide line-specific comments only for lines present in patches',
    '- keep comments actionable and concise',
    `Repository: ${input.owner}/${input.repo}`,
    `PR Number: ${input.prNumber}`,
    `Retrigger: ${input.retrigger}`,
    `Diff:\n${diffText}`,
  ].join('\n');

  let response: string;
  try {
    response = await flue.client.prompt(reviewPrompt, { model, result: v.string() });
  } catch (error) {
    throw new Error(formatPromptError(error, `${model.providerID}/${model.modelID}`));
  }
  const parsed = safeJsonParse<ReviewResult>(response);
  return normalizeReviewResult(parsed, filesToReview.length);
}

function normalizeReviewResult(result: ReviewResult, filesReviewed: number): ReviewResult {
  const criticalIssuesFound = result.criticalIssues?.length ?? 0;
  const suggestionsProvided = result.suggestions?.length ?? 0;

  return {
    approved: criticalIssuesFound === 0 && result.approved,
    summary: result.summary ?? 'Review completed.',
    lineComments: Array.isArray(result.lineComments) ? result.lineComments : [],
    criticalIssues: Array.isArray(result.criticalIssues) ? result.criticalIssues : [],
    suggestions: Array.isArray(result.suggestions) ? result.suggestions : [],
    stats: {
      filesReviewed,
      criticalIssuesFound,
      suggestionsProvided,
    },
  };
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
      name: 'Codex Code Review',
      head_sha: headSha,
      status: 'in_progress',
      started_at: new Date().toISOString(),
    },
  );
}

async function completeCheckRun(
  owner: string,
  repo: string,
  checkRunId: number,
  review: ReviewResult,
  token: string,
): Promise<void> {
  const title = review.approved ? 'Code Review Passed' : 'Code Review Failed';
  const critical = review.criticalIssues.length > 0 ? review.criticalIssues.map((issue) => `- ${issue}`).join('\n') : '- None';
  const suggestions = review.suggestions.length > 0 ? review.suggestions.map((issue) => `- ${issue}`).join('\n') : '- None';

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
        text: `Critical Issues:\n${critical}\n\nSuggestions:\n${suggestions}`,
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
        title: 'Code Review Failed',
        summary: 'Webhook processing failed before review completed.',
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
  const keyData = pemToArrayBuffer(privateKeyPem);
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
  const normalized = pem
    .replace(/\\n/g, '\n')
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s+/g, '');

  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
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
