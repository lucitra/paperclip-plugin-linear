import { useState, useEffect, type CSSProperties, type FormEvent } from "react";
import {
  useHostContext,
  usePluginAction,
  usePluginData,
  type PluginDetailTabProps,
  type PluginSettingsPageProps,
} from "@paperclipai/plugin-sdk/ui";
import { PLUGIN_ID, ACTION_KEYS, DATA_KEYS, DEFAULT_CONFIG } from "../constants.js";

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const cardStyle: CSSProperties = {
  border: "1px solid var(--border, #27272a)",
  borderRadius: "8px",
  padding: "16px",
  background: "var(--card, #09090b)",
};

const labelStyle: CSSProperties = {
  fontSize: "12px",
  fontWeight: 500,
  color: "var(--muted-foreground, #a1a1aa)",
};

const inputStyle: CSSProperties = {
  fontSize: "13px",
  padding: "6px 10px",
  border: "1px solid var(--border, #27272a)",
  borderRadius: "6px",
  background: "var(--input, #18181b)",
  color: "var(--foreground, #fafafa)",
  outline: "none",
  width: "100%",
};

const primaryBtnStyle: CSSProperties = {
  fontSize: "13px",
  fontWeight: 500,
  padding: "8px 16px",
  borderRadius: "6px",
  border: "none",
  background: "var(--primary, #fafafa)",
  color: "var(--primary-foreground, #09090b)",
  cursor: "pointer",
};

const secondaryBtnStyle: CSSProperties = {
  ...primaryBtnStyle,
  background: "var(--secondary, #27272a)",
  color: "var(--secondary-foreground, #fafafa)",
};

const destructiveBtnStyle: CSSProperties = {
  ...primaryBtnStyle,
  background: "var(--destructive, #dc2626)",
  color: "#fff",
};

const pillStyle: CSSProperties = {
  fontSize: "11px",
  padding: "2px 8px",
  borderRadius: "9999px",
  background: "var(--accent, #27272a)",
  color: "var(--accent-foreground, #fafafa)",
  display: "inline-block",
};

const greenDot: CSSProperties = {
  width: "8px",
  height: "8px",
  borderRadius: "50%",
  background: "#22c55e",
  display: "inline-block",
};

const redDot: CSSProperties = {
  ...greenDot,
  background: "#ef4444",
};

const stackStyle: CSSProperties = {
  display: "grid",
  gap: "16px",
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
};

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

function useConnectionStatus() {
  const status = usePluginAction(ACTION_KEYS.oauthStatus);
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    status({})
      .then((result: any) => {
        if (!cancelled) setData(result);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  return { data, loading, refresh: async () => {
    setLoading(true);
    try {
      const result = await status({});
      setData(result as any);
    } finally {
      setLoading(false);
    }
  }};
}

function useSettingsConfig() {
  const [configJson, setConfigJson] = useState<Record<string, unknown>>({ ...DEFAULT_CONFIG });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/plugins/${PLUGIN_ID}/config`, { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) throw new Error(await res.text());
        return res.json();
      })
      .then((result: any) => {
        if (cancelled) return;
        setConfigJson({ ...DEFAULT_CONFIG, ...(result?.configJson ?? {}) });
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  async function save(next: Record<string, unknown>) {
    setSaving(true);
    try {
      const res = await fetch(`/api/plugins/${PLUGIN_ID}/config`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ configJson: next }),
      });
      if (!res.ok) throw new Error(await res.text());
      setConfigJson(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setSaving(false);
    }
  }

  return { configJson, setConfigJson, loading, saving, error, save };
}

// ---------------------------------------------------------------------------
// Settings Page
// ---------------------------------------------------------------------------

export function LinearSettingsPage({ context }: PluginSettingsPageProps) {
  const { configJson, setConfigJson, loading: configLoading, saving, error: configError, save } = useSettingsConfig();
  const conn = useConnectionStatus();
  const oauthDisconnect = usePluginAction(ACTION_KEYS.oauthDisconnect);
  const triggerImport = usePluginAction(ACTION_KEYS.triggerImport);
  const triggerSync = usePluginAction(ACTION_KEYS.triggerSync);
  const listTeams = usePluginAction(ACTION_KEYS.listTeams);

  const [teams, setTeams] = useState<Array<{ id: string; name: string; key: string }>>([]);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<Record<string, unknown> | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<Record<string, unknown> | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  const isConnected = !!(conn.data as any)?.connected;

  function setField(key: string, value: unknown) {
    setConfigJson((c) => ({ ...c, [key]: value }));
  }

  async function handleConnect() {
    setActionError(null);
    try {
      // Use the server-managed OAuth flow which reads credentials from .env
      // and auto-configures the plugin (secret ref, team ID, auto-import)
      const startUrl = `${window.location.origin}/api/auth/linear/start?companyId=${encodeURIComponent(context.companyId ?? "")}`;
      const popup = window.open(startUrl, "linear-oauth", "width=600,height=700");

      // Poll for popup close, then refresh connection status
      const pollInterval = setInterval(() => {
        if (popup?.closed) {
          clearInterval(pollInterval);
          // Server flow auto-configures plugin + triggers import,
          // just refresh the UI to pick up the new state
          setTimeout(() => conn.refresh(), 1000);
        }
      }, 1000);
      // Safety timeout
      setTimeout(() => clearInterval(pollInterval), 120000);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleDisconnect() {
    setActionError(null);
    try {
      await oauthDisconnect({});
      await conn.refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleImport() {
    setImporting(true);
    setImportResult(null);
    setActionError(null);
    try {
      const res = await fetch(`${window.location.origin}/api/auth/linear/import?companyId=${encodeURIComponent(context.companyId ?? "")}`, { method: "POST" });
      if (!res.ok) throw new Error(`Import failed: ${res.status}`);
      const result = await res.json();
      setImportResult(result);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  }

  async function handleSync() {
    setSyncing(true);
    setSyncResult(null);
    setActionError(null);
    try {
      const res = await fetch(`${window.location.origin}/api/auth/linear/sync?companyId=${encodeURIComponent(context.companyId ?? "")}`, { method: "POST" });
      if (!res.ok) throw new Error(`Sync failed: ${res.status}`);
      const result = await res.json();
      setSyncResult(result);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  }

  async function handleLoadTeams() {
    try {
      const result = await listTeams({}) as any;
      setTeams(result?.teams ?? []);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSaveConfig(e: FormEvent) {
    e.preventDefault();
    try {
      await save(configJson);
      setSavedMsg("Saved");
      setTimeout(() => setSavedMsg(null), 1500);
    } catch {}
  }

  if (configLoading || conn.loading) {
    return <div style={{ fontSize: "12px", opacity: 0.7 }}>Loading…</div>;
  }

  return (
    <div style={stackStyle}>
      {/* Connection status */}
      <div style={cardStyle}>
        <div style={{ ...stackStyle, gap: "12px" }}>
          <div style={rowStyle}>
            <span style={isConnected ? greenDot : redDot} />
            <strong style={{ fontSize: "14px" }}>
              {isConnected ? "Connected to Linear" : "Not connected"}
            </strong>
            {isConnected && (conn.data as any)?.teamKey && (
              <span style={pillStyle}>{(conn.data as any).teamKey}</span>
            )}
          </div>

          {isConnected && (conn.data as any)?.teamName && (
            <div style={{ fontSize: "12px", color: "var(--muted-foreground, #a1a1aa)" }}>
              Team: {(conn.data as any).teamName}
              {(conn.data as any)?.highestNumber != null && (
                <> · Highest issue: #{(conn.data as any).highestNumber}</>
              )}
              {(conn.data as any)?.connectedAt && (
                <> · Connected {new Date((conn.data as any).connectedAt).toLocaleDateString()}</>
              )}
            </div>
          )}

          <div style={rowStyle}>
            {isConnected ? (
              <>
                <button
                  type="button"
                  style={secondaryBtnStyle}
                  onClick={handleSync}
                  disabled={syncing}
                >
                  {syncing ? "Syncing…" : "Re-sync all"}
                </button>
                <button
                  type="button"
                  style={secondaryBtnStyle}
                  onClick={handleImport}
                  disabled={importing}
                >
                  {importing ? "Importing…" : "Import issues"}
                </button>
                <button
                  type="button"
                  style={destructiveBtnStyle}
                  onClick={handleDisconnect}
                >
                  Disconnect
                </button>
              </>
            ) : (
              <button type="button" style={primaryBtnStyle} onClick={handleConnect}>
                Connect Linear
              </button>
            )}
          </div>

          {importResult && (
            <div style={{ fontSize: "12px", color: "#22c55e" }}>
              Import complete: {(importResult as any).imported} imported, {(importResult as any).skipped} skipped
            </div>
          )}
          {syncResult && (
            <div style={{ fontSize: "12px", color: "#22c55e" }}>
              Sync complete: {(syncResult as any).synced} synced, {(syncResult as any).errors} errors
            </div>
          )}
        </div>
      </div>

      {/* Configuration */}
      <form onSubmit={handleSaveConfig} style={cardStyle}>
        <div style={{ ...stackStyle, gap: "12px" }}>
          <strong style={{ fontSize: "14px" }}>Configuration</strong>

          <div style={{ display: "grid", gap: "4px" }}>
            <label style={labelStyle}>Sync Direction</label>
            <select
              style={{ ...inputStyle, cursor: "pointer" }}
              value={String(configJson.syncDirection ?? "bidirectional")}
              onChange={(e) => setField("syncDirection", e.target.value)}
            >
              <option value="bidirectional">Bidirectional</option>
              <option value="linear-to-paperclip">Linear → Paperclip only</option>
              <option value="paperclip-to-linear">Paperclip → Linear only</option>
            </select>
          </div>

          <label style={rowStyle}>
            <input
              type="checkbox"
              checked={configJson.syncComments !== false}
              onChange={(e) => setField("syncComments", e.target.checked)}
            />
            <span style={{ fontSize: "13px" }}>Sync comments between linked issues</span>
          </label>

          {configError && (
            <div style={{ color: "var(--destructive, #dc2626)", fontSize: "12px" }}>{configError}</div>
          )}

          <div style={rowStyle}>
            <button type="submit" style={primaryBtnStyle} disabled={saving}>
              {saving ? "Saving…" : "Save settings"}
            </button>
            {savedMsg && <span style={{ fontSize: "12px", opacity: 0.7 }}>{savedMsg}</span>}
          </div>
        </div>
      </form>

      {/* Webhook info */}
      <div style={cardStyle}>
        <div style={{ ...stackStyle, gap: "8px" }}>
          <strong style={{ fontSize: "14px" }}>Webhook</strong>
          <div style={{ fontSize: "12px", color: "var(--muted-foreground, #a1a1aa)" }}>
            Configure a webhook in Linear pointing to:
          </div>
          <code style={{
            fontSize: "12px",
            padding: "8px 12px",
            background: "var(--muted, #18181b)",
            borderRadius: "6px",
            wordBreak: "break-all",
            display: "block",
          }}>
            {`${window.location.origin}/api/plugins/${PLUGIN_ID}/webhooks/linear-events`}
          </code>
          <div style={{ fontSize: "11px", color: "var(--muted-foreground, #71717a)" }}>
            Resources: Issue, Comment, IssueLabel, Project
          </div>
        </div>
      </div>

      {actionError && (
        <div style={{ color: "var(--destructive, #dc2626)", fontSize: "12px", padding: "8px" }}>
          {actionError}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Issue Detail Tab
// ---------------------------------------------------------------------------

export function LinearIssueTab({ context }: PluginDetailTabProps) {
  const issueId = context.entityId;
  const linkData = usePluginData<{
    linked: boolean;
    linear?: {
      identifier: string;
      title?: string;
      state?: string;
      stateType?: string;
      url: string;
      assignee?: string | null;
    };
    syncDirection?: string;
    lastSyncAt?: string;
    fetchError?: boolean;
  }>(DATA_KEYS.issueLink, { issueId });

  const linkAction = usePluginAction(ACTION_KEYS.triggerSync);
  const [syncing, setSyncing] = useState(false);

  if (linkData.loading) {
    return <div style={{ fontSize: "12px", opacity: 0.7, padding: "16px" }}>Loading…</div>;
  }

  if (!linkData.data?.linked) {
    return (
      <div style={{ padding: "16px", fontSize: "13px", color: "var(--muted-foreground, #a1a1aa)" }}>
        Not linked to a Linear issue. Use the agent tool or link manually.
      </div>
    );
  }

  const { linear, syncDirection, lastSyncAt, fetchError } = linkData.data;

  const stateColor: Record<string, string> = {
    backlog: "#71717a",
    unstarted: "#a1a1aa",
    started: "#3b82f6",
    completed: "#22c55e",
    cancelled: "#ef4444",
  };

  return (
    <div style={{ padding: "16px", ...stackStyle, gap: "12px" }}>
      {/* Linear issue badge */}
      <div style={rowStyle}>
        <a
          href={linear?.url}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: "14px",
            fontWeight: 600,
            color: "var(--foreground, #fafafa)",
            textDecoration: "none",
          }}
        >
          {linear?.identifier}
        </a>
        {linear?.state && (
          <span style={{
            ...pillStyle,
            background: stateColor[linear.stateType ?? "backlog"] ?? "#71717a",
            color: "#fff",
          }}>
            {linear.state}
          </span>
        )}
        {fetchError && (
          <span style={{ ...pillStyle, background: "#713f12", color: "#fbbf24" }}>
            Stale data
          </span>
        )}
      </div>

      {/* Title */}
      {linear?.title && (
        <div style={{ fontSize: "13px" }}>{linear.title}</div>
      )}

      {/* Metadata */}
      <div style={{ fontSize: "12px", color: "var(--muted-foreground, #a1a1aa)", display: "grid", gap: "4px" }}>
        {linear?.assignee && <div>Assignee: {linear.assignee}</div>}
        <div>Sync: {syncDirection ?? "bidirectional"}</div>
        {lastSyncAt && <div>Last sync: {new Date(lastSyncAt).toLocaleString()}</div>}
      </div>

      {/* Actions */}
      <div style={rowStyle}>
        <a
          href={linear?.url}
          target="_blank"
          rel="noopener noreferrer"
          style={secondaryBtnStyle}
        >
          Open in Linear
        </a>
        <button
          type="button"
          style={secondaryBtnStyle}
          disabled={syncing}
          onClick={async () => {
            setSyncing(true);
            try {
              await linkAction({});
              linkData.refresh();
            } finally {
              setSyncing(false);
            }
          }}
        >
          {syncing ? "Syncing…" : "Sync now"}
        </button>
      </div>
    </div>
  );
}
