# paperclip-plugin-linear

Codex guidance for the Paperclip Linear sync plugin.

## Purpose

Paperclip plugin for Linear issue search, creation, linking, unlinking, and bidirectional issue sync. Server-side OAuth/import/webhook behavior lives in the Lucitra Paperclip fork; this plugin handles plugin-side tools and issue detail UI.

## Development

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm dev
```

Run only scripts that exist in `package.json`.

## Rules

- Keep plugin tools, manifest, worker, and UI behavior aligned.
- Do not log Linear API tokens or Paperclip secret values.
- Be explicit about sync direction and comment-bridging behavior.
- Check compatibility with the Paperclip plugin SDK used by this repo.
