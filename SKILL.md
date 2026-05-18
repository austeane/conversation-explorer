---
name: conversation-explorer
description: Use when Codex needs to help a user access, snapshot, inspect, and ask questions about their local macOS Messages iMessage database (`~/Library/Messages/chat.db`). Trigger for requests involving chat.db, iMessage history, Messages exports, conversation analysis, or answering questions from local message data. Includes the required macOS Full Disk Access permission step.
---

# Conversation Explorer

## Goal

Get from "I want to ask questions about my Messages history" to a private, queryable SQLite snapshot of `chat.db`.

## Privacy Rules

- Treat `chat.db`, WAL/SHM files, attachments, handles, phone numbers, emails, message text, screenshots, and exports as private.
- Query a copied snapshot, not the live Messages database.
- Prefer aggregate answers and small targeted excerpts over broad dumps.
- Do not commit or upload copied databases, exports, attachments, or derived files unless the user explicitly asks and understands the privacy impact.

## Permission Step

Before reading `~/Library/Messages/chat.db`, tell the user that macOS requires Full Disk Access for the app or terminal running commands.

Ask them to grant access in:

```text
System Settings -> Privacy & Security -> Full Disk Access
```

They should enable the actual process that will read the file, such as Terminal, iTerm, the IDE, or the Codex desktop app. After changing this setting, they may need to restart that app.

If access is missing, commands often fail with `Operation not permitted`, return an empty-looking folder, or cannot copy `chat.db`.

## Create A Snapshot

Create a private working folder outside any public repo unless the user chooses a different location:

```bash
mkdir -p "$HOME/message-analysis/chat-snapshot"
cp -p "$HOME/Library/Messages/chat.db" "$HOME/message-analysis/chat-snapshot/chat.db"
test -f "$HOME/Library/Messages/chat.db-wal" && cp -p "$HOME/Library/Messages/chat.db-wal" "$HOME/message-analysis/chat-snapshot/chat.db-wal" || true
test -f "$HOME/Library/Messages/chat.db-shm" && cp -p "$HOME/Library/Messages/chat.db-shm" "$HOME/message-analysis/chat-snapshot/chat.db-shm" || true
```

Use the copied path for all later queries:

```bash
DB="$HOME/message-analysis/chat-snapshot/chat.db"
```

## Verify The Database

Confirm the snapshot opens and has the expected Messages tables:

```bash
sqlite3 "$DB" ".tables"
sqlite3 "$DB" "select count(*) as messages from message;"
sqlite3 "$DB" "select count(*) as handles from handle;"
sqlite3 "$DB" "select count(*) as chats from chat;"
```

Useful tables usually include:

- `message`: message rows, timestamps, text, sender direction, attachment flags.
- `handle`: phone numbers, emails, or account identifiers.
- `chat`: conversation threads.
- `chat_message_join`: links messages to chats.
- `chat_handle_join`: links chats to handles.
- `attachment` and `message_attachment_join`: attachment metadata.

## Start With Orientation Queries

List active one-on-one or group chats before answering detailed questions:

```sql
select
  c.ROWID as chat_id,
  coalesce(c.display_name, group_concat(distinct h.id)) as chat_name,
  count(distinct m.ROWID) as message_count,
  min(m.date) as first_date_raw,
  max(m.date) as last_date_raw
from chat c
join chat_message_join cmj on cmj.chat_id = c.ROWID
join message m on m.ROWID = cmj.message_id
left join chat_handle_join chj on chj.chat_id = c.ROWID
left join handle h on h.ROWID = chj.handle_id
group by c.ROWID
order by message_count desc
limit 25;
```

Convert modern Messages timestamps with Apple epoch nanoseconds:

```sql
datetime((m.date / 1000000000) + 978307200, 'unixepoch', 'localtime')
```

If a database uses older second-based timestamps, use:

```sql
datetime(m.date + 978307200, 'unixepoch', 'localtime')
```

## Answer Questions

After the snapshot is verified, ask what the user wants to know. Common next steps:

- Identify a target conversation by `chat_id`, handle, display name, or date range.
- Count messages by sender, month, weekday, hour, or year.
- Search for terms or phrases with targeted `like` queries.
- Extract small samples around specific dates or keywords.
- Build a derived local table or CSV for repeated analysis.

For text previews, keep queries narrow:

```sql
select
  m.ROWID,
  datetime((m.date / 1000000000) + 978307200, 'unixepoch', 'localtime') as sent_at,
  case when m.is_from_me = 1 then 'me' else coalesce(h.id, 'them') end as sender,
  m.text
from message m
left join handle h on h.ROWID = m.handle_id
where m.text like '%example%'
order by m.date
limit 20;
```

If `message.text` is null, the content may be in `attributedBody`; do not dump that blob. Decode only when needed and keep outputs scoped to the user's question.

## Cleanup

When finished, remind the user where the private snapshot lives and offer to delete it:

```bash
rm -rf "$HOME/message-analysis/chat-snapshot"
```
