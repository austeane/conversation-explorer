import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let conn: Database.Database;

describe("category-status persistence", () => {
  beforeAll(() => {
    conn = new Database(process.env.RUNTIME_DB_PATH, { readonly: true, fileMustExist: true });
  });

  afterAll(() => {
    conn.close();
  });

  it("keeps HDBSCAN outliers out of the small-talk bucket", () => {
    const rows = conn
      .prepare(
        `
        SELECT category, category_status, category_reason
        FROM seg_segment_categories
        WHERE category_status = 'topic_outlier'
        `,
      )
      .all() as Array<{ category: string | null; category_status: string; category_reason: string }>;

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.category !== "small_talk")).toBe(true);
    expect(rows.every((row) => row.category_reason === "hdbscan_outlier")).toBe(true);
  });
});
