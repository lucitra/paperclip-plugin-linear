export const PLUGIN_ID = "paperclip-plugin-linear";
export const PLUGIN_VERSION = "0.8.3";

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
  initialImport: "initial-import",
} as const;

export const SLOT_IDS = {
  issueTab: "linear-issue-tab",
  settingsPage: "linear-settings",
} as const;

export const EXPORT_NAMES = {
  issueTab: "LinearIssueTab",
  settingsPage: "LinearSettingsPage",
} as const;

export const ACTION_KEYS = {
  oauthStart: "oauth-start",
  oauthCallback: "oauth-callback",
  oauthDisconnect: "oauth-disconnect",
  oauthStatus: "oauth-status",
  triggerImport: "trigger-import",
  triggerSync: "trigger-sync",
  listTeams: "list-teams",
  configure: "configure",
} as const;

export const DATA_KEYS = {
  issueLink: "issue-link",
  connectionStatus: "connection-status",
} as const;

export const STATE_KEYS = {
  linkPrefix: "link:",
  linearPrefix: "linear:",
  oauthToken: "oauth-token", // legacy — kept for migration
  secretTokenRef: "secret-token-ref",
  clientSecretRef: "client-secret-ref",
  oauthTeamId: "oauth-team-id",
  oauthTeamKey: "oauth-team-key",
  companyId: "company-id",
  serverUrl: "server-url",
  connected: "connected",
  projectLinkPrefix: "project-link:",
  projectLinearPrefix: "project-linear:",
} as const;

export const LINEAR_OAUTH = {
  authorizeUrl: "https://linear.app/oauth/authorize",
  tokenUrl: "https://api.linear.app/oauth/token",
  revokeUrl: "https://api.linear.app/oauth/revoke",
  scopes: ["read", "write", "admin"],
} as const;

export const DEFAULT_CONFIG = {
  linearTokenRef: "",
  linearClientId: "",
  linearClientSecret: "",
  teamId: "",
  syncComments: true,
  syncDirection: "bidirectional" as const,
};
