import type { TrackerConfig } from '../types';
import type { TrackerClient, TrackerIssueParams, TrackerIssueResult } from './types';

export class JiraTrackerClient implements TrackerClient {
  private token: string;
  private projectKey: string;
  private baseUrl: string;

  constructor(config: TrackerConfig) {
    if (!config.jira_base_url) {
      throw new Error('Jira tracker requires jira_base_url in config');
    }
    this.baseUrl = config.jira_base_url.replace(/\/+$/, '');
    this.token = config.token;
    this.projectKey = config.team;
  }

  async createIssue(params: TrackerIssueParams): Promise<TrackerIssueResult> {
    const url = `${this.baseUrl}/rest/api/2/issue`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        fields: {
          project: { key: this.projectKey },
          summary: params.title,
          description: params.body,
          issuetype: { name: 'Bug' },
          labels: params.labels,
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Jira createIssue failed: ${res.status} ${body}`);
    }

    const data = (await res.json()) as { id: string; key: string };
    return {
      id: data.id,
      url: `${this.baseUrl}/browse/${data.key}`,
      key: data.key,
    };
  }

  async addComment(issueId: string, comment: string): Promise<void> {
    const url = `${this.baseUrl}/rest/api/2/issue/${issueId}/comment`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body: comment }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Jira addComment failed: ${res.status} ${body}`);
    }
  }
}
