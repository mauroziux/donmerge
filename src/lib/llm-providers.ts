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

// ── Cloudflare AI Gateway (infra-layer fallback) ────────────────────────────
//
// When CF_AI_GATEWAY_URL + CF_AI_GATEWAY_TOKEN + CF_AI_GATEWAY_ROUTE are set,
// ALL LLM traffic routes through a single AI Gateway route. The gateway's
// routing config owns the fallback chain (e.g. DeepSeek -> GLM -> Llama) and
// retries/caching, so DonMerge registers ONE provider and skips its app-layer
// fallback. This collapses KIMI/GLM/OPENAI keys into one CF token.

/** Provider + model IDs used when the AI Gateway is enabled. */
export const AI_GATEWAY_PROVIDER_ID = 'aigateway';
export const AI_GATEWAY_MODEL_ID = 'donmerge-text';

export interface AiGatewayEnv {
  CF_AI_GATEWAY_URL?: string;
  CF_AI_GATEWAY_TOKEN?: string;
  CF_AI_GATEWAY_ROUTE?: string;
}

/** True iff the AI Gateway env vars are configured (gateway mode active). */
export function aiGatewayEnabled(env: AiGatewayEnv): boolean {
  return Boolean(
    env.CF_AI_GATEWAY_URL && env.CF_AI_GATEWAY_TOKEN && env.CF_AI_GATEWAY_ROUTE
  );
}

/** Full OpenAI-compatible endpoint for a gateway route. */
export function aiGatewayRouteUrl(gatewayUrl: string, routeId: string): string {
  const base = gatewayUrl.replace(/\/$/, '');
  return `${base}/route/${routeId}`;
}

/**
 * Build an OpenCode provider entry that routes through a CF AI Gateway route.
 * The gateway authenticates with the CF token (sent as the API key) and applies
 * its routing config (fallback chain, retries, caching). The model field sent
 * by OpenCode is nominal — the route decides which upstream provider handles it.
 */
export function buildAiGatewayProviderConfig(
  token: string,
  routeUrl: string
): Record<string, unknown> {
  return {
    npm: '@ai-sdk/openai-compatible',
    name: 'CF AI Gateway',
    options: {
      baseURL: routeUrl,
      apiKey: token,
    },
    models: {
      [AI_GATEWAY_MODEL_ID]: {
        name: 'DonMerge Text (gateway-routed fallback chain)',
      },
    },
  };
}

/**
 * Build the opencodeConfig for gateway mode: a single `aigateway` provider.
 * Replaces the per-provider kimi/glm config when the gateway is enabled.
 */
export function buildAiGatewayOpencodeConfig(env: AiGatewayEnv): {
  provider: Record<string, unknown>;
} {
  const routeUrl = aiGatewayRouteUrl(env.CF_AI_GATEWAY_URL!, env.CF_AI_GATEWAY_ROUTE!);
  return {
    provider: {
      [AI_GATEWAY_PROVIDER_ID]: buildAiGatewayProviderConfig(env.CF_AI_GATEWAY_TOKEN!, routeUrl),
    },
  };
}

/**
 * Resolve the base URL for the direct-fetch LLM client (triage auto-fix).
 * Returns the gateway route URL when gateway mode is on, else the provider URL.
 */
export function resolveDirectFetchBaseURL(
  providerID: string,
  env: AiGatewayEnv
): string {
  if (aiGatewayEnabled(env)) {
    return aiGatewayRouteUrl(env.CF_AI_GATEWAY_URL!, env.CF_AI_GATEWAY_ROUTE!);
  }
  return resolveOpenAIBaseURL(providerID);
}

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
