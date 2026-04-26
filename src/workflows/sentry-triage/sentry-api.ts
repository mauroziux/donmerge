/**
 * Sentry API client for fetching issue and event data.
 *
 * All requests use caller-provided auth tokens.
 */

import type { SentryIssueData, SentryEvent } from './types';
import { parseSentryUrl } from './sentry-url-parser';

const SENTRY_API_BASE = 'https://sentry.io';

/**
 * Generic fetch wrapper for Sentry API with Bearer auth.
 */
export async function sentryFetch<T>(
  path: string,
  token: string
): Promise<T> {
  const url = path.startsWith('http') ? path : `${SENTRY_API_BASE}${path}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Sentry API error ${response.status}: ${errorBody}`);
  }

  return (await response.json()) as T;
}

/**
 * Fetch a Sentry issue by org and issue ID.
 */
export async function fetchSentryIssue(
  org: string,
  issueId: string,
  token: string
): Promise<SentryIssueData> {
  return sentryFetch<SentryIssueData>(
    `/api/0/organizations/${org}/issues/${issueId}/`,
    token
  );
}

/**
 * Fetch events for a Sentry issue.
 *
 * @param maxEvents - Maximum number of events to fetch (default 3)
 */
export async function fetchSentryEvents(
  org: string,
  issueId: string,
  token: string,
  maxEvents = 3
): Promise<SentryEvent[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = await sentryFetch<any[]>(
    `/api/0/organizations/${org}/issues/${issueId}/events/?full=true&per_page=${maxEvents}`,
    token
  );

  return raw.map((entry) => transformEvent(entry));
}

/**
 * Fetch a full Sentry issue with events from a URL.
 * Convenience function combining URL parsing, issue fetch, and event fetch.
 */
export async function fetchFullSentryIssue(
  sentryIssueUrl: string,
  token: string
): Promise<SentryIssueData> {
  const { org, issueId } = parseSentryUrl(sentryIssueUrl);
  const issue = await fetchSentryIssue(org, issueId, token);
  const events = await fetchSentryEvents(org, issueId, token);
  issue.events = events;
  return issue;
}

/**
 * Transform a raw Sentry event API response into a SentryEvent shape.
 * Handles exception entries, breadcrumbs, request, contexts, extra, and tags.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function transformEvent(raw: any): SentryEvent {
  const event: SentryEvent = {
    id: raw.id ?? '',
    timestamp: raw.timestamp ?? '',
  };

  // Extract exceptions from entries
  if (Array.isArray(raw.entries)) {
    for (const entry of raw.entries) {
      if (entry.type === 'exception' && entry.data?.values) {
        event.exceptions = entry.data.values.map(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (exc: any) => ({
            type: exc.type ?? 'Unknown',
            value: exc.value ?? '',
            stacktrace: {
              frames: Array.isArray(exc.stacktrace?.frames)
                ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  exc.stacktrace.frames.map((frame: any) => ({
                    filename: frame.filename ?? '',
                    function: frame.function ?? '',
                    lineno: frame.lineno ?? 0,
                    colno: frame.colno ?? 0,
                    absPath: frame.absPath ?? '',
                    context: Array.isArray(frame.context)
                      ? frame.context
                      : undefined,
                    inApp: frame.inApp ?? false,
                    module: frame.module,
                    package: frame.package,
                  }))
                : [],
            },
          })
        );
      }

      if (entry.type === 'breadcrumbs' && Array.isArray(entry.data)) {
        event.breadcrumbs = entry.data
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((crumb: any) => ({
            timestamp: crumb.timestamp ?? '',
            category: crumb.category ?? '',
            message: crumb.message ?? '',
            type: crumb.type ?? '',
            data: crumb.data,
          }))
          .filter((crumb: { message: string }) => crumb.message);
      }
    }
  }

  // Direct properties
  if (raw.request) {
    event.request = {
      url: raw.request.url,
      method: raw.request.method,
      headers: raw.request.headers,
    };
  }

  if (raw.contexts) {
    event.contexts = raw.contexts;
  }

  if (raw.extra) {
    event.extra = raw.extra;
  }

  if (Array.isArray(raw.tags)) {
    event.tags = raw.tags;
  }

  return event;
}
