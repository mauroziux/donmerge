/**
 * Tests for reply-classifier.ts
 *
 * Covers:
 * - classifyReplyHeuristic: dismiss/accept pattern detection, null on neutral text
 * - parseClassificationJson: robust LLM output parsing
 * - resolveReplyClassifierLlm: gateway-first, openai fallback, none
 * - classifyReply: full pipeline with mocked fetch
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  classifyReplyHeuristic,
  parseClassificationJson,
  resolveReplyClassifierLlm,
  classifyReply,
} from '../reply-classifier';

// ─── Heuristics ─────────────────────────────────────────────────────

describe('classifyReplyHeuristic', () => {
  it('classifies "no aplica" replies as dismiss', () => {
    const result = classifyReplyHeuristic('No aplica porque el null ya se valida arriba en el handler');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('dismiss');
    expect(result!.source).toBe('heuristic');
    expect(result!.reason).toContain('null ya se valida');
  });

  it('classifies "false positive" as dismiss', () => {
    expect(classifyReplyHeuristic('false positive, this is generated code')!.type).toBe('dismiss');
  });

  it('classifies "won\'t fix" as dismiss', () => {
    expect(classifyReplyHeuristic("won't fix this, it's temporary")!.type).toBe('dismiss');
  });

  it('classifies "out of scope" as dismiss', () => {
    expect(classifyReplyHeuristic('out of scope for this PR')!.type).toBe('dismiss');
  });

  it('classifies acknowledgments as accept', () => {
    expect(classifyReplyHeuristic('good catch, fixing now')!.type).toBe('accept');
  });

  it('classifies "ya lo arreglé" as accept', () => {
    expect(classifyReplyHeuristic('cierto, ya lo arreglé en el último commit')!.type).toBe('accept');
  });

  it('returns null on neutral replies (question)', () => {
    expect(classifyReplyHeuristic('why do you think this is unsafe here?')).toBeNull();
  });

  it('returns null on empty text', () => {
    expect(classifyReplyHeuristic('   ')).toBeNull();
  });
});

// ─── LLM output parsing ─────────────────────────────────────────────

describe('parseClassificationJson', () => {
  it('parses plain JSON', () => {
    const result = parseClassificationJson(
      '{"type":"dismiss","reason":"null already validated","learning":"Don\'t flag null checks here"}'
    );
    expect(result).toEqual({
      type: 'dismiss',
      reason: 'null already validated',
      learning: "Don't flag null checks here",
      source: 'llm',
    });
  });

  it('parses JSON inside markdown fences', () => {
    const result = parseClassificationJson(
      '```json\n{"type":"accept","reason":"valid finding"}\n```'
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe('accept');
    expect(result!.learning).toBeNull();
  });

  it('parses JSON surrounded by prose', () => {
    const result = parseClassificationJson(
      'Sure, here is the classification:\n{"type":"question","reason":"asking"}\nHope it helps.'
    );
    expect(result!.type).toBe('question');
  });

  it('returns null on invalid JSON', () => {
    expect(parseClassificationJson('not json at all')).toBeNull();
  });

  it('returns null on unknown type', () => {
    expect(parseClassificationJson('{"type":"maybe","reason":"x"}')).toBeNull();
  });

  it('truncates long reasons', () => {
    const result = parseClassificationJson(
      `{"type":"dismiss","reason":"${'a'.repeat(500)}"}`
    );
    expect(result!.reason.length).toBeLessThanOrEqual(281);
  });
});

// ─── LLM config resolution ──────────────────────────────────────────

describe('resolveReplyClassifierLlm', () => {
  it('prefers the AI gateway when configured', () => {
    const config = resolveReplyClassifierLlm({
      CF_AI_GATEWAY_URL: 'https://gw.example.com/v1',
      CF_AI_GATEWAY_TOKEN: 'cf-token',
      CF_AI_GATEWAY_ROUTE: 'donmerge-text-fallback',
      OPENAI_API_KEY: 'sk-x',
    });
    expect(config).toEqual({
      baseURL: 'https://gw.example.com/v1/compat',
      apiKey: 'cf-token',
      model: 'dynamic/donmerge-text-fallback',
      timeoutMs: 25_000,
    });
  });

  it('falls back to OpenAI without a gateway', () => {
    const config = resolveReplyClassifierLlm({ OPENAI_API_KEY: 'sk-x' });
    expect(config).toEqual({
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'sk-x',
      model: 'gpt-4o-mini',
      timeoutMs: 25_000,
    });
  });

  it('returns null with no providers', () => {
    expect(resolveReplyClassifierLlm({})).toBeNull();
  });
});

// ─── Full pipeline ──────────────────────────────────────────────────

describe('classifyReply', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    mockFetch.mockReset();
  });

  it('short-circuits on heuristic match without calling the LLM', async () => {
    const result = await classifyReply(
      { OPENAI_API_KEY: 'sk-x' },
      { findingBody: 'possible null deref', replyText: 'no aplica, se valida arriba' }
    );
    expect(result!.type).toBe('dismiss');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('uses the LLM when heuristics do not match', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [
            {
              message: {
                content:
                  '{"type":"dismiss","reason":"constructor guarantees non-null","learning":"Don\'t flag nullable constructor params in services"}',
              },
            },
          ],
        }),
    });

    const result = await classifyReply(
      { CF_AI_GATEWAY_URL: 'https://gw.example.com/v1', CF_AI_GATEWAY_TOKEN: 't', CF_AI_GATEWAY_ROUTE: 'r' },
      { findingBody: 'nullable param', replyText: 'the DI container always passes this' }
    );

    expect(result).toEqual({
      type: 'dismiss',
      reason: 'constructor guarantees non-null',
      learning: "Don't flag nullable constructor params in services",
      source: 'llm',
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://gw.example.com/v1/compat/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer t' }),
      })
    );
  });

  it('returns null when the LLM fails and heuristics do not match', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));
    const result = await classifyReply(
      { OPENAI_API_KEY: 'sk-x' },
      { findingBody: 'finding', replyText: 'hm interesting point' }
    );
    expect(result).toBeNull();
  });

  it('returns null with no LLM config and no heuristic match', async () => {
    const result = await classifyReply({}, { findingBody: 'f', replyText: 'maybe later' });
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
