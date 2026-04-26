/**
 * Auto-Fix Pipeline for Sentry Triage (Phase C)
 *
 * Generates a code fix via LLM and creates a GitHub PR.
 * Self-contained GitHub API helpers (same pattern as repo-fetcher.ts).
 */

import * as v from 'valibot';

import type { AutoFixOutput, AutoFixContext, SentryTriageEnv } from './types';
import { buildFixPrompt } from './prompts';
import { sanitizeSentryTitle, sanitizeSentryData } from './prompts/sanitizers';
import { parseModelConfig, safeJsonParse } from './utils';

// ── GitHub API Operations ──────────────────────────────────────────────────────
// Self-contained helpers — same pattern as repo-fetcher.ts, no cross-module imports.

async function githubApiCall<T>(
  url: string,
  token: string,
  method: 'GET' | 'POST' | 'PUT' = 'GET',
  body?: unknown
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'donmerge-fix',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`GitHub API error ${response.status}: ${errorBody}`);
  }
  return (await response.json()) as T;
}

async function getDefaultBranch(repo: string, token: string): Promise<string> {
  const result = await githubApiCall<{ default_branch: string }>(
    `https://api.github.com/repos/${repo}`,
    token
  );
  return result.default_branch;
}

async function getBranchHeadSha(repo: string, branch: string, token: string): Promise<string> {
  const result = await githubApiCall<{ object: { sha: string } }>(
    `https://api.github.com/repos/${repo}/git/ref/heads/${branch}`,
    token
  );
  return result.object.sha;
}

async function createBranch(
  repo: string,
  branchName: string,
  baseSha: string,
  token: string
): Promise<void> {
  await githubApiCall(
    `https://api.github.com/repos/${repo}/git/refs`,
    token,
    'POST',
    { ref: `refs/heads/${branchName}`, sha: baseSha }
  );
}

async function getFileBlobSha(
  repo: string,
  filePath: string,
  ref: string,
  token: string
): Promise<string> {
  const result = await githubApiCall<{ sha: string }>(
    `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(filePath)}?ref=${ref}`,
    token
  );
  return result.sha;
}

async function updateFile(
  repo: string,
  filePath: string,
  content: string,
  message: string,
  branch: string,
  fileSha: string,
  token: string
): Promise<string> {
  const encoded = btoa(content);
  const result = await githubApiCall<{ commit: { sha: string } }>(
    `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(filePath)}`,
    token,
    'PUT',
    { message, content: encoded, sha: fileSha, branch }
  );
  return result.commit.sha;
}

async function createPullRequest(
  repo: string,
  title: string,
  body: string,
  headBranch: string,
  baseBranch: string,
  token: string
): Promise<string> {
  const result = await githubApiCall<{ html_url: string }>(
    `https://api.github.com/repos/${repo}/pulls`,
    token,
    'POST',
    { title, body, head: headBranch, base: baseBranch }
  );
  return result.html_url;
}

// ── Fix Generation (LLM) ───────────────────────────────────────────────────────

async function generateFix(
  context: AutoFixContext,
  flue: AutoFixContext['flue'],
  env: SentryTriageEnv
): Promise<AutoFixOutput | null> {
  // Pick the first affected file that exists in sourceCode
  const targetFile = context.triageOutput.affected_files.find(
    (f) => context.sourceCode.has(f)
  );
  if (!targetFile) {
    console.log('Auto-fix: no target file found in source code');
    return null;
  }

  const fileContent = context.sourceCode.get(targetFile)!;

  // Get exception info from triage output for prompt context
  const exceptionType = context.triageOutput.root_cause.split(':')[0] || 'Unknown';
  const exceptionValue = context.triageOutput.stack_trace_summary.split('\n')[0] || '';

  const model = parseModelConfig(env.CODEX_MODEL);
  const prompt = buildFixPrompt({
    triageOutput: context.triageOutput,
    targetFile,
    fileContent,
    allAffectedFiles: context.triageOutput.affected_files,
    sentryExceptionType: exceptionType,
    sentryExceptionValue: exceptionValue,
  });

  let response: string;
  try {
    response = await flue.client.prompt(prompt, { model, result: v.string() });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'unknown';
    console.error('Auto-fix LLM prompt failed', { error: msg });
    return null;
  }

  let parsed: AutoFixOutput;
  try {
    parsed = safeJsonParse<AutoFixOutput>(response);
  } catch {
    console.error('Auto-fix: LLM returned invalid JSON');
    return null;
  }

  // Validate output
  if (!parsed.file_path || typeof parsed.description !== 'string') {
    console.error('Auto-fix: invalid output structure');
    return null;
  }

  // Validate that LLM returned the same file we asked it to fix
  // Normalize paths for comparison (strip leading slashes)
  const normalizedTarget = targetFile.replace(/^\/+/, '');
  const normalizedPath = parsed.file_path.replace(/^\/+/, '');
  if (normalizedPath !== normalizedTarget) {
    console.error('Auto-fix: LLM returned different file_path', {
      expected: normalizedTarget,
      got: normalizedPath,
    });
    return null;
  }

  // LLM says it can't confidently fix
  const content = parsed.patched_content;
  if (!content) {
    console.log('Auto-fix: LLM returned null patched_content (no confident fix)');
    return null;
  }

  // No-op check: patched content identical to current
  if (content.trim() === fileContent.trim()) {
    console.log('Auto-fix: patched content identical to current (no-op)');
    return null;
  }

  return { ...parsed, patched_content: content };
}

// ── Orchestrator ───────────────────────────────────────────────────────────────

/**
 * Run the full auto-fix pipeline.
 * Returns the PR URL on success, null on failure/skip.
 * Never throws — all errors are caught and logged.
 */
export async function runAutoFix(
  context: AutoFixContext,
  env: SentryTriageEnv
): Promise<string | null> {
  let branchCreated = false;
  let branchName = '';

  try {
    // Step 1: Generate fix via LLM
    const fixOutput = await generateFix(context, context.flue, env);
    if (!fixOutput) {
      return null;
    }

    // Step 2: Get default branch
    const baseBranch = await getDefaultBranch(context.repo, context.githubToken);

    // Step 3: Get head SHA of base branch
    const baseSha = await getBranchHeadSha(context.repo, baseBranch, context.githubToken);

    // Step 4: Create branch name
    const shortHash = crypto.randomUUID().replace(/-/g, '').substring(0, 8);
    branchName = `donmerge/fix/sentry-${context.sentryIssueId}-${shortHash}`;

    // Step 5: Create branch
    await createBranch(context.repo, branchName, baseSha, context.githubToken);
    branchCreated = true;

    // Step 6: Get file blob SHA — normalize path (GitHub rejects leading /)
    const filePath = fixOutput.file_path.replace(/^\/+/, '');
    const fileSha = await getFileBlobSha(context.repo, filePath, baseBranch, context.githubToken);

    // Step 7: Commit the fix
    const rawMessage = context.triageOutput.suggested_fix.slice(0, 72);
    const commitMessage = `fix(sentry): ${rawMessage.replace(/\n/g, ' ')}`;

    // patched_content is guaranteed non-null after generateFix validation
    const patchedContent = fixOutput.patched_content!;
    await updateFile(
      context.repo,
      filePath,
      patchedContent,
      commitMessage,
      branchName,
      fileSha,
      context.githubToken
    );

    // Step 8: Create PR
    const prTitle = `fix(sentry): ${sanitizeSentryTitle(context.sentryTitle).slice(0, 80)}`;
    const prBody = buildPrBody(context, fixOutput);
    const prUrl = await createPullRequest(
      context.repo,
      prTitle,
      prBody,
      branchName,
      baseBranch,
      context.githubToken
    );

    console.log('Auto-fix: PR created successfully', { prUrl, branchName });
    return prUrl;
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'unknown';
    console.error('Auto-fix pipeline failed', { error: msg });

    // Best-effort cleanup: delete orphan branch if it was created
    if (branchCreated && branchName) {
      await deleteBranch(context.repo, branchName, context.githubToken);
    }

    return null;
  }
}

async function deleteBranch(repo: string, branchName: string, token: string): Promise<void> {
  try {
    await fetch(`https://api.github.com/repos/${repo}/git/refs/heads/${branchName}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'donmerge-fix',
      },
    });
  } catch {
    // Best-effort cleanup — don't mask the original error
  }
}

function buildPrBody(context: AutoFixContext, fixOutput: AutoFixOutput): string {
  const sanitizedRootCause = sanitizeSentryData(context.triageOutput.root_cause, 2000);
  const sanitizedStackTrace = sanitizeSentryData(context.triageOutput.stack_trace_summary, 2000);

  return `## 🤠 DonMerge Sentry Triage

### Sentry Issue
[${sanitizeSentryTitle(context.sentryTitle)}](${context.sentryIssueUrl})

### Root Cause
${sanitizedRootCause}

### Fix
${fixOutput.description}

### Stack Trace Summary
${sanitizedStackTrace}

---
*Auto-generated by [DonMerge](https://donmerge.dev) Sentry Triage*`;
}
