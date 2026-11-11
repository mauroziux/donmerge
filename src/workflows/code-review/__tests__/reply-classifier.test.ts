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
  parseClassificationJson,
  resolveReplyClassifierLlm,
  resolveClefConfig,
  classifyReply,
  classifyCommandIntent,
} from '../reply-classifier';

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
      '```json\n{"type":"accept","reason":"valid finding","learning":null}\n```'
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe('accept');
    expect(result!.learning).toBeNull();
  });

  it('rejects prose-wrapped JSON as a verdict — strict whole-string parsing', () => {
    expect(
      parseClassificationJson('Sure, here is the classification:\n{"type":"question","reason":"asking"}\nHope it helps.')
    ).toBeNull();
    expect(
      parseClassificationJson('I think {"type":"dismiss","reason":"x"} fits')
    ).toBeNull();
  });

  it('rejects hedged extra keys and duplicate keys', () => {
    expect(
      parseClassificationJson('{"type":"dismiss","reason":"x","confidence":"low"}')
    ).toBeNull();
    expect(
      parseClassificationJson('{"type":"question","type":"dismiss","reason":"x"}')
    ).toBeNull();
    expect(
      parseClassificationJson('{"type":"question","\\u0074ype":"dismiss","reason":"x"}')
    ).toBeNull();
  });

  it('requires the complete requested object — bare or mistyped verdicts are rejected', () => {
    expect(parseClassificationJson('{"type":"dismiss"}')).toBeNull();
    expect(parseClassificationJson('{"type":"dismiss","reason":"no aplica"}')).toBeNull();
    expect(parseClassificationJson('{"type":"dismiss","reason":123,"learning":null}')).toBeNull();
    expect(
      parseClassificationJson('{"type":"dismiss","reason":"no aplica","learning":null}')
    ).not.toBeNull();
  });

  it('returns null on invalid JSON', () => {
    expect(parseClassificationJson('not json at all')).toBeNull();
  });

  it('returns null on unknown type', () => {
    expect(parseClassificationJson('{"type":"maybe","reason":"x"}')).toBeNull();
  });

  it('truncates long reasons', () => {
    const result = parseClassificationJson(
      `{"type":"dismiss","reason":"${'a'.repeat(500)}","learning":null}`
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

  it('consults the LLM first — model nuance owns intent, heuristics only degrade', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: '{"type":"question","reason":"asking","learning":null}' } }],
        }),
    });
    const result = await classifyReply(
      { OPENAI_API_KEY: 'sk-x' },
      { findingBody: 'possible null deref', replyText: 'no aplica, se valida arriba' }
    );
    // The LLM saw a question in this phrasing — its verdict wins over the regex.
    expect(result!.type).toBe('question');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns no teaching when no provider is configured — regex never substitutes intent', async () => {
    const result = await classifyReply(
      {},
      { findingBody: 'possible null deref', replyText: 'no aplica, se valida arriba' }
    );
    expect(result).toBeNull();
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

  it('never falls back to phrasing heuristics during a provider outage', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));
    // 'no aplica' would heuristic-match as dismiss — but a configured provider
    // failed, and an unclassified reply is not a teaching.
    const result = await classifyReply(
      { OPENAI_API_KEY: 'sk-x' },
      { findingBody: 'finding', replyText: 'no aplica porque el null se valida' }
    );
    expect(result).toBeNull();
  });

  it('returns null with no LLM config and no heuristic match', async () => {
    const result = await classifyReply({}, { findingBody: 'f', replyText: 'maybe later' });
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ─── CLEF (Workers AI) fallback ─────────────────────────────────────

describe('resolveClefConfig', () => {
  it('requires both account id and token', () => {
    expect(resolveClefConfig({ CF_ACCOUNT_ID: 'acc' })).toBeNull();
    expect(resolveClefConfig({ CF_AI_API_TOKEN: 'tok' })).toBeNull();
    expect(resolveClefConfig({ CF_ACCOUNT_ID: 'acc', CF_AI_API_TOKEN: 'tok' })).toEqual({
      accountId: 'acc',
      token: 'tok',
    });
  });
});

describe('classifyReply via CLEF', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    mockFetch.mockReset();
  });

  it('uses a CLEF choice answer when no chat LLM is configured', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          result: {
            answers: {
              reply_teaching: {
                type: 'choice',
                choice: 'dismiss',
                probabilities: { dismiss: 0.91, accept: 0.03, question: 0.05, other: 0.01 },
                confidence: 0.91,
              },
            },
          },
        }),
    });

    const result = await classifyReply(
      { CF_ACCOUNT_ID: 'acc', CF_AI_API_TOKEN: 'tok' },
      { findingBody: 'nullable param', replyText: 'el contenedor siempre pasa una instancia valida' }
    );

    expect(result).toEqual({
      type: 'dismiss',
      reason: 'el contenedor siempre pasa una instancia valida',
      learning: null,
      source: 'clef',
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/acc/ai/run/@cf/cloudflare/clef',
      expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer tok' }) })
    );
  });

  it('ignores out-of-range CLEF confidence and returns no teaching', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          result: {
            answers: {
              reply_teaching: { type: 'choice', choice: 'dismiss', probabilities: {}, confidence: 1.7 },
            },
          },
        }),
    });

    const result = await classifyReply(
      { CF_ACCOUNT_ID: 'acc', CF_AI_API_TOKEN: 'tok' },
      { findingBody: 'f', replyText: 'no aplica' }
    );
    expect(result).toBeNull();
  });

  it('a confident CLEF "other" verdict is definitive — no heuristic override', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          result: {
            answers: {
              reply_teaching: { type: 'choice', choice: 'other', probabilities: {}, confidence: 0.88 },
            },
          },
        }),
    });

    // 'good catch' would heuristic-match as accept — the model said no teaching.
    const result = await classifyReply(
      { CF_ACCOUNT_ID: 'acc', CF_AI_API_TOKEN: 'tok' },
      { findingBody: 'f', replyText: 'good catch' }
    );
    expect(result).toBeNull();
  });

  it('ignores low-confidence CLEF answers and returns no teaching', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          result: {
            answers: {
              reply_teaching: { type: 'choice', choice: 'dismiss', probabilities: {}, confidence: 0.2 },
            },
          },
        }),
    });

    const result = await classifyReply(
      { CF_ACCOUNT_ID: 'acc', CF_AI_API_TOKEN: 'tok' },
      { findingBody: 'f', replyText: 'good catch, fixing' }
    );
    // CLEF is configured and responded without confidence: no heuristic guessing.
    expect(result).toBeNull();
  });
});

// ─── Command intent gate ────────────────────────────────────────────

describe('classifyCommandIntent', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    mockFetch.mockReset();
  });

  it('fails closed on an oversized command before calling either provider', async () => {
    const body = '@donmerge dismiss ' + 'x'.repeat(1200) + ' but is that correct?';
    expect(await classifyCommandIntent(
      { OPENAI_API_KEY: 'sk-x', CF_ACCOUNT_ID: 'acc', CF_AI_API_TOKEN: 'tok' }, body,
    )).toBe('question');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sends the complete original command including surrounding whitespace to the LLM', async () => {
    const body = '  @donmerge dismiss  ';
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({
      choices: [{ message: { content: '{"intent":"directive"}' } }],
    }) });
    expect(await classifyCommandIntent({ OPENAI_API_KEY: 'sk-x' }, body)).toBe('directive');
    const request = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(request.messages[1].content).toBe(body);
  });

  it('uses the chat LLM verdict when configured', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ choices: [{ message: { content: '{"intent":"question"}' } }] }),
    });
    const intent = await classifyCommandIntent(
      { OPENAI_API_KEY: 'sk-x' },
      '@donmerge dismiss?'
    );
    expect(intent).toBe('question');
  });

  it('rejects prose responses as verdicts — only a whole-string JSON object counts', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [
            { message: { content: 'Sure! I would say "intent":"directive" fits here.' } },
          ],
        }),
    });
    await expect(
      classifyCommandIntent({ OPENAI_API_KEY: 'sk-x' }, '@donmerge dismiss')
    ).resolves.toBe('question');

    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [
            { message: { content: 'I am unsure, but {"intent":"directive"} is plausible' } },
          ],
        }),
    });
    // JSON embedded in prose is still not the model's verdict.
    await expect(
      classifyCommandIntent({ OPENAI_API_KEY: 'sk-x' }, '@donmerge dismiss')
    ).resolves.toBe('question');
  });

  it('rejects hedged verdict objects with extra properties', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: '{"intent":"directive","explanation":"uncertain"}' } }],
        }),
    });
    await expect(
      classifyCommandIntent({ OPENAI_API_KEY: 'sk-x' }, '@donmerge dismiss')
    ).resolves.toBe('question');
  });

  it('rejects contradictory duplicate-key verdicts, including escaped keys', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: '{"intent":"question","intent":"directive"}' } }],
        }),
    });
    // JSON.parse would collapse to the last key — the raw duplicate is rejected.
    await expect(
      classifyCommandIntent({ OPENAI_API_KEY: 'sk-x' }, '@donmerge dismiss')
    ).resolves.toBe('question');

    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [
            { message: { content: '{"intent":"question","\\u0069ntent":"directive"}' } },
            { message: { content: '{"intent":"question","in\\u0074ent":"directive"}' } },
          ],
        }),
    });
    // Escaped duplicates decode to the same key — also rejected.
    await expect(
      classifyCommandIntent({ OPENAI_API_KEY: 'sk-x' }, '@donmerge dismiss')
    ).resolves.toBe('question');
  });

  it('falls through to CLEF when the configured chat LLM returns a malformed verdict', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: 'maybe directive? hard to say' } }],
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            result: { answers: { is_question: { type: 'noul', noul: 0.11 } } },
          }),
      });
    await expect(
      classifyCommandIntent(
        { OPENAI_API_KEY: 'sk-x', CF_ACCOUNT_ID: 'acc', CF_AI_API_TOKEN: 'tok' },
        '@donmerge dismiss'
      )
    ).resolves.toBe('directive');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('accepts a fenced JSON object as a verdict', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: '```json\n{"intent":"directive"}\n```' } }],
        }),
    });
    await expect(
      classifyCommandIntent({ OPENAI_API_KEY: 'sk-x' }, '@donmerge dismiss')
    ).resolves.toBe('directive');
  });

  it('returns question for an empty body — no directive without content', async () => {
    await expect(classifyCommandIntent({}, '   ')).resolves.toBe('question');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('treats an out-of-range CLEF probability as unusable and fails closed', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          result: { answers: { is_question: { type: 'noul', noul: -0.3 } } },
        }),
    });
    await expect(
      classifyCommandIntent({ CF_ACCOUNT_ID: 'acc', CF_AI_API_TOKEN: 'tok' }, '@donmerge dismiss')
    ).resolves.toBe('question');
  });

  it('falls back to CLEF noul probability without a chat LLM', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          result: { answers: { is_question: { type: 'noul', noul: 0.93 } } },
        }),
    });
    const intent = await classifyCommandIntent(
      { CF_ACCOUNT_ID: 'acc', CF_AI_API_TOKEN: 'tok' },
      '@donmerge preference por qu\u00e9 no aplica esto'
    );
    expect(intent).toBe('question');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/acc/ai/run/@cf/cloudflare/clef',
      expect.anything()
    );
  });

  it('treats a CLEF directive verdict as executable', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          result: { answers: { is_question: { type: 'noul', noul: 0.08 } } },
        }),
    });
    const intent = await classifyCommandIntent(
      { CF_ACCOUNT_ID: 'acc', CF_AI_API_TOKEN: 'tok' },
      'hola, por favor ignora los logs de debug'
    );
    expect(intent).toBe('directive');
  });

  it('fails closed with no provider configured — commands never execute on regex guesses', async () => {
    // Without a model there is no way to distinguish '@donmerge dismiss?' from
    // a phrased question, so every command is treated as a question (skipped).
    await expect(classifyCommandIntent({}, '@donmerge dismiss?')).resolves.toBe('question');
    await expect(classifyCommandIntent({}, '@donmerge dismiss')).resolves.toBe('question');
    await expect(classifyCommandIntent({}, '@donmerge preference por qu\u00e9 no aplica')).resolves.toBe('question');
    await expect(classifyCommandIntent({}, 'no aplica porque el null se valida')).resolves.toBe('question');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('fails closed during a provider outage — an unverifiable command is not executed', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));
    await expect(
      classifyCommandIntent({ CF_ACCOUNT_ID: 'acc', CF_AI_API_TOKEN: 'tok' }, '@donmerge dismiss')
    ).resolves.toBe('question');
  });
});

// ─── Provider chain: LLM failure falls through to CLEF ──────────────

describe('classifyReply provider chain', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    mockFetch.mockReset();
  });

  it('does not classify an oversized human reply from a truncated prefix', async () => {
    const replyText = 'No aplica '.repeat(150) + '¿pero es correcto?';
    expect(await classifyReply(
      { OPENAI_API_KEY: 'sk-x', CF_ACCOUNT_ID: 'acc', CF_AI_API_TOKEN: 'tok' },
      { findingBody: 'finding', replyText },
    )).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('falls through to a CLEF verdict when the configured chat LLM fails', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('gateway down'))
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            result: {
              answers: {
                reply_teaching: { type: 'choice', choice: 'accept', probabilities: {}, confidence: 0.82 },
              },
            },
          }),
      });

    const result = await classifyReply(
      { OPENAI_API_KEY: 'sk-x', CF_ACCOUNT_ID: 'acc', CF_AI_API_TOKEN: 'tok' },
      { findingBody: 'finding', replyText: 'buen punto, lo arreglo' }
    );

    expect(result).toEqual({
      type: 'accept',
      reason: 'buen punto, lo arreglo',
      learning: null,
      source: 'clef',
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('returns no teaching when both configured providers fail', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('gateway down'))
      .mockRejectedValueOnce(new Error('clef down'));

    const result = await classifyReply(
      { OPENAI_API_KEY: 'sk-x', CF_ACCOUNT_ID: 'acc', CF_AI_API_TOKEN: 'tok' },
      { findingBody: 'finding', replyText: 'buen punto, lo arreglo' }
    );
    expect(result).toBeNull();
  });
});
