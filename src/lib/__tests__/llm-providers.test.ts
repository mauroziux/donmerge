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
  GLM_BASE_URL,
  OPENAI_BASE_URL,
  DEFAULT_PRIMARY_MODEL,
  DEFAULT_FALLBACK_MODEL,
  isOpenAICompatibleProvider,
  resolveOpenAIBaseURL,
  buildKimiProviderConfig,
  buildGlmProviderConfig,
  buildOpencodeConfig,
  resolveFallbackModel,
  selectApiKey,
  aiGatewayEnabled,
  aiGatewayCompatUrl,
  aiGatewayModelId,
  buildAiGatewayOpencodeConfig,
  resolveDirectFetchBaseURL,
  AI_GATEWAY_PROVIDER_ID,
} from '../llm-providers';

describe('llm-providers', () => {
  // ── Constants ──────────────────────────────────────────────────────────────

  it('exposes the Kimi Code and OpenAI base URLs', () => {
    expect(KIMI_BASE_URL).toBe('https://api.kimi.com/coding/v1');
    expect(GLM_BASE_URL).toBe('https://open.bigmodel.cn/api/coding/paas/v4');
    expect(OPENAI_BASE_URL).toBe('https://api.openai.com/v1');
    expect(DEFAULT_PRIMARY_MODEL).toBe('kimi/k3');
    expect(DEFAULT_FALLBACK_MODEL).toBe('openai/gpt-4o');
  });

  // ── isOpenAICompatibleProvider ─────────────────────────────────────────────

  it('recognizes OpenAI-compatible providers', () => {
    expect(isOpenAICompatibleProvider('openai')).toBe(true);
    expect(isOpenAICompatibleProvider('kimi')).toBe(true);
    expect(isOpenAICompatibleProvider('moonshot')).toBe(true);
    expect(isOpenAICompatibleProvider('glm')).toBe(true);
    expect(isOpenAICompatibleProvider('zhipu')).toBe(true);
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

  it('resolves the GLM base URL for glm/zhipu providers', () => {
    expect(resolveOpenAIBaseURL('glm')).toBe(GLM_BASE_URL);
    expect(resolveOpenAIBaseURL('zhipu')).toBe(GLM_BASE_URL);
    expect(resolveOpenAIBaseURL('Zhipu')).toBe(GLM_BASE_URL);
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

  // ── buildGlmProviderConfig ────────────────────────────────────────────────

  it('builds an OpenCode provider entry for GLM 5.2 with the GLM baseURL', () => {
    const config = buildGlmProviderConfig('sk-glm-123');
    expect(config.npm).toBe('@ai-sdk/openai-compatible');
    expect((config.options as Record<string, unknown>).baseURL).toBe(GLM_BASE_URL);
    expect((config.options as Record<string, unknown>).apiKey).toBe('sk-glm-123');
    expect((config.models as Record<string, unknown>)['5.2']).toBeDefined();
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

  it('builds a full opencodeConfig registering both kimi and glm providers when keys are present', () => {
    const opencodeConfig = buildOpencodeConfig('sk-kimi-123', 'sk-glm-123');
    expect(opencodeConfig.provider).toBeDefined();
    expect(opencodeConfig.provider.kimi).toBeDefined();
    expect(opencodeConfig.provider.glm).toBeDefined();
    expect(
      ((opencodeConfig.provider.glm as Record<string, unknown>).options as Record<string, unknown>).baseURL
    ).toBe(GLM_BASE_URL);
  });

  it('returns an empty provider map when no keys are configured', () => {
    expect(buildOpencodeConfig(undefined, undefined)).toEqual({ provider: {} });
    expect(buildOpencodeConfig('', '')).toEqual({ provider: {} });
    expect(buildOpencodeConfig('   ', '   ')).toEqual({ provider: {} });
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
      selectApiKey('kimi', { openai: 'sk-oai', kimi: 'sk-kimi', glm: 'sk-glm' })
    ).toBe('sk-kimi');
    expect(
      selectApiKey('Moonshot', { openai: 'sk-oai', kimi: 'sk-kimi', glm: 'sk-glm' })
    ).toBe('sk-kimi');
  });

  it('selects the GLM key for glm/zhipu providers', () => {
    expect(
      selectApiKey('glm', { openai: 'sk-oai', kimi: 'sk-kimi', glm: 'sk-glm' })
    ).toBe('sk-glm');
    expect(
      selectApiKey('Zhipu', { openai: 'sk-oai', kimi: 'sk-kimi', glm: 'sk-glm' })
    ).toBe('sk-glm');
  });

  it('falls back to the OpenAI key when no Kimi or GLM key is set', () => {
    expect(selectApiKey('kimi', { openai: 'sk-oai' })).toBe('sk-oai');
    expect(selectApiKey('glm', { openai: 'sk-oai' })).toBe('sk-oai');
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

describe('AI Gateway integration', () => {
  it('aiGatewayEnabled is false when any env var is missing', () => {
    expect(aiGatewayEnabled({})).toBe(false);
    expect(aiGatewayEnabled({ CF_AI_GATEWAY_URL: 'x' })).toBe(false);
    expect(aiGatewayEnabled({ CF_AI_GATEWAY_URL: 'x', CF_AI_GATEWAY_TOKEN: 'y' })).toBe(false);
  });

  it('aiGatewayEnabled is true when all three env vars are set', () => {
    expect(
      aiGatewayEnabled({
        CF_AI_GATEWAY_URL: 'https://gateway.ai.cloudflare.com/v1/acct/gw',
        CF_AI_GATEWAY_TOKEN: 'cfut_x',
        CF_AI_GATEWAY_ROUTE: 'route-id',
      })
    ).toBe(true);
  });

  it('aiGatewayCompatUrl builds the OpenAI-compatible compat base (SDK appends /chat/completions)', () => {
    expect(aiGatewayCompatUrl('https://gateway.ai.cloudflare.com/v1/acct/gw')).toBe(
      'https://gateway.ai.cloudflare.com/v1/acct/gw/compat'
    );
  });

  it('aiGatewayCompatUrl strips a trailing slash', () => {
    expect(aiGatewayCompatUrl('https://x/v1/acct/gw/')).toBe('https://x/v1/acct/gw/compat');
  });

  it('aiGatewayModelId produces the dynamic/{route} selector', () => {
    expect(aiGatewayModelId('donmerge-text-fallback')).toBe('dynamic/donmerge-text-fallback');
  });

  it('buildAiGatewayOpencodeConfig registers a single aigateway provider with compat baseURL and dynamic model', () => {
    const config = buildAiGatewayOpencodeConfig({
      CF_AI_GATEWAY_URL: 'https://gateway.ai.cloudflare.com/v1/acct/gw',
      CF_AI_GATEWAY_TOKEN: 'cfut_token',
      CF_AI_GATEWAY_ROUTE: 'route-123',
    });
    expect(config.provider).toHaveProperty(AI_GATEWAY_PROVIDER_ID);
    const provider = (config.provider as Record<string, any>)[AI_GATEWAY_PROVIDER_ID];
    expect(provider.options.baseURL).toBe(
      'https://gateway.ai.cloudflare.com/v1/acct/gw/compat'
    );
    expect(provider.options.apiKey).toBe('cfut_token');
    expect(provider.models).toHaveProperty('dynamic/route-123');
  });

  it('resolveDirectFetchBaseURL returns the compat URL when gateway is enabled', () => {
    const env = {
      CF_AI_GATEWAY_URL: 'https://gateway.ai.cloudflare.com/v1/acct/gw',
      CF_AI_GATEWAY_TOKEN: 't',
      CF_AI_GATEWAY_ROUTE: 'r',
    };
    expect(resolveDirectFetchBaseURL('kimi', env)).toBe(
      'https://gateway.ai.cloudflare.com/v1/acct/gw/compat'
    );
    // falls back to provider URL when gateway is off
    expect(resolveDirectFetchBaseURL('kimi', {})).toBe(KIMI_BASE_URL);
  });
});
