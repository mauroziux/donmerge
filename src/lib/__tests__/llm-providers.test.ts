/**
 * Tests for the shared LLM provider configuration module.
 *
 * Covers provider baseURL resolution, Kimi OpenCode provider config generation,
 * fallback model resolution, and API key selection — the routing logic that
 * makes Kimi K3 the primary model with OpenAI as fallback across both the
 * code-review and triage workflows.
 */

import { describe, it, expect } from 'vitest';
import {
  KIMI_BASE_URL,
  OPENAI_BASE_URL,
  DEFAULT_PRIMARY_MODEL,
  DEFAULT_FALLBACK_MODEL,
  isOpenAICompatibleProvider,
  resolveOpenAIBaseURL,
  buildKimiProviderConfig,
  buildOpencodeConfig,
  resolveFallbackModel,
  selectApiKey,
} from '../llm-providers';

describe('llm-providers', () => {
  // ── Constants ──────────────────────────────────────────────────────────────

  it('exposes the Kimi Code and OpenAI base URLs', () => {
    expect(KIMI_BASE_URL).toBe('https://api.kimi.com/coding/v1');
    expect(OPENAI_BASE_URL).toBe('https://api.openai.com/v1');
    expect(DEFAULT_PRIMARY_MODEL).toBe('kimi/k3');
    expect(DEFAULT_FALLBACK_MODEL).toBe('openai/gpt-4o');
  });

  // ── isOpenAICompatibleProvider ─────────────────────────────────────────────

  it('recognizes OpenAI-compatible providers', () => {
    expect(isOpenAICompatibleProvider('openai')).toBe(true);
    expect(isOpenAICompatibleProvider('kimi')).toBe(true);
    expect(isOpenAICompatibleProvider('moonshot')).toBe(true);
    expect(isOpenAICompatibleProvider('KIMI')).toBe(true); // case-insensitive
    expect(isOpenAICompatibleProvider('anthropic')).toBe(false);
    expect(isOpenAICompatibleProvider('')).toBe(false);
  });

  // ── resolveOpenAIBaseURL ───────────────────────────────────────────────────

  it('resolves the Kimi base URL for kimi/moonshot providers', () => {
    expect(resolveOpenAIBaseURL('kimi')).toBe(KIMI_BASE_URL);
    expect(resolveOpenAIBaseURL('moonshot')).toBe(KIMI_BASE_URL);
    expect(resolveOpenAIBaseURL('Moonshot')).toBe(KIMI_BASE_URL);
  });

  it('resolves the OpenAI base URL for openai and unknown providers', () => {
    expect(resolveOpenAIBaseURL('openai')).toBe(OPENAI_BASE_URL);
    expect(resolveOpenAIBaseURL('some-proxy')).toBe(OPENAI_BASE_URL);
    expect(resolveOpenAIBaseURL('')).toBe(OPENAI_BASE_URL);
  });

  // ── buildKimiProviderConfig ────────────────────────────────────────────────

  it('builds an OpenCode provider entry for Kimi K3 with the Kimi baseURL', () => {
    const config = buildKimiProviderConfig('sk-kimi-123');
    expect(config.npm).toBe('@ai-sdk/openai-compatible');
    expect((config.options as Record<string, unknown>).baseURL).toBe(KIMI_BASE_URL);
    expect((config.options as Record<string, unknown>).apiKey).toBe('sk-kimi-123');
    expect((config.models as Record<string, unknown>).k3).toBeDefined();
  });

  // ── buildOpencodeConfig ────────────────────────────────────────────────────

  it('builds a full opencodeConfig registering the kimi provider when a key is present', () => {
    const opencodeConfig = buildOpencodeConfig('sk-kimi-123');
    expect(opencodeConfig.provider).toBeDefined();
    expect(opencodeConfig.provider.kimi).toBeDefined();
    expect(
      ((opencodeConfig.provider.kimi as Record<string, unknown>).options as Record<string, unknown>).baseURL
    ).toBe(KIMI_BASE_URL);
  });

  it('returns an empty provider map when no Kimi key is configured', () => {
    expect(buildOpencodeConfig(undefined)).toEqual({ provider: {} });
    expect(buildOpencodeConfig('')).toEqual({ provider: {} });
    expect(buildOpencodeConfig('   ')).toEqual({ provider: {} });
  });

  // ── resolveFallbackModel ───────────────────────────────────────────────────

  it('defaults the fallback to OpenAI gpt-4o', () => {
    expect(resolveFallbackModel(undefined)).toEqual({
      providerID: 'openai',
      modelID: 'gpt-4o',
    });
  });

  it('parses a provider/model fallback string', () => {
    expect(resolveFallbackModel('anthropic/claude-sonnet-4')).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4',
    });
  });

  it('falls back to OpenAI when a fallback string has no slash', () => {
    expect(resolveFallbackModel('gpt-4o-mini')).toEqual({
      providerID: 'openai',
      modelID: 'gpt-4o-mini',
    });
  });

  it('falls back to OpenAI gpt-4o on a malformed fallback string', () => {
    expect(resolveFallbackModel('/')).toEqual({ providerID: 'openai', modelID: 'gpt-4o' });
    expect(resolveFallbackModel('openai/')).toEqual({ providerID: 'openai', modelID: 'gpt-4o' });
  });

  // ── selectApiKey ───────────────────────────────────────────────────────────

  it('selects the Kimi key for kimi/moonshot providers', () => {
    expect(
      selectApiKey('kimi', { openai: 'sk-oai', kimi: 'sk-kimi' })
    ).toBe('sk-kimi');
    expect(
      selectApiKey('Moonshot', { openai: 'sk-oai', kimi: 'sk-kimi' })
    ).toBe('sk-kimi');
  });

  it('falls back to the OpenAI key when no Kimi key is set', () => {
    expect(selectApiKey('kimi', { openai: 'sk-oai' })).toBe('sk-oai');
  });

  it('selects the OpenAI key for openai and unknown providers', () => {
    expect(selectApiKey('openai', { openai: 'sk-oai' })).toBe('sk-oai');
    expect(selectApiKey('proxy', { openai: 'sk-oai' })).toBe('sk-oai');
  });

  it('selects the Anthropic key (with OpenAI fallback) for anthropic', () => {
    expect(
      selectApiKey('anthropic', { openai: 'sk-oai', anthropic: 'sk-ant' })
    ).toBe('sk-ant');
    expect(selectApiKey('anthropic', { openai: 'sk-oai' })).toBe('sk-oai');
  });
});
