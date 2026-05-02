/**
 * Auto-Fix V2 Pipeline for Triage
 *
 * Clones the repo in the sandbox and lets the LLM work freely
 * using an agent loop with JSON command responses.
 *
 * Flow:
 *   1. Clone repo (shallow) into sandbox
 *   2. Agent loop: LLM → parse JSON action → execute in sandbox → repeat
 *   3. Extract changes from sandbox
 *   4. Create PR via GitHub API
 */

import type { AutoFixContext, AutoFixSandbox, TriageEnv, TriageOutput } from './types';
import { sanitizeTitle, sanitizeData } from './prompts/sanitizers';
import { parseModelConfig, extractJsonFromResponse, safeJsonParse, utf8ToBase64, base64ToUtf8 } from './utils';
import { resolvePaths, formatPathMappingPrompt, type ResolveResult } from './path-resolver';

// ── Constants ──────────────────────────────────────────────────────────────────

const REPO_DIR = '/home/user/repo';
const MAX_AGENT_STEPS = 15;
const SHELL_OUTPUT_LIMIT = 10_000;
const MAX_EDIT_CONTENT_BYTES = 2 * 1024 * 1024; // 2 MB

// ── Shell helper ──────────────────────────────────────────────────────────────

/**
 * Execute a command via the Cloudflare Sandbox exec() API and return
 * combined stdout + stderr as a single string (mimicking shell output).
 */
async function execShell(
  sandbox: AutoFixSandbox,
  command: string,
): Promise<string> {
  const result = await sandbox.exec(command);
  const parts: string[] = [];
  if (result.stdout) parts.push(result.stdout);
  if (result.stderr) parts.push(result.stderr);
  return parts.join('\n');
}

// ── Dangerous command patterns ─────────────────────────────────────────────────

const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+\//,        // rm -rf /
  /:\(\)\{.*;\}\;/,        // fork bomb
  /curl\s+.*\|\s*sh/,      // curl | sh
  /wget\s+.*\|\s*sh/,      // wget | sh
  /mkfs/,                  // format filesystem
  /dd\s+if=/,              // dd overwrite
  /git\s+push/,            // no pushing from sandbox
  />\s*\/dev\/sd/,         // write to block devices
  /chmod\s+-R\s+777\s+\//, // chmod everything
];

function isDangerous(command: string): boolean {
  return DANGEROUS_PATTERNS.some((p) => p.test(command));
}

/** Validate a file path for safe interpolation into a shell command. */
function sanitizeFilePath(path: string): string {
  if (!/^[a-zA-Z0-9._/-]+$/.test(path)) {
    throw new Error(`Unsafe file path rejected: ${path}`);
  }
  return path;
}

/** Validate a repo-relative path — rejects traversal and non-canonical forms. */
function validateRepoRelativePath(filePath: string): string {
  // Strip leading slashes
  const stripped = filePath.replace(/^\/+/, '');
  // Must match safe characters
  if (!/^[a-zA-Z0-9._/-]+$/.test(stripped)) {
    throw new Error(`Unsafe file path rejected: ${filePath}`);
  }
  // Reject path traversal
  const parts = stripped.split('/');
  if (parts.some((p) => p === '..')) {
    throw new Error(`Path traversal rejected: ${filePath}`);
  }
  return stripped;
}

/**
 * Write content to a file inside the sandbox using base64 encoding
 * to avoid shell quoting / injection issues.
 */
async function writeFileToSandbox(
  sandbox: AutoFixSandbox,
  repoRelativePath: string,
  content: string,
): Promise<void> {
  const safePath = validateRepoRelativePath(repoRelativePath);
  const fullPath = `${REPO_DIR}/${safePath}`;
  const b64 = utf8ToBase64(content);
  const dirPart = fullPath.substring(0, fullPath.lastIndexOf('/'));
  // Use only the validated path in the shell command; content is base64-encoded
  const cmd = `mkdir -p '${dirPart}' && printf '%s' '${b64}' | base64 -d > '${fullPath}'`;
  const result = await sandbox.exec(cmd);
  if (!result.success) {
    throw new Error(`Failed to write file ${safePath}: exit ${result.exitCode}`);
  }
}

// ── Agent action types ─────────────────────────────────────────────────────────

interface ShellAction {
  action: 'shell';
  command: string;
}

interface DoneAction {
  action: 'done';
  summary: string;
  files_changed: string[];
}

interface CannotFixAction {
  action: 'cannot_fix';
  reason: string;
}

interface EditAction {
  action: 'edit';
  file: string;
  content: string;
}

type AgentAction = ShellAction | DoneAction | CannotFixAction | EditAction;

// ── GitHub API Operations ──────────────────────────────────────────────────────
// Self-contained helpers — same pattern as auto-fix.ts and repo-fetcher.ts.

async function githubApiCall<T>(
  url: string,
  token: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
  body?: unknown,
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'donmerge-fix-v2',
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
    token,
  );
  return result.default_branch;
}

async function getBranchHeadSha(repo: string, branch: string, token: string): Promise<string> {
  const result = await githubApiCall<{ object: { sha: string } }>(
    `https://api.github.com/repos/${repo}/git/ref/heads/${branch}`,
    token,
  );
  return result.object.sha;
}

async function createBranch(
  repo: string,
  branchName: string,
  baseSha: string,
  token: string,
): Promise<void> {
  await githubApiCall(
    `https://api.github.com/repos/${repo}/git/refs`,
    token,
    'POST',
    { ref: `refs/heads/${branchName}`, sha: baseSha },
  );
}

async function getFileFromGitHub(
  repo: string,
  filePath: string,
  ref: string,
  token: string,
): Promise<{ sha: string; content: string }> {
  const result = await githubApiCall<{ sha: string; content: string }>(
    `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(filePath)}?ref=${ref}`,
    token,
  );
  // GitHub API returns base64-encoded content — use UTF-8-safe decode
  const content = base64ToUtf8(result.content.replace(/\n/g, ''));
  return { sha: result.sha, content };
}

async function updateFileViaGitHub(
  repo: string,
  filePath: string,
  content: string,
  message: string,
  branch: string,
  fileSha: string,
  token: string,
): Promise<string> {
  const encoded = utf8ToBase64(content);
  const result = await githubApiCall<{ commit: { sha: string } }>(
    `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(filePath)}`,
    token,
    'PUT',
    { message, content: encoded, sha: fileSha, branch },
  );
  return result.commit.sha;
}

async function createPullRequest(
  repo: string,
  title: string,
  body: string,
  headBranch: string,
  baseBranch: string,
  token: string,
): Promise<string> {
  const result = await githubApiCall<{ html_url: string }>(
    `https://api.github.com/repos/${repo}/pulls`,
    token,
    'POST',
    { title, body, head: headBranch, base: baseBranch },
  );
  return result.html_url;
}

async function deleteBranch(repo: string, branchName: string, token: string): Promise<void> {
  try {
    await fetch(`https://api.github.com/repos/${repo}/git/ref/heads/${branchName}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'donmerge-fix-v2',
      },
    });
  } catch {
    // Best-effort cleanup — don't mask the original error
  }
}

// ── LLM API (direct, multi-turn, provider-aware) ──────────────────────────────

/**
 * Call the OpenAI Chat Completions API (also used as fallback for unknown providers).
 */
async function callOpenAI(
  apiKey: string,
  messages: Array<{ role: string; content: string }>,
  modelConfig: { providerID: string; modelID: string },
): Promise<string> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: modelConfig.modelID,
      messages,
      temperature: 0.2,
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${body.slice(0, 500)}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Empty response from OpenAI API');
  }
  return content;
}

/**
 * Call the Anthropic Messages API.
 *
 * Separates system messages from the messages array (Anthropic requires `system`
 * as a top-level field) and adapts the response format.
 */
async function callAnthropic(
  apiKey: string,
  messages: Array<{ role: string; content: string }>,
  modelConfig: { providerID: string; modelID: string },
): Promise<string> {
  // Anthropic requires system as a top-level param, not in messages
  const systemParts = messages.filter((m) => m.role === 'system');
  const chatMessages = messages.filter((m) => m.role !== 'system');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: modelConfig.modelID,
      system: systemParts.map((m) => m.content).join('\n\n') || undefined,
      messages: chatMessages,
      max_tokens: 4096,
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${body.slice(0, 500)}`);
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text: string }>;
  };
  const textBlock = data.content?.find((b) => b.type === 'text');
  if (!textBlock?.text) {
    throw new Error('Empty response from Anthropic API');
  }
  return textBlock.text;
}

type LlmApiKey = { openai: string; anthropic?: string };

/**
 * Route LLM calls to the correct provider based on modelConfig.providerID.
 *
 * - `openai`  → OpenAI Chat Completions API
 * - `anthropic` → Anthropic Messages API
 * - other    → OpenAI-compatible endpoint (fallback for proxies/gateways)
 */
async function callLLM(
  apiKeys: LlmApiKey,
  messages: Array<{ role: string; content: string }>,
  modelConfig: { providerID: string; modelID: string },
): Promise<string> {
  switch (modelConfig.providerID) {
    case 'anthropic': {
      const key = apiKeys.anthropic ?? apiKeys.openai;
      return callAnthropic(key, messages, modelConfig);
    }
    default: {
      // 'openai' and any unknown providers (proxies, gateways) use OpenAI-compatible format
      return callOpenAI(apiKeys.openai, messages, modelConfig);
    }
  }
}

// ── Clone ──────────────────────────────────────────────────────────────────────

/** Strip the access token from clone output to prevent credential leaks. */
function redactToken(text: string, token: string): string {
  return text.replaceAll(token, '***');
}

async function cloneRepo(
  sandbox: AutoFixSandbox,
  repo: string,
  githubToken: string,
): Promise<void> {
  // Clean up in case the sandbox is reused from the triage step
  await execShell(sandbox, `rm -rf ${REPO_DIR} 2>/dev/null || true`);

  const cloneUrl = `https://x-access-token:${githubToken}@github.com/${repo}.git`;
  const output = await execShell(
    sandbox,
    `git clone --depth=1 --single-branch ${cloneUrl} ${REPO_DIR} 2>&1`,
  );
  // Redact token before logging — git errors may include the clone URL
  console.log('[auto-fix-v2] Clone output:', redactToken(output?.slice?.(0, 500) ?? '', githubToken));
  // Strip token from the remote URL so it doesn't leak via git remote -v or error messages
  await execShell(sandbox, `cd ${REPO_DIR} && git remote set-url origin https://github.com/${repo}.git`);
}

// ── Build system prompt ────────────────────────────────────────────────────────

function buildSystemPrompt(
  errorTitle: string,
  triageOutput: TriageOutput,
  pathResolveResult: ResolveResult | null,
): string {
  const sanitizedTitle = sanitizeData(errorTitle, 500);
  const sanitizedRootCause = sanitizeData(triageOutput.root_cause, 2000);
  const sanitizedStackTrace = sanitizeData(triageOutput.stack_trace_summary, 2000);
  const sanitizedSuggestedFix = sanitizeData(triageOutput.suggested_fix, 1000);

  // Build affected files list using resolved paths when available
  const displayFiles = triageOutput.affected_files.map((p) => {
    if (pathResolveResult) {
      const mapping = pathResolveResult.resolved.get(p);
      if (mapping) return `${p} → ${mapping}`;
    }
    return p;
  });

  const pathMappingSection = pathResolveResult
    ? formatPathMappingPrompt(pathResolveResult)
    : '';

  return (
    `You are DonMerge Fix Agent. You have a cloned git repository at ${REPO_DIR}.\n\n` +
    `ERROR CONTEXT:\n` +
    `- Title: ${sanitizedTitle}\n` +
    `- Root Cause: ${sanitizedRootCause}\n` +
    `- Stack Trace: ${sanitizedStackTrace}\n` +
    `- Suggested Fix: ${sanitizedSuggestedFix}\n` +
    `- Affected Files: ${displayFiles.join(', ')}\n` +
    pathMappingSection + '\n\n' +
    `Respond with a single JSON object per message:\n\n` +
    `{"action": "shell", "command": "ls -la"}\n` +
    `  → Run a shell command in ${REPO_DIR}. You will receive the output.\n\n` +
    `{"action": "edit", "file": "path/to/file.ts", "content": "full file content here"}\n` +
    `  → Write the full file content to the given path (relative to ${REPO_DIR}). Safe for any content.\n\n` +
    `{"action": "done", "summary": "...", "files_changed": ["file.ts"]}\n` +
    `  → You are done. List all files you changed (use actual repo paths).\n\n` +
    `{"action": "cannot_fix", "reason": "..."}\n` +
    `  → You cannot fix this issue.\n\n` +
    `RULES:\n` +
    `1. All commands run from ${REPO_DIR} (cd ${REPO_DIR} first if needed).\n` +
    `2. Fix ONLY the bug described above. No refactoring, no unrelated changes.\n` +
    `3. Commit your changes with a descriptive message before responding with "done".\n` +
    `4. Do NOT push — the orchestrator will handle that.\n` +
    `5. If you cannot fix the issue, respond with "cannot_fix".\n` +
    `6. Keep responses minimal — just the JSON object, no explanation outside it.\n` +
    `7. Use the RESOLVED paths from PATH MAPPING above when reading or editing files.\n` +
    `8. Prefer "edit" action for writing files — it handles special characters safely.`
  );
}

// ── Parse agent action ─────────────────────────────────────────────────────────

function parseAgentAction(raw: string): AgentAction | null {
  try {
    const json = extractJsonFromResponse(raw);
    const parsed = safeJsonParse<Record<string, unknown>>(json);

    if (!parsed || typeof parsed !== 'object') return null;

    if (parsed.action === 'shell' && typeof parsed.command === 'string') {
      return { action: 'shell', command: parsed.command };
    }

    if (
      parsed.action === 'done' &&
      typeof parsed.summary === 'string' &&
      Array.isArray(parsed.files_changed)
    ) {
      return {
        action: 'done',
        summary: parsed.summary,
        files_changed: (parsed.files_changed as string[]).filter(
          (f) => typeof f === 'string',
        ),
      };
    }

    if (parsed.action === 'cannot_fix' && typeof parsed.reason === 'string') {
      return { action: 'cannot_fix', reason: parsed.reason };
    }

    if (
      parsed.action === 'edit' &&
      typeof parsed.file === 'string' &&
      typeof parsed.content === 'string'
    ) {
      return { action: 'edit', file: parsed.file, content: parsed.content };
    }

    return null;
  } catch {
    return null;
  }
}

// ── Agent loop ─────────────────────────────────────────────────────────────────

interface AgentResult {
  type: 'done' | 'cannot_fix' | 'max_steps';
  summary: string;
  filesChanged: string[];
}

async function runAgentLoop(
  sandbox: AutoFixSandbox,
  context: AutoFixContext,
  env: TriageEnv,
  pathResolveResult: ResolveResult | null,
  initialSha: string,
): Promise<AgentResult> {
  const model = parseModelConfig(env.CODEX_MODEL);
  const systemPrompt = buildSystemPrompt(context.errorTitle, context.triageOutput, pathResolveResult);

  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: 'Begin. Investigate the error and fix it.' },
  ];

  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    console.log(`[auto-fix-v2] Agent step ${step + 1}/${MAX_AGENT_STEPS}`);

    // Call LLM
    let response: string;
    try {
      response = await callLLM(
        { openai: env.OPENAI_API_KEY, anthropic: env.ANTHROPIC_API_KEY },
        messages,
        model,
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'unknown';
      console.error('[auto-fix-v2] LLM call failed', { step, error: msg });
      return {
        type: 'max_steps',
        summary: `LLM call failed at step ${step + 1}: ${msg}`,
        filesChanged: [],
      };
    }

    // Parse action
    const action = parseAgentAction(response);
    if (!action) {
      console.warn('[auto-fix-v2] Could not parse agent action', {
        step,
        response: response.slice(0, 200),
      });
      messages.push({ role: 'assistant', content: response });
      messages.push({
        role: 'user',
        content:
          'Your response was not valid JSON or had an unknown action. ' +
          'Respond with exactly one JSON object:\n' +
          '{"action": "shell", "command": "..."}\n' +
          '{"action": "edit", "file": "path/to/file.ts", "content": "full file content"}\n' +
          '{"action": "done", "summary": "...", "files_changed": [...]}\n' +
          '{"action": "cannot_fix", "reason": "..."}',
      });
      continue;
    }

    // ── cannot_fix ──────────────────────────────────────────────────────────────
    if (action.action === 'cannot_fix') {
      console.log('[auto-fix-v2] Agent cannot fix', { reason: action.reason });
      return { type: 'cannot_fix', summary: action.reason, filesChanged: [] };
    }

    // ── edit ─────────────────────────────────────────────────────────────────────
    if (action.action === 'edit') {
      const contentBytes = new TextEncoder().encode(action.content).byteLength;
      if (contentBytes > MAX_EDIT_CONTENT_BYTES) {
        console.warn('[auto-fix-v2] Edit content exceeds size limit', {
          file: action.file,
          byteLength: contentBytes,
          limit: MAX_EDIT_CONTENT_BYTES,
        });
        messages.push({ role: 'assistant', content: response });
        messages.push({
          role: 'user',
          content: `Edit content for ${action.file} exceeds 2 MB limit (${contentBytes} bytes). Use shell action with a smaller patch.`,
        });
        continue;
      }

      console.log('[auto-fix-v2] Agent edit', { file: action.file, contentLen: action.content.length });
      try {
        await writeFileToSandbox(sandbox, action.file, action.content);
        messages.push({ role: 'assistant', content: response });
        messages.push({
          role: 'user',
          content: `File written successfully: ${action.file}`,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'unknown';
        console.warn('[auto-fix-v2] Edit write failed', { file: action.file, error: msg });
        messages.push({ role: 'assistant', content: response });
        messages.push({
          role: 'user',
          content: `Failed to write file: ${msg}. Use a different file path or approach.`,
        });
      }
      continue;
    }

    // ── done ────────────────────────────────────────────────────────────────────
    if (action.action === 'done') {
      console.log('[auto-fix-v2] Agent done', {
        summary: action.summary,
        files: action.files_changed,
      });
      return {
        type: 'done',
        summary: action.summary,
        filesChanged: action.files_changed,
      };
    }

    // ── shell ───────────────────────────────────────────────────────────────────
    if (isDangerous(action.command)) {
      console.warn('[auto-fix-v2] Blocked dangerous command', {
        command: action.command,
      });
      messages.push({ role: 'assistant', content: response });
      messages.push({
        role: 'user',
        content: `Command blocked for safety: "${action.command}". Use a different approach.`,
      });
      continue;
    }

    let shellOutput: string;
    try {
      shellOutput = await execShell(
        sandbox,
        `cd ${REPO_DIR} && ${action.command} 2>&1`,
      );
      // Truncate very long output to avoid token explosion
      if (shellOutput && shellOutput.length > SHELL_OUTPUT_LIMIT) {
        shellOutput = shellOutput.slice(0, SHELL_OUTPUT_LIMIT) + '\n... [truncated]';
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'unknown';
      shellOutput = `Command failed: ${msg}`;
    }

    console.log('[auto-fix-v2] Shell output', {
      command: action.command.slice(0, 100),
      outputLen: shellOutput?.length ?? 0,
    });

    messages.push({ role: 'assistant', content: response });
    messages.push({ role: 'user', content: `Command output:\n${shellOutput}` });
  }

  // Hit max steps — auto-commit and return whatever we have
  console.log('[auto-fix-v2] Hit max steps, auto-committing');
  let filesChanged: string[] = [];
  try {
    await execShell(
      sandbox,
      `cd ${REPO_DIR} && git add -A && git commit -m "fix: auto-fix in progress (max steps reached)" --allow-empty 2>&1`,
    );
    const diffOutput = await execShell(
      sandbox,
      `cd ${REPO_DIR} && git diff ${initialSha} --name-only 2>&1`,
    );
    filesChanged = diffOutput?.split('\n').filter(Boolean) ?? [];
  } catch {
    // Best effort
  }

  return {
    type: 'max_steps',
    summary: 'Agent hit maximum step limit',
    filesChanged,
  };
}

// ── PR creation from sandbox changes ───────────────────────────────────────────

async function createPrFromSandbox(
  sandbox: AutoFixSandbox,
  context: AutoFixContext,
  agentResult: AgentResult,
  initialSha: string,
): Promise<string | null> {
  const { repo, githubToken, triageOutput, errorTitle, sourceUrl } = context;

  // 1. Resolve changed files — prefer actual git diff over LLM-reported paths
  let filesChanged: string[] = [];

  // First, check for uncommitted changes and auto-commit them if present
  try {
    const statusOutput = await execShell(
      sandbox,
      `cd ${REPO_DIR} && git status --porcelain 2>&1`,
    );
    if (statusOutput?.trim()) {
      console.log('[auto-fix-v2] Uncommitted changes detected, auto-committing');
      await execShell(
        sandbox,
        `cd ${REPO_DIR} && git add -A && git commit -m "fix: auto-fix by DonMerge" 2>&1`,
      );
    }
  } catch {
    // Best effort — may not have uncommitted changes
  }

  // Use git diff to get actual changed file paths
  try {
    // Diff against the initial SHA to capture all changes across multiple commits
    const diffOutput = await execShell(
      sandbox,
      `cd ${REPO_DIR} && git diff ${initialSha} --name-only 2>&1`,
    );
    const diffFiles = diffOutput?.split('\n').filter(Boolean) ?? [];

    if (diffFiles.length > 0) {
      filesChanged = diffFiles;
      console.log('[auto-fix-v2] Using git diff for changed files', { files: filesChanged });
    }
  } catch {
    // git diff may fail if only one commit exists; fall through
  }

  // Fallback to LLM-reported files only if git diff yielded nothing
  if (filesChanged.length === 0 && agentResult.filesChanged.length > 0) {
    filesChanged = agentResult.filesChanged;
    console.log('[auto-fix-v2] Falling back to agent-reported files', { files: filesChanged });
  }

  if (filesChanged.length === 0) {
    console.log('[auto-fix-v2] No files changed, skipping PR');
    return null;
  }

  console.log('[auto-fix-v2] Changed files', { files: filesChanged });

  // 2. Get base branch and SHA
  const baseBranch = await getDefaultBranch(repo, githubToken);
  const baseSha = await getBranchHeadSha(repo, baseBranch, githubToken);

  // 3. Create branch
  const shortHash = crypto.randomUUID().replace(/-/g, '').substring(0, 8);
  const safeTitle = errorTitle
    .replace(/[^a-zA-Z0-9]/g, '-')
    .toLowerCase()
    .slice(0, 40);
  const branchName = `donmerge/fix-v2/${safeTitle}-${shortHash}`;

  let branchCreated = false;

  try {
    await createBranch(repo, branchName, baseSha, githubToken);
    branchCreated = true;

    // 4. Push each changed file via GitHub Contents API
    for (const filePath of filesChanged) {
      const normalizedPath = sanitizeFilePath(filePath.replace(/^\/+/, ''));

      // Read the file content from the sandbox
      const newContent = await execShell(
        sandbox,
        `cd ${REPO_DIR} && cat "${normalizedPath}" 2>&1`,
      );

      // Get current blob SHA from GitHub
      const { sha: fileSha } = await getFileFromGitHub(
        repo,
        normalizedPath,
        baseBranch,
        githubToken,
      );

      // Commit the updated file
      const rawMessage = triageOutput.suggested_fix.slice(0, 72);
      const commitMessage = `fix: ${rawMessage.replace(/\n/g, ' ')}`;
      await updateFileViaGitHub(
        repo,
        normalizedPath,
        newContent,
        commitMessage,
        branchName,
        fileSha,
        githubToken,
      );
    }

    // 5. Create PR
    const prTitle = `fix(v2): ${sanitizeTitle(errorTitle).slice(0, 80)}`;
    const prBody = buildPrBody(context, agentResult);
    const prUrl = await createPullRequest(
      repo,
      prTitle,
      prBody,
      branchName,
      baseBranch,
      githubToken,
    );

    console.log('[auto-fix-v2] PR created', {
      prUrl,
      branchName,
      files: filesChanged.length,
    });
    return prUrl;
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'unknown';
    console.error('[auto-fix-v2] PR creation failed', { error: msg });

    // Best-effort cleanup: delete orphan branch
    if (branchCreated) {
      await deleteBranch(repo, branchName, githubToken);
    }

    return null;
  }
}

// ── PR body builder ────────────────────────────────────────────────────────────

function buildPrBody(context: AutoFixContext, agentResult: AgentResult): string {
  const sanitizedRootCause = sanitizeData(context.triageOutput.root_cause, 2000);
  const sanitizedStackTrace = sanitizeData(
    context.triageOutput.stack_trace_summary,
    2000,
  );
  const sanitizedSummary = sanitizeData(agentResult.summary, 2000);

  const sourceSection = context.sourceUrl
    ? `[${sanitizeTitle(context.errorTitle)}](${context.sourceUrl})`
    : sanitizeTitle(context.errorTitle);

  const fileList =
    agentResult.filesChanged.length > 0
      ? agentResult.filesChanged.map((f) => `- \`${f}\``).join('\n')
      : '- (none)';

  return (
    `## DonMerge Triage (V2 — Agent Fix)\n\n` +
    `### Error\n${sourceSection}\n\n` +
    `### Root Cause\n${sanitizedRootCause}\n\n` +
    `### Agent Summary\n${sanitizedSummary}\n\n` +
    `### Files Changed\n${fileList}\n\n` +
    `### Stack Trace Summary\n${sanitizedStackTrace}\n\n` +
    `---\n*Auto-generated by [DonMerge](https://donmerge.dev) Triage V2*`
  );
}

// ── Public API ─────────────────────────────────────────────────────────────────

/** Dependencies injected by the processor. */
export interface AutoFixV2Deps {
  sandbox: AutoFixSandbox;
  /** FlueRuntime — available for future use (e.g. provider routing). */
  flue: unknown;
}

/**
 * Run the V2 auto-fix pipeline: clone repo in sandbox, agent loop, PR via GitHub API.
 *
 * Returns the PR URL on success, null on failure/skip.
 * Never throws — all errors are caught and logged.
 */
export async function runAutoFixV2(
  context: AutoFixContext,
  env: TriageEnv,
  deps: AutoFixV2Deps,
): Promise<string | null> {
  const { sandbox } = deps;

  try {
    // 1. Clone repo
    console.log('[auto-fix-v2] Cloning repo', { repo: context.repo });
    await cloneRepo(sandbox, context.repo, context.githubToken);

    // 2. Configure git identity in sandbox
    await execShell(
      sandbox,
      `cd ${REPO_DIR} && git config user.name "donmerge[bot]" && git config user.email "bot@donmerge.dev" 2>&1`,
    );

    // 2b. Capture initial SHA for multi-commit diff detection
    let initialSha: string;
    try {
      const shaOutput = await execShell(sandbox, `cd ${REPO_DIR} && git rev-parse HEAD 2>&1`);
      initialSha = shaOutput?.trim() ?? '';
      if (!initialSha) {
        console.warn('[auto-fix-v2] Could not capture initial SHA, falling back to HEAD~1');
      }
    } catch {
      initialSha = '';
    }

    // 3. Resolve Sentry-reported paths against actual repo layout
    let pathResolveResult: ResolveResult | null = null;
    try {
      pathResolveResult = await resolvePaths(
        sandbox,
        context.triageOutput.affected_files,
      );
      console.log('[auto-fix-v2] Path resolution', {
        resolved: pathResolveResult.resolved.size,
        unresolved: pathResolveResult.unresolved.length,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'unknown';
      console.warn('[auto-fix-v2] Path resolution failed, continuing without mapping', { error: msg });
    }

    // 4. Run agent loop
    const agentResult = await runAgentLoop(sandbox, context, env, pathResolveResult, initialSha);

    if (agentResult.type === 'cannot_fix') {
      console.log('[auto-fix-v2] Agent could not fix', {
        reason: agentResult.summary,
      });
      return null;
    }

    if (agentResult.type !== 'done') {
      console.log('[auto-fix-v2] Agent did not produce a fix', {
        type: agentResult.type,
        reason: agentResult.summary,
      });
      return null;
    }

    // 5. Create PR via GitHub API (handles git diff for actual changed files)
    return await createPrFromSandbox(sandbox, context, agentResult, initialSha);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'unknown';
    console.error('[auto-fix-v2] Pipeline failed', { error: msg });
    return null;
  }
}
