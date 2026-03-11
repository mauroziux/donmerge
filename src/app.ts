import { FlueWorker } from '@flue/cloudflare/worker';
import { processGitHubCodeReviewWebhook } from './workflows/code-review';
import type { WorkerEnv } from './workflows/code-review';

const app = new FlueWorker<WorkerEnv>();

app.get('/health', (c) => {
  return c.json({ ok: true, service: 'codex-review-webhook' });
});

app.post('/webhook/github', async (c) => {
  const signature = c.req.header('x-hub-signature-256') ?? '';
  const event = c.req.header('x-github-event') ?? '';
  const rawBody = await c.req.text();

  const result = await processGitHubCodeReviewWebhook(c.env, event, signature, rawBody);
  return c.json(result.body, result.status);
});

export { Sandbox } from '@cloudflare/sandbox';
export default app;
