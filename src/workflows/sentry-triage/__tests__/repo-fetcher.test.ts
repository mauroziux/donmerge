/**
 * Tests for repo-fetcher.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractInAppPaths, fetchFile, fetchRepoCodeForTriage } from '../repo-fetcher';
import { createSentryEvent } from './helpers';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('extractInAppPaths', () => {
  it('should extract in-app filenames from events', () => {
    const events = [
      createSentryEvent({
        exceptions: [
          {
            type: 'TypeError',
            value: 'test',
            stacktrace: {
              frames: [
                { filename: 'src/app.ts', function: 'main', lineno: 1, colno: 0, absPath: '/app/src/app.ts', inApp: true },
                { filename: 'src/utils.ts', function: 'helper', lineno: 5, colno: 2, absPath: '/app/src/utils.ts', inApp: true },
              ],
            },
          },
        ],
      }),
    ];

    const paths = extractInAppPaths(events);
    expect(paths).toEqual(expect.arrayContaining(['src/app.ts', 'src/utils.ts']));
    expect(paths).toHaveLength(2);
  });

  it('should exclude non-in-app frames', () => {
    const events = [
      createSentryEvent({
        exceptions: [
          {
            type: 'TypeError',
            value: 'test',
            stacktrace: {
              frames: [
                { filename: 'src/app.ts', function: 'main', lineno: 1, colno: 0, absPath: '/app/src/app.ts', inApp: true },
                { filename: 'node_modules/lib/index.js', function: 'external', lineno: 10, colno: 0, absPath: '/app/node_modules/lib/index.js', inApp: false },
              ],
            },
          },
        ],
      }),
    ];

    const paths = extractInAppPaths(events);
    expect(paths).toEqual(['src/app.ts']);
  });

  it('should exclude node_modules paths', () => {
    const events = [
      createSentryEvent({
        exceptions: [
          {
            type: 'Error',
            value: 'test',
            stacktrace: {
              frames: [
                { filename: 'node_modules/express/router.js', function: 'handle', lineno: 1, colno: 0, absPath: '/app/node_modules/express/router.js', inApp: true },
              ],
            },
          },
        ],
      }),
    ];

    const paths = extractInAppPaths(events);
    expect(paths).toEqual([]);
  });

  it('should exclude vendor paths', () => {
    const events = [
      createSentryEvent({
        exceptions: [
          {
            type: 'Error',
            value: 'test',
            stacktrace: {
              frames: [
                { filename: 'vendor/symfony/Kernel.php', function: 'handle', lineno: 1, colno: 0, absPath: '/app/vendor/symfony/Kernel.php', inApp: true },
              ],
            },
          },
        ],
      }),
    ];

    const paths = extractInAppPaths(events);
    expect(paths).toEqual([]);
  });

  it('should exclude __pycache__ paths', () => {
    const events = [
      createSentryEvent({
        exceptions: [
          {
            type: 'Error',
            value: 'test',
            stacktrace: {
              frames: [
                { filename: '__pycache__/app.cpython-39.pyc', function: 'run', lineno: 1, colno: 0, absPath: '/app/__pycache__/app.cpython-39.pyc', inApp: true },
              ],
            },
          },
        ],
      }),
    ];

    const paths = extractInAppPaths(events);
    expect(paths).toEqual([]);
  });

  it('should deduplicate paths across events', () => {
    const events = [
      createSentryEvent({
        exceptions: [
          {
            type: 'Error',
            value: 'test',
            stacktrace: {
              frames: [
                { filename: 'src/app.ts', function: 'main', lineno: 1, colno: 0, absPath: '/app/src/app.ts', inApp: true },
              ],
            },
          },
        ],
      }),
      createSentryEvent({
        exceptions: [
          {
            type: 'Error',
            value: 'test',
            stacktrace: {
              frames: [
                { filename: 'src/app.ts', function: 'main', lineno: 1, colno: 0, absPath: '/app/src/app.ts', inApp: true },
              ],
            },
          },
        ],
      }),
    ];

    const paths = extractInAppPaths(events);
    expect(paths).toEqual(['src/app.ts']);
  });

  it('should return empty array for events without exceptions', () => {
    const events = [createSentryEvent({ exceptions: undefined })];
    const paths = extractInAppPaths(events);
    expect(paths).toEqual([]);
  });

  it('should return empty array for empty events array', () => {
    const paths = extractInAppPaths([]);
    expect(paths).toEqual([]);
  });

  it('should skip frames without filename', () => {
    const events = [
      createSentryEvent({
        exceptions: [
          {
            type: 'Error',
            value: 'test',
            stacktrace: {
              frames: [
                { filename: '', function: 'anonymous', lineno: 1, colno: 0, absPath: '', inApp: true },
              ],
            },
          },
        ],
      }),
    ];

    const paths = extractInAppPaths(events);
    // Empty filename is falsy, so it should be excluded
    expect(paths).toEqual([]);
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
  it('should fetch code for in-app paths from events', async () => {
    const fileContent = 'export function handleRequest() {}';
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: btoa(fileContent),
        encoding: 'base64',
        size: 100,
      }),
    });

    const events = [
      createSentryEvent({
        exceptions: [
          {
            type: 'TypeError',
            value: 'test',
            stacktrace: {
              frames: [
                { filename: 'src/index.ts', function: 'main', lineno: 1, colno: 0, absPath: '/app/src/index.ts', inApp: true },
              ],
            },
          },
        ],
      }),
    ];

    const result = await fetchRepoCodeForTriage('tableoltd/test-repo', 'abc123', events, 'gh-token');
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

  it('should return empty map when no events have in-app paths', async () => {
    const result = await fetchRepoCodeForTriage('owner/repo', 'abc123', [], 'token');
    expect(result.size).toBe(0);
  });

  it('should skip files that fail to fetch', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve('Not Found'),
    });

    const events = [
      createSentryEvent({
        exceptions: [
          {
            type: 'Error',
            value: 'test',
            stacktrace: {
              frames: [
                { filename: 'src/gone.ts', function: 'main', lineno: 1, colno: 0, absPath: '/app/src/gone.ts', inApp: true },
              ],
            },
          },
        ],
      }),
    ];

    const result = await fetchRepoCodeForTriage('owner/repo', 'abc123', events, 'token');
    expect(result.size).toBe(0);
  });
});
