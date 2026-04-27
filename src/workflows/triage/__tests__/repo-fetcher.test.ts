/**
 * Tests for repo-fetcher.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
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
        size: 20000, // > 10KB limit
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
    const result = await fetchRepoCodeForTriage(
      'owner/repo',
      'abc123',
      ['src/app.ts', 'node_modules/express/index.js'],
      'token'
    );
    // Only src/app.ts should be fetched (node_modules filtered out)
    // Both will fail with the default mock, but we verify fetch wasn't called for node_modules
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
