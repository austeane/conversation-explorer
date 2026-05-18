import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReadStream, createWriteStream, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";

import { prepareRuntimeData, sha256File, validateRuntimeDb } from "../scripts/prepare-runtime-data.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixtureDb = join(root, "data/fixtures/tiny.db");

let tempDir: string;

describe("runtime database artifact workflow", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "runtime-artifact-"));
  });

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it("validates the fixture schema expected by runtime preparation", () => {
    validateRuntimeDb(fixtureDb, { minBytes: 1 });
  });

  it("inflates a local fixture gzip with a matching checksum", async () => {
    const dbPath = join(tempDir, "conversation.db");
    const gzipPath = `${dbPath}.gz`;
    await pipeline(createReadStream(fixtureDb), createGzip(), createWriteStream(gzipPath));

    const result = await prepareRuntimeData({
      cwd: tempDir,
      env: {
        NODE_ENV: "development",
        RUNTIME_DB_PATH: dbPath,
        RUNTIME_DB_GZIP_PATH: gzipPath,
        RUNTIME_DB_SHA256: sha256File(gzipPath),
        RUNTIME_DB_MIN_BYTES: "1",
      },
      log: () => undefined,
    });

    expect(result.source).toBe("local-gzip");
    expect(existsSync(dbPath)).toBe(true);
    const conn = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const generatedAt = conn.prepare("SELECT v FROM meta WHERE k = 'generated_at'").get() as { v: string };
      expect(generatedAt.v).toBe("fixture-1");
    } finally {
      conn.close();
    }
  });

  it("rejects a local gzip with the wrong checksum", async () => {
    const dbPath = join(tempDir, "conversation.db");
    const gzipPath = `${dbPath}.gz`;
    await pipeline(createReadStream(fixtureDb), createGzip(), createWriteStream(gzipPath));

    await expect(
      prepareRuntimeData({
        cwd: tempDir,
        env: {
          NODE_ENV: "development",
          RUNTIME_DB_PATH: dbPath,
          RUNTIME_DB_GZIP_PATH: gzipPath,
          RUNTIME_DB_SHA256: "0".repeat(64),
          RUNTIME_DB_MIN_BYTES: "1",
        },
        log: () => undefined,
      }),
    ).rejects.toThrow(/checksum mismatch/);
  });
});
