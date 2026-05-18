import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { sha256File, validateRuntimeDb } from "./prepare-runtime-data.mjs";

const cwd = process.cwd();
const dbPath = process.env.RUNTIME_DB_PATH
  ? resolveFrom(cwd, process.env.RUNTIME_DB_PATH)
  : join(cwd, "data/runtime/conversation.db");
const gzipPath = process.env.RUNTIME_DB_GZIP_PATH
  ? resolveFrom(cwd, process.env.RUNTIME_DB_GZIP_PATH)
  : `${dbPath}.gz`;
const shaPath = `${gzipPath}.sha256`;

if (!existsSync(dbPath)) {
  throw new Error(`Runtime DB not found: ${dbPath}. Run pnpm etl first.`);
}

validateRuntimeDb(dbPath, { minBytes: Number(process.env.RUNTIME_DB_MIN_BYTES ?? 4096) });
mkdirSync(dirname(gzipPath), { recursive: true });
await pipeline(createReadStream(dbPath), createGzip({ level: 9 }), createWriteStream(gzipPath, { mode: 0o600 }));

const sha = sha256File(gzipPath);
writeFileSync(shaPath, `${sha}  ${gzipPath}\n`, { mode: 0o600 });

console.log(`[runtime:pack] db: ${dbPath} (${formatBytes(statSync(dbPath).size)})`);
console.log(`[runtime:pack] gzip: ${gzipPath} (${formatBytes(statSync(gzipPath).size)})`);
console.log(`[runtime:pack] sha256: ${sha}`);

function resolveFrom(cwd, pathValue) {
  return pathValue.startsWith("/") ? pathValue : join(cwd, pathValue);
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
