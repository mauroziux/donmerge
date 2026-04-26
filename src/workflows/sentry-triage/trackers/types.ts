import type { TrackerConfig, SentryTriageOutput } from '../types';

export interface TrackerIssueParams {
  title: string;
  body: string;
  labels: string[];
}

export interface TrackerIssueResult {
  id: string;
  url: string;
  key: string; // e.g. "ENG-123", "PROJ-456", "#42"
}

export interface TrackerClient {
  createIssue(params: TrackerIssueParams): Promise<TrackerIssueResult>;
  addComment(issueId: string, comment: string): Promise<void>;
}

export interface TrackerIssueContext {
  repo: string;
  sentryIssueUrl: string;
  sentryTitle: string;
  triageOutput: SentryTriageOutput;
  tracker: TrackerConfig;
  fixPrUrl: string | null;
}
