import { FlueWorker } from '@flue/cloudflare/worker';
import { validateWebhookFast } from './workflows/code-review';
import type { WorkerEnv, WebhookContext } from './workflows/code-review';
import { ReviewProcessor } from './workflows/code-review/processor';
import { CodeReviewWorkflow } from './workflows/code-review/code-review-workflow';
import { TriageProcessor } from './workflows/triage/processor';
import { handlePushReview, handleTriage, handleJobStatus } from './api/routes';
import { RateLimiter } from './api/rate-limit';
import { handleSentryWebhook } from './webhooks/sentry';
import { handleCodeReviewQueue } from './queues/code-review-consumer';

// Extended env type that includes all DO bindings
interface AppEnv extends WorkerEnv {
  ReviewProcessor: DurableObjectNamespace;
  TriageProcessor: DurableObjectNamespace;
  RateLimiter: DurableObjectNamespace;
  DONMERGE_API_KEYS?: string;
  SENTRY_WEBHOOK_SECRET?: string;
  SENTRY_REPO_MAP?: string;
  SENTRY_GITHUB_TOKEN?: string;
  CODE_REVIEW_WORKFLOW?: Workflow;
  CODE_REVIEW_QUEUE: Queue<WebhookContext>;
  // Multi-tenant D1 database (Phase 1)
  DB?: D1Database;
  TENANT_ENCRYPTION_KEY?: string;
}

const app = new FlueWorker<AppEnv>();

app.get('/health', (c) => {
  return c.json({ ok: true, service: 'codex-review-webhook' });
});

app.post('/webhook/github', async (c) => {
  const signature = c.req.header('x-hub-signature-256') ?? '';
  const event = c.req.header('x-github-event') ?? '';
  const rawBody = await c.req.text();

  // Fast validation (signature, repo allowlist, trigger check)
  const validation = await validateWebhookFast(c.env, event, signature, rawBody);

  // If validation fails or event should be skipped, respond immediately
  if (!validation.shouldProcess) {
    return c.json(validation.body, validation.status);
  }

  // Enqueue to the code-review queue. The consumer (handleCodeReviewQueue)
  // runs the pipeline with a 15-minute wall-clock budget — vs the 30s
  // waitUntil cap that was cancelling Workflow.create() mid-flight.
  await c.env.CODE_REVIEW_QUEUE.send(validation.context!);

  // Return 202 Accepted immediately
  return c.json(
    {
      ok: true,
      accepted: true,
      message: 'Review queued for processing',
      prNumber: validation.context?.prNumber,
    },
    202
  );
});

// Push API routes
app.post('/api/v1/review', handlePushReview);
app.post('/api/v1/triage', handleTriage);
app.get('/api/v1/status/*', handleJobStatus);

// Debug: probe each configured LLM provider from inside a real sandbox.
// Auth-gated. Used to diagnose provider/gateway outages (see rms#4002 incident).
app.post('/api/v1/debug/providers', async (c) => {
  const key = (c.req.header('Authorization') ?? '').replace('Bearer ', '');
  const valid = (c.env.DONMERGE_API_KEYS ?? '').split(',').map((k: string) => k.trim()).includes(key);
  if (!valid) return c.json({ error: 'Unauthorized' }, 401);
  const { getSandbox } = await import('@cloudflare/sandbox');
  const sandbox = getSandbox((c.env as any).Sandbox, `egress-debug-${Date.now()}`, { sleepAfter: '1m' });
  try {
    const t = (cmd: string) => sandbox.exec(cmd, { timeout: 60_000 });
    await sandbox.setEnvVars({
      OPENAI_API_KEY: (c.env as any).OPENAI_API_KEY ?? '',
      GLM_API_KEY: (c.env as any).GLM_API_KEY ?? '',
      KIMI_API_KEY: (c.env as any).KIMI_API_KEY ?? '',
      CF_AI_GATEWAY_URL: (c.env as any).CF_AI_GATEWAY_URL ?? '',
      CF_AI_GATEWAY_TOKEN: (c.env as any).CF_AI_GATEWAY_TOKEN ?? '',
      CF_AI_GATEWAY_ROUTE: (c.env as any).CF_AI_GATEWAY_ROUTE ?? '',
    });
    const tiny = (url: string, auth: string, model: string) =>
      t(`curl -s -m 25 -o /tmp/r.json -w '%{http_code} %{time_total}s' ${url} -H "Authorization: Bearer ${auth}" -H 'Content-Type: application/json' -d '{"model":"${model}","messages":[{"role":"user","content":"say OK"}],"max_tokens":5}'; head -c 150 /tmp/r.json`);
    const fmt = (p: PromiseSettledResult<any>) =>
      p.status === 'fulfilled' ? { stdout: (p.value?.stdout ?? '').trim().slice(0, 300), exitCode: p.value?.exitCode } : { rejected: String(p.reason).slice(0, 200) };
    const [kimi, glm, openai, gateway] = await Promise.allSettled([
      tiny('https://api.kimi.com/coding/v1/chat/completions', '$KIMI_API_KEY', 'k3'),
      tiny('https://open.bigmodel.cn/api/coding/paas/v4/chat/completions', '$GLM_API_KEY', 'glm-4.7'),
      tiny('https://api.openai.com/v1/chat/completions', '$OPENAI_API_KEY', 'gpt-4o'),
      t(`curl -s -m 30 -o /tmp/g.json -w '%{http_code} %{time_total}s' "$CF_AI_GATEWAY_URL/compat/chat/completions" -H "Authorization: Bearer $CF_AI_GATEWAY_TOKEN" -H 'Content-Type: application/json' -d "{\"model\":\"dynamic/$CF_AI_GATEWAY_ROUTE\",\"messages\":[{\"role\":\"user\",\"content\":\"say OK\"}],\"max_tokens\":5}"; head -c 200 /tmp/g.json`),
    ]);
    return c.json({ kimi: fmt(kimi), glm: fmt(glm), openai: fmt(openai), gateway: fmt(gateway) });
  } finally {
    await (sandbox.destroy?.() ?? Promise.resolve());
  }
});

// Sentry webhook — receives Sentry event_alert webhooks directly
app.post('/webhook/sentry', handleSentryWebhook);

// Export Durable Objects
export { Sandbox } from '@cloudflare/sandbox';
export { ReviewProcessor };
export { CodeReviewWorkflow };
export { TriageProcessor };
export { RateLimiter };

// Worker entrypoint: Hono fetch + Queue consumer.
// FlueWorker extends Hono so app.fetch is the standard Worker fetch handler;
// binding it preserves `this` for route lookup.
export default {
  fetch: app.fetch.bind(app),
  queue: handleCodeReviewQueue,
};
