import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { createGunzip } from "node:zlib";

const DEFAULT_DB_PATH = join(process.cwd(), "data/runtime/conversation.db");
const DEFAULT_FIXTURE_DB_PATH = join(process.cwd(), "data/fixtures/tiny.db");
const REQUIRED_TABLES = [
  "messages",
  "messages_fts",
  "attachments",
  "meta",
  "phrase_bigrams",
  "phrase_collocations",
  "phrase_divergence_2",
  "phrase_divergence_3",
  "phrase_trigrams",
  "sentence_stats",
  "sentence_length_hist",
  "seg_segments",
  "seg_msg_segment",
  "seg_topics",
  "seg_topic_categories",
  "seg_segment_categories",
  "seg_links",
  "seg_category_transitions",
  "seg_seasons",
  "seg_topic_stability",
  "cmp_people",
  "cmp_distinctive_words",
  "cmp_meta",
];

export async function prepareRuntimeData(options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const log = options.log ?? console.log;
  const production = env.NODE_ENV === "production";
  const dbPath = env.RUNTIME_DB_PATH ? resolveFrom(cwd, env.RUNTIME_DB_PATH) : join(cwd, "data/runtime/conversation.db");
  const gzipPath = env.RUNTIME_DB_GZIP_PATH ? resolveFrom(cwd, env.RUNTIME_DB_GZIP_PATH) : `${dbPath}.gz`;
  const minDbBytes = Number(env.RUNTIME_DB_MIN_BYTES ?? 4096);

  if (existsSync(dbPath)) {
    validateRuntimeDb(dbPath, { minBytes: minDbBytes });
    log(`[data] using local db ${dbPath} (${formatBytes(statSync(dbPath).size)})`);
    return { source: "local-db", dbPath };
  }

  mkdirSync(dirname(dbPath), { recursive: true });

  if (!production && existsSync(gzipPath)) {
    await inflateCheckedGzip({
      gzipPath,
      dbPath,
      expectedSha256: env.RUNTIME_DB_SHA256,
      minDbBytes,
      log,
      sourceLabel: "local gzip",
    });
    return { source: "local-gzip", dbPath };
  }

  if (!production && existsSync(DEFAULT_FIXTURE_DB_PATH)) {
    const tempPath = `${dbPath}.tmp-${process.pid}`;
    rmSync(tempPath, { force: true });
    await pipeline(createReadStream(DEFAULT_FIXTURE_DB_PATH), createWriteStream(tempPath, { mode: 0o600 }));
    validateRuntimeDb(tempPath, { minBytes: 1 });
    renameSync(tempPath, dbPath);
    log(`[data] copied fixture db ${DEFAULT_FIXTURE_DB_PATH} -> ${dbPath}`);
    return { source: "fixture-db", dbPath };
  }

  const runtimeUrl = env.RUNTIME_DB_URL;
  const bearer = env.RUNTIME_DB_BEARER;
  const expectedSha256 = env.RUNTIME_DB_SHA256;
  if (!runtimeUrl || !bearer || !expectedSha256) {
    throw new Error("Missing runtime artifact env. Set RUNTIME_DB_URL, RUNTIME_DB_BEARER, and RUNTIME_DB_SHA256.");
  }

  const downloadPath = `${dbPath}.download-${process.pid}.gz`;
  rmSync(downloadPath, { force: true });
  try {
    log(`[data] fetching private runtime artifact ${runtimeUrl}`);
    const response = await fetch(runtimeUrl, {
      headers: {
        Accept: "application/octet-stream",
        Authorization: `Bearer ${bearer}`,
      },
    });
    if (!response.ok || !response.body) {
      throw new Error(`Runtime artifact fetch failed: HTTP ${response.status}`);
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(downloadPath, { mode: 0o600 }));
    await inflateCheckedGzip({
      gzipPath: downloadPath,
      dbPath,
      expectedSha256,
      minDbBytes,
      log,
      sourceLabel: "remote artifact",
    });
    return { source: "remote-artifact", dbPath };
  } finally {
    rmSync(downloadPath, { force: true });
  }
}

export async function inflateCheckedGzip({ gzipPath, dbPath, expectedSha256, minDbBytes, log, sourceLabel }) {
  if (expectedSha256) {
    const actualSha256 = sha256File(gzipPath);
    if (actualSha256 !== expectedSha256) {
      throw new Error(`Runtime DB checksum mismatch for ${gzipPath}: expected ${expectedSha256}, got ${actualSha256}`);
    }
  }

  const tempPath = `${dbPath}.tmp-${process.pid}`;
  rmSync(tempPath, { force: true });
  try {
    await pipeline(createReadStream(gzipPath), createGunzip(), createWriteStream(tempPath, { mode: 0o600 }));
    validateRuntimeDb(tempPath, { minBytes: minDbBytes });
    renameSync(tempPath, dbPath);
    log(`[data] prepared ${dbPath} from ${sourceLabel} (${formatBytes(statSync(dbPath).size)})`);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

export function validateRuntimeDb(dbPath, options = {}) {
  const minBytes = options.minBytes ?? 4096;
  const size = statSync(dbPath).size;
  if (size < minBytes) {
    throw new Error(`Runtime DB is unexpectedly small: ${dbPath} (${formatBytes(size)})`);
  }
  const header = readFileSync(dbPath).subarray(0, 16).toString("utf8");
  if (header !== "SQLite format 3\u0000") {
    throw new Error(`Runtime DB does not have a SQLite header: ${dbPath}`);
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    for (const table of REQUIRED_TABLES) {
      const row = db
        .prepare("SELECT 1 FROM sqlite_master WHERE name = ? AND type IN ('table', 'virtual table')")
        .get(table);
      if (!row) throw new Error(`Runtime DB is missing required table: ${table}`);
    }
    const identityRows = db
      .prepare(
        "SELECT k FROM meta WHERE k IN ('conversation_id','conversation_title','conversation_brand','conversation_subtitle','timezone','self_label','self_short_label','counterpart_label','counterpart_short_label')",
      )
      .all();
    if (identityRows.length < 9) {
      throw new Error("Runtime DB meta is missing conversation identity keys");
    }
  } finally {
    db.close();
  }
}

export function sha256File(path) {
  const hash = createHash("sha256");
  const bytes = readFileSync(path);
  hash.update(bytes);
  return hash.digest("hex");
}

function resolveFrom(cwd, pathValue) {
  return pathValue.startsWith("/") ? pathValue : join(cwd, pathValue);
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entrypoint) {
  await prepareRuntimeData();
}
