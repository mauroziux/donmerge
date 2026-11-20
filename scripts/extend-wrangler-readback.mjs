import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Temporary workaround for https://github.com/cloudflare/workers-sdk/issues/16717.
// Restrict it to the exact pinned Wrangler bundle; a dependency upgrade must
// deliberately re-evaluate or remove this patch instead of silently changing it.
const expectedVersion = '4.105.0';
const expectedSha256 = '8641bcc9571c41b63b3ad2bbdd7d3c52cafc125cf8d5d86b14ae3bad4fcb1889';
const original = `async function fetchUploadedVersion(config2, accountId, scriptName, versionId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await fetchVersion2(config2, accountId, scriptName, versionId);
    } catch (error53) {
      if (!(error53 instanceof APIError) || error53.code !== 100146 || attempt === 4) {
        throw error53;
      }
      await timersPromises.setTimeout(500);
    }
  }
  throw new Error("Unable to fetch uploaded Worker version");
}`;
const replacement = `async function fetchUploadedVersion(config2, accountId, scriptName, versionId) {
  const delays = [500, 500, 500, 500, 10000, 20000, 30000];
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return await fetchVersion2(config2, accountId, scriptName, versionId);
    } catch (error53) {
      if (!(error53 instanceof APIError) || error53.code !== 100146 || attempt === 7) {
        throw error53;
      }
      await timersPromises.setTimeout(delays[attempt]);
    }
  }
  throw new Error("Unable to fetch uploaded Worker version");
}`;

export function extendReadbackRetry(source, version) {
  const digest = createHash('sha256').update(source).digest('hex');
  if (version !== expectedVersion || digest !== expectedSha256) {
    throw new Error('Unexpected Wrangler bundle; review the temporary readback workaround before deploying.');
  }
  if (source.split(original).length !== 2) {
    throw new Error('Expected Wrangler readback function was not uniquely found.');
  }
  return source.replace(original, replacement);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const require = createRequire(import.meta.url);
    const packageFile = require.resolve('wrangler/package.json');
    const packageJson = JSON.parse(readFileSync(packageFile, 'utf8'));
    const cliFile = join(dirname(packageFile), 'wrangler-dist', 'cli.js');
    const patched = extendReadbackRetry(readFileSync(cliFile, 'utf8'), packageJson.version);
    writeFileSync(cliFile, patched);
    console.log('Extended the bounded Wrangler 100146 readback retry window.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Unable to prepare Wrangler readback workaround.');
    process.exitCode = 1;
  }
}
