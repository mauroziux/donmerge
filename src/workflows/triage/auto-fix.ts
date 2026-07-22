/**
 * Auto-Fix Pipeline for Triage
 *
 * Generates a code fix via LLM and creates a GitHub PR.
 * Self-contained GitHub API helpers (same pattern as repo-fetcher.ts).
 */

import type { AutoFixOutput, AutoFixContext, TriageEnv } from './types';
import { buildFixPrompt } from './prompts';
import { sanitizeTitle, sanitizeData } from './prompts/sanitizers';
import { parseModelConfig, safeJsonParse, extractJsonFromResponse, validateFixOutput, applyEdits, utf8ToBase64 } from './utils';

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
  const encoded = utf8ToBase64(content);
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

// ── OpenAI API (direct) ─────────────────────────────────────────────────────────

/**
 * Call OpenAI API directly (no OpenRouter / Flue overhead).
 * Used for simple text-to-JSON tasks like fix generation.
 */
async function callOpenAI(
  apiKey: string,
  prompt: string,
  modelConfig: { providerID: string; modelID: string }
): Promise<string> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: modelConfig.modelID,
      messages: [
        { role: 'user', content: prompt }
      ],
      temperature: 0.2,
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${body.slice(0, 500)}`);
  }

  const data = await response.json() as { choices: Array<{ message: { content: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Empty response from OpenAI API');
  }
  return content;
}

// ── Fix Generation (LLM) ───────────────────────────────────────────────────────

/** Return type for generateFix — includes both the parsed output and the patched content. */
interface GenerateFixResult {
  output: AutoFixOutput;
  patchedContent: string;
}

/**
 * Try to apply surgical edits from a parsed LLM output.
 * Returns null if edits can't be applied or result is a no-op.
 */
function tryApplyEdits(
  parsed: AutoFixOutput,
  normalizedTarget: string,
  fileContent: string
): GenerateFixResult | null {
  // Check file_path matches target
  const normalizedPath = parsed.file_path.replace(/^\/+/, '');
  if (normalizedPath !== normalizedTarget) {
    console.error('Auto-fix: LLM returned different file_path', {
      expected: normalizedTarget,
      got: normalizedPath,
    });
    return null;
  }

  // Empty edits = LLM can't fix
  if (!parsed.edits || parsed.edits.length === 0) {
    console.log('Auto-fix: LLM returned empty edits (no confident fix)');
    return null;
  }

  // Apply edits
  const result = applyEdits(fileContent, parsed.edits);
  if (!result) {
    console.error('Auto-fix: majority of edits failed to match');
    return null;
  }

  if (result.applied === 0) {
    console.error('Auto-fix: no edits applied');
    return null;
  }

  // No-op check
  if (result.content.trim() === fileContent.trim()) {
    console.log('Auto-fix: patched content identical to current (no-op)');
    return null;
  }

  return { output: parsed, patchedContent: result.content };
}

async function generateFix(
  context: AutoFixContext,
  env: TriageEnv
): Promise<GenerateFixResult | null> {
  // V1 requires sourceCode — V2 (auto-fix-v2.ts) works without it
  if (!context.sourceCode) {
    console.log('Auto-fix V1: no sourceCode provided (use V2 for sandbox-based fixes)');
    return null;
  }

  const sourceCode = context.sourceCode;

  // Pick the first affected file that exists in sourceCode
  const targetFile = context.triageOutput.affected_files.find(
    (f) => sourceCode.has(f)
  );
  if (!targetFile) {
    console.log('Auto-fix: no target file found in source code');
    return null;
  }

  const fileContent = context.sourceCode.get(targetFile)!;
  const normalizedTarget = targetFile.replace(/^\/+/, '');
  console.log('[DEBUG generateFix] Target file path:', targetFile, '| Content length:', fileContent.length);

  const model = parseModelConfig(env.CODEX_MODEL);
  const prompt = buildFixPrompt({
    triageOutput: context.triageOutput,
    targetFile,
    fileContent,
    allAffectedFiles: context.triageOutput.affected_files,
    errorTitle: context.errorTitle,
    errorDescription: context.triageOutput.root_cause,
  });

  // ── Tier 1: Initial prompt ────────────────────────────────────────────────────

  let response: string | undefined;
  try {
    response = await callOpenAI(env.OPENAI_API_KEY, prompt, model);
    console.log('[DEBUG generateFix] Tier 1 succeeded | Response length:', response.length);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'unknown';
    console.error('[DEBUG generateFix] Tier 1 failed', { error: msg });
    return null;
  }

  // ── Tier 2: Parse and validate ────────────────────────────────────────────────

  let validationReason: string | undefined;
  try {
    const json = extractJsonFromResponse(response);
    const parsed = safeJsonParse<AutoFixOutput>(json);
    const validation = validateFixOutput(parsed);
    if (validation.valid) {
      console.log('[DEBUG generateFix] Tier 2 parse succeeded | Edits count:', parsed.edits?.length ?? 0);
      const result = tryApplyEdits(parsed, normalizedTarget, fileContent);
      if (result) return result;
      const normalizedPath = parsed.file_path.replace(/^\/+/, '');
      if (normalizedPath !== normalizedTarget) {
        validationReason = `file_path mismatch: expected ${normalizedTarget}, got ${normalizedPath}`;
      }
    } else {
      validationReason = validation.reason ?? 'unknown validation error';
    }
  } catch (e) {
    validationReason = `JSON parse error: ${e instanceof Error ? e.message : 'unknown'}`;
  }

  // ── Tier 3: Retry with corrective prompt ──────────────────────────────────────

  if (validationReason) {
    const retryPrompt = `${prompt}\n\nYour previous response was invalid. Produce valid JSON matching the schema exactly.\nReason: ${validationReason}`;
    try {
      response = await callOpenAI(env.OPENAI_API_KEY, retryPrompt, model);
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'unknown';
      console.error('Auto-fix: retry API call failed', { error: msg });
      return null;
    }

    try {
      const json = extractJsonFromResponse(response);
      const parsed = safeJsonParse<AutoFixOutput>(json);
      const validation = validateFixOutput(parsed);
      if (validation.valid) {
        const result = tryApplyEdits(parsed, normalizedTarget, fileContent);
        return result;
      }
      console.error('Auto-fix: invalid output after retry', { reason: validation.reason });
      return null;
    } catch {
      console.error('Auto-fix: failed to parse retry response');
      return null;
    }
  }

  return null;
}

// ── Orchestrator ───────────────────────────────────────────────────────────────

/**
 * Run the full auto-fix pipeline.
 * Returns the PR URL on success, null on failure/skip.
 * Never throws — all errors are caught and logged.
 */
export async function runAutoFix(
  context: AutoFixContext,
  env: TriageEnv
): Promise<string | null> {
  let branchCreated = false;
  let branchName = '';

  try {
    // Step 1: Generate fix via LLM
    console.log('[DEBUG runAutoFix] Starting generateFix | repo:', context.repo, '| errorTitle:', context.errorTitle);
    const fixResult = await generateFix(context, env);
    if (!fixResult) {
      return null;
    }

    // Step 2: Get default branch
    const baseBranch = await getDefaultBranch(context.repo, context.githubToken);

    // Step 3: Get head SHA of base branch
    const baseSha = await getBranchHeadSha(context.repo, baseBranch, context.githubToken);

    // Step 4: Create branch name
    const shortHash = crypto.randomUUID().replace(/-/g, '').substring(0, 8);
    const safeTitle = context.errorTitle.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase().slice(0, 40);
    branchName = `donmerge/fix/${safeTitle}-${shortHash}`;

    // Step 5: Create branch
    await createBranch(context.repo, branchName, baseSha, context.githubToken);
    branchCreated = true;

    // Step 6: Get file blob SHA — normalize path (GitHub rejects leading /)
    const filePath = fixResult.output.file_path.replace(/^\/+/, '');
    const fileSha = await getFileBlobSha(context.repo, filePath, baseBranch, context.githubToken);

    // Step 7: Commit the fix
    const rawMessage = context.triageOutput.suggested_fix.slice(0, 72);
    const commitMessage = `fix: ${rawMessage.replace(/\n/g, ' ')}`;

    await updateFile(
      context.repo,
      filePath,
      fixResult.patchedContent,
      commitMessage,
      branchName,
      fileSha,
      context.githubToken
    );

    // Step 8: Create PR
    const prTitle = `fix: ${sanitizeTitle(context.errorTitle).slice(0, 80)}`;
    const prBody = buildPrBody(context, fixResult.output);
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
    await fetch(`https://api.github.com/repos/${repo}/git/ref/heads/${branchName}`, {
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
  const sanitizedRootCause = sanitizeData(context.triageOutput.root_cause, 2000);
  const sanitizedStackTrace = sanitizeData(context.triageOutput.stack_trace_summary, 2000);

  const sourceSection = context.sourceUrl
    ? `[${sanitizeTitle(context.errorTitle)}](${context.sourceUrl})`
    : sanitizeTitle(context.errorTitle);

  return `## DonMerge Triage

### Error
${sourceSection}

### Root Cause
${sanitizedRootCause}

### Fix
${fixOutput.description}

### Stack Trace Summary
${sanitizedStackTrace}

---
*Auto-generated by [DonMerge](https://donmerge.dev) Triage*`;
}
