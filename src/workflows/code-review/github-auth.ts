/**
 * GitHub App authentication utilities.
 */

import type { WorkerEnv } from './types';
import { base64UrlFromBuffer, pemToArrayBuffer, timingSafeEqual } from './crypto';
import { parseRepoConfigs } from './utils';

/**
 * Resolve a GitHub token from either GitHub App or PAT.
 */
export async function resolveGitHubToken(env: WorkerEnv, installationId?: number): Promise<string> {
  if (env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && installationId) {
    const appJwt = await createGitHubAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
    return createInstallationToken(installationId, appJwt);
  }

  if (env.GITHUB_TOKEN_PAT) {
    return env.GITHUB_TOKEN_PAT;
  }

  throw new Error(
    'Missing GitHub credentials: configure GitHub App (GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY) or GITHUB_TOKEN_PAT'
  );
}

/**
 * Create an installation access token for a GitHub App.
 */
async function createInstallationToken(installationId: number, appJwt: string): Promise<string> {
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${appJwt}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'codex-review-worker',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`GitHub API error ${response.status}: ${errorBody}`);
  }

  const tokenResponse = (await response.json()) as { token: string };
  return tokenResponse.token;
}

/**
 * Create a JWT for GitHub App authentication.
 */
async function createGitHubAppJwt(appId: string, privateKeyPem: string): Promise<string> {
  // Validate inputs
  if (!appId || !privateKeyPem) {
    throw new Error('Missing GitHub App credentials: appId or privateKey is empty');
  }

  // Check if PEM looks valid (basic sanity check)
  if (!privateKeyPem.includes('PRIVATE KEY')) {
    throw new Error(
      'Invalid GitHub App private key: PEM must contain "PRIVATE KEY" header. ' +
        'Ensure you copied the full key including -----BEGIN PRIVATE KEY----- and -----END PRIVATE KEY-----'
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlFromBuffer(
    new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).buffer as ArrayBuffer
  );
  const payload = base64UrlFromBuffer(
    new TextEncoder().encode(
      JSON.stringify({
        iat: now - 60,
        exp: now + 9 * 60,
        iss: appId,
      })
    ).buffer as ArrayBuffer
  );

  const signingInput = `${header}.${payload}`;

  let keyData: ArrayBuffer;
  try {
    keyData = pemToArrayBuffer(privateKeyPem);
  } catch (error) {
    throw new Error(
      `Failed to parse GitHub App private key: ${error instanceof Error ? error.message : 'unknown error'}. ` +
        'Make sure the key is in PEM format (base64 encoded).'
    );
  }

  const key = await crypto.subtle.importKey(
    'pkcs8',
    keyData,
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
    },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${base64UrlFromBuffer(signature)}`;
}

/**
 * Verify a GitHub webhook signature.
 */
export async function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string
): Promise<boolean> {
  if (!header.startsWith('sha256=')) {
    return false;
  }
  const expectedHex = header.slice('sha256='.length);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  const digestHex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return timingSafeEqual(digestHex, expectedHex);
}

/**
 * Check if a repository is in the allowed list.
 */
export function isRepoAllowed(
  owner: string,
  repo: string,
  repoConfigsVar?: string
): boolean {
  if (!repoConfigsVar) {
    // No config - allow all (for local dev)
    return true;
  }

  const repoConfigs = parseRepoConfigs(repoConfigsVar);
  const key = `${owner.toLowerCase()}/${repo.toLowerCase()}`;
  return repoConfigs.has(key);
}
