/**
 * Extract a configured 1:1 iMessage conversation into a self-contained SQLite
 * runtime database.
 *
 * Run with: pnpm extract -- --config config/conversation.local.json
 */
import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { bucket, localIso } from "../src/lib/conversation/time";
import { handleMatchesConfigured, hasFlag, loadConversationConfig } from "./config";
import { decodeAttributedBody } from "./decode-attributed-body";

const config = loadConversationConfig({ ensureOutputDirs: true });
const RAW_DIR = config.output.rawSnapshotDir;
const OUT_DB = config.output.dbPath;
const MESSAGES_DIR = config.source.messagesDir;
const INCLUDE_GROUPS = hasFlag("--include-groups") || (config.source.includeGroups && !hasFlag("--one-on-one-only"));
const targetHandles = new Set(config.counterpart.handles);

console.log(`[conversation-etl] starting ${config.conversation.id}`);
mkdirSync(RAW_DIR, { recursive: true });
mkdirSync(dirname(OUT_DB), { recursive: true });

// 1. Snapshot the live Messages DB (has WAL — must copy all three files).
for (const f of ["chat.db", "chat.db-wal", "chat.db-shm"]) {
  const src = join(MESSAGES_DIR, f);
  if (existsSync(src)) {
    copyFileSync(src, join(RAW_DIR, f));
  }
}
console.log("[conversation-etl] snapshot ok");

// 2. Open snapshot read-only and the output DB fresh.
const src = new Database(join(RAW_DIR, "chat.db"), { readonly: true, fileMustExist: true });
src.pragma("journal_mode = wal"); // ok on read-only handle
if (existsSync(OUT_DB)) rmSync(OUT_DB);
const out = new Database(OUT_DB);
out.pragma("journal_mode = WAL");
out.pragma("synchronous = NORMAL");

// 3. Resolve handle ROWIDs and chats.
const handleRows = (src
  .prepare(`SELECT ROWID as rowid, id, service, country FROM handle`)
  .all() as Array<{ rowid: number; id: string; service: string; country: string | null }>)
  .filter((row) => handleMatchesConfigured(row.id, targetHandles));

const handleIds = handleRows.map((h) => h.rowid);
if (handleIds.length === 0) {
  throw new Error(
    `No Messages handles matched counterpart.handles for ${config.counterpart.label}. Run pnpm imessage:discover to confirm the handle list.`,
  );
}
console.log(`[conversation-etl] handles: ${handleIds.length} (${handleRows.map((h) => `${h.rowid}:${h.service}`).join(", ")})`);

// Chats the configured counterpart is in.
const chatIdsRow = src
  .prepare(
    `SELECT DISTINCT chat_id FROM chat_handle_join WHERE handle_id IN (${handleIds.map(() => "?").join(",")})`,
  )
  .all(...handleIds) as Array<{ chat_id: number }>;
const allChatIds = chatIdsRow.map((r) => r.chat_id);
if (allChatIds.length === 0) {
  throw new Error(`No chats include the configured counterpart handles for ${config.counterpart.label}.`);
}

const chatMeta = src
  .prepare(
    `SELECT ROWID as rowid, style, chat_identifier, display_name,
       (SELECT COUNT(*) FROM chat_handle_join WHERE chat_id=chat.ROWID) AS participants,
       (SELECT COUNT(*) FROM chat_message_join WHERE chat_id=chat.ROWID) AS msgs
     FROM chat
     WHERE ROWID IN (${allChatIds.map(() => "?").join(",")})`,
  )
  .all(...allChatIds) as Array<{
    rowid: number;
    style: number;
    chat_identifier: string;
    display_name: string | null;
    participants: number;
    msgs: number;
  }>;

// style 45 = 1:1, style 43 = group
const ONE_ON_ONE = chatMeta.filter((c) => c.style === 45);
const GROUPS = chatMeta.filter((c) => c.style === 43);
const targetChats = INCLUDE_GROUPS ? chatMeta : ONE_ON_ONE;
const targetChatIds = targetChats.map((c) => c.rowid);

if (targetChatIds.length === 0) {
  throw new Error(`No ${INCLUDE_GROUPS ? "conversation" : "1:1"} chats matched the configured counterpart handles.`);
}

console.log(
  `[conversation-etl] chats: ${ONE_ON_ONE.length} 1:1 (${ONE_ON_ONE.reduce((a, c) => a + c.msgs, 0)} msgs), ${GROUPS.length} groups (${GROUPS.reduce((a, c) => a + c.msgs, 0)} msgs); using ${targetChats.length}`,
);

// 4. Output schema
out.exec(`
CREATE TABLE chats (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,            -- 'oneonone' | 'group'
  identifier TEXT NOT NULL,
  display_name TEXT,
  participants INTEGER NOT NULL,
  msg_count INTEGER NOT NULL
);

CREATE TABLE handles (
  id INTEGER PRIMARY KEY,
  identifier TEXT NOT NULL,
  service TEXT,
  country TEXT
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,         -- chat.db message.ROWID
  guid TEXT,
  ts INTEGER NOT NULL,            -- unix epoch seconds (local-clock = UTC stored time)
  date_iso TEXT NOT NULL,         -- ISO local time string for fast bucketing
  ymd TEXT NOT NULL,              -- YYYY-MM-DD local
  ym TEXT NOT NULL,               -- YYYY-MM local
  chat_id INTEGER NOT NULL,
  handle_id INTEGER,
  is_from_me INTEGER NOT NULL,
  service TEXT,
  text TEXT,
  decoded_from TEXT NOT NULL,     -- 'text' | 'attributedBody' | 'fallback' | 'none'
  has_attachment INTEGER NOT NULL,
  associated_message_guid TEXT,
  associated_message_type INTEGER,
  thread_originator_guid TEXT,
  reply_to_guid TEXT,
  expressive_style TEXT,
  balloon_bundle_id TEXT,
  rich_link_url TEXT,
  word_count INTEGER NOT NULL DEFAULT 0,
  char_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX messages_ts_idx ON messages(ts);
CREATE INDEX messages_ym_idx ON messages(ym);
CREATE INDEX messages_chat_ts_idx ON messages(chat_id, ts);
CREATE INDEX messages_guid_idx ON messages(guid);
CREATE INDEX messages_thread_idx ON messages(thread_originator_guid);
CREATE INDEX messages_assoc_idx ON messages(associated_message_guid);

CREATE TABLE attachments (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL,
  guid TEXT,
  filename TEXT,                  -- absolute path under ~/Library/Messages/Attachments
  rel_path TEXT,                  -- relative to ~/Library/Messages/Attachments
  mime_type TEXT,
  uti TEXT,
  total_bytes INTEGER,
  is_image INTEGER NOT NULL,
  is_video INTEGER NOT NULL,
  thumb_path TEXT                 -- web path under /attachments/<id>.jpg (filled by thumbs.ts)
);
CREATE INDEX attachments_msg_idx ON attachments(message_id);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  text,
  content='messages',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TABLE meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`);

// 5. Insert chats + handles
const insChat = out.prepare(
  `INSERT INTO chats (id, kind, identifier, display_name, participants, msg_count) VALUES (?, ?, ?, ?, ?, ?)`,
);
for (const c of targetChats) {
  insChat.run(c.rowid, c.style === 45 ? "oneonone" : "group", c.chat_identifier, c.display_name, c.participants, c.msgs);
}

const insHandle = out.prepare(
  `INSERT INTO handles (id, identifier, service, country) VALUES (?, ?, ?, ?)`,
);
// Pull every handle in any of the target chats so we can identify group participants
const handlesInChats = src
  .prepare(
    `SELECT DISTINCT h.ROWID as rowid, h.id as identifier, h.service, h.country
     FROM handle h JOIN chat_handle_join chj ON chj.handle_id=h.ROWID
     WHERE chj.chat_id IN (${targetChatIds.map(() => "?").join(",")})`,
  )
  .all(...targetChatIds) as Array<{ rowid: number; identifier: string; service: string; country: string | null }>;
for (const h of handlesInChats) insHandle.run(h.rowid, h.identifier, h.service, h.country);

console.log(`[conversation-etl] inserted ${targetChats.length} chats, ${handlesInChats.length} handles`);

// 6. Stream messages
const APPLE_EPOCH_OFFSET = 978307200; // seconds between 1970-01-01 and 2001-01-01

const msgStmt = src.prepare(`
  SELECT m.ROWID as id, m.guid, m.date, m.handle_id, m.is_from_me, m.service,
         m.text, m.attributedBody,
         m.cache_has_attachments,
         m.associated_message_guid, m.associated_message_type,
         m.thread_originator_guid,
         m.expressive_send_style_id, m.balloon_bundle_id,
         m.payload_data,
         cmj.chat_id
  FROM message m
  JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  WHERE cmj.chat_id IN (${targetChatIds.map(() => "?").join(",")})
  ORDER BY m.date ASC
`);

const insMsg = out.prepare(`
  INSERT INTO messages
    (id, guid, ts, date_iso, ymd, ym, chat_id, handle_id, is_from_me, service,
     text, decoded_from, has_attachment, associated_message_guid, associated_message_type,
     thread_originator_guid, reply_to_guid, expressive_style, balloon_bundle_id, rich_link_url,
     word_count, char_count)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);

const insMsgFts = out.prepare(`INSERT INTO messages_fts(rowid, text) VALUES (?, ?)`);

let total = 0,
  decodedAttr = 0,
  fellBack = 0,
  noText = 0,
  withAtt = 0;
const decodedFrom: Record<string, number> = { text: 0, attributedBody: 0, fallback: 0, none: 0 };

const tx = out.transaction(() => {
  const rows = msgStmt.iterate(...targetChatIds) as IterableIterator<{
    id: number;
    guid: string | null;
    date: bigint | number;
    handle_id: number | null;
    is_from_me: number;
    service: string | null;
    text: string | null;
    attributedBody: Buffer | null;
    cache_has_attachments: number | null;
    associated_message_guid: string | null;
    associated_message_type: number | null;
    thread_originator_guid: string | null;
    expressive_send_style_id: string | null;
    balloon_bundle_id: string | null;
    payload_data: Buffer | null;
    chat_id: number;
  }>;

  for (const r of rows) {
    total++;

    let text: string | null = null;
    let decoded: string = "none";
    if (r.text && r.text.trim() !== "") {
      text = r.text;
      decoded = "text";
      decodedFrom.text++;
    } else if (r.attributedBody) {
      const t = decodeAttributedBody(r.attributedBody);
      if (t && t.length > 0) {
        text = t;
        decoded = "attributedBody";
        decodedFrom.attributedBody++;
        decodedAttr++;
      } else {
        // try generic fallback (already inside decodeAttributedBody)
        // if it returned null, try once more with broader scan
        const t2 = decodeAttributedBody(r.attributedBody);
        if (t2) {
          text = t2;
          decoded = "fallback";
          decodedFrom.fallback++;
          fellBack++;
        } else {
          decoded = "none";
          decodedFrom.none++;
          noText++;
        }
      }
    } else {
      decodedFrom.none++;
      noText++;
    }

    // Apple "date" is nanoseconds since 2001-01-01 (older rows may be seconds)
    const rawDate = typeof r.date === "bigint" ? r.date : BigInt(r.date);
    let unixSec: number;
    if (rawDate > 1_000_000_000_000n) {
      // nanoseconds-since-Apple-epoch
      unixSec = Number(rawDate / 1_000_000_000n) + APPLE_EPOCH_OFFSET;
    } else {
      // seconds-since-Apple-epoch (legacy)
      unixSec = Number(rawDate) + APPLE_EPOCH_OFFSET;
    }
    const iso = localIso(unixSec);
    const ymd = bucket(unixSec, "ymd");
    const ym = bucket(unixSec, "ym");

    // rich link payload — decode embedded URL if present (look for http(s) ASCII run)
    let richUrl: string | null = null;
    if (r.payload_data && r.payload_data.length) {
      const idxHttp = r.payload_data.indexOf(Buffer.from("http", "ascii"));
      if (idxHttp >= 0) {
        let end = idxHttp;
        while (end < r.payload_data.length) {
          const b = r.payload_data[end];
          if (b < 0x20 || b > 0x7e) break;
          end++;
        }
        const url = r.payload_data.subarray(idxHttp, end).toString("ascii");
        if (/^https?:\/\/[^\s]+$/.test(url)) richUrl = url;
      }
    }

    let wordCount = 0;
    let charCount = 0;
    if (text) {
      charCount = text.length;
      wordCount = text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;
    }

    insMsg.run(
      r.id,
      r.guid,
      unixSec,
      iso,
      ymd,
      ym,
      r.chat_id,
      r.handle_id && r.handle_id > 0 ? r.handle_id : null,
      r.is_from_me,
      r.service,
      text,
      decoded,
      r.cache_has_attachments ? 1 : 0,
      r.associated_message_guid,
      r.associated_message_type,
      r.thread_originator_guid,
      // reply_to_guid: thread_originator_guid is the original message guid for inline replies
      r.thread_originator_guid,
      r.expressive_send_style_id,
      r.balloon_bundle_id,
      richUrl,
      wordCount,
      charCount,
    );
    if (text) insMsgFts.run(r.id, text);

    if (r.cache_has_attachments) withAtt++;
    if (total % 25000 === 0) console.log(`[conversation-etl] ${total} messages...`);
  }
});
tx();

// Update word/char counts in a single pass
out.exec(`
UPDATE messages SET
  char_count = COALESCE(LENGTH(text), 0),
  word_count = CASE
    WHEN text IS NULL OR TRIM(text) = '' THEN 0
    ELSE (LENGTH(TRIM(text)) - LENGTH(REPLACE(TRIM(text), ' ', '')) + 1)
  END
`);

console.log(`[conversation-etl] messages inserted: ${total}`);
console.log(`[conversation-etl]   decoded text/attr/fallback/none = ${decodedFrom.text}/${decodedFrom.attributedBody}/${decodedFrom.fallback}/${decodedFrom.none}`);
console.log(`[conversation-etl]   with attachments: ${withAtt}`);

// 7. Insert attachments
const attRows = src.prepare(`
  SELECT a.ROWID as id, a.guid, a.filename, a.mime_type, a.uti, a.total_bytes,
         maj.message_id
  FROM attachment a
  JOIN message_attachment_join maj ON maj.attachment_id = a.ROWID
  JOIN chat_message_join cmj ON cmj.message_id = maj.message_id
  WHERE cmj.chat_id IN (${targetChatIds.map(() => "?").join(",")})
`).all(...targetChatIds) as Array<{
  id: number; guid: string | null; filename: string | null;
  mime_type: string | null; uti: string | null; total_bytes: number | null;
  message_id: number;
}>;

const insAtt = out.prepare(`
  INSERT INTO attachments
    (id, message_id, guid, filename, rel_path, mime_type, uti, total_bytes, is_image, is_video, thumb_path)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)
`);

const ATT_ROOT = `${MESSAGES_DIR.replace(/\/$/, "")}/Attachments/`;
let imgs = 0, vids = 0;
const attTx = out.transaction(() => {
  for (const a of attRows) {
    const filename = a.filename ? a.filename.replace(/^~/, MESSAGES_DIR.replace(/\/Library\/Messages$/, "")) : null;
    const rel = filename && filename.startsWith(ATT_ROOT) ? filename.slice(ATT_ROOT.length) : null;
    const isImg = /^image\//.test(a.mime_type || "") ? 1 : 0;
    const isVid = /^video\//.test(a.mime_type || "") ? 1 : 0;
    if (isImg) imgs++;
    if (isVid) vids++;
    insAtt.run(a.id, a.message_id, a.guid, filename, rel, a.mime_type, a.uti, a.total_bytes, isImg, isVid, null);
  }
});
attTx();
console.log(`[conversation-etl] attachments inserted: ${attRows.length} (${imgs} images, ${vids} videos)`);

// 8. Meta + summary aggregates baked into a `meta` table for fast index page
function setMeta(k: string, v: string | number) {
  out.prepare(`INSERT OR REPLACE INTO meta (k,v) VALUES (?,?)`).run(k, String(v));
}
setMeta("generated_at", new Date().toISOString());
setMeta("include_groups", INCLUDE_GROUPS ? "1" : "0");
setMeta("total_messages", total);
setMeta("conversation_id", config.conversation.id);
setMeta("conversation_title", config.conversation.title);
setMeta("conversation_brand", config.conversation.brand);
setMeta("conversation_subtitle", config.conversation.subtitle);
setMeta("timezone", config.conversation.timezone);
setMeta("self_label", config.self.label);
setMeta("self_short_label", config.self.shortLabel);
setMeta("counterpart_label", config.counterpart.label);
setMeta("counterpart_short_label", config.counterpart.shortLabel);

const stats = out.prepare(`
  SELECT
    COUNT(*) AS total,
    SUM(is_from_me) AS me,
    SUM(1-is_from_me) AS them,
    MIN(ts) AS first_ts,
    MAX(ts) AS last_ts,
    SUM(has_attachment) AS att,
    SUM(CASE WHEN associated_message_type BETWEEN 2000 AND 2005 THEN 1 ELSE 0 END) AS tapbacks,
    SUM(CASE WHEN associated_message_type BETWEEN 3000 AND 3005 THEN 1 ELSE 0 END) AS tapbacks_removed,
    SUM(CASE WHEN reply_to_guid IS NOT NULL THEN 1 ELSE 0 END) AS replies,
    SUM(word_count) AS total_words
  FROM messages
`).get() as Record<string, number>;

for (const [k, v] of Object.entries(stats)) setMeta(`stat_${k}`, v ?? 0);

console.log("[conversation-etl] stats:", stats);

// 9. Optimize FTS + analyze
out.exec(`
INSERT INTO messages_fts(messages_fts) VALUES('optimize');
ANALYZE;
VACUUM;
`);

const sizeMb = (statSync(OUT_DB).size / 1024 / 1024).toFixed(1);
console.log(`[conversation-etl] done - ${OUT_DB} = ${sizeMb} MB`);

src.close();
out.close();
