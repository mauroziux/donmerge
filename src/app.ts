import { FlueWorker } from '@flue/cloudflare/worker';
import { processGitHubCodeReviewWebhook, validateWebhookFast } from './workflows/code-review';
import type { WorkerEnv } from './workflows/code-review';

const app = new FlueWorker<WorkerEnv>();

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

  // Respond immediately to GitHub (within 10s timeout)
  // Process the review in background using waitUntil
  c.executionCtx.waitUntil(
    processGitHubCodeReviewWebhook(c.env, validation.context!)
  );

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

export { Sandbox } from '@cloudflare/sandbox';
export default app;
