import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext, PluginWebhookInput } from "@paperclipai/plugin-sdk";
import {
  TOOL_NAMES,
  JOB_KEYS,
  ACTION_KEYS,
  DATA_KEYS,
  STATE_KEYS,
  LINEAR_OAUTH,
} from "./constants.js";
import * as linear from "./linear.js";
import * as sync from "./sync.js";

// ---------------------------------------------------------------------------
// Module-level context (set during setup, used by onWebhook)
// ---------------------------------------------------------------------------

let currentCtx: PluginContext | null = null;

// ---------------------------------------------------------------------------
// In-flight lock: prevents duplicate issue creation when Linear sends
// duplicate webhook events for the same issue ID simultaneously.
// ---------------------------------------------------------------------------

const inFlightCreates = new Set<string>();

// Tracks Paperclip issue IDs that were just created from Linear webhooks.
// The issue.created event handler checks this to avoid a feedback loop
// (webhook creates Paperclip issue → issue.created fires → would push back to Linear).
const recentlyCreatedFromLinear = new Set<string>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve Linear API token — config secret ref or plugin state */
async function resolveToken(ctx: PluginContext): Promise<string> {
  // 1. Secret ref from config (manual setup via settings page — passes scope check)
  const config = await ctx.config.get();
  const configRef = config.linearTokenRef as string | undefined;
  if (configRef) return ctx.secrets.resolve(configRef);

  // 2. OAuth token stored in plugin state
  const oauthToken = await ctx.state.get({
    scopeKind: "instance",
    stateKey: STATE_KEYS.oauthToken,
  });
  if (oauthToken) return String(oauthToken);

  throw new Error("Not connected to Linear. Use the settings page to connect via OAuth.");
}

async function getTeamId(ctx: PluginContext): Promise<string> {
  // Try state first (set during OAuth)
  const stored = await ctx.state.get({
    scopeKind: "instance",
    stateKey: STATE_KEYS.oauthTeamId,
  });
  if (stored) return String(stored);

  const config = await ctx.config.get();
  const teamId = config.teamId as string | undefined;
  if (!teamId) throw new Error("teamId not configured");
  return teamId;
}

async function getCompanyId(ctx: PluginContext): Promise<string | null> {
  const stored = await ctx.state.get({
    scopeKind: "instance",
    stateKey: STATE_KEYS.companyId,
  });
  return stored ? String(stored) : null;
}


// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin = definePlugin({
  async setup(ctx) {
    currentCtx = ctx;
    ctx.logger.info("Linear Issue Sync plugin starting");

    // -----------------------------------------------------------------------
    // OAuth action handlers (called from settings UI)
    // -----------------------------------------------------------------------

    /** Generate the OAuth authorize URL for the user to open */
    ctx.actions.register(ACTION_KEYS.oauthStart, async (params: any) => {
      const config = await ctx.config.get();
      const clientId = config.linearClientId as string;
      if (!clientId) {
        return { error: "linearClientId not configured. Set it in plugin config." };
      }

      const { companyId, redirectUri } = params as {
        companyId: string;
        redirectUri: string;
      };

      // Store companyId and server URL for later use during import
      await ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.companyId },
        companyId,
      );

      // Generate a state token for CSRF protection
      const stateToken = Math.random().toString(36).slice(2) + Date.now().toString(36);
      await ctx.state.set(
        { scopeKind: "instance", stateKey: `oauth-state:${stateToken}` },
        { companyId, createdAt: Date.now() },
      );

      const authUrl = new URL(LINEAR_OAUTH.authorizeUrl);
      authUrl.searchParams.set("client_id", clientId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", LINEAR_OAUTH.scopes.join(","));
      authUrl.searchParams.set("state", stateToken);
      authUrl.searchParams.set("prompt", "consent");

      return { authorizeUrl: authUrl.toString(), state: stateToken };
    });

    /** Exchange OAuth code for token, detect team, store everything */
    ctx.actions.register(ACTION_KEYS.oauthCallback, async (params: any) => {
      const { code, state: stateToken } = params as { code: string; state: string };

      // Validate CSRF state
      const stateRaw = await ctx.state.get({
        scopeKind: "instance",
        stateKey: `oauth-state:${stateToken}`,
      });
      if (!stateRaw) {
        return { error: "Invalid or expired OAuth state. Please try again." };
      }
      // Clean up state token
      await ctx.state.delete({
        scopeKind: "instance",
        stateKey: `oauth-state:${stateToken}`,
      });

      const config = await ctx.config.get();
      const clientId = config.linearClientId as string;
      const clientSecret = config.linearClientSecret as string;
      if (!clientId || !clientSecret) {
        return { error: "OAuth client credentials not configured" };
      }

      // Determine redirect URI — the webhook endpoint on this plugin
      const redirectUri = (params as any).redirectUri as string;

      try {
        // Exchange code for token
        const tokenResponse = await linear.exchangeCodeForToken(
          ctx.http.fetch.bind(ctx.http),
          { code, clientId, clientSecret, redirectUri },
        );

        const token = tokenResponse.access_token;

        // Store token in plugin state
        await ctx.state.set(
          { scopeKind: "instance", stateKey: STATE_KEYS.oauthToken },
          token,
        );

        // Detect first team
        const teams = await linear.getTeams(ctx.http.fetch.bind(ctx.http), token);
        const team = teams[0];
        if (team) {
          await ctx.state.set(
            { scopeKind: "instance", stateKey: STATE_KEYS.oauthTeamId },
            team.id,
          );
          await ctx.state.set(
            { scopeKind: "instance", stateKey: STATE_KEYS.oauthTeamKey },
            team.key,
          );
        }

        // Mark as connected
        await ctx.state.set(
          { scopeKind: "instance", stateKey: STATE_KEYS.connected },
          {
            connectedAt: new Date().toISOString(),
            teamId: team?.id,
            teamKey: team?.key,
            teamName: team?.name,
          },
        );

        // Get highest issue number for the team
        let highestNumber = 0;
        if (team) {
          highestNumber = await linear.getHighestIssueNumber(
            ctx.http.fetch.bind(ctx.http),
            token,
            team.id,
          );
        }

        ctx.logger.info(`Linear OAuth connected: team=${team?.key}, highestNumber=${highestNumber}`);

        return {
          connected: true,
          teamId: team?.id,
          teamKey: team?.key,
          teamName: team?.name,
          highestNumber,
        };
      } catch (err) {
        ctx.logger.error("OAuth callback failed", { error: String(err) });
        return { error: `OAuth failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    });

    /** Disconnect Linear: revoke token, delete secret, and clear state */
    ctx.actions.register(ACTION_KEYS.oauthDisconnect, async () => {
      try {
        const token = await resolveToken(ctx);
        await linear.revokeToken(ctx.http.fetch.bind(ctx.http), token);
      } catch {
        // Best effort — token may already be invalid
      }

      // Clear all OAuth state
      await ctx.state.delete({ scopeKind: "instance", stateKey: STATE_KEYS.oauthToken });
      await ctx.state.delete({ scopeKind: "instance", stateKey: STATE_KEYS.oauthTeamId });
      await ctx.state.delete({ scopeKind: "instance", stateKey: STATE_KEYS.oauthTeamKey });
      await ctx.state.delete({ scopeKind: "instance", stateKey: STATE_KEYS.connected });

      ctx.logger.info("Linear disconnected");
      return { disconnected: true };
    });

    /** Get connection status (called from settings UI) */
    ctx.actions.register(ACTION_KEYS.oauthStatus, async () => {
      const connectedRaw = await ctx.state.get({
        scopeKind: "instance",
        stateKey: STATE_KEYS.connected,
      });

      // Also check if connected via server-managed OAuth (linearTokenRef in config)
      const config = await ctx.config.get();
      const hasConfigRef = !!(config.linearTokenRef as string | undefined);

      if (!connectedRaw && !hasConfigRef) {
        return { connected: false };
      }

      const info = (connectedRaw as Record<string, unknown>) ?? {};

      // Try to fetch live stats
      try {
        const token = await resolveToken(ctx);
        const teamId = (info.teamId ?? config.teamId) as string;
        if (teamId) {
          const highest = await linear.getHighestIssueNumber(
            ctx.http.fetch.bind(ctx.http),
            token,
            teamId,
          );
          return { connected: true, ...info, teamId, highestNumber: highest };
        }
        // Token resolved successfully — connected even without team info
        return { connected: true, ...info };
      } catch {
        // Token may be expired — still show cached info if we have state
        if (connectedRaw) return { connected: true, ...info };
        return { connected: false, error: "Token expired or invalid" };
      }
    });

    /** List available Linear teams */
    ctx.actions.register(ACTION_KEYS.listTeams, async () => {
      const token = await resolveToken(ctx);
      const teams = await linear.getTeams(ctx.http.fetch.bind(ctx.http), token);
      return { teams };
    });

    /**
     * Create a new Linear team and bind the plugin instance to it.
     * Used by onboarding to give each Paperclip company its own isolated team.
     */
    ctx.actions.register(ACTION_KEYS.createTeam, async (params: any) => {
      const { name, key, description } = params as {
        name: string;
        key: string;
        description?: string;
      };
      if (!name || !key) {
        throw new Error("createTeam requires both `name` and `key`");
      }

      const token = await resolveToken(ctx);
      const team = await linear.createTeam(
        ctx.http.fetch.bind(ctx.http),
        token,
        { name, key, description },
      );

      // Bind the new team to this plugin instance (same state the OAuth
      // callback populates when auto-detecting).
      await ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthTeamId },
        team.id,
      );
      await ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.oauthTeamKey },
        team.key,
      );

      return { team };
    });

    /** Configure prefix/counter */
    ctx.actions.register(ACTION_KEYS.configure, async (params: any) => {
      const { teamId } = params as { teamId?: string };
      if (teamId) {
        await ctx.state.set(
          { scopeKind: "instance", stateKey: STATE_KEYS.oauthTeamId },
          teamId,
        );
        // Update team key too
        const token = await resolveToken(ctx);
        const teams = await linear.getTeams(ctx.http.fetch.bind(ctx.http), token);
        const team = teams.find((t) => t.id === teamId);
        if (team) {
          await ctx.state.set(
            { scopeKind: "instance", stateKey: STATE_KEYS.oauthTeamKey },
            team.key,
          );
        }
      }
      return { ok: true };
    });

    /** Trigger import (called from settings UI after OAuth) */
    ctx.actions.register(ACTION_KEYS.triggerImport, async (params: any) => {
      const { companyId } = params as { companyId: string };

      // Store company ID for the import job
      await ctx.state.set(
        { scopeKind: "instance", stateKey: STATE_KEYS.companyId },
        companyId,
      );

      // Run import inline (not as a job — UI wants progress feedback)
      return await runImport(ctx);
    });

    /** Trigger a full re-sync of all linked issues */
    ctx.actions.register(ACTION_KEYS.triggerSync, async () => {
      return await runFullSync(ctx);
    });

    // -----------------------------------------------------------------------
    // Agent tools
    // -----------------------------------------------------------------------

    ctx.tools.register(
      TOOL_NAMES.search,
      { displayName: "Search Linear Issues", description: "Search Linear issues by query", parametersSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
      async (params: any) => {
        const { query } = params as { query: string };
        const token = await resolveToken(ctx);
        const teamId = await getTeamId(ctx).catch(() => "");

        const results = await linear.searchIssues(ctx.http.fetch.bind(ctx.http), token, teamId, query);
        return {
          content: `Found ${results.totalCount} issues`,
          data: {
            total_count: results.totalCount,
            issues: results.issues.map((issue) => ({
              identifier: issue.identifier, title: issue.title,
              state: issue.state.name, url: issue.url,
              assignee: issue.assignee?.name ?? null,
            })),
          },
        };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.create,
      { displayName: "Create Linear Issue", description: "Create a new issue in Linear", parametersSchema: { type: "object", properties: { title: { type: "string" }, description: { type: "string" }, teamId: { type: "string" } }, required: ["title"] } },
      async (params: any) => {
        const { title, description, teamId: paramTeamId } = params as { title: string; description?: string; teamId?: string };
        const token = await resolveToken(ctx);
        const teamId = paramTeamId || await getTeamId(ctx).catch(() => "");
        if (!teamId) return { content: "Error: no team ID", data: { error: "No team ID specified" } };

        const issue = await linear.createIssue(ctx.http.fetch.bind(ctx.http), token, { title, description, teamId });
        return {
          content: `Created ${issue.identifier}: ${issue.title}`,
          data: { identifier: issue.identifier, title: issue.title, url: issue.url },
        };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.link,
      { displayName: "Link Linear Issue", description: "Link a Linear issue to a Paperclip issue", parametersSchema: { type: "object", properties: { linearRef: { type: "string", description: "Linear issue identifier (e.g. LUC-123) or URL" }, paperclipIssueId: { type: "string", description: "Paperclip issue ID to link to" } }, required: ["linearRef", "paperclipIssueId"] } },
      async (params, runCtx) => {
        const { linearRef, paperclipIssueId } = params as { linearRef: string; paperclipIssueId: string };
        const ref = linear.parseLinearIssueRef(linearRef);
        if (!ref) return { content: "Error: invalid ref", data: { error: "Could not parse Linear issue reference" } };

        const issueId = paperclipIssueId;
        const companyId = runCtx.companyId;

        const existing = await sync.getLink(ctx, issueId);
        if (existing) return { content: "Error: already linked", data: { error: `Already linked to ${existing.linearIdentifier}` } };

        const token = await resolveToken(ctx);
        const linearIssue = await linear.getIssueByIdentifier(ctx.http.fetch.bind(ctx.http), token, ref.identifier);
        if (!linearIssue) return { content: "Error: not found", data: { error: `${ref.identifier} not found` } };

        const config = await ctx.config.get();
        const syncDirection = (config.syncDirection as sync.IssueLink["syncDirection"]) || "bidirectional";

        const link = await sync.createLink(ctx, {
          paperclipIssueId: issueId, paperclipCompanyId: companyId,
          linearIssueId: linearIssue.id, linearIdentifier: linearIssue.identifier,
          linearUrl: linearIssue.url, linearStateType: linearIssue.state.type, syncDirection,
        });

        return {
          content: `Linked to ${linearIssue.identifier}`,
          data: { linked: true, identifier: linearIssue.identifier, url: linearIssue.url, syncDirection: link.syncDirection },
        };
      },
    );

    ctx.tools.register(
      TOOL_NAMES.unlink,
      { displayName: "Unlink Linear Issue", description: "Remove the Linear sync link", parametersSchema: { type: "object", properties: { paperclipIssueId: { type: "string", description: "Paperclip issue ID to unlink" } }, required: ["paperclipIssueId"] } },
      async (params: any) => {
        const { paperclipIssueId } = params as { paperclipIssueId: string };
        const removed = await sync.removeLink(ctx, paperclipIssueId);
        return { content: removed ? "Unlinked" : "No link found", data: { unlinked: removed } };
      },
    );

    // -----------------------------------------------------------------------
    // Events: bidirectional sync
    // -----------------------------------------------------------------------

    ctx.events.on("issue.updated", async (event) => {
      const payload = event.payload as Record<string, unknown> | undefined;
      const issueId = (event.entityId ?? payload?.id) as string | undefined;
      if (!issueId) return;

      // Skip if this update came from the Linear webhook (prevents feedback loop)
      if (payload?.source === "linear") return;

      const link = await sync.getLink(ctx, issueId);
      if (!link) return;

      const changes: sync.SyncChanges = {};
      if (payload?.status) changes.status = payload.status as string;
      if (payload?.priority) changes.priority = payload.priority as string;
      if (payload?.title) changes.title = payload.title as string;
      if (payload?.description !== undefined) changes.description = payload.description as string;
      if (payload?.estimate !== undefined) changes.estimate = payload.estimate as number | null;
      if (payload?.dueDate !== undefined) changes.dueDate = payload.dueDate as string | null;

      if (Object.keys(changes).length === 0) return;

      try {
        const token = await resolveToken(ctx);
        const teamId = await getTeamId(ctx);
        await sync.syncToLinear(ctx, link, changes, token, teamId);
      } catch (err) {
        ctx.logger.error("Failed to sync to Linear", { error: String(err) });
      }
    });

    ctx.events.on("issue.created", async (event) => {
      const payload = event.payload as Record<string, unknown> | undefined;
      const issueId = (event.entityId ?? payload?.id) as string | undefined;

      ctx.logger.info(`issue.created event received: issueId=${issueId}, entityId=${event.entityId}, payloadKeys=${payload ? Object.keys(payload).join(",") : "none"}`);

      if (!issueId) { ctx.logger.info("issue.created: no issueId, skipping"); return; }

      // Skip if this issue was created by the Linear webhook (prevents feedback loop)
      if (payload?.source === "linear") { ctx.logger.info("issue.created: source=linear, skipping"); return; }
      if (recentlyCreatedFromLinear.has(issueId)) { ctx.logger.info("issue.created: recently created from linear, skipping"); return; }

      const config = await ctx.config.get();
      const syncDirection = (config.syncDirection as string) || "bidirectional";
      if (syncDirection === "linear-to-paperclip") { ctx.logger.info("issue.created: syncDirection=linear-to-paperclip, skipping"); return; }

      const companyId = await getCompanyId(ctx);
      if (!companyId) { ctx.logger.info("issue.created: no companyId stored, skipping"); return; }

      // Skip if already linked (e.g. created via import or link tool)
      const existingLink = await sync.getLink(ctx, issueId);
      if (existingLink) { ctx.logger.info("issue.created: already linked, skipping"); return; }

      try {
        const token = await resolveToken(ctx);
        const teamId = await getTeamId(ctx);

        const title = (payload?.title as string) ?? "Untitled";
        const description = payload?.description as string | undefined;
        const priority = payload?.priority as string | undefined;

        const priorityMap: Record<string, number> = {
          critical: 1, high: 2, medium: 3, low: 4,
        };

        const linearIssue = await linear.createIssue(
          ctx.http.fetch.bind(ctx.http),
          token,
          {
            title,
            description,
            teamId,
            priority: priority ? priorityMap[priority] : undefined,
          },
        );

        await sync.createLink(ctx, {
          paperclipIssueId: issueId,
          paperclipCompanyId: companyId,
          linearIssueId: linearIssue.id,
          linearIdentifier: linearIssue.identifier,
          linearUrl: linearIssue.url,
          linearStateType: linearIssue.state.type,
          syncDirection: syncDirection as sync.IssueLink["syncDirection"],
        });

        await ctx.activity.log({
          companyId,
          message: `issue.pushed_to_linear`,
          entityType: "issue",
          entityId: issueId,
          metadata: { source: "paperclip", identifier: linearIssue.identifier, title, action: "pushed" },
        });

        ctx.logger.info(`Created Linear issue for Paperclip issue: ${linearIssue.identifier}`);
      } catch (err) {
        ctx.logger.error(`Failed to create Linear issue: ${err}`);
      }
    });

    ctx.events.on("project.created", async (event) => {
      const payload = event.payload as Record<string, unknown> | undefined;
      const projectId = (event.entityId ?? payload?.id) as string | undefined;
      if (!projectId || payload?.source === "linear") return;

      const existing = await sync.getProjectLink(ctx, projectId);
      if (existing) return;

      const companyId = await getCompanyId(ctx);
      if (!companyId) return;

      try {
        const token = await resolveToken(ctx);
        const teamId = await getTeamId(ctx);
        const name = (payload?.name as string) ?? "Untitled";
        const description = payload?.description as string | undefined;
        const status = (payload?.status as string) ?? "backlog";

        const linearState = sync.paperclipProjectStateToLinear(status);
        const created = await linear.createProject(ctx.http.fetch.bind(ctx.http), token, {
          name, description, teamIds: [teamId], state: linearState,
        });

        await sync.createProjectLink(ctx, {
          paperclipProjectId: projectId,
          paperclipCompanyId: companyId,
          linearProjectId: created.id,
          linearProjectName: created.name,
          linearState,
          syncDirection: "bidirectional",
        });

        await ctx.activity.log({
          companyId,
          message: `project.pushed_to_linear`,
          entityType: "project",
          entityId: projectId,
          metadata: { source: "paperclip", projectName: name, linearProjectId: created.id, action: "pushed" },
        });

        ctx.logger.info(`Created Linear project for Paperclip project: ${name}`);
      } catch (err) {
        ctx.logger.error(`Failed to create Linear project: ${err}`);
      }
    });

    ctx.events.on("project.updated", async (event) => {
      const payload = event.payload as Record<string, unknown> | undefined;
      const projectId = (event.entityId ?? payload?.id) as string | undefined;
      if (!projectId || payload?.source === "linear") return;

      const link = await sync.getProjectLink(ctx, projectId);
      if (!link) return;

      const changes: { name?: string; description?: string; status?: string } = {};
      if (payload?.name) changes.name = payload.name as string;
      if (payload?.description !== undefined) changes.description = payload.description as string;
      if (payload?.status) changes.status = payload.status as string;

      if (Object.keys(changes).length === 0) return;

      try {
        const token = await resolveToken(ctx);
        await sync.syncProjectToLinear(ctx, link, changes, token);
      } catch (err) {
        ctx.logger.error(`Failed to sync project to Linear: ${err}`);
      }
    });

    ctx.events.on("issue.comment.created", async (event) => {
      const config = await ctx.config.get();
      if (!config.syncComments) return;

      const payload = event.payload as Record<string, unknown> | undefined;
      const issueId = (payload?.issueId ?? event.entityId) as string | undefined;
      const body = payload?.body as string | undefined;
      const authorName = (payload?.authorName as string) || "Paperclip user";
      if (!issueId || !body) return;

      const link = await sync.getLink(ctx, issueId);
      if (!link) return;

      try {
        const token = await resolveToken(ctx);
        await sync.bridgeCommentToLinear(ctx, link, token, body, authorName);
      } catch (err) {
        ctx.logger.error("Failed to bridge comment to Linear", { error: String(err) });
      }
    });

    // -----------------------------------------------------------------------
    // Scheduled jobs
    // -----------------------------------------------------------------------

    ctx.jobs.register(JOB_KEYS.periodicSync, async () => {
      ctx.logger.info("Running periodic Linear sync");
      try {
        const result = await runFullSync(ctx);
        ctx.logger.info(`Periodic sync complete: ${JSON.stringify(result)}`);
      } catch (err) {
        ctx.logger.error("Periodic sync failed", { error: String(err) });
      }
    });

    ctx.jobs.register(JOB_KEYS.initialImport, async () => {
      ctx.logger.info("Starting initial Linear issue import (job)");
      try {
        const result = await runImport(ctx);
        ctx.logger.info(`Initial import complete: ${JSON.stringify(result)}`);
      } catch (err) {
        ctx.logger.error("Initial import job failed", { error: String(err) });
      }
    });

    // -----------------------------------------------------------------------
    // UI data providers
    // -----------------------------------------------------------------------

    ctx.data.register(DATA_KEYS.issueLink, async (params: any) => {
      const issueId = params.issueId as string | undefined;
      if (!issueId) return { linked: false };
      const link = await sync.getLink(ctx, issueId);
      if (!link) return { linked: false };

      try {
        const token = await resolveToken(ctx);
        const linearIssue = await linear.getIssue(ctx.http.fetch.bind(ctx.http), token, link.linearIssueId);
        return {
          linked: true,
          linear: {
            identifier: linearIssue.identifier, title: linearIssue.title,
            state: linearIssue.state.name, stateType: linearIssue.state.type,
            url: linearIssue.url, assignee: linearIssue.assignee?.name ?? null,
          },
          syncDirection: link.syncDirection,
          lastSyncAt: link.lastSyncAt,
        };
      } catch {
        return {
          linked: true,
          linear: { identifier: link.linearIdentifier, url: link.linearUrl },
          syncDirection: link.syncDirection, lastSyncAt: link.lastSyncAt, fetchError: true,
        };
      }
    });

    ctx.data.register(DATA_KEYS.connectionStatus, async () => {
      const connectedRaw = await ctx.state.get({
        scopeKind: "instance",
        stateKey: STATE_KEYS.connected,
      });
      if (!connectedRaw) return { connected: false };
      return { connected: true, ...(connectedRaw as Record<string, unknown>) };
    });

    ctx.logger.info("Linear Issue Sync plugin ready");
  },

  // -------------------------------------------------------------------------
  // Webhook handler: Linear events
  // -------------------------------------------------------------------------
  async onWebhook(input: PluginWebhookInput) {
    const ctx = currentCtx;
    if (!ctx) return;

    const body = input.parsedBody as Record<string, unknown> | undefined;
    if (!body) return;

    const action = body.action as string | undefined;
    const type = body.type as string | undefined;
    const data = body.data as Record<string, unknown> | undefined;

    if (!data || !type || !action) return;

    ctx.logger.info(`Webhook: type=${type} action=${action} id=${data.id}`);

    try {
      await handleWebhookEvent(ctx, type, action, data);
    } catch (err) {
      ctx.logger.error("Webhook handler error", { error: String(err) });
    }
  },

  async onHealth() {
    return { status: "ok" as const, message: "Linear Issue Sync operational" };
  },

  async onValidateConfig(config) {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Must have either OAuth credentials or a token ref
    // Note: client secret may be in a Paperclip secret (not visible in config)
    const hasOAuth = !!config.linearClientId;
    const hasTokenRef = !!config.linearTokenRef;
    if (!hasOAuth && !hasTokenRef) {
      warnings.push(
        "Configure either OAuth credentials (linearClientId) or a linearTokenRef to connect to Linear.",
      );
    }
    return { ok: errors.length === 0, errors, warnings };
  },
});

// ---------------------------------------------------------------------------
// Webhook event processing
// ---------------------------------------------------------------------------

async function handleWebhookEvent(
  ctx: PluginContext,
  type: string,
  action: string,
  data: Record<string, unknown>,
): Promise<void> {
  const linearIssueId = data.id as string;

  // --- Issue events ---
  if (type === "Issue") {
    if (action === "update") {
      const link = await sync.getLinkByLinear(ctx, linearIssueId);
      if (!link) return;

      // Build a fake LinearIssue from webhook data for syncFromLinear
      const state = data.state as Record<string, unknown> | undefined;
      const stateType = (state?.type as string) ?? link.lastLinearStateType;
      const stateName = (state?.name as string) ?? stateType;

      const fakeIssue: linear.LinearIssue = {
        id: linearIssueId,
        identifier: (data.identifier as string) ?? link.linearIdentifier,
        title: (data.title as string) ?? "",
        description: (data.description as string | null) ?? null,
        state: { name: stateName, type: stateType },
        priority: (data.priority as number) ?? 0,
        url: link.linearUrl,
        assignee: null,
        labels: { nodes: [] },
        project: null,
        createdAt: "",
        updatedAt: "",
      };

      await sync.syncFromLinear(ctx, link, fakeIssue);

      // Also sync fields that syncFromLinear doesn't cover
      const extraPatch: Record<string, unknown> = {};
      if (data.estimate !== undefined) extraPatch.estimate = data.estimate;
      if (data.dueDate !== undefined) extraPatch.dueDate = data.dueDate;
      if (Object.keys(extraPatch).length > 0) {
        await ctx.issues.update(link.paperclipIssueId, extraPatch as any, link.paperclipCompanyId);
      }

      ctx.logger.info(`Webhook synced issue update: ${link.linearIdentifier}`);

    } else if (action === "create") {
      // New issue created in Linear → create in Paperclip
      const companyId = await getCompanyId(ctx);
      if (!companyId) return;

      const existing = await sync.getLinkByLinear(ctx, linearIssueId);
      if (existing) return;

      // Prevent duplicate creation from simultaneous webhook deliveries
      if (inFlightCreates.has(linearIssueId)) {
        ctx.logger.info(`Skipping duplicate webhook create for ${linearIssueId} — already in flight`);
        return;
      }
      inFlightCreates.add(linearIssueId);

      const identifier = data.identifier as string | undefined;
      const state = data.state as Record<string, unknown> | undefined;
      const stateType = (state?.type as string) ?? "backlog";

      const statusMap: Record<string, string> = {
        backlog: "backlog", unstarted: "todo", started: "in_progress",
        completed: "done", cancelled: "cancelled",
      };
      const priorityMap: Record<number, string> = {
        0: "low", 1: "critical", 2: "high", 3: "medium", 4: "low",
      };

      const status = statusMap[stateType] ?? "backlog";
      const priority = priorityMap[(data.priority as number) ?? 0] ?? "medium";

      try {
        const created = await ctx.issues.create({
          companyId,
          title: (data.title as string) ?? "Untitled",
          description: (data.description as string | null) ?? undefined,
          priority: priority as "critical" | "high" | "medium" | "low",
        });

        if (status !== "backlog") {
          await ctx.issues.update(created.id, {
            status: status as any,
          }, companyId);
        }

        const url = identifier
          ? `https://linear.app/issue/${identifier}`
          : "";

        // Mark as created-from-Linear BEFORE createLink so the issue.created
        // event handler (which fires from ctx.issues.create above) can skip it.
        recentlyCreatedFromLinear.add(created.id);
        setTimeout(() => recentlyCreatedFromLinear.delete(created.id), 10_000);

        await sync.createLink(ctx, {
          paperclipIssueId: created.id,
          paperclipCompanyId: companyId,
          linearIssueId,
          linearIdentifier: identifier ?? linearIssueId,
          linearUrl: url,
          linearStateType: stateType,
          syncDirection: "bidirectional",
        });

        await ctx.activity.log({
          companyId,
          message: `issue.synced_from_linear`,
          entityType: "issue",
          entityId: created.id,
          metadata: { source: "linear", identifier, title: (data.title as string) ?? "", action: "created" },
        });

        ctx.logger.info(`Webhook created issue from Linear: ${identifier}`);
      } catch (err) {
        ctx.logger.warn(`Webhook failed to create issue: ${err}`);
      } finally {
        inFlightCreates.delete(linearIssueId);
      }

    } else if (action === "remove") {
      // Issue deleted in Linear → cancel in Paperclip
      const link = await sync.getLinkByLinear(ctx, linearIssueId);
      if (!link) return;

      await ctx.issues.update(link.paperclipIssueId, {
        status: "cancelled" as any,
      }, link.paperclipCompanyId);

      ctx.logger.info(`Webhook archived issue (deleted in Linear): ${link.linearIdentifier}`);
    }
  }

  // --- Comment events ---
  if (type === "Comment" && (action === "create" || action === "update")) {
    const issueData = data.issue as Record<string, unknown> | undefined;
    const issueLinearId = issueData?.id as string | undefined;
    if (!issueLinearId) return;

    const link = await sync.getLinkByLinear(ctx, issueLinearId);
    if (!link) return;

    const commentBody = data.body as string;
    if (!commentBody || commentBody.includes("[synced from Paperclip]")) return;

    const userName = (data.user as Record<string, unknown>)?.name as string ?? "Linear user";

    try {
      await ctx.issues.createComment(
        link.paperclipIssueId,
        `**${userName}** (from Linear):\n\n${commentBody}`,
        link.paperclipCompanyId,
      );

      await ctx.activity.log({
        companyId: link.paperclipCompanyId,
        message: `issue.comment.synced_from_linear`,
        entityType: "issue",
        entityId: link.paperclipIssueId,
        metadata: { source: "linear", identifier: link.linearIdentifier, author: userName, bodySnippet: commentBody.slice(0, 120), action: "comment.synced" },
      });

      ctx.logger.info(`Webhook bridged comment to ${link.linearIdentifier}`);
    } catch (err) {
      ctx.logger.warn(`Webhook failed to bridge comment: ${err}`);
    }
  }

  // --- Project events ---
  if (type === "Project") {
    const linearProjectId = data.id as string;

    if (action === "create") {
      const companyId = await getCompanyId(ctx);
      if (!companyId) return;
      const existing = await sync.getProjectLinkByLinear(ctx, linearProjectId);
      if (existing) return;

      const name = (data.name as string) ?? "Untitled";
      const state = (data.state as string)?.toLowerCase() ?? "planned";
      const status = sync.linearProjectStateToPaperclip(state);

      try {
        const created = await (ctx.projects as any).create({
          companyId,
          name,
          description: (data.description as string) ?? undefined,
          status,
        });

        await sync.createProjectLink(ctx, {
          paperclipProjectId: created.id,
          paperclipCompanyId: companyId,
          linearProjectId,
          linearProjectName: name,
          linearState: state,
          syncDirection: "bidirectional",
        });

        await ctx.activity.log({
          companyId,
          message: `project.synced_from_linear`,
          entityType: "project",
          entityId: created.id,
          metadata: { source: "linear", projectName: name, action: "created" },
        });

        ctx.logger.info(`Webhook created project from Linear: ${name}`);
      } catch (err) {
        ctx.logger.warn(`Webhook failed to create project: ${err}`);
      }

    } else if (action === "update") {
      const link = await sync.getProjectLinkByLinear(ctx, linearProjectId);
      if (!link) return;

      await sync.syncProjectFromLinear(ctx, link, {
        id: linearProjectId,
        name: (data.name as string) ?? "",
        description: (data.description as string | null) ?? null,
        state: (data.state as string) ?? link.lastLinearState,
      });

    } else if (action === "remove") {
      const link = await sync.getProjectLinkByLinear(ctx, linearProjectId);
      if (!link) return;

      await (ctx.projects as any).update(link.paperclipProjectId, { status: "cancelled" } as any, link.paperclipCompanyId);
      ctx.logger.info(`Webhook archived project (deleted in Linear): ${link.linearProjectName}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Import logic
// ---------------------------------------------------------------------------

async function runImport(ctx: PluginContext): Promise<{
  imported: number;
  skipped: number;
  labels: number;
  projects: number;
}> {
  // Check if already ran
  const importDone = await ctx.state.get({
    scopeKind: "instance",
    stateKey: "initial-import-done",
  });
  if (importDone) {
    ctx.logger.info("Initial import already completed, skipping");
    return { imported: 0, skipped: 0, labels: 0, projects: 0 };
  }

  const token = await resolveToken(ctx);
  const teamId = await getTeamId(ctx);
  const companyId = await getCompanyId(ctx);
  if (!companyId) {
    throw new Error("No company ID stored. Connect via OAuth settings first.");
  }

  const fetch = ctx.http.fetch.bind(ctx.http);

  // ---- Phase 1: Sync projects from Linear ----
  ctx.logger.info("Import phase: syncing projects");
  const linearProjects = await linear.listProjects(fetch, token);
  const existingProjects = await ctx.projects.list({ companyId });
  const projectMap = new Map<string, string>(); // project name → Paperclip project ID
  for (const ep of existingProjects) {
    projectMap.set(ep.name, ep.id);
  }

  const linearStatusMap: Record<string, string> = {
    planned: "backlog", backlog: "backlog",
    started: "active", "in progress": "active",
    completed: "completed", done: "completed",
    canceled: "cancelled", cancelled: "cancelled",
    paused: "paused",
  };

  for (const lp of linearProjects) {
    if (!projectMap.has(lp.name)) {
      try {
        const status = linearStatusMap[lp.state?.toLowerCase() ?? ""] ?? "backlog";
        const created = await (ctx.projects as any).create({
          companyId,
          name: lp.name,
          description: lp.description ?? undefined,
          status,
          targetDate: lp.targetDate ?? undefined,
        });
        projectMap.set(lp.name, created.id);
        ctx.logger.info(`Created project: ${lp.name}`);
      } catch (err) {
        ctx.logger.warn(`Failed to create project ${lp.name}: ${err}`);
      }
    }

    // Create project link for ongoing sync (whether just created or already existed)
    const paperclipProjectId = projectMap.get(lp.name);
    if (paperclipProjectId) {
      const existingLink = await sync.getProjectLink(ctx, paperclipProjectId);
      if (!existingLink) {
        try {
          await sync.createProjectLink(ctx, {
            paperclipProjectId,
            paperclipCompanyId: companyId,
            linearProjectId: lp.id,
            linearProjectName: lp.name,
            linearState: lp.state?.toLowerCase() ?? "planned",
            syncDirection: "bidirectional",
          });
        } catch (err) {
          ctx.logger.warn(`Failed to create project link for ${lp.name}: ${err}`);
        }
      }
    }
  }

  // Also push Paperclip-only projects to Linear
  for (const ep of existingProjects) {
    if (!linearProjects.some((lp) => lp.name === ep.name)) {
      try {
        const linearState = sync.paperclipProjectStateToLinear(ep.status ?? "backlog");
        const created = await linear.createProject(fetch, token, {
          name: ep.name,
          description: ep.description ?? undefined,
          teamIds: [teamId],
          state: linearState,
        });

        await sync.createProjectLink(ctx, {
          paperclipProjectId: ep.id,
          paperclipCompanyId: companyId,
          linearProjectId: created.id,
          linearProjectName: created.name,
          linearState,
          syncDirection: "bidirectional",
        });
        ctx.logger.info(`Pushed Paperclip project to Linear: ${ep.name}`);
      } catch (err) {
        ctx.logger.warn(`Failed to push project ${ep.name} to Linear: ${err}`);
      }
    }
  }

  // ---- Phase 2: Sync labels via SDK ----
  ctx.logger.info("Import phase: syncing labels");
  const existingLabels = await (ctx as any).labels.list(companyId);
  const labelMap = new Map<string, string>(); // label name → Paperclip label ID
  for (const el of existingLabels) {
    labelMap.set(el.name, el.id);
  }

  // Default colors for labels without colors
  const defaultColors = ["#6366f1", "#8b5cf6", "#ec4899", "#f43f5e", "#f97316", "#eab308", "#22c55e", "#06b6d4"];
  let colorIdx = 0;

  // ---- Phase 3: Import issues ----
  ctx.logger.info("Import phase: importing issues");
  let imported = 0;
  let skipped = 0;
  let cursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const page = await linear.listOpenIssues(fetch, token, teamId, cursor);

    for (const linearIssue of page.issues) {
      // Skip if already linked
      const existing = await sync.getLinkByLinear(ctx, linearIssue.id);
      if (existing) {
        skipped++;
        continue;
      }

      const priorityMap: Record<number, string> = {
        0: "low", 1: "critical", 2: "high", 3: "medium", 4: "low",
      };
      const priority = priorityMap[linearIssue.priority] ?? "medium";

      const statusMap: Record<string, string> = {
        backlog: "backlog", unstarted: "todo", started: "in_progress",
        completed: "done", cancelled: "cancelled",
      };
      const status = statusMap[linearIssue.state.type] ?? "backlog";

      // Ensure labels exist in Paperclip
      const issueLabelIds: string[] = [];
      for (const ll of linearIssue.labels.nodes) {
        if (!labelMap.has(ll.name)) {
          const color = ll.color || defaultColors[colorIdx % defaultColors.length];
          colorIdx++;
          const created = await (ctx as any).labels.create(companyId, ll.name, color);
          if (created) {
            labelMap.set(ll.name, created.id);
            ctx.logger.info(`Created label: ${ll.name}`);
          }
        }
        const labelId = labelMap.get(ll.name);
        if (labelId) issueLabelIds.push(labelId);
      }

      // Resolve project
      const projectId = linearIssue.project?.name
        ? projectMap.get(linearIssue.project.name) ?? null
        : null;

      const description = linearIssue.description ?? undefined;

      try {
        const created = await ctx.issues.create({
          companyId,
          title: linearIssue.title,
          description,
          priority: priority as "critical" | "high" | "medium" | "low",
          ...(projectId ? { projectId } : {}),
          ...(issueLabelIds.length > 0 ? { labelIds: issueLabelIds } : {}),
        } as any);

        if (status !== "backlog") {
          await ctx.issues.update(created.id, {
            status: status as any,
          }, companyId);
        }

        await sync.createLink(ctx, {
          paperclipIssueId: created.id,
          paperclipCompanyId: companyId,
          linearIssueId: linearIssue.id,
          linearIdentifier: linearIssue.identifier,
          linearUrl: linearIssue.url,
          linearStateType: linearIssue.state.type,
          syncDirection: "bidirectional",
        });

        imported++;
        ctx.logger.info(`Imported ${linearIssue.identifier}: ${linearIssue.title}`);
      } catch (err) {
        ctx.logger.warn(`Failed to import ${linearIssue.identifier}: ${err}`);
      }
    }

    hasMore = page.hasNextPage;
    cursor = page.endCursor ?? undefined;
  }

  // Mark import as done
  await ctx.state.set(
    { scopeKind: "instance", stateKey: "initial-import-done" },
    new Date().toISOString(),
  );

  const companyIdForLog = companyId;
  await ctx.activity.log({
    companyId: companyIdForLog,
    message: `Linear import complete: ${imported} issues, ${labelMap.size} labels, ${projectMap.size} projects`,
    entityType: "company",
    entityId: companyIdForLog,
    metadata: { imported, skipped, labels: labelMap.size, projects: projectMap.size },
  });

  ctx.logger.info(`Import complete: ${imported} issues, ${labelMap.size} labels, ${projectMap.size} projects`);
  return { imported, skipped, labels: labelMap.size, projects: projectMap.size };
}

// ---------------------------------------------------------------------------
// Full sync (re-sync all linked issues from Linear)
// ---------------------------------------------------------------------------

async function runFullSync(ctx: PluginContext): Promise<{
  synced: number;
  errors: number;
}> {
  let token: string;
  try {
    token = await resolveToken(ctx);
  } catch {
    return { synced: 0, errors: 0 };
  }

  const teamId = await getTeamId(ctx).catch(() => "");
  if (!teamId) return { synced: 0, errors: 0 };

  // Fetch all open Linear issues for the team
  const allLinear: linear.LinearIssue[] = [];
  let cursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const page = await linear.listOpenIssues(
      ctx.http.fetch.bind(ctx.http),
      token,
      teamId,
      cursor,
    );
    allLinear.push(...page.issues);
    hasMore = page.hasNextPage;
    cursor = page.endCursor ?? undefined;
  }

  let synced = 0;
  let errors = 0;

  for (const linearIssue of allLinear) {
    const link = await sync.getLinkByLinear(ctx, linearIssue.id);
    if (!link) continue;

    try {
      await sync.syncFromLinear(ctx, link, linearIssue);
      synced++;
    } catch (err) {
      ctx.logger.warn(`Sync failed for ${linearIssue.identifier}: ${err}`);
      errors++;
    }
  }

  ctx.logger.info(`Full sync complete: ${synced} synced, ${errors} errors`);
  return { synced, errors };
}

export default plugin;
runWorker(plugin, import.meta.url);
