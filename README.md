# paperclip-plugin-linear

Paperclip plugin for bidirectional Linear issue sync.

## Features

- **Link issues** — Connect Paperclip issues to Linear issues for bidirectional sync
- **Status sync** — Status changes propagate both directions (configurable: bidirectional, linear-to-paperclip, or paperclip-to-linear)
- **Comment bridging** — Comments sync between linked issues (opt-in)
- **Agent tools** — Agents can search, create, link, and unlink Linear issues
- **Webhook support** — Real-time updates from Linear via webhooks
- **Issue detail tab** — See linked Linear issue info directly in Paperclip UI

## Installation

```bash
# In your Paperclip instance
npx paperclipai plugin install paperclip-plugin-linear
```

## Configuration

In Paperclip Settings → Plugins → Linear Issue Sync:

1. Create a secret with your Linear API key (Settings → Secrets)
2. Set `linearTokenRef` to the secret's UUID
3. Set `teamId` to your Linear team ID
4. Optionally enable comment sync and choose sync direction

## Agent Tools

| Tool | Description |
|------|-------------|
| `search-linear-issues` | Search Linear issues by query |
| `create-linear-issue` | Create a new issue in Linear |
| `link-linear-issue` | Link a Linear issue to a Paperclip issue |
| `unlink-linear-issue` | Remove the sync link |

## Development

```bash
pnpm install
pnpm build      # Build TypeScript
pnpm typecheck  # Type check without emitting
pnpm dev        # Watch mode
```

## License

MIT
