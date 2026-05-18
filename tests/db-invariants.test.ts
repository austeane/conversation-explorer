import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let conn: Database.Database;

describe("database invariants", () => {
  beforeAll(() => {
    conn = new Database(process.env.RUNTIME_DB_PATH, { readonly: true, fileMustExist: true });
  });

  afterAll(() => {
    conn.close();
  });

  it("keeps message ids unique and timestamps populated", () => {
    const row = conn
      .prepare(
        `
        SELECT
          COUNT(*) AS total,
          COUNT(DISTINCT id) AS distinct_ids,
          SUM(CASE WHEN ts IS NULL THEN 1 ELSE 0 END) AS null_ts
        FROM messages
        `,
      )
      .get() as { total: number; distinct_ids: number; null_ts: number };

    expect(row.total).toBeGreaterThan(0);
    expect(row.distinct_ids).toBe(row.total);
    expect(row.null_ts).toBe(0);
  });

  it("has the analysis tables the app and eval runner rely on", () => {
    expect(tableExists("messages")).toBe(true);
    expect(tableExists("messages_fts")).toBe(true);
    expect(tableExists("seg_topics")).toBe(true);
    expect(tableExists("seg_topic_stability")).toBe(true);
    expect(tableExists("seg_segment_categories")).toBe(true);
    expect(tableExists("seg_seasons")).toBe(true);
    expect(tableExists("meta")).toBe(true);
  });

  it("has category-status columns and generated metadata", () => {
    const categoryColumns = columnsFor("seg_segment_categories");

    expect(categoryColumns).toContain("category_status");
    expect(categoryColumns).toContain("category_reason");
    expect(categoryColumns).toContain("secondary_category");
    expect(categoryColumns).toContain("secondary_score");

    const generatedAt = conn.prepare("SELECT v FROM meta WHERE k = 'generated_at'").get() as { v: string } | undefined;
    expect(generatedAt?.v).toBeTruthy();
  });

  it("materializes at least one phase for the global phase filter", () => {
    const row = conn.prepare("SELECT COUNT(*) AS count FROM seg_seasons").get() as { count: number };
    expect(row.count).toBeGreaterThan(0);
  });
});

function tableExists(name: string) {
  const row = conn
    .prepare("SELECT 1 FROM sqlite_master WHERE name = ? AND type IN ('table', 'virtual table')")
    .get(name);
  return Boolean(row);
}

function columnsFor(table: string) {
  return conn.prepare(`PRAGMA table_info(${table})`).all().map((row) => (row as { name: string }).name);
}
