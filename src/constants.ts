export const PLUGIN_ID = "paperclip-plugin-linear";
export const PLUGIN_VERSION = "0.1.1";

export const TOOL_NAMES = {
  search: "search-linear-issues",
  link: "link-linear-issue",
  unlink: "unlink-linear-issue",
  create: "create-linear-issue",
} as const;

export const WEBHOOK_KEYS = {
  linear: "linear-events",
} as const;

export const JOB_KEYS = {
  periodicSync: "periodic-sync",
} as const;

export const SLOT_IDS = {
  issueTab: "linear-issue-tab",
  settingsPage: "linear-settings",
} as const;

export const EXPORT_NAMES = {
  issueTab: "LinearIssueTab",
  settingsPage: "LinearSettingsPage",
} as const;

export const STATE_KEYS = {
  linkPrefix: "link:",
  linearPrefix: "linear:",
} as const;

export const DEFAULT_CONFIG = {
  linearTokenRef: "",
  teamId: "",
  syncComments: true,
  syncDirection: "bidirectional" as const,
};
