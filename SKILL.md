---
name: conversation-explorer
description: Use when Codex needs to work in this repository to reproduce a private iMessage conversation explorer, configure a user's own conversation history, run the local extraction and runtime artifact workflow, deploy the app with private data, or sanitize and publish the generic codebase without leaking personal archive material.
---

# Conversation Explorer

## Core Rules

- Treat every real message archive, runtime DB, attachment, screenshot, handle, and local config value as private.
- Keep user-specific values in `config/conversation.local.json` or deployment env vars; never hard-code them in source.
- Keep source labels generic unless they come from runtime DB metadata.
- Do not commit generated data under `data/raw/`, `data/runtime/`, `public/attachments/`, browser traces, screenshots, local notes, or packed runtime artifacts.
- Use `README.md` as the user-facing reproduction guide and keep this file as the concise agent workflow.

## Reproduce A Conversation

1. Install dependencies with `pnpm install`.
2. Copy `config/conversation.example.json` to `config/conversation.local.json`.
3. Run `pnpm imessage:discover -- --messages-dir ~/Library/Messages` to list candidate one-on-one conversations.
4. Run `pnpm imessage:discover -- --messages-dir ~/Library/Messages --candidate N` to print a config block for the chosen candidate.
5. Fill the ignored local config with labels, handles, source path, output paths, and timezone.
6. Run `pnpm etl -- --config config/conversation.local.json`.
7. Run locally with `SITE_PASSPHRASE=local SITE_SECRET=local-secret pnpm dev`.
8. Verify app labels, filters, and page copy come from runtime DB metadata rather than source constants.

## Runtime Artifact

- Run `pnpm runtime:pack` after ETL to validate and gzip `data/runtime/conversation.db`.
- Publish only to private object storage or a private release asset via `pnpm runtime:publish`.
- Configure production with `RUNTIME_DB_URL`, `RUNTIME_DB_BEARER`, `RUNTIME_DB_SHA256`, `SITE_PASSPHRASE`, `SITE_SECRET`, and `NODE_ENV=production`.
- Remember that the gzip artifact contains message text; a passphrase gate does not make public object storage safe.

## Validation

Run these before finishing code changes:

```bash
pnpm eval
pnpm check-types
pnpm test
pnpm build
```

Before publishing or pushing a generic copy, also run privacy scans:

```bash
rg -n -i "your-real-name|counterpart-real-name|known-private-handle|data/raw|data/runtime|public/attachments"
find . -type f \( -name '*.db' -o -name '*.db.gz' -o -name '*.db-wal' -o -name '*.db-shm' -o -name '*.npy' -o -name '*.png' -o -name '*.jpg' -o -name '*.log' \) -print
```

Only `data/fixtures/tiny.db` should appear in the file scan.
