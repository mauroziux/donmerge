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
 * Classification strategy: cheap regex heuristics first (free, instant, covers
 * the common phrasings); LLM via direct fetch (CF AI Gateway when configured,
 * no sandbox needed) for everything else. If the LLM fails, heuristics apply —
 * an unclassified reply is never silently treated as teaching.
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
  /** 'heuristic' or 'llm' — how the classification was produced. */
  source: 'heuristic' | 'llm';
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
}

// ── Heuristic classification ─────────────────────────────────────────────────

const DISMISS_PATTERNS: RegExp[] = [
  /no\s+aplica/i,
  /no\s+es\s+aplicable/i,
  /not\s+applicable/i,
  /doesn'?t\s+apply/i,
  /does\s+not\s+apply/i,
  /false\s+positive/i,
  /falso\s+positivo/i,
  /won'?t\s+fix/i,
  /wontfix/i,
  /by\s+design/i,
  /as\s+designed/i,
  /intencional/i,
  /esperado/i,
  /^n\/?a$/im,
  /^ignora(?:r)?\b/im,
  /^ignore\b/im,
  /ya\s+se\s+valida/i,
  /already\s+(?:validated|checked|handled|verified)/i,
  /out\s+of\s+scope/i,
  /fuera\s+de\s+(?:scope|alcance)/i,
];

const ACCEPT_PATTERNS: RegExp[] = [
  /buen\s+punto/i,
  /buena\s+observaci[oó]n/i,
  /good\s+catch/i,
  /valid\s+point/i,
  /fair\s+point/i,
  /tienes\s+raz[oó]n/i,
  /you'?re\s+right/i,
  /cierto/i,
  /^ok\b/im,
  /lo\s+arreglo/i,
  /ya\s+lo\s+arregl[eé]/i,
  /(?:will\s+fix|fixing|fixed|addressed|resuelto|resuelta)/i,
  /aplicado/i,
  /applied/i,
];

/**
 * Classify a reply with free regex heuristics. Returns null when no pattern
 * matches — the caller should then try the LLM classifier.
 */
export function classifyReplyHeuristic(replyText: string): ReplyClassification | null {
  const text = replyText.trim();
  if (!text) return null;

  for (const pattern of DISMISS_PATTERNS) {
    if (pattern.test(text)) {
      return {
        type: 'dismiss',
        reason: excerpt(text),
        learning: null, // caller composes learning from finding context + reason
        source: 'heuristic',
      };
    }
  }

  for (const pattern of ACCEPT_PATTERNS) {
    if (pattern.test(text)) {
      return {
        type: 'accept',
        reason: excerpt(text),
        learning: null,
        source: 'heuristic',
      };
    }
  }

  return null;
}

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

/** Parse the LLM output, tolerating markdown fences and prose around JSON. */
export function parseClassificationJson(content: string): ReplyClassification | null {
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
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

  const reason = typeof obj.reason === 'string' && obj.reason.trim() ? obj.reason.trim() : '';
  const learning = typeof obj.learning === 'string' && obj.learning.trim() ? obj.learning.trim() : null;

  return {
    type: obj.type,
    reason: excerpt(reason),
    learning,
    source: 'llm',
  };
}

/**
 * Full classification pipeline: heuristics → LLM → give up (null means
 * "no teaching detected", the caller must not record anything).
 */
export async function classifyReply(
  env: ReplyClassifierEnv,
  input: { findingBody: string; replyText: string; filePath?: string }
): Promise<ReplyClassification | null> {
  const heuristic = classifyReplyHeuristic(input.replyText);
  if (heuristic) return heuristic;

  const llmConfig = resolveReplyClassifierLlm(env);
  if (!llmConfig) return null;

  const llmResult = await classifyReplyWithLlm(llmConfig, input);
  if (llmResult && (llmResult.type === 'dismiss' || llmResult.type === 'accept')) {
    return llmResult;
  }
  // question/other from the LLM: no teaching.
  if (llmResult) return llmResult;

  // LLM unavailable: treat only regex-obvious replies as teaching.
  return null;
}
