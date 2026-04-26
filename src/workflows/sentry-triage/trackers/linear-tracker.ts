import type { TrackerConfig } from '../types';
import type { TrackerClient, TrackerIssueParams, TrackerIssueResult } from './types';

const LINEAR_API_URL = 'https://api.linear.app/graphql';

export class LinearTrackerClient implements TrackerClient {
  private token: string;
  private teamKey: string;

  constructor(config: TrackerConfig) {
    this.token = config.token;
    this.teamKey = config.team;
  }

  private async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const res = await fetch(LINEAR_API_URL, {
      method: 'POST',
      headers: {
        Authorization: this.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      const errorBody = await res.text();
      throw new Error(`Linear API error ${res.status}: ${errorBody}`);
    }

    const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };

    if (json.errors && json.errors.length > 0) {
      const messages = json.errors.map((e) => e.message).join(', ');
      throw new Error(`Linear GraphQL error: ${messages}`);
    }

    return json.data as T;
  }

  async createIssue(params: TrackerIssueParams): Promise<TrackerIssueResult> {
    // 1. Resolve team key → team ID (parameterized query to prevent injection)
    const teamId = await this.resolveTeamId(this.teamKey);

    // 2. Resolve label names → label IDs (if labels provided)
    let labelIds: string[] = [];
    if (params.labels.length > 0) {
      labelIds = await this.resolveLabelIds(params.labels);
    }

    // 3. Create issue
    const input: Record<string, unknown> = {
      teamId,
      title: params.title,
      description: params.body,
    };
    if (labelIds.length > 0) {
      input.labelIds = labelIds;
    }

    const createData = await this.graphql<{
      issueCreate: { issue: { id: string; url: string; identifier: string } | null };
    }>(
      `mutation CreateIssue($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id url identifier } } }`,
      { input }
    );

    const issue = createData.issueCreate.issue;
    if (!issue) {
      throw new Error('Linear issueCreate returned null issue');
    }

    return {
      id: issue.id,
      url: issue.url,
      key: issue.identifier,
    };
  }

  async addComment(issueId: string, comment: string): Promise<void> {
    await this.graphql<{ commentCreate: { success: boolean } }>(
      `mutation CreateComment($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
      { input: { issueId, body: comment } }
    );
  }

  private async resolveTeamId(teamKey: string): Promise<string> {
    const data = await this.graphql<{ teams: { nodes: Array<{ id: string }> } }>(
      `query Teams($filter: TeamFilter) { teams(filter: $filter) { nodes { id } } }`,
      { filter: { key: { eq: teamKey } } }
    );
    const teams = data.teams.nodes;
    if (!teams || teams.length === 0) {
      throw new Error(`Linear team not found: ${teamKey}`);
    }
    return teams[0].id;
  }

  private async resolveLabelIds(labelNames: string[]): Promise<string[]> {
    const data = await this.graphql<{ issueLabels: { nodes: Array<{ id: string; name: string }> } }>(
      `query IssueLabels($filter: IssueLabelFilter) { issueLabels(filter: $filter) { nodes { id name } } }`
    );
    const lowerLabels = labelNames.map((l) => l.toLowerCase());
    return data.issueLabels.nodes
      .filter((node) => lowerLabels.includes(node.name.toLowerCase()))
      .map((node) => node.id);
  }
}
