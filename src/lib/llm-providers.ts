/**
 * LLM provider configuration shared across DonMerge workflows.
 *
 * Primary model: Kimi K3 (via Kimi Code, an OpenAI-compatible endpoint).
 * Fallback:      OpenAI gpt-4o.
 *
 * Kimi Code is fully OpenAI-compatible (same /chat/completions request/response
 * shape), so it is wired through two surfaces:
 *
 *   - Flue / OpenCode sandbox (code review + triage prompt): registered as a
 *     custom "kimi" provider via `opencodeConfig` with a custom `baseURL`.
 *   - Direct fetch (triage auto-fix agent): `callOpenAI()` with a configurable
 *     `baseURL` and provider-specific API key.
 *
 * The provider routing is driven by the `CODEX_MODEL` env var
 * ("provider/model", e.g. "kimi/k3") parsed by `parseModelConfig()`.
 */

/** Kimi Code (managed coding service) base URL. OpenAI-compatible. */
export const KIMI_BASE_URL = 'https://api.kimi.com/coding/v1';

/** Zhipu GLM Coding Plan base URL. OpenAI-compatible. */
export const GLM_BASE_URL = 'https://open.bigmodel.cn/api/coding/paas/v4';

/** OpenAI public API base URL. */
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

/** Default primary model (provider/model format consumed by parseModelConfig). */
export const DEFAULT_PRIMARY_MODEL = 'kimi/k3';

/** Default fallback model, used when the primary provider fails. */
export const DEFAULT_FALLBACK_MODEL = 'openai/gpt-4o';

export interface ModelConfig {
  providerID: string;
  modelID: string;
}

/** Provider identifiers with special handling. */
export type KnownProvider = 'kimi' | 'moonshot' | 'glm' | 'zhipu' | 'openai' | 'anthropic';

/**
 * Returns true when a provider speaks the OpenAI Chat Completions protocol
 * (same /chat/completions request/response shape). Kimi and OpenAI do;
 * Anthropic does not (handled by a dedicated code path).
 */
export function isOpenAICompatibleProvider(providerID: string): boolean {
  const id = providerID.toLowerCase();
  return id === 'openai' || id === 'kimi' || id === 'moonshot' || id === 'glm' || id === 'zhipu';
}

/**
 * Resolve the OpenAI-compatible baseURL for a provider.
 * Used by the direct-fetch LLM client (triage auto-fix).
 */
export function resolveOpenAIBaseURL(providerID: string): string {
  const id = providerID.toLowerCase();
  if (id === 'kimi' || id === 'moonshot') {
    return KIMI_BASE_URL;
  }
  if (id === 'glm' || id === 'zhipu') {
    return GLM_BASE_URL;
  }
  // 'openai' and any unknown OpenAI-compatible provider (proxies, gateways)
  return OPENAI_BASE_URL;
}

/**
 * Build a single OpenCode provider config entry for Kimi K3.
 *
 * Kimi Code is OpenAI-compatible, so we register it under the
 * `@ai-sdk/openai-compatible` package with a custom `baseURL`. OpenCode routes
 * model IDs like "kimi/k3" to this provider by matching the provider key
 * ("kimi") to the configured provider.
 */
export function buildKimiProviderConfig(apiKey: string): Record<string, unknown> {
  return {
    npm: '@ai-sdk/openai-compatible',
    name: 'Kimi K3',
    options: {
      baseURL: KIMI_BASE_URL,
      apiKey,
    },
    models: {
      k3: {
        name: 'Kimi K3',
      },
    },
  };
}

/**
 * Build a single OpenCode provider config entry for GLM 5.2.
 */
export function buildGlmProviderConfig(apiKey: string): Record<string, unknown> {
  return {
    npm: '@ai-sdk/openai-compatible',
    name: 'GLM 5.2',
    options: {
      baseURL: GLM_BASE_URL,
      apiKey,
    },
    models: {
      '5.2': {
        name: 'GLM 5.2',
      },
    },
  };
}

/**
 * Build a full `opencodeConfig` object for the Flue sandbox, registering the
 * Kimi and GLM providers so OpenCode can route model IDs like "kimi/k3" or "glm/5.2".
 */
export function buildOpencodeConfig(
  kimiApiKey?: string,
  glmApiKey?: string
): { provider: Record<string, unknown> } {
  const providers: Record<string, unknown> = {};
  if (kimiApiKey && kimiApiKey.trim()) {
    providers.kimi = buildKimiProviderConfig(kimiApiKey);
  }
  if (glmApiKey && glmApiKey.trim()) {
    providers.glm = buildGlmProviderConfig(glmApiKey);
  }
  return { provider: providers };
}

/**
 * Resolve the fallback model config from env, defaulting to OpenAI gpt-4o.
 */
export function resolveFallbackModel(envFallback?: string): ModelConfig {
  const raw = (envFallback ?? DEFAULT_FALLBACK_MODEL).trim();
  if (!raw.includes('/')) {
    return { providerID: 'openai', modelID: raw };
  }
  const [providerID, ...rest] = raw.split('/');
  const modelID = rest.join('/').trim();
  if (!providerID.trim() || !modelID) {
    return { providerID: 'openai', modelID: 'gpt-4o' };
  }
  return { providerID: providerID.trim(), modelID };
}

/**
 * Select the API key for a provider from the available env-provided keys.
 * Used by the direct-fetch LLM client.
 */
export function selectApiKey(
  providerID: string,
  keys: { openai?: string; kimi?: string; glm?: string; anthropic?: string }
): string | undefined {
  const id = providerID.toLowerCase();
  if (id === 'kimi' || id === 'moonshot') {
    return keys.kimi ?? keys.openai;
  }
  if (id === 'glm' || id === 'zhipu') {
    return keys.glm ?? keys.openai;
  }
  if (id === 'anthropic') {
    return keys.anthropic ?? keys.openai;
  }
  // 'openai' and unknown OpenAI-compatible providers use the OpenAI key
  return keys.openai;
}
