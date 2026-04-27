import type { TrackerConfig } from '../types';
import type { TrackerClient, TrackerIssueParams, TrackerIssueResult } from './types';

export class GitHubTrackerClient implements TrackerClient {
  private token: string;
  private repo: string;

  constructor(config: TrackerConfig, repo: string) {
    this.token = config.token;
    this.repo = repo;
  }

  async createIssue(params: TrackerIssueParams): Promise<TrackerIssueResult> {
    const url = `https://api.github.com/repos/${this.repo}/issues`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'donmerge-triage',
      },
      body: JSON.stringify({
        title: params.title,
        body: params.body,
        labels: params.labels,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GitHub createIssue failed: ${res.status} ${body}`);
    }

    const data = (await res.json()) as { number: number; html_url: string };
    return {
      id: String(data.number),
      url: data.html_url,
      key: '#' + data.number,
    };
  }

  async addComment(issueId: string, comment: string): Promise<void> {
    const url = `https://api.github.com/repos/${this.repo}/issues/${issueId}/comments`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'donmerge-triage',
      },
      body: JSON.stringify({ body: comment }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GitHub addComment failed: ${res.status} ${body}`);
    }
  }
}
