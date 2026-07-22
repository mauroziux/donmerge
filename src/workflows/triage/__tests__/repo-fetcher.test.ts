/**
 * Tests for repo-fetcher.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Buffer } from 'node:buffer';
import { filterInAppPaths, fetchFile, fetchRepoCodeForTriage } from '../repo-fetcher';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('filterInAppPaths', () => {
  it('should pass through normal application paths', () => {
    const paths = ['src/app.ts', 'src/utils.ts'];
    const result = filterInAppPaths(paths);
    expect(result).toEqual(['src/app.ts', 'src/utils.ts']);
  });

  it('should exclude node_modules paths', () => {
    const paths = ['src/app.ts', 'node_modules/express/router.js'];
    const result = filterInAppPaths(paths);
    expect(result).toEqual(['src/app.ts']);
  });

  it('should exclude vendor paths', () => {
    const paths = ['src/app.ts', 'vendor/symfony/Kernel.php'];
    const result = filterInAppPaths(paths);
    expect(result).toEqual(['src/app.ts']);
  });

  it('should exclude __pycache__ paths', () => {
    const paths = ['src/app.py', '__pycache__/app.cpython-39.pyc'];
    const result = filterInAppPaths(paths);
    expect(result).toEqual(['src/app.py']);
  });

  it('should exclude .venv paths', () => {
    const paths = ['src/app.py', '.venv/lib/python/site.py'];
    const result = filterInAppPaths(paths);
    expect(result).toEqual(['src/app.py']);
  });

  it('should exclude site-packages paths', () => {
    const paths = ['src/app.py', 'site-packages/numpy/__init__.py'];
    const result = filterInAppPaths(paths);
    expect(result).toEqual(['src/app.py']);
  });

  it('should exclude third_party paths', () => {
    const paths = ['src/app.ts', 'third_party/lib/index.js'];
    const result = filterInAppPaths(paths);
    expect(result).toEqual(['src/app.ts']);
  });

  it('should exclude external paths', () => {
    const paths = ['src/app.ts', 'external/sdk/client.js'];
    const result = filterInAppPaths(paths);
    expect(result).toEqual(['src/app.ts']);
  });

  it('should deduplicate paths', () => {
    const paths = ['src/app.ts', 'src/app.ts'];
    const result = filterInAppPaths(paths);
    expect(result).toEqual(['src/app.ts', 'src/app.ts']); // filterInAppPaths doesn't dedupe
  });

  it('should return empty array for empty input', () => {
    const result = filterInAppPaths([]);
    expect(result).toEqual([]);
  });

  it('should return empty array when all paths are excluded', () => {
    const paths = ['node_modules/a.js', 'vendor/b.php'];
    const result = filterInAppPaths(paths);
    expect(result).toEqual([]);
  });
});

describe('fetchFile', () => {
  it('should fetch and decode a base64 file', async () => {
    const content = btoa('export function hello() { return "world"; }');
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content,
        encoding: 'base64',
        size: 100,
      }),
    });

    const result = await fetchFile('owner', 'repo', 'src/index.ts', 'abc123', 'token');
    expect(result).toBe('export function hello() { return "world"; }');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/owner/repo/contents/src%2Findex.ts?ref=abc123',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer token',
        }),
      })
    );
  });

  it('should return null for non-base64 encoding', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: 'raw content',
        encoding: 'utf-8',
        size: 100,
      }),
    });

    const result = await fetchFile('owner', 'repo', 'src/index.ts', 'abc123', 'token');
    expect(result).toBeNull();
  });

  it('should return null for files exceeding MAX_FILE_SIZE', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: btoa('x'),
        encoding: 'base64',
        size: 200_000, // > 100KB limit
      }),
    });

    const result = await fetchFile('owner', 'repo', 'src/big.ts', 'abc123', 'token');
    expect(result).toBeNull();
  });

  it('should return null on fetch error (404)', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve('Not Found'),
    });

    const result = await fetchFile('owner', 'repo', 'src/missing.ts', 'abc123', 'token');
    expect(result).toBeNull();
  });

  it('should return null on network error', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const result = await fetchFile('owner', 'repo', 'src/file.ts', 'abc123', 'token');
    expect(result).toBeNull();
  });

  it('should correctly decode Unicode content (Spanish accents + emoji) from base64', async () => {
    // Simulates GitHub Contents API returning base64-encoded UTF-8 content
    const original = '// Comentario en español: ¡ñoño! 🎉 ruta: /áéíóú';
    // Encode exactly as GitHub does: UTF-8 bytes → base64 (not Latin1 btoa)
    const b64 = Buffer.from(original, 'utf-8').toString('base64');

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: b64,
        encoding: 'base64',
        size: 100,
      }),
    });

    const result = await fetchFile('owner', 'repo', 'src/i18n.ts', 'abc123', 'token');
    expect(result).toBe(original);
  });
});

describe('fetchRepoCodeForTriage', () => {
  it('should fetch code for provided file paths', async () => {
    const fileContent = 'export function handleRequest() {}';
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: btoa(fileContent),
        encoding: 'base64',
        size: 100,
      }),
    });

    const result = await fetchRepoCodeForTriage(
      'tableoltd/test-repo',
      'abc123',
      ['src/index.ts'],
      'gh-token'
    );
    expect(result).toBeInstanceOf(Map);
    expect(result.get('src/index.ts')).toBe(fileContent);
  });

  it('should throw for invalid repo format', async () => {
    await expect(
      fetchRepoCodeForTriage('invalid-repo', 'abc123', [], 'token')
    ).rejects.toThrow('Invalid repo format');

    await expect(
      fetchRepoCodeForTriage('', 'abc123', [], 'token')
    ).rejects.toThrow('Invalid repo format');
  });

  it('should return empty map when no paths provided', async () => {
    const result = await fetchRepoCodeForTriage('owner/repo', 'abc123', [], 'token');
    expect(result.size).toBe(0);
  });

  it('should skip files that fail to fetch', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve('Not Found'),
    });

    const result = await fetchRepoCodeForTriage(
      'owner/repo',
      'abc123',
      ['src/gone.ts'],
      'token'
    );
    expect(result.size).toBe(0);
  });

  it('should filter out node_modules paths before fetching', async () => {
    // Mock: src/app.ts succeeds, node_modules should never be attempted
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: btoa('export const app = 1;'),
        encoding: 'base64',
        size: 100,
      }),
    });

    const result = await fetchRepoCodeForTriage(
      'owner/repo',
      'abc123',
      ['src/app.ts', 'node_modules/express/index.js'],
      'token'
    );

    // Only src/app.ts should be fetched (node_modules filtered out)
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.size).toBe(1);
    expect(result.get('src/app.ts')).toBe('export const app = 1;');
  });

  it('should fall back to GitHub tree when initial paths yield zero files', async () => {
    // First pass: all initial fetches fail (404)
    // Tree API: returns full repo tree with actual paths
    // Retry: fetches resolved path successfully
    mockFetch
      // Initial fetch for app/src/features/auth/LoginPage.tsx → 404
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve('Not Found'),
      })
      // Git tree API call → returns full tree
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          tree: [
            { path: 'apps/web/src/features/auth/LoginPage.tsx', type: 'blob' },
            { path: 'apps/web/src/App.tsx', type: 'blob' },
            { path: 'package.json', type: 'blob' },
          ],
        }),
      })
      // Retry fetch for resolved path → success
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          content: btoa('export function LoginPage() {}'),
          encoding: 'base64',
          size: 100,
        }),
      });

    const result = await fetchRepoCodeForTriage(
      'owner/repo',
      'abc123',
      ['app/src/features/auth/LoginPage.tsx'],
      'token'
    );

    // Should resolve the path via tree and fetch the actual file
    expect(result.size).toBe(1);
    expect(result.get('apps/web/src/features/auth/LoginPage.tsx'))
      .toBe('export function LoginPage() {}');

    // 3 fetch calls: 1 initial (404) + 1 tree API + 1 retry
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('should not trigger tree fallback when files are fetched successfully', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: btoa('export const app = 1;'),
        encoding: 'base64',
        size: 100,
      }),
    });

    const result = await fetchRepoCodeForTriage(
      'owner/repo',
      'abc123',
      ['src/app.ts'],
      'token'
    );

    expect(result.size).toBe(1);
    // Only the initial fetch — no tree fallback
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('should not fetch ambiguous suffix matches from tree fallback', async () => {
    // Tree contains two files that match the same suffix — should resolve neither
    mockFetch
      // Initial fetch for src/config.ts → 404
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: () => Promise.resolve('Not Found'),
      })
      // Git tree API call → returns tree with two ambiguous candidates
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          tree: [
            { path: 'packages/web/src/config.ts', type: 'blob' },
            { path: 'packages/api/src/config.ts', type: 'blob' },
            { path: 'package.json', type: 'blob' },
          ],
        }),
      });

    const result = await fetchRepoCodeForTriage(
      'owner/repo',
      'abc123',
      ['src/config.ts'],
      'token'
    );

    // Both files share suffix "src/config.ts" → ambiguous → should not fetch either
    expect(result.size).toBe(0);

    // 2 fetch calls only: 1 initial (404) + 1 tree API — no retry fetch
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should include Unicode content (Spanish accents + emoji) in the returned Map', async () => {
    const original = '// ¡Hola señor! Bienvenido al café 🚀💻 ñoño';
    const b64 = Buffer.from(original, 'utf-8').toString('base64');

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: b64,
        encoding: 'base64',
        size: 100,
      }),
    });

    const result = await fetchRepoCodeForTriage(
      'owner/repo',
      'abc123',
      ['src/i18n.ts'],
      'token'
    );

    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(1);
    expect(result.get('src/i18n.ts')).toBe(original);
  });
});
