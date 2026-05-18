/**
 * Generate 512px JPEG thumbnails for all image attachments.
 * Output: configured local attachments directory.
 * Updates `attachments.thumb_path` in the configured runtime DB.
 *
 * Uses macOS `sips` (built-in, handles HEIC/JPEG/PNG/TIFF natively).
 */
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { loadConversationConfig } from "./config";

const config = loadConversationConfig({ validateMessagesDir: false });
const DB_PATH = config.output.dbPath;
const PUB_DIR = config.output.attachmentsPublicDir;
const THUMB_MAX = 512;

if (process.env.NODE_ENV === "production" && process.env.ALLOW_PUBLIC_ATTACHMENT_THUMBS !== "1") {
  console.log("[thumbs] skipping public thumbnail generation in production");
  process.exit(0);
}

mkdirSync(PUB_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

const rows = db.prepare(`
  SELECT id, filename, mime_type, total_bytes
  FROM attachments
  WHERE is_image = 1 AND filename IS NOT NULL
  ORDER BY id ASC
`).all() as Array<{ id: number; filename: string; mime_type: string | null; total_bytes: number | null }>;

console.log(`[thumbs] ${rows.length} image attachments`);

const update = db.prepare(`UPDATE attachments SET thumb_path = ? WHERE id = ?`);

let made = 0, skipped = 0, missing = 0, failed = 0;
const t0 = Date.now();

for (const a of rows) {
  if (!existsSync(a.filename)) {
    missing++;
    continue;
  }
  const out = join(PUB_DIR, `${a.id}.jpg`);
  if (existsSync(out)) {
    skipped++;
    update.run(`/attachments/${a.id}.jpg`, a.id);
    continue;
  }
  // sips: resample to max dim, output JPEG quality ~80
  const res = spawnSync(
    "sips",
    [
      "-s", "format", "jpeg",
      "-s", "formatOptions", "80",
      "-Z", String(THUMB_MAX),
      a.filename,
      "--out", out,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  if (res.status !== 0) {
    failed++;
    continue;
  }
  made++;
  update.run(`/attachments/${a.id}.jpg`, a.id);

  if ((made + skipped) % 250 === 0) {
    const dt = (Date.now() - t0) / 1000;
    console.log(`[thumbs] ${made} new, ${skipped} cached, ${missing} missing, ${failed} failed (${dt.toFixed(1)}s)`);
  }
}

console.log(`[thumbs] done — ${made} new, ${skipped} cached, ${missing} missing, ${failed} failed`);
db.close();
