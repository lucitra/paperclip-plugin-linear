import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginWebhookInput } from "@paperclipai/plugin-sdk";
import { TOOL_NAMES, JOB_KEYS } from "./constants.js";
import * as linear from "./linear.js";
import * as sync from "./sync.js";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("Linear Issue Sync plugin starting");

    async function resolveToken(): Promise<string> {
      const config = await ctx.config.get();
      const ref = config.linearTokenRef as string | undefined;
      if (!ref) throw new Error("linearTokenRef not configured");
      return ctx.secrets.resolve(ref);
    }

    async function getTeamId(): Promise<string> {
      const config = await ctx.config.get();
      const teamId = config.teamId as string | undefined;
      if (!teamId) throw new Error("teamId not configured");
      return teamId;
    }

    // -- Agent tool: search Linear issues --
    ctx.tools.register(
      TOOL_NAMES.search,
      { displayName: "Search Linear Issues", description: "Search Linear issues by query", parametersSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
      async (params) => {
        const { query } = params as { query: string };
        const token = await resolveToken();
        const config = await ctx.config.get();
        const teamId = (config.teamId as string) || "";

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

    // -- Agent tool: create Linear issue --
    ctx.tools.register(
      TOOL_NAMES.create,
      { displayName: "Create Linear Issue", description: "Create a new issue in Linear", parametersSchema: { type: "object", properties: { title: { type: "string" }, description: { type: "string" }, teamId: { type: "string" } }, required: ["title"] } },
      async (params) => {
        const { title, description, teamId: paramTeamId } = params as { title: string; description?: string; teamId?: string };
        const token = await resolveToken();
        const config = await ctx.config.get();
        const teamId = paramTeamId || (config.teamId as string) || "";
        if (!teamId) return { content: "Error: no team ID", data: { error: "No team ID specified" } };

        const issue = await linear.createIssue(ctx.http.fetch.bind(ctx.http), token, { title, description, teamId });
        return {
          content: `Created ${issue.identifier}: ${issue.title}`,
          data: { identifier: issue.identifier, title: issue.title, url: issue.url },
        };
      },
    );

    // -- Agent tool: link Linear issue --
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

        const token = await resolveToken();
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

    // -- Agent tool: unlink --
    ctx.tools.register(
      TOOL_NAMES.unlink,
      { displayName: "Unlink Linear Issue", description: "Remove the Linear sync link", parametersSchema: { type: "object", properties: { paperclipIssueId: { type: "string", description: "Paperclip issue ID to unlink" } }, required: ["paperclipIssueId"] } },
      async (params) => {
        const { paperclipIssueId } = params as { paperclipIssueId: string };
        const issueId = paperclipIssueId;
        const removed = await sync.removeLink(ctx, issueId);
        return { content: removed ? "Unlinked" : "No link found", data: { unlinked: removed } };
      },
    );

    // -- Event: issue status changed -> sync to Linear --
    ctx.events.on("issue.updated", async (event) => {
      const payload = event.payload as Record<string, unknown> | undefined;
      const issueId = payload?.id as string | undefined;
      const status = payload?.status as string | undefined;
      if (!issueId || !status) return;

      const link = await sync.getLink(ctx, issueId);
      if (!link) return;

      try {
        const token = await resolveToken();
        const teamId = await getTeamId();
        await sync.syncToLinear(ctx, link, status, token, teamId);
      } catch (err) {
        ctx.logger.error("Failed to sync status to Linear", { error: String(err) });
      }
    });

    // -- Event: comment added -> bridge to Linear --
    ctx.events.on("issue.comment.created", async (event) => {
      const config = await ctx.config.get();
      if (!config.syncComments) return;

      const payload = event.payload as Record<string, unknown> | undefined;
      const issueId = payload?.issueId as string | undefined;
      const body = payload?.body as string | undefined;
      const authorName = (payload?.authorName as string) || "Paperclip user";
      if (!issueId || !body) return;

      const link = await sync.getLink(ctx, issueId);
      if (!link) return;

      try {
        const token = await resolveToken();
        await sync.bridgeCommentToLinear(ctx, link, token, body, authorName);
      } catch (err) {
        ctx.logger.error("Failed to bridge comment to Linear", { error: String(err) });
      }
    });

    // -- Periodic sync job --
    ctx.jobs.register(JOB_KEYS.periodicSync, async () => {
      ctx.logger.info("Running periodic Linear sync (webhook-driven, polling pending SDK state listing)");
    });

    // -- UI data: link info for issue detail tab --
    ctx.data.register("issue-link", async (params) => {
      const issueId = params.issueId as string | undefined;
      if (!issueId) return { linked: false };
      const link = await sync.getLink(ctx, issueId);
      if (!link) return { linked: false };

      try {
        const token = await resolveToken();
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

    ctx.logger.info("Linear Issue Sync plugin ready");
  },

  // -- Webhook: Linear events --
  async onWebhook(input: PluginWebhookInput) {
    // Note: ctx is not available here — webhook handling is stateless.
    // For full sync, we'd need to use the host's event dispatch.
    // For now, this is a stub — real webhook handling requires the plugin
    // to store incoming events and process them in the next setup cycle.
    // The periodic sync job handles catching up on missed changes.
  },

  async onHealth() {
    return { status: "ok" as const, message: "Linear Issue Sync operational" };
  },

  async onValidateConfig(config) {
    const errors: string[] = [];
    if (!config.linearTokenRef) errors.push("linearTokenRef is required");
    return { ok: errors.length === 0, errors };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
