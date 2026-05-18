// Server-only better-sqlite3 singleton.
// This module is imported by files that TanStack also loads to create browser
// RPC stubs, so Node dependencies must be required lazily inside server calls.

import type DatabaseModule from "better-sqlite3";
import { LEXICONS } from "./conversation/lexicons";

type DatabaseConstructor = typeof DatabaseModule;
type DatabaseHandle = DatabaseModule.Database;
type FsModule = typeof import("node:fs");
type CryptoModule = typeof import("node:crypto");
type ModuleBuiltin = typeof import("node:module");

export const DB_PATH = processEnv("RUNTIME_DB_PATH") ?? projectPath("data/runtime/conversation.db");
const BASELINE_PATH = projectPath("data/baseline-frequencies.json");
const TOPIC_REPS_PATH = projectPath("data/topic_reps.json");
const EVAL_REPORT_PATH = projectPath("data/eval/report.json");
const TURN_MOVES_PATH = projectPath("data/eval/turn_moves.jsonl");
const MESSAGE_EMBEDDINGS_PATH = projectPath("data/embeddings_msg.npy");
const MESSAGE_EMBEDDING_IDS_PATH = projectPath("data/embeddings_msg_ids.npy");
const ATTACHMENT_EMBEDDINGS_PATH = projectPath("data/embeddings_attach.npy");
const ATTACHMENT_EMBEDDING_IDS_PATH = projectPath("data/embeddings_attach_ids.npy");
const MIGRATION_DIR = projectPath("data/migration");
const CATEGORIES_PATH = projectPath("src/lib/categories.ts");

let _db: DatabaseHandle | null = null;
let _databaseConstructor: DatabaseConstructor | null = null;
const dbCache = new Map<string, unknown>();

export function db(): DatabaseHandle {
  if (!_db) {
    const Database = databaseConstructor();
    _db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    try {
      _db.pragma("journal_mode = WAL");
    } catch {
      // Read-only fixture DBs cannot change journal mode. Query-only still
      // enforces the contract that app code must not write through this handle.
    }
    _db.pragma("query_only = ON");
  }
  return _db;
}

export function getDbVersion(): string {
  try {
    const row = db()
      .prepare("SELECT v FROM meta WHERE k = 'generated_at'")
      .get() as { v: string } | undefined;
    if (row?.v) return `meta:${row.v}:mtime:${artifactVersion(DB_PATH)}`;
  } catch {
    // Fall back to file metadata below. Some test or partial ETL states may not
    // have a readable meta table yet, but the DB file timestamp still changes.
  }
  return `mtime:${artifactVersion(DB_PATH)}`;
}

export function getDataGeneratedAt(): string {
  try {
    const row = db()
      .prepare("SELECT v FROM meta WHERE k = 'generated_at'")
      .get() as { v: string } | undefined;
    if (row?.v) return row.v;
  } catch {
    // Partial fixture DBs may not include the meta table yet.
  }

  try {
    return new Date(nodeBuiltin<FsModule>("node:fs").statSync(DB_PATH).mtimeMs).toISOString();
  } catch {
    return "unknown";
  }
}

export function getMethodVersion(): string {
  const lexiconDescriptor = Object.entries(LEXICONS)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, lexicon]) => ({
      kind,
      version: lexicon.version,
      tokens: lexicon.tokens,
      regex: lexicon.regex.source,
      phrases: lexicon.phrases?.map((phrase) => phrase.source) ?? [],
    }));

  return hashString(
    JSON.stringify({
      lexicons: lexiconDescriptor,
      topic_reps: artifactVersion(TOPIC_REPS_PATH),
      turn_moves: artifactVersion(TURN_MOVES_PATH),
      message_embeddings: artifactVersion(MESSAGE_EMBEDDINGS_PATH),
      message_embedding_ids: artifactVersion(MESSAGE_EMBEDDING_IDS_PATH),
      attachment_embeddings: artifactVersion(ATTACHMENT_EMBEDDINGS_PATH),
      attachment_embedding_ids: artifactVersion(ATTACHMENT_EMBEDDING_IDS_PATH),
      categories: artifactVersion(CATEGORIES_PATH),
    }),
  );
}

export function getBundleVersion(): string {
  return [
    `db=${getDbVersion()}`,
    `method=${getMethodVersion()}`,
    `baseline=${artifactVersion(BASELINE_PATH)}`,
    `eval=${artifactVersion(EVAL_REPORT_PATH)}`,
    `migration=${migrationReportsVersion()}`,
  ].join("|");
}

export function withDbCache<T>(scope: string, build: () => T): T {
  const key = `${scope}|${getBundleVersion()}`;
  if (dbCache.has(key)) return dbCache.get(key) as T;
  const result = build();
  dbCache.set(key, result);
  return result;
}

export function clearDbCache(scopePrefix?: string): number {
  if (!scopePrefix) {
    const count = dbCache.size;
    dbCache.clear();
    return count;
  }

  let cleared = 0;
  for (const key of dbCache.keys()) {
    if (!key.startsWith(scopePrefix)) continue;
    dbCache.delete(key);
    cleared += 1;
  }
  return cleared;
}

function artifactVersion(path: string): string {
  try {
    const fs = nodeBuiltin<FsModule>("node:fs");
    if (!fs.existsSync(path)) return "missing";
    const stat = fs.statSync(path);
    return `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  } catch (err) {
    return `error:${(err as Error).message}`;
  }
}

function migrationReportsVersion(): string {
  try {
    const fs = nodeBuiltin<FsModule>("node:fs");
    if (!fs.existsSync(MIGRATION_DIR)) return "missing";
    const reports = fs
      .readdirSync(MIGRATION_DIR)
      .filter((name) => /^report.*\.json$/.test(name))
      .sort();
    if (reports.length === 0) return "none";
    return reports.map((name) => `${name}:${artifactVersion(`${MIGRATION_DIR}/${name}`)}`).join(",");
  } catch (err) {
    return `error:${(err as Error).message}`;
  }
}

function hashString(value: string): string {
  return nodeBuiltin<CryptoModule>("node:crypto").createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function readTextFile(path: string): string {
  return nodeBuiltin<FsModule>("node:fs").readFileSync(path, "utf-8");
}

export function projectPath(relativePath: string): string {
  const proc = nodeProcess();
  if (!proc) return relativePath;
  return `${proc.cwd().replace(/\/$/, "")}/${relativePath.replace(/^\//, "")}`;
}

function processEnv(key: string): string | undefined {
  return nodeProcess()?.env?.[key];
}

function databaseConstructor(): DatabaseConstructor {
  if (_databaseConstructor) return _databaseConstructor;
  const loaded = nodeRequire()("better-sqlite3") as DatabaseConstructor & { default?: DatabaseConstructor };
  _databaseConstructor = loaded.default ?? loaded;
  return _databaseConstructor;
}

function nodeRequire(): NodeJS.Require {
  return nodeBuiltin<ModuleBuiltin>("node:module").createRequire(import.meta.url);
}

function nodeProcess(): (NodeJS.Process & { getBuiltinModule?: (id: string) => unknown }) | null {
  if (typeof process === "undefined" || !process.versions?.node) return null;
  return process as NodeJS.Process & { getBuiltinModule?: (id: string) => unknown };
}

function nodeBuiltin<T>(id: string): T {
  const getBuiltinModule = nodeProcess()?.getBuiltinModule;
  if (typeof getBuiltinModule !== "function") {
    throw new Error(`Server-only Node module requested outside Node runtime: ${id}`);
  }
  return getBuiltinModule(id) as T;
}
