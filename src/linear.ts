/**
 * Linear GraphQL API client. Uses the plugin SDK's http.fetch for outbound calls
 * so all requests go through the capability-gated host proxy.
 */

const LINEAR_API = "https://api.linear.app/graphql";
const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
const LINEAR_REVOKE_URL = "https://api.linear.app/oauth/revoke";

interface LinearFetch {
  (url: string, init?: RequestInit): Promise<Response>;
}

// --- OAuth helpers ---

export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  scope?: string;
}

export async function exchangeCodeForToken(
  fetch: LinearFetch,
  params: {
    code: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  },
): Promise<OAuthTokenResponse> {
  const res = await fetch(LINEAR_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      client_id: params.clientId,
      client_secret: params.clientSecret,
      redirect_uri: params.redirectUri,
    }).toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${text}`);
  }
  return (await res.json()) as OAuthTokenResponse;
}

export async function revokeToken(
  fetch: LinearFetch,
  token: string,
): Promise<void> {
  await fetch(LINEAR_REVOKE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
  });
}

/** Get the highest issue number for a team (to set issueCounter) */
export async function getHighestIssueNumber(
  fetch: LinearFetch,
  token: string,
  teamId: string,
): Promise<number> {
  const data = await gql<{
    issues: { nodes: Array<{ number: number }> };
  }>(fetch, token, `
    query HighestIssueNumber($teamId: ID!) {
      issues(
        filter: { team: { id: { eq: $teamId } } }
        orderBy: createdAt
        first: 1
      ) {
        nodes { number }
      }
    }
  `, { teamId });
  return data.issues.nodes[0]?.number ?? 0;
}

/** Register or update a webhook on Linear */
export async function registerWebhook(
  fetch: LinearFetch,
  token: string,
  params: {
    url: string;
    teamId: string;
    label?: string;
    resourceTypes?: string[];
  },
): Promise<{ id: string; enabled: boolean }> {
  const label = params.label ?? "Paperclip Sync (auto)";
  const resourceTypes = params.resourceTypes ?? ["Issue", "Comment", "IssueLabel", "Project"];

  // Check for existing webhook
  const existing = await gql<{
    webhooks: { nodes: Array<{ id: string; url: string; label: string; enabled: boolean }> };
  }>(fetch, token, `
    query ExistingWebhooks {
      webhooks { nodes { id url label enabled } }
    }
  `);

  const match = existing.webhooks.nodes.find(
    (w) => w.label === label || w.url.includes("/api/plugins/"),
  );

  if (match) {
    // Update existing
    const updated = await gql<{
      webhookUpdate: { webhook: { id: string; enabled: boolean } };
    }>(fetch, token, `
      mutation UpdateWebhook($id: String!, $input: WebhookUpdateInput!) {
        webhookUpdate(id: $id, input: $input) {
          webhook { id enabled }
        }
      }
    `, { id: match.id, input: { url: params.url, enabled: true } });
    return updated.webhookUpdate.webhook;
  }

  // Create new
  const created = await gql<{
    webhookCreate: { webhook: { id: string; enabled: boolean } };
  }>(fetch, token, `
    mutation CreateWebhook($input: WebhookCreateInput!) {
      webhookCreate(input: $input) {
        webhook { id enabled }
      }
    }
  `, {
    input: {
      url: params.url,
      label,
      teamId: params.teamId,
      resourceTypes,
      enabled: true,
    },
  });
  return created.webhookCreate.webhook;
}

/** Delete a webhook from Linear */
export async function deleteWebhook(
  fetch: LinearFetch,
  token: string,
  webhookId: string,
): Promise<void> {
  await gql(fetch, token, `
    mutation DeleteWebhook($id: String!) {
      webhookDelete(id: $id) { success }
    }
  `, { id: webhookId });
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  state: { name: string; type: string };
  priority: number;
  url: string;
  assignee: { name: string; email: string } | null;
  labels: { nodes: Array<{ name: string }> };
  createdAt: string;
  updatedAt: string;
}

export interface LinearComment {
  id: string;
  body: string;
  user: { name: string; email: string };
  createdAt: string;
  url: string;
}

export interface LinearTeam {
  id: string;
  name: string;
  key: string;
}

export interface LinearSearchResult {
  issues: LinearIssue[];
  totalCount: number;
}

async function gql<T>(
  fetch: LinearFetch,
  token: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(LINEAR_API, {
    method: "POST",
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Linear API error: ${res.status} ${text}`);
  }

  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new Error(`Linear GraphQL error: ${json.errors[0].message}`);
  }
  if (!json.data) {
    throw new Error("Linear API returned no data");
  }
  return json.data;
}

export async function searchIssues(
  fetch: LinearFetch,
  token: string,
  teamId: string,
  query: string,
): Promise<LinearSearchResult> {
  const filter: Record<string, unknown> = {};
  if (teamId) filter.team = { id: { eq: teamId } };

  const data = await gql<{
    issueSearch: { nodes: LinearIssue[]; totalCount: number };
  }>(fetch, token, `
    query SearchIssues($query: String!, $filter: IssueFilter) {
      issueSearch(query: $query, filter: $filter, first: 20) {
        totalCount
        nodes {
          id identifier title description url priority
          createdAt updatedAt
          state { name type }
          assignee { name email }
          labels { nodes { name } }
        }
      }
    }
  `, { query, filter: Object.keys(filter).length ? filter : undefined });

  return {
    issues: data.issueSearch.nodes,
    totalCount: data.issueSearch.totalCount,
  };
}

export async function getIssue(
  fetch: LinearFetch,
  token: string,
  issueId: string,
): Promise<LinearIssue> {
  const data = await gql<{ issue: LinearIssue }>(fetch, token, `
    query GetIssue($id: String!) {
      issue(id: $id) {
        id identifier title description url priority
        createdAt updatedAt
        state { name type }
        assignee { name email }
        labels { nodes { name } }
      }
    }
  `, { id: issueId });

  return data.issue;
}

export async function getIssueByIdentifier(
  fetch: LinearFetch,
  token: string,
  identifier: string,
): Promise<LinearIssue | null> {
  try {
    const [teamKey, numberStr] = identifier.split("-");
    if (!teamKey || !numberStr) return null;
    const number = parseInt(numberStr, 10);

    const data = await gql<{
      issues: { nodes: LinearIssue[] };
    }>(fetch, token, `
      query GetIssueByNumber($teamKey: String!, $number: Float!) {
        issues(filter: { team: { key: { eq: $teamKey } }, number: { eq: $number } }, first: 1) {
          nodes {
            id identifier title description url priority
            createdAt updatedAt
            state { name type }
            assignee { name email }
            labels { nodes { name } }
          }
        }
      }
    `, { teamKey, number });

    return data.issues.nodes[0] ?? null;
  } catch {
    return null;
  }
}

export async function createIssue(
  fetch: LinearFetch,
  token: string,
  input: {
    title: string;
    description?: string;
    teamId: string;
    priority?: number;
    assigneeId?: string;
  },
): Promise<LinearIssue> {
  const data = await gql<{
    issueCreate: { issue: LinearIssue };
  }>(fetch, token, `
    mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        issue {
          id identifier title description url priority
          createdAt updatedAt
          state { name type }
          assignee { name email }
          labels { nodes { name } }
        }
      }
    }
  `, { input });

  return data.issueCreate.issue;
}

export async function updateIssue(
  fetch: LinearFetch,
  token: string,
  issueId: string,
  input: Record<string, unknown>,
): Promise<LinearIssue> {
  const data = await gql<{
    issueUpdate: { issue: LinearIssue };
  }>(fetch, token, `
    mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        issue {
          id identifier title description url priority
          createdAt updatedAt
          state { name type }
          assignee { name email }
          labels { nodes { name } }
        }
      }
    }
  `, { id: issueId, input });

  return data.issueUpdate.issue;
}

/** Convenience wrapper for state-only updates */
export async function updateIssueState(
  fetch: LinearFetch,
  token: string,
  issueId: string,
  stateId: string,
): Promise<LinearIssue> {
  return updateIssue(fetch, token, issueId, { stateId });
}

export async function getWorkflowStates(
  fetch: LinearFetch,
  token: string,
  teamId: string,
): Promise<Array<{ id: string; name: string; type: string }>> {
  const data = await gql<{
    workflowStates: { nodes: Array<{ id: string; name: string; type: string }> };
  }>(fetch, token, `
    query GetStates($teamId: ID!) {
      workflowStates(filter: { team: { id: { eq: $teamId } } }) {
        nodes { id name type }
      }
    }
  `, { teamId });

  return data.workflowStates.nodes;
}

export async function listComments(
  fetch: LinearFetch,
  token: string,
  issueId: string,
): Promise<LinearComment[]> {
  const data = await gql<{
    issue: { comments: { nodes: LinearComment[] } };
  }>(fetch, token, `
    query ListComments($id: String!) {
      issue(id: $id) {
        comments(orderBy: createdAt) {
          nodes {
            id body createdAt url
            user { name email }
          }
        }
      }
    }
  `, { id: issueId });

  return data.issue.comments.nodes;
}

export async function createComment(
  fetch: LinearFetch,
  token: string,
  issueId: string,
  body: string,
): Promise<LinearComment> {
  const data = await gql<{
    commentCreate: { comment: LinearComment };
  }>(fetch, token, `
    mutation CreateComment($input: CommentCreateInput!) {
      commentCreate(input: $input) {
        comment {
          id body createdAt url
          user { name email }
        }
      }
    }
  `, { input: { issueId, body } });

  return data.commentCreate.comment;
}

export async function listOpenIssues(
  fetch: LinearFetch,
  token: string,
  teamId: string,
  cursor?: string,
): Promise<{ issues: LinearIssue[]; hasNextPage: boolean; endCursor: string | null }> {
  const data = await gql<{
    issues: {
      nodes: LinearIssue[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  }>(fetch, token, `
    query ListOpenIssues($teamId: ID!, $after: String) {
      issues(
        filter: {
          team: { id: { eq: $teamId } }
          state: { type: { nin: ["completed", "cancelled"] } }
        }
        first: 50
        after: $after
        orderBy: updatedAt
      ) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id identifier title description url priority
          createdAt updatedAt
          state { name type }
          assignee { name email }
          labels { nodes { name } }
        }
      }
    }
  `, { teamId, after: cursor ?? null });

  return {
    issues: data.issues.nodes,
    hasNextPage: data.issues.pageInfo.hasNextPage,
    endCursor: data.issues.pageInfo.endCursor,
  };
}

export async function getTeams(
  fetch: LinearFetch,
  token: string,
): Promise<LinearTeam[]> {
  const data = await gql<{
    teams: { nodes: LinearTeam[] };
  }>(fetch, token, `
    query GetTeams {
      teams { nodes { id name key } }
    }
  `);

  return data.teams.nodes;
}

/**
 * Parse a Linear issue reference from various formats:
 * - https://linear.app/workspace/issue/TEAM-123/title-slug
 * - TEAM-123
 * - team-123
 */
export function parseLinearIssueRef(
  ref: string,
): { identifier: string } | null {
  // URL format
  const urlMatch = ref.match(/linear\.app\/[^/]+\/issue\/([A-Z]+-\d+)/i);
  if (urlMatch) {
    return { identifier: urlMatch[1].toUpperCase() };
  }

  // Identifier format (TEAM-123)
  const idMatch = ref.match(/^([A-Z]+-\d+)$/i);
  if (idMatch) {
    return { identifier: idMatch[1].toUpperCase() };
  }

  return null;
}
