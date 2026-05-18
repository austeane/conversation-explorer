import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeHandle, numberArg, resolveConfigPath, stringArg } from "./config";

const APPLE_EPOCH_OFFSET = 978307200;

type Candidate = {
  id: string;
  displayName: string | null;
  handles: string[];
  normalizedHandles: string[];
  services: string[];
  totalMessages: number;
  firstTs: number | null;
  lastTs: number | null;
  chatIds: number[];
  attachmentCount: number;
};

const argv = process.argv.slice(2);
const messagesDirArg = stringArg("--messages-dir", argv);
if (!messagesDirArg) {
  throw new Error("Usage: pnpm imessage:discover -- --messages-dir ~/Library/Messages [--min-messages 25] [--json] [--candidate 1]");
}

const messagesDir = resolveConfigPath(messagesDirArg);
const minMessages = numberArg("--min-messages", argv) ?? 25;
const json = argv.includes("--json");
const selectedCandidate = stringArg("--candidate", argv);
const snapshotDir = mkdtempSync(join(tmpdir(), "imessage-discover-"));

try {
  for (const file of ["chat.db", "chat.db-wal", "chat.db-shm"]) {
    const source = join(messagesDir, file);
    if (existsSync(source)) copyFileSync(source, join(snapshotDir, file));
  }

  const db = new Database(join(snapshotDir, "chat.db"), { readonly: true, fileMustExist: true });
  db.pragma("journal_mode = wal");

  const rows = db
    .prepare(
      `
      SELECT
        c.ROWID AS chat_id,
        c.display_name AS display_name,
        h.id AS handle,
        h.service AS service,
        COUNT(m.ROWID) AS messages,
        MIN(m.date) AS first_date,
        MAX(m.date) AS last_date,
        SUM(CASE WHEN m.cache_has_attachments = 1 THEN 1 ELSE 0 END) AS attachments
      FROM chat c
      JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
      JOIN handle h ON h.ROWID = chj.handle_id
      JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
      JOIN message m ON m.ROWID = cmj.message_id
      WHERE c.style = 45
      GROUP BY c.ROWID, c.display_name, h.id, h.service
      HAVING messages >= ?
      ORDER BY messages DESC
      `,
    )
    .all(minMessages) as Array<{
    chat_id: number;
    display_name: string | null;
    handle: string;
    service: string | null;
    messages: number;
    first_date: bigint | number | null;
    last_date: bigint | number | null;
    attachments: number | null;
  }>;

  const candidates = groupCandidates(rows);
  if (json) {
    console.log(JSON.stringify(candidates, null, 2));
  } else if (selectedCandidate) {
    const candidate = candidates.find((item) => item.id === selectedCandidate);
    if (!candidate) {
      throw new Error(`Candidate ${selectedCandidate} not found. Run without --candidate to list candidates.`);
    }
    printConfigBlock(candidate, messagesDir);
  } else {
    printCandidates(candidates);
  }

  db.close();
} finally {
  rmSync(snapshotDir, { recursive: true, force: true });
}

function groupCandidates(
  rows: Array<{
    chat_id: number;
    display_name: string | null;
    handle: string;
    service: string | null;
    messages: number;
    first_date: bigint | number | null;
    last_date: bigint | number | null;
    attachments: number | null;
  }>,
): Candidate[] {
  const groups = new Map<string, Omit<Candidate, "id">>();
  for (const row of rows) {
    const normalized = normalizeHandle(row.handle);
    const key = normalized;
    const existing =
      groups.get(key) ??
      ({
        displayName: row.display_name,
        handles: [],
        normalizedHandles: [],
        services: [],
        totalMessages: 0,
        firstTs: null,
        lastTs: null,
        chatIds: [],
        attachmentCount: 0,
      } satisfies Omit<Candidate, "id">);

    pushUnique(existing.handles, row.handle);
    pushUnique(existing.normalizedHandles, normalized);
    if (row.service) pushUnique(existing.services, row.service);
    pushUnique(existing.chatIds, row.chat_id);
    existing.totalMessages += row.messages;
    existing.attachmentCount += row.attachments ?? 0;
    const first = row.first_date == null ? null : appleDateToUnix(row.first_date);
    const last = row.last_date == null ? null : appleDateToUnix(row.last_date);
    existing.firstTs = minNullable(existing.firstTs, first);
    existing.lastTs = maxNullable(existing.lastTs, last);
    existing.displayName = existing.displayName ?? row.display_name;
    groups.set(key, existing);
  }

  return [...groups.values()]
    .sort((a, b) => b.totalMessages - a.totalMessages)
    .map((candidate, index) => ({ id: String(index + 1), ...candidate }));
}

function printCandidates(candidates: Candidate[]) {
  console.log(`Found ${candidates.length} one-on-one candidates with at least ${minMessages} messages.\n`);
  for (const candidate of candidates) {
    console.log(
      [
        `${candidate.id}. ${candidate.displayName ?? candidate.handles[0] ?? "Unknown"}`,
        `   handles: ${candidate.handles.join(", ")}`,
        `   services: ${candidate.services.join(", ") || "unknown"}`,
        `   messages: ${candidate.totalMessages}`,
        `   dates: ${formatTs(candidate.firstTs)} to ${formatTs(candidate.lastTs)}`,
        `   chats: ${candidate.chatIds.join(", ")}; attachment messages: ${candidate.attachmentCount}`,
        `   config: pnpm imessage:discover -- --messages-dir ${messagesDir} --candidate ${candidate.id}`,
      ].join("\n"),
    );
  }
}

function printConfigBlock(candidate: Candidate, messagesDir: string) {
  const label = candidate.displayName ?? "Them";
  const config = {
    conversation: {
      id: slugify(label),
      title: `${label} Conversation`,
      brand: "conversation explorer",
      subtitle: "a private conversation, observed",
      timezone: "America/Vancouver",
    },
    self: {
      label: "Me",
      shortLabel: "Me",
    },
    counterpart: {
      label,
      shortLabel: label,
      handles: candidate.normalizedHandles,
    },
    source: {
      messagesDir,
      includeGroups: false,
    },
    output: {
      dbPath: "data/runtime/conversation.db",
      rawSnapshotDir: "data/raw",
      attachmentsPublicDir: "public/attachments",
    },
    comparison: {
      enabled: true,
      minMessages: 100,
      resolveContactNames: true,
    },
  };
  console.log(JSON.stringify(config, null, 2));
}

function appleDateToUnix(date: bigint | number): number {
  const rawDate = typeof date === "bigint" ? date : BigInt(date);
  if (rawDate > 1_000_000_000_000n) {
    return Number(rawDate / 1_000_000_000n) + APPLE_EPOCH_OFFSET;
  }
  return Number(rawDate) + APPLE_EPOCH_OFFSET;
}

function formatTs(ts: number | null): string {
  return ts == null ? "unknown" : new Date(ts * 1000).toISOString().slice(0, 10);
}

function minNullable(left: number | null, right: number | null): number | null {
  if (left == null) return right;
  if (right == null) return left;
  return Math.min(left, right);
}

function maxNullable(left: number | null, right: number | null): number | null {
  if (left == null) return right;
  if (right == null) return left;
  return Math.max(left, right);
}

function pushUnique<T>(values: T[], value: T) {
  if (!values.includes(value)) values.push(value);
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "conversation";
}
