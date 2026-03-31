import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  DEFAULT_CONFIG,
  EXPORT_NAMES,
  JOB_KEYS,
  PLUGIN_ID,
  PLUGIN_VERSION,
  SLOT_IDS,
  TOOL_NAMES,
  WEBHOOK_KEYS,
} from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Linear Issue Sync",
  description:
    "Bidirectional sync between Linear issues and Paperclip issues. Link issues, sync status changes, and bridge comments.",
  author: "Lucitra",
  categories: ["connector"],
  capabilities: [
    "issues.read",
    "issues.update",
    "issue.comments.read",
    "issue.comments.create",
    "plugin.state.read",
    "plugin.state.write",
    "events.subscribe",
    "http.outbound",
    "secrets.read-ref",
    "webhooks.receive",
    "jobs.schedule",
    "agent.tools.register",
    "instance.settings.register",
    "ui.detailTab.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      linearTokenRef: {
        type: "string",
        format: "secret-ref",
        title: "Linear API Key (secret reference)",
        description:
          "Secret UUID for your Linear API key. Create the secret in Settings → Secrets, then paste its UUID here.",
      },
      teamId: {
        type: "string",
        title: "Default Team ID",
        description:
          "Default Linear team ID for creating issues. Find it in Linear team settings.",
        default: DEFAULT_CONFIG.teamId,
      },
      syncComments: {
        type: "boolean",
        title: "Sync Comments",
        description: "Mirror comments between linked issues",
        default: true,
      },
      syncDirection: {
        type: "string",
        title: "Sync Direction",
        enum: ["bidirectional", "linear-to-paperclip", "paperclip-to-linear"],
        default: DEFAULT_CONFIG.syncDirection,
      },
    },
    required: ["linearTokenRef"],
  },
  jobs: [
    {
      jobKey: JOB_KEYS.periodicSync,
      displayName: "Periodic Sync",
      description:
        "Polls linked Linear issues to catch changes missed by webhooks.",
      schedule: "*/15 * * * *",
    },
  ],
  webhooks: [
    {
      endpointKey: WEBHOOK_KEYS.linear,
      displayName: "Linear Events",
      description:
        "Receives issue and comment events from Linear webhooks. Configure a webhook in Linear settings pointing to this endpoint.",
    },
  ],
  tools: [
    {
      name: TOOL_NAMES.search,
      displayName: "Search Linear Issues",
      description:
        "Search Linear issues. Returns matching issues with status, labels, and assignees.",
      parametersSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query",
          },
        },
        required: ["query"],
      },
    },
    {
      name: TOOL_NAMES.create,
      displayName: "Create Linear Issue",
      description: "Create a new issue in Linear.",
      parametersSchema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Issue title",
          },
          description: {
            type: "string",
            description: "Issue description (markdown)",
          },
          teamId: {
            type: "string",
            description: "Team ID (omit to use default)",
          },
        },
        required: ["title"],
      },
    },
    {
      name: TOOL_NAMES.link,
      displayName: "Link Linear Issue",
      description:
        "Link a Linear issue to the current Paperclip issue for bidirectional sync.",
      parametersSchema: {
        type: "object",
        properties: {
          linearRef: {
            type: "string",
            description: "Linear issue identifier (e.g. LUC-123) or URL",
          },
        },
        required: ["linearRef"],
      },
    },
    {
      name: TOOL_NAMES.unlink,
      displayName: "Unlink Linear Issue",
      description:
        "Remove the sync link between a Linear issue and the current Paperclip issue.",
      parametersSchema: {
        type: "object",
        properties: {},
      },
    },
  ],
  ui: {
    slots: [
      {
        type: "detailTab",
        id: SLOT_IDS.issueTab,
        displayName: "Linear",
        exportName: EXPORT_NAMES.issueTab,
        entityTypes: ["issue"],
      },
      {
        type: "settingsPage",
        id: SLOT_IDS.settingsPage,
        displayName: "Linear Issue Sync",
        exportName: EXPORT_NAMES.settingsPage,
      },
    ],
  },
};

export default manifest;
