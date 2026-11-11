/**
 * Reply classification for natural-language teaching.
 *
 * When a human replies to a DonMerge review comment without an explicit
 * `@donmerge <command>` (e.g. "no aplica porque el null ya se valida arriba"),
 * the reply is still a teaching signal. This module classifies it into:
 *
 *   - dismiss: the finding does not apply (with the human's reason) → ignore learning
 *   - accept:  the finding is valid / being fixed → reinforcement learning
 *   - question / other: no actionable teaching → no learning, no ack
 *
 * Classification strategy: teaching and command execution require a model
 * decision — chat LLM via CF AI Gateway first (nuance, produces the learning
 * text), then CLEF on Workers AI (cheap calibrated probabilities). Without a
 * usable model verdict (nothing configured, outage, low confidence) the system
 * fails closed: no learning is stored and commands are treated as questions
 * (not executed). Regex phrasing never substitutes for intent.
 */

import {
  aiGatewayEnabled,
  aiGatewayModelId,
  aiGatewayCompatUrl,
  OPENAI_BASE_URL,
} from '../../lib/llm-providers';

// ── Types ────────────────────────────────────────────────────────────────────

export type ReplyClassificationType = 'dismiss' | 'accept' | 'question' | 'other';

export interface ReplyClassification {
  type: ReplyClassificationType;
  /** Short human-facing restatement of why (used in the ack comment). */
  reason: string;
  /**
   * Imperative instruction for future reviews (stored as the learning text).
   * Only meaningful for dismiss/accept; null otherwise.
   */
  learning: string | null;
  /** 'llm' or 'clef' — which model produced the classification. */
  source: 'llm' | 'clef';
}

/** LLM configuration resolved once per invocation (gateway-first). */
export interface ReplyClassifierLlmConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export interface ReplyClassifierEnv {
  CF_AI_GATEWAY_URL?: string;
  CF_AI_GATEWAY_TOKEN?: string;
  CF_AI_GATEWAY_ROUTE?: string;
  OPENAI_API_KEY?: string;
  /** CLEF on Workers AI — cheap intent classifier used when no chat LLM is available. */
  CF_ACCOUNT_ID?: string;
  CF_AI_API_TOKEN?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function excerpt(text: string, maxLength = 280): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
}

// ── LLM classification (direct fetch, no sandbox) ────────────────────────────

/**
 * Resolve the LLM endpoint for reply classification.
 * Gateway-first (one route, owned fallback chain); plain OpenAI as the
 * non-gateway fallback. Returns null when no provider is usable.
 */
export function resolveReplyClassifierLlm(
  env: ReplyClassifierEnv
): ReplyClassifierLlmConfig | null {
  if (aiGatewayEnabled(env)) {
    return {
      baseURL: aiGatewayCompatUrl(env.CF_AI_GATEWAY_URL!),
      apiKey: env.CF_AI_GATEWAY_TOKEN!,
      model: aiGatewayModelId(env.CF_AI_GATEWAY_ROUTE!),
      timeoutMs: 25_000,
    };
  }
  if (env.OPENAI_API_KEY?.trim()) {
    return {
      baseURL: OPENAI_BASE_URL,
      apiKey: env.OPENAI_API_KEY,
      model: 'gpt-4o-mini',
      timeoutMs: 25_000,
    };
  }
  return null;
}

/**
 * Classify a reply with an LLM. Input is fully sanitized/truncated; the model
 * may only answer with the JSON schema — anything else is treated as failure.
 * Returns null on any failure (network, timeout, unparseable) — never throws.
 */
export async function classifyReplyWithLlm(
  config: ReplyClassifierLlmConfig,
  input: { findingBody: string; replyText: string; filePath?: string }
): Promise<ReplyClassification | null> {
  const system =
    'You classify replies to AI code-review comments. The AI reviewer left a finding; ' +
    'a human replied to it. Decide what the reply teaches:\n' +
    '- "dismiss": the finding does not apply, is a false positive, out of scope, or intentional ' +
    '(with or without an explanation)\n' +
    '- "accept": the finding is valid — acknowledged, being fixed, or already fixed\n' +
    '- "question": the human is asking for clarification (no teaching yet)\n' +
    '- "other": anything without actionable teaching\n\n' +
    'Respond with ONLY a JSON object: ' +
    '{"type":"dismiss|accept|question|other","reason":"<one short sentence restating the human\'s point>","learning":"<imperative instruction for future reviews, null unless dismiss/accept>"}\n' +
    'The learning must be a generalizable repo-level rule derived from the reply, not a quote. ' +
    'For dismiss it starts with "Don\'t flag"; for accept it starts with "Confirmed valid".';

  const user = JSON.stringify({
    finding_file: input.filePath,
    finding_body: input.findingBody.slice(0, 1200),
    human_reply: input.replyText.slice(0, 1200),
  });

  try {
    const response = await fetch(`${config.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0,
        max_tokens: 300,
      }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });

    if (!response.ok) {
      console.warn('[reply-classifier] LLM HTTP error', {
        status: response.status,
        model: config.model,
      });
      return null;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    return parseClassificationJson(content);
  } catch (error) {
    console.warn('[reply-classifier] LLM call failed:', {
      error: error instanceof Error ? error.message : error,
    });
    return null;
  }
}

/**
 * Strict teaching-verdict parse: the model's ENTIRE response (modulo a
 * markdown fence) must be a JSON object with keys exactly among
 * {type, reason, learning}, no duplicate keys (literal or escaped), type
 * valid. Prose-wrapped or hedged responses are NOT usable verdicts.
 */
export function parseClassificationJson(content: string): ReplyClassification | null {
  let text = content.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) text = fence[1].trim();

  if (!text.startsWith('{') || !text.endsWith('}')) return null;

  // JSON.parse collapses duplicate keys (including escaped forms) — scan and
  // decode every raw key token first.
  const keyTokens = text.match(/"(?:[^"\\]|\\.)*"\s*:/g) ?? [];
  const decodedKeys = keyTokens.map((token) => {
    try {
      return JSON.parse(token.slice(0, token.lastIndexOf('"') + 1)) as string;
    } catch {
      return token;
    }
  });
  const keySet = new Set(decodedKeys);
  if (decodedKeys.length !== keySet.size) return null;
  for (const key of decodedKeys) {
    if (key !== 'type' && key !== 'reason' && key !== 'learning') return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as { type?: unknown; reason?: unknown; learning?: unknown };

  if (
    obj.type !== 'dismiss' &&
    obj.type !== 'accept' &&
    obj.type !== 'question' &&
    obj.type !== 'other'
  ) {
    return null;
  }

  // The verdict must be the complete requested object: a non-empty string
  // reason and a learning that is either null or a non-empty string. A bare
  // {"type":"dismiss"} is a hedged/incomplete response, not a verdict.
  if (!('reason' in obj) || typeof obj.reason !== 'string' || !obj.reason.trim()) return null;
  if (
    !('learning' in obj) ||
    (obj.learning !== null &&
      (typeof obj.learning !== 'string' || !obj.learning.trim()))
  ) {
    return null;
  }

  return {
    type: obj.type,
    reason: excerpt(obj.reason.trim()),
    learning: obj.learning === null ? null : obj.learning.trim(),
    source: 'llm',
  };
}

// ── CLEF (Workers AI) — cheap calibrated intent decisions ───────────────────

const CLEF_MODEL_ID = '@cf/cloudflare/clef';
const CLEF_TIMEOUT_MS = 6_000;

export interface ClefConfig {
  accountId: string;
  token: string;
}

export function resolveClefConfig(env: ReplyClassifierEnv): ClefConfig | null {
  const accountId = env.CF_ACCOUNT_ID?.trim();
  const token = env.CF_AI_API_TOKEN?.trim();
  return accountId && token ? { accountId, token } : null;
}

/**
 * Run CLEF typed questions against a text state via the Workers AI REST API.
 * Returns the `answers` map or null; never throws.
 */
export async function clefRun(
  config: ClefConfig,
  state: string,
  questions: Record<string, unknown>
): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/ai/run/${CLEF_MODEL_ID}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: 'clef', state: state.slice(0, 4000), questions }),
        signal: AbortSignal.timeout(CLEF_TIMEOUT_MS),
      }
    );

    if (!response.ok) {
      console.warn('[reply-classifier] CLEF HTTP error', { status: response.status });
      return null;
    }

    const data = (await response.json()) as {
      result?: { answers?: Record<string, unknown> };
    };
    return data.result?.answers ?? null;
  } catch (error) {
    console.warn('[reply-classifier] CLEF call failed:', {
      error: error instanceof Error ? error.message : error,
    });
    return null;
  }
}

// ── Command intent gate (question vs directive) ─────────────────────────

export type CommandIntent = 'directive' | 'question';

/** Classify intent with the chat LLM. Returns null on any failure. */
async function classifyIntentWithLlm(
  config: ReplyClassifierLlmConfig,
  commentBody: string
): Promise<CommandIntent | null> {
  const system =
    'You classify comments addressed to the @donmerge code-review bot. Decide if the comment ' +
    'is a directive (a command to execute now, however politely phrased) or a question ' +
    '(asking whether/what/how/why, requesting clarification or confirmation, in any language). ' +
    'Respond with ONLY a JSON object: {"intent":"directive"} or {"intent":"question"}.\n' +
    'Examples: "@donmerge dismiss" → directive. "@donmerge dismiss?" → question. ' +
    '"@donmerge preference por qué no aplica esto?" → question. ' +
    '"@donmerge preference ignora los logs" → directive. ' +
    '"Could you dismiss this?" → question. "please dismiss this finding" → directive.';

  try {
    const response = await fetch(`${config.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: commentBody.slice(0, 1200) },
        ],
        temperature: 0,
        max_tokens: 60,
      }),
      signal: AbortSignal.timeout(Math.min(config.timeoutMs, 8_000)),
    });
    if (!response.ok) return null;

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content ?? '';
    return parseIntentJson(content);
  } catch {
    return null;
  }
}

/**
 * Strict intent parse: the model's ENTIRE response (modulo a markdown
 * fence) must be the JSON object {"intent":"directive"|"question"}. JSON
 * embedded in prose is NOT a usable verdict — the caller falls through
 * (CLEF → fail-closed).
 */
function parseIntentJson(content: string): CommandIntent | null {
  let text = content.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) text = fence[1].trim();

  if (!text.startsWith('{') || !text.endsWith('}')) return null;

  // JSON.parse collapses duplicate keys — including escaped ones
  // ({"intent":"question","\u0069ntent":"directive"}). Scan every raw key
  // token, JSON-decode it, and require exactly one key named "intent".
  const keyTokens = text.match(/"(?:[^"\\]|\\.)*"\s*:/g) ?? [];
  const decodedKeys = keyTokens.map((token) => {
    try {
      return JSON.parse(token.slice(0, token.lastIndexOf('"') + 1)) as string;
    } catch {
      return token;
    }
  });
  if (decodedKeys.length !== 1 || decodedKeys[0] !== 'intent') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  // The verdict must be EXACTLY {"intent": "directive"|"question"} — no
  // hedging extras ("explanation", "confidence") attached.
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== 'intent') return null;
  const intent = (parsed as { intent: unknown }).intent;
  return intent === 'directive' || intent === 'question' ? intent : null;
}

/**
 * Decide whether a `@donmerge <command>` comment is a real directive or a
 * question about the command ("@donmerge dismiss?" must not mutate memory).
 * Chat LLM first (nuance, any language), CLEF second (calibrated probability).
 * Without a usable model verdict this always returns 'question' — a command
 * we cannot verify is never executed.
 */
export async function classifyCommandIntent(
  env: ReplyClassifierEnv,
  commentBody: string
): Promise<CommandIntent> {
  const text = commentBody.trim();
  // An empty body carries no directive: fail closed.
  if (!text) return 'question';

  const llm = resolveReplyClassifierLlm(env);
  const clef = resolveClefConfig(env);
  if (llm) {
    const intent = await classifyIntentWithLlm(llm, text);
    if (intent) return intent;
  }

  if (clef) {
    const answers = await clefRun(
      clef,
      `GitHub PR comment addressed to the @donmerge code-review bot:\n${text}`,
      {
        is_question: {
          type: 'noul',
          instructions:
            'Is the author asking a question or requesting clarification (in any language), ' +
            'rather than giving a direct command to execute? Questions about whether to ' +
            'dismiss/accept, or asking what a command does, count as questions. ' +
            'Polite but imperative requests ("please dismiss this") are commands, not questions.',
        },
      }
    );
    const noul = answers?.is_question as { noul?: unknown } | undefined;
    if (
      noul &&
      typeof noul.noul === 'number' &&
      Number.isFinite(noul.noul) &&
      noul.noul >= 0 &&
      noul.noul <= 1
    ) {
      return noul.noul >= 0.5 ? 'question' : 'directive';
    }
  }

  // No usable model verdict (outage, or nothing configured): fail closed —
  // a command we cannot verify is a question must never mutate memory.
  // The human can retry once a provider is reachable.
  return 'question';
}

/**
 * Full classification pipeline: chat LLM (nuance + learning text) → CLEF
 * (calibrated choice). Without a usable model verdict there is no teaching.
 * null means "no teaching detected" — the caller must not record anything.
 */
export async function classifyReply(
  env: ReplyClassifierEnv,
  input: { findingBody: string; replyText: string; filePath?: string }
): Promise<ReplyClassification | null> {
  const llmConfig = resolveReplyClassifierLlm(env);
  const clef = resolveClefConfig(env);

  if (llmConfig) {
    const llmResult = await classifyReplyWithLlm(llmConfig, input);
    if (llmResult) return llmResult; // includes question/other — the model owns nuance
  }

  if (clef) {
    const answers = await clefRun(
      clef,
      `AI code-review finding:\n${input.findingBody.slice(0, 2000)}\n\nHuman reply:\n${input.replyText.slice(0, 2000)}`,
      {
        reply_teaching: {
          type: 'choice',
          instructions: 'What does the human reply teach about the AI code-review finding?',
          criteria: {
            dismiss:
              'The finding does not apply: false positive, out of scope, intentional, or already validated elsewhere',
            accept: 'The finding is valid: acknowledged, being fixed, or already fixed',
            question: 'The human is asking for clarification — no teaching yet',
            other: 'No actionable teaching',
          },
        },
      }
    );
    const choice = answers?.reply_teaching as { choice?: unknown; confidence?: unknown } | undefined;
    if (
      choice &&
      typeof choice.confidence === 'number' &&
      Number.isFinite(choice.confidence) &&
      choice.confidence >= 0.5 &&
      choice.confidence <= 1 &&
      (choice.choice === 'dismiss' || choice.choice === 'accept' || choice.choice === 'question' || choice.choice === 'other')
    ) {
      // A confident model verdict is definitive — including "other": a
      // model-designated non-teaching must not be overridden by phrase regexes.
      if (choice.choice === 'other') return null;
      return {
        type: choice.choice,
        reason: excerpt(input.replyText),
        learning: null, // caller composes learning from finding context + reason
        source: 'clef',
      };
    }
  }

  // Teaching requires a model decision. Without one (nothing configured, or a
  // configured provider that could not decide), there is no teaching — regex
  // phrasing never substitutes for intent.
  return null;
}
