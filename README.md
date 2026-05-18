# conversation-explorer

A private TanStack Start app for exploring a single iMessage conversation behind a passphrase gate. The app is reusable: local extraction is driven by an ignored JSON config, while production reads a private SQLite runtime artifact fetched during build.

This repository is the generic version. It should not contain real names, handles, raw Messages snapshots, runtime databases, attachment thumbnails, screenshots, or deployment secrets. The tracked fixture DB is synthetic and exists only so tests and development builds can run without private data.

## Data Model

```text
~/Library/Messages/chat.db
  -> config/conversation.local.json
  -> data/runtime/conversation.db
  -> data/runtime/conversation.db.gz + SHA-256
  -> private object storage
  -> production build fetches, verifies, inflates, and serves local SQLite
```

The runtime database contains message text and metadata. Keep the object-storage bucket private. The passphrase gate protects the app routes; it does not make a public bucket safe. Attachment thumbnails are not shipped as public static files.

## Quick Start

```bash
pnpm install
cp config/conversation.example.json config/conversation.local.json
pnpm imessage:discover -- --messages-dir ~/Library/Messages
pnpm etl -- --config config/conversation.local.json
pnpm runtime:pack
SITE_PASSPHRASE=local SITE_SECRET=local-secret pnpm dev
```

`config/conversation.local.json` is ignored because it can contain names, handles, and local paths. The tracked example uses fake values.

## Reproduce With Your Own Conversation

1. On macOS, give your terminal Full Disk Access so it can read `~/Library/Messages/chat.db`.

2. Discover candidate one-on-one conversations:

```bash
pnpm imessage:discover -- --messages-dir ~/Library/Messages
```

The discovery script copies `chat.db`, `chat.db-wal`, and `chat.db-shm` into a temp directory and reads only the snapshot. It prints candidate counterparts with handles, services, message counts, date range, chat IDs, and attachment counts.

3. Print a ready-to-paste config for a candidate:

```bash
pnpm imessage:discover -- --messages-dir ~/Library/Messages --candidate 1
```

4. Create and fill your ignored local config:

```bash
cp config/conversation.example.json config/conversation.local.json
```

Set the conversation title, labels, timezone, counterpart handles, source Messages directory, and output paths. Keep real phone numbers, emails, names, and local paths in this ignored file.

5. Build the private runtime DB:

```bash
pnpm etl -- --config config/conversation.local.json
```

This writes `data/runtime/conversation.db`, stores display identity in the DB `meta` table, and materializes the analysis tables the routes expect.

6. Run locally:

```bash
SITE_PASSPHRASE=local SITE_SECRET=local-secret pnpm dev
```

Verify the app's root page, auth page, sender filters, and route labels use the labels from your runtime DB rather than source constants.

7. Pack and publish a private artifact:

```bash
pnpm runtime:pack
RUNTIME_DB_PUBLISH_URL=s3://private-bucket/path/conversation.db.gz pnpm runtime:publish
# or, for a private GitHub release asset:
RUNTIME_DB_PUBLISH_URL=github://owner/repo/runtime-data/conversation.db.gz pnpm runtime:publish
```

Copy the printed SHA-256 into `RUNTIME_DB_SHA256`. Store the gzip artifact somewhere private; the artifact contains message text.

8. Deploy with runtime artifact env vars:

```bash
RUNTIME_DB_URL=https://private-artifact-endpoint/path/conversation.db.gz
RUNTIME_DB_BEARER=long-random-token
RUNTIME_DB_SHA256=sha256-of-gzip
SITE_PASSPHRASE=shared-passphrase
SITE_SECRET=openssl-rand-hex-32
NODE_ENV=production
```

`pnpm build` runs `pnpm prepare:data`, which fetches the private artifact, verifies the checksum, inflates SQLite locally, validates the required tables and identity metadata, and fails closed on errors.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm imessage:discover -- --messages-dir ~/Library/Messages` | Safely snapshot Messages metadata and list candidate 1:1 counterparts. |
| `pnpm etl -- --config config/conversation.local.json` | Build `data/runtime/conversation.db` from the configured conversation. |
| `pnpm runtime:pack` | Validate and gzip the runtime DB, then print the SHA-256 checksum. |
| `pnpm runtime:publish` | Upload the gzip artifact when `RUNTIME_DB_PUBLISH_URL` is set to `s3://...` or `github://owner/repo/tag[/asset]`. |
| `pnpm prepare:data` | Use an existing DB, local gzip, fixture DB in development, or private remote artifact in production. |
| `pnpm build` | Prepare data and build the TanStack Start app. |
| `pnpm start` | Run the built server. |

## Runtime Env

Production deploys should set:

```bash
RUNTIME_DB_URL=https://private-artifact-endpoint/path/conversation.db.gz
RUNTIME_DB_BEARER=long-random-token
RUNTIME_DB_SHA256=sha256-of-gzip
SITE_PASSPHRASE=shared-passphrase
SITE_SECRET=openssl-rand-hex-32
NODE_ENV=production
```

Optional local overrides:

```bash
RUNTIME_DB_PATH=data/runtime/conversation.db
RUNTIME_DB_GZIP_PATH=data/runtime/conversation.db.gz
RUNTIME_DB_MIN_BYTES=4096
CONVERSATION_CONFIG=config/conversation.local.json
```

## Repository Hygiene

Do not commit runtime databases, compressed runtime artifacts, raw Messages snapshots, local configs, thumbnails, screenshots, Playwright dumps, or generated page-analysis notes. The tracked fixture DB is synthetic and exists only for tests.

Ignored private/generated paths include:

```text
config/conversation.local.json
data/raw/
data/runtime/
data/*.db
data/*.db.gz
data/baseline-frequencies.json
data/topic_reps.json
data/migration/
public/attachments/
.playwright-mcp/
tmp/page-analysis/
summaries/
NOTES_*.md
```

Before publishing a derived repo, scan it:

```bash
rg -n -i "your-name|counterpart-name|phone|email|data/runtime|data/raw|public/attachments"
find . -type f \( -name '*.db' -o -name '*.db.gz' -o -name '*.npy' -o -name '*.png' -o -name '*.jpg' -o -name '*.log' \) -print
```

Only `data/fixtures/tiny.db` should appear in the second command.

## Tests

```bash
pnpm eval
pnpm test
pnpm check-types
pnpm build
```

The build works in a fresh clone without private data by copying the synthetic fixture DB in development. Production builds fail closed unless a valid private runtime artifact is configured.
