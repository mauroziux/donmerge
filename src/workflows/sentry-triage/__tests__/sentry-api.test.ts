/**
 * Tests for sentry-api.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  sentryFetch,
  fetchSentryIssue,
  fetchSentryEvents,
  fetchFullSentryIssue,
  transformEvent,
} from '../sentry-api';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sentryFetch', () => {
  it('should make GET request with Bearer auth header', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: '123' }),
    });

    const result = await sentryFetch<{ id: string }>('/api/0/test', 'my-token');

    expect(mockFetch).toHaveBeenCalledWith('https://sentry.io/api/0/test', {
      method: 'GET',
      headers: {
        Authorization: 'Bearer my-token',
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });
    expect(result).toEqual({ id: '123' });
  });

  it('should use full URL when path starts with http', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    await sentryFetch('https://custom.sentry.io/api/test', 'token');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://custom.sentry.io/api/test',
      expect.anything()
    );
  });

  it('should throw on non-ok response with status and body', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      text: () => Promise.resolve('Forbidden'),
    });

    await expect(sentryFetch('/api/0/test', 'bad-token')).rejects.toThrow(
      'Sentry API error 403: Forbidden'
    );
  });

  it('should throw on 404 response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve('Not Found'),
    });

    await expect(sentryFetch('/api/0/test', 'token')).rejects.toThrow(
      'Sentry API error 404: Not Found'
    );
  });
});

describe('fetchSentryIssue', () => {
  it('should fetch issue from correct URL', async () => {
    const issueData = {
      id: '12345',
      title: 'Test Error',
      shortId: 'PROJ-1',
    };
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(issueData),
    });

    const result = await fetchSentryIssue('acme', '12345', 'token');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://sentry.io/api/0/organizations/acme/issues/12345/',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer token',
        }),
      })
    );
    expect(result).toEqual(issueData);
  });
});

describe('fetchSentryEvents', () => {
  it('should fetch events with correct URL and default maxEvents', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });

    await fetchSentryEvents('acme', '12345', 'token');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://sentry.io/api/0/organizations/acme/issues/12345/events/?full=true&per_page=3',
      expect.anything()
    );
  });

  it('should fetch events with custom maxEvents', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });

    await fetchSentryEvents('acme', '12345', 'token', 10);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://sentry.io/api/0/organizations/acme/issues/12345/events/?full=true&per_page=10',
      expect.anything()
    );
  });

  it('should transform raw events using transformEvent', async () => {
    const rawEvents = [
      {
        id: 'evt-1',
        timestamp: '2025-01-01T00:00:00Z',
        entries: [
          {
            type: 'exception',
            data: {
              values: [
                {
                  type: 'TypeError',
                  value: 'test error',
                  stacktrace: {
                    frames: [
                      {
                        filename: 'src/app.ts',
                        function: 'main',
                        lineno: 10,
                        colno: 5,
                        absPath: '/app/src/app.ts',
                        inApp: true,
                      },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    ];
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(rawEvents),
    });

    const result = await fetchSentryEvents('acme', '12345', 'token');

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('evt-1');
    expect(result[0].exceptions).toHaveLength(1);
    expect(result[0].exceptions![0].type).toBe('TypeError');
  });
});

describe('fetchFullSentryIssue', () => {
  it('should parse URL, fetch issue, and fetch events', async () => {
    const issueData = {
      id: '12345',
      shortId: 'PROJ-1',
      title: 'Test Error',
      project: { slug: 'test', id: '1' },
      firstSeen: '2025-01-01T00:00:00Z',
      lastSeen: '2025-01-02T00:00:00Z',
      count: '10',
      userCount: 5,
      platform: 'javascript',
      environment: 'production',
      tags: [],
    };

    // First call: fetchSentryIssue
    // Second call: fetchSentryEvents
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(issueData) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) });

    const result = await fetchFullSentryIssue(
      'https://sentry.io/organizations/acme/issues/12345/',
      'token'
    );

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.id).toBe('12345');
    expect(result.events).toEqual([]);
  });

  it('should use subdomain URL format', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: '99', title: 'Error', tags: [] }),
      })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([]) });

    await fetchFullSentryIssue('https://acme.sentry.io/issues/99/', 'token');

    // First call should be to the issues endpoint
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      'https://sentry.io/api/0/organizations/acme/issues/99/',
      expect.anything()
    );
  });
});

describe('transformEvent', () => {
  it('should extract id and timestamp', () => {
    const result = transformEvent({ id: 'evt-42', timestamp: '2025-01-01T00:00:00Z' });
    expect(result.id).toBe('evt-42');
    expect(result.timestamp).toBe('2025-01-01T00:00:00Z');
  });

  it('should default id and timestamp to empty strings', () => {
    const result = transformEvent({});
    expect(result.id).toBe('');
    expect(result.timestamp).toBe('');
  });

  it('should extract exceptions from entries', () => {
    const raw = {
      id: 'evt-1',
      timestamp: '2025-01-01T00:00:00Z',
      entries: [
        {
          type: 'exception',
          data: {
            values: [
              {
                type: 'TypeError',
                value: 'Cannot read property',
                stacktrace: {
                  frames: [
                    {
                      filename: 'src/app.ts',
                      function: 'main',
                      lineno: 10,
                      colno: 5,
                      absPath: '/app/src/app.ts',
                      inApp: true,
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    };

    const result = transformEvent(raw);
    expect(result.exceptions).toHaveLength(1);
    expect(result.exceptions![0].type).toBe('TypeError');
    expect(result.exceptions![0].value).toBe('Cannot read property');
    expect(result.exceptions![0].stacktrace.frames).toHaveLength(1);
    expect(result.exceptions![0].stacktrace.frames[0].filename).toBe('src/app.ts');
    expect(result.exceptions![0].stacktrace.frames[0].inApp).toBe(true);
  });

  it('should default missing exception fields', () => {
    const raw = {
      id: 'evt-1',
      entries: [
        {
          type: 'exception',
          data: {
            values: [
              {
                stacktrace: {
                  frames: [{}],
                },
              },
            ],
          },
        },
      ],
    };

    const result = transformEvent(raw);
    expect(result.exceptions![0].type).toBe('Unknown');
    expect(result.exceptions![0].value).toBe('');
    const frame = result.exceptions![0].stacktrace.frames[0];
    expect(frame.filename).toBe('');
    expect(frame.function).toBe('');
    expect(frame.lineno).toBe(0);
    expect(frame.colno).toBe(0);
    expect(frame.inApp).toBe(false);
  });

  it('should extract breadcrumbs from entries', () => {
    const raw = {
      id: 'evt-1',
      entries: [
        {
          type: 'breadcrumbs',
          data: [
            { timestamp: '2025-01-01T00:00:00Z', category: 'nav', message: 'click', type: 'ui' },
            { timestamp: '2025-01-01T00:01:00Z', category: 'fetch', message: 'GET /api', type: 'http' },
          ],
        },
      ],
    };

    const result = transformEvent(raw);
    expect(result.breadcrumbs).toHaveLength(2);
    expect(result.breadcrumbs![0].category).toBe('nav');
    expect(result.breadcrumbs![1].message).toBe('GET /api');
  });

  it('should filter breadcrumbs without messages', () => {
    const raw = {
      id: 'evt-1',
      entries: [
        {
          type: 'breadcrumbs',
          data: [
            { timestamp: '2025-01-01T00:00:00Z', category: 'nav', message: 'click', type: 'ui' },
            { timestamp: '2025-01-01T00:01:00Z', category: 'fetch', message: '', type: 'http' },
          ],
        },
      ],
    };

    const result = transformEvent(raw);
    expect(result.breadcrumbs).toHaveLength(1);
  });

  it('should extract request data', () => {
    const raw = {
      id: 'evt-1',
      request: {
        url: 'https://example.com/api',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      },
    };

    const result = transformEvent(raw);
    expect(result.request).toEqual({
      url: 'https://example.com/api',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
  });

  it('should extract contexts', () => {
    const raw = {
      id: 'evt-1',
      contexts: { browser: { name: 'Chrome' } },
    };

    const result = transformEvent(raw);
    expect(result.contexts).toEqual({ browser: { name: 'Chrome' } });
  });

  it('should extract extra data', () => {
    const raw = {
      id: 'evt-1',
      extra: { userId: 42 },
    };

    const result = transformEvent(raw);
    expect(result.extra).toEqual({ userId: 42 });
  });

  it('should extract tags', () => {
    const raw = {
      id: 'evt-1',
      tags: [['browser', 'Chrome']],
    };

    const result = transformEvent(raw);
    expect(result.tags).toEqual([['browser', 'Chrome']]);
  });

  it('should handle empty entries array', () => {
    const raw = { id: 'evt-1', entries: [] };
    const result = transformEvent(raw);
    expect(result.exceptions).toBeUndefined();
    expect(result.breadcrumbs).toBeUndefined();
  });

  it('should handle missing entries', () => {
    const raw = { id: 'evt-1' };
    const result = transformEvent(raw);
    expect(result.exceptions).toBeUndefined();
  });

  it('should handle non-array tags', () => {
    const raw = { id: 'evt-1', tags: 'not-an-array' };
    const result = transformEvent(raw);
    expect(result.tags).toBeUndefined();
  });
});
