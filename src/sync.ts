/**
 * Sync logic between Linear issues and Paperclip issues.
 * Manages link state in plugin state storage and handles
 * bidirectional status + comment syncing.
 */

import type { PluginContext, Issue } from "@paperclipai/plugin-sdk";

type IssueStatus = Issue["status"];
import { STATE_KEYS } from "./constants.js";
import * as linear from "./linear.js";

export interface IssueLink {
  paperclipIssueId: string;
  paperclipCompanyId: string;
  linearIssueId: string;
  linearIdentifier: string;
  linearUrl: string;
  syncDirection: "bidirectional" | "linear-to-paperclip" | "paperclip-to-linear";
  lastSyncAt: string;
  lastLinearStateType: string;
  lastCommentSyncAt: string | null;
}

function linkStateKey(paperclipIssueId: string): string {
  return `${STATE_KEYS.linkPrefix}${paperclipIssueId}`;
}

function linearStateKey(linearIssueId: string): string {
  return `${STATE_KEYS.linearPrefix}${linearIssueId}`;
}

export async function getLink(
  ctx: PluginContext,
  paperclipIssueId: string,
): Promise<IssueLink | null> {
  const raw = await ctx.state.get({
    scopeKind: "instance",
    stateKey: linkStateKey(paperclipIssueId),
  });
  if (!raw) return null;
  return JSON.parse(String(raw)) as IssueLink;
}

export async function getLinkByLinear(
  ctx: PluginContext,
  linearIssueId: string,
): Promise<IssueLink | null> {
  const raw = await ctx.state.get({
    scopeKind: "instance",
    stateKey: linearStateKey(linearIssueId),
  });
  if (!raw) return null;
  const paperclipIssueId = String(raw);
  return getLink(ctx, paperclipIssueId);
}

export async function createLink(
  ctx: PluginContext,
  params: {
    paperclipIssueId: string;
    paperclipCompanyId: string;
    linearIssueId: string;
    linearIdentifier: string;
    linearUrl: string;
    linearStateType: string;
    syncDirection: IssueLink["syncDirection"];
  },
): Promise<IssueLink> {
  const link: IssueLink = {
    paperclipIssueId: params.paperclipIssueId,
    paperclipCompanyId: params.paperclipCompanyId,
    linearIssueId: params.linearIssueId,
    linearIdentifier: params.linearIdentifier,
    linearUrl: params.linearUrl,
    syncDirection: params.syncDirection,
    lastSyncAt: new Date().toISOString(),
    lastLinearStateType: params.linearStateType,
    lastCommentSyncAt: null,
  };

  await ctx.state.set(
    { scopeKind: "instance", stateKey: linkStateKey(params.paperclipIssueId) },
    JSON.stringify(link),
  );

  await ctx.state.set(
    { scopeKind: "instance", stateKey: linearStateKey(params.linearIssueId) },
    params.paperclipIssueId,
  );

  return link;
}

export async function removeLink(
  ctx: PluginContext,
  paperclipIssueId: string,
): Promise<boolean> {
  const link = await getLink(ctx, paperclipIssueId);
  if (!link) return false;

  await ctx.state.delete({
    scopeKind: "instance",
    stateKey: linkStateKey(paperclipIssueId),
  });

  await ctx.state.delete({
    scopeKind: "instance",
    stateKey: linearStateKey(link.linearIssueId),
  });

  return true;
}

async function updateLink(ctx: PluginContext, link: IssueLink): Promise<void> {
  link.lastSyncAt = new Date().toISOString();
  await ctx.state.set(
    { scopeKind: "instance", stateKey: linkStateKey(link.paperclipIssueId) },
    JSON.stringify(link),
  );
}

function linearStateToPaperclipStatus(stateType: string): IssueStatus {
  switch (stateType) {
    case "completed": return "done";
    case "cancelled": return "cancelled";
    case "started": return "in_progress";
    default: return "backlog";
  }
}

function paperclipStatusToLinearStateType(status: string): string {
  switch (status) {
    case "done": return "completed";
    case "cancelled": return "cancelled";
    case "in_progress": return "started";
    default: return "unstarted";
  }
}

function linearPriorityToPaperclip(priority: number): "critical" | "high" | "medium" | "low" {
  const map: Record<number, "critical" | "high" | "medium" | "low"> = {
    0: "low", 1: "critical", 2: "high", 3: "medium", 4: "low",
  };
  return map[priority] ?? "medium";
}

export async function syncFromLinear(
  ctx: PluginContext,
  link: IssueLink,
  linearIssue: linear.LinearIssue,
): Promise<void> {
  if (link.syncDirection === "paperclip-to-linear") return;

  const patch: Record<string, unknown> = {};

  // Sync status
  const newStateType = linearIssue.state.type;
  if (newStateType !== link.lastLinearStateType) {
    patch.status = linearStateToPaperclipStatus(newStateType);
    link.lastLinearStateType = newStateType;
  }

  // Sync priority if available
  if (linearIssue.priority !== undefined) {
    patch.priority = linearPriorityToPaperclip(linearIssue.priority);
  }

  // Sync title if available
  if (linearIssue.title) {
    patch.title = linearIssue.title;
  }

  if (Object.keys(patch).length === 0) return;

  await ctx.issues.update(link.paperclipIssueId, patch as Parameters<typeof ctx.issues.update>[1], link.paperclipCompanyId);
  await updateLink(ctx, link);

  ctx.logger.info(
    `Synced Linear ${link.linearIdentifier} -> Paperclip (${Object.keys(patch).join(", ")})`,
  );
}

function paperclipPriorityToLinear(priority: string): number {
  const map: Record<string, number> = {
    critical: 1, high: 2, medium: 3, low: 4,
  };
  return map[priority] ?? 0;
}

export async function syncToLinear(
  ctx: PluginContext,
  link: IssueLink,
  changes: { status?: string; priority?: string; title?: string },
  token: string,
  teamId: string,
): Promise<void> {
  if (link.syncDirection === "linear-to-paperclip") return;

  const linearUpdate: Record<string, unknown> = {};
  const synced: string[] = [];

  // Status → Linear state
  if (changes.status) {
    const targetStateType = paperclipStatusToLinearStateType(changes.status);
    if (targetStateType !== link.lastLinearStateType) {
      const states = await linear.getWorkflowStates(ctx.http.fetch.bind(ctx.http), token, teamId);
      const targetState = states.find((s) => s.type === targetStateType);
      if (targetState) {
        linearUpdate.stateId = targetState.id;
        link.lastLinearStateType = targetStateType;
        synced.push(`status:${targetState.name}`);
      }
    }
  }

  // Priority → Linear priority
  if (changes.priority) {
    linearUpdate.priority = paperclipPriorityToLinear(changes.priority);
    synced.push(`priority:${changes.priority}`);
  }

  // Title → Linear title
  if (changes.title) {
    linearUpdate.title = changes.title;
    synced.push("title");
  }

  if (Object.keys(linearUpdate).length === 0) return;

  await linear.updateIssue(ctx.http.fetch.bind(ctx.http), token, link.linearIssueId, linearUpdate);
  await updateLink(ctx, link);

  ctx.logger.info(
    `Synced Paperclip -> Linear ${link.linearIdentifier} (${synced.join(", ")})`,
  );
}

export async function bridgeCommentToLinear(
  ctx: PluginContext,
  link: IssueLink,
  token: string,
  commentBody: string,
  authorName: string,
): Promise<void> {
  if (link.syncDirection === "linear-to-paperclip") return;
  if (commentBody.includes("[synced from Linear]")) return;

  await linear.createComment(
    ctx.http.fetch.bind(ctx.http),
    token,
    link.linearIssueId,
    `**${authorName}** [synced from Paperclip]:\n\n${commentBody}`,
  );
}
