import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { realMessageWhere, type MessageKind } from "../src/lib/conversation/filters";

type Metric = {
  key: string;
  label: string;
  group: string;
  value: number;
  reason: string;
};

type Snapshot = {
  generated_at: string;
  db_path: string;
  db_generated_at: string | null;
  metrics: Record<string, Metric>;
};

type ReportMetric = {
  key: string;
  label: string;
  group: string;
  old: number | null;
  new: number | null;
  delta: number | null;
  delta_pct: number | null;
  changed: boolean;
  reason: string;
};

type Report = {
  generated_at: string;
  baseline_path: string;
  current_path: string;
  baseline_initialized: boolean;
  summary: {
    metric_count: number;
    changed_count: number;
    largest_abs_delta_pct: number | null;
  };
  metrics: ReportMetric[];
  top_deltas: ReportMetric[];
};

const PROJECT = new URL("..", import.meta.url).pathname;
const DB_PATH = process.env.RUNTIME_DB_PATH ?? join(PROJECT, "data/runtime/conversation.db");
const OUT_DIR = join(PROJECT, "data/migration");
const BASELINE_PATH = join(OUT_DIR, "baseline.json");
const CURRENT_PATH = join(OUT_DIR, "current.json");
const REPORT_PATH = join(OUT_DIR, "report-latest.json");

const MESSAGE_KIND_LABELS: Array<[MessageKind, string]> = [
  ["all_row", "All message rows"],
  ["visible_message", "Visible non-reaction rows"],
  ["text_turn", "Text turn rows"],
  ["segmentable_text", "Segmentable text rows"],
  ["object_message", "Object/app rows"],
  ["reaction_add", "Tapback additions"],
  ["reaction_remove", "Tapback removals"],
];

const REASONS = {
  messageKind: "Named message-kind predicates changed; this catches ghost rows, reactions, and object-message drift.",
  monthly: "Monthly volume audit for timezone and message-kind changes.",
  category: "Category taxonomy/status migration audit.",
  segment: "Segmentation/topic migration audit.",
  phase: "Materialized season table audit.",
  comparison: "Comparison cohort ETL audit.",
  phrase: "Phrase-model artifact audit.",
} as const;

main();

function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const current = collectSnapshot();
  writeJson(CURRENT_PATH, current);

  let baselineInitialized = false;
  let baseline: Snapshot;
  if (existsSync(BASELINE_PATH)) {
    baseline = readJson<Snapshot>(BASELINE_PATH);
  } else {
    baseline = current;
    baselineInitialized = true;
    writeJson(BASELINE_PATH, baseline);
  }

  const report = buildReport(baseline, current, baselineInitialized);
  writeJson(REPORT_PATH, report);

  console.log(`[compare] baseline: ${BASELINE_PATH}`);
  console.log(`[compare] current: ${CURRENT_PATH}`);
  console.log(`[compare] report: ${REPORT_PATH}`);
  console.log(
    `[compare] ${report.summary.changed_count}/${report.summary.metric_count} metrics changed` +
      (baselineInitialized ? " (baseline initialized from current DB)" : ""),
  );
}

function collectSnapshot(): Snapshot {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  db.pragma("query_only = ON");

  const metrics: Record<string, Metric> = {};
  const add = (key: string, label: string, group: string, value: number, reason: string) => {
    metrics[key] = {
      key,
      label,
      group,
      value,
      reason,
    };
  };

  const dbGeneratedAt = tableExists(db, "meta")
    ? stringScalar(db, "SELECT v FROM meta WHERE k = 'generated_at'")
    : null;

  if (tableExists(db, "messages")) {
    add("messages.total", "All message rows", "Messages", count(db, "messages"), REASONS.messageKind);
    add("messages.from_me", "Rows from Me", "Messages", scalar(db, "SELECT COUNT(*) FROM messages WHERE is_from_me = 1"), REASONS.messageKind);
    add("messages.from_them", "Rows from Them", "Messages", scalar(db, "SELECT COUNT(*) FROM messages WHERE is_from_me = 0"), REASONS.messageKind);
    add("messages.with_attachments", "Rows with attachments", "Messages", scalar(db, "SELECT COUNT(*) FROM messages WHERE has_attachment = 1"), REASONS.messageKind);
    add("messages.active_days", "Active local days", "Messages", scalar(db, "SELECT COUNT(DISTINCT ymd) FROM messages"), REASONS.monthly);

    for (const [kind, label] of MESSAGE_KIND_LABELS) {
      add(`messages.kind.${kind}`, label, "Message predicates", scalar(db, `SELECT COUNT(*) FROM messages WHERE ${realMessageWhere(kind)}`), REASONS.messageKind);
    }

    const monthly = db
      .prepare(
        `
        SELECT ym, COUNT(*) AS n
        FROM messages
        WHERE ${realMessageWhere("visible_message")}
        GROUP BY ym
        ORDER BY ym
      `,
      )
      .all() as Array<{ ym: string; n: number }>;
    for (const row of monthly) {
      add(`messages.month.${row.ym}`, `Visible messages in ${row.ym}`, "Monthly volume", row.n, REASONS.monthly);
    }
  }

  if (tableExists(db, "seg_segments")) {
    add("segments.total", "Segments", "Segments", count(db, "seg_segments"), REASONS.segment);
    add("segments.topic_outliers", "Topic outlier segments", "Segments", scalar(db, "SELECT COUNT(*) FROM seg_segments WHERE topic_id IS NULL"), REASONS.segment);
    add("segments.with_topic", "Segments with a topic", "Segments", scalar(db, "SELECT COUNT(*) FROM seg_segments WHERE topic_id IS NOT NULL"), REASONS.segment);
    add("segments.messages_mapped", "Messages mapped to segments", "Segments", tableExists(db, "seg_msg_segment") ? count(db, "seg_msg_segment") : 0, REASONS.segment);
  }

  if (tableExists(db, "seg_links")) {
    add("segments.links", "Consecutive segment links", "Segments", count(db, "seg_links"), REASONS.segment);
  }

  if (tableExists(db, "seg_category_transitions")) {
    add("segments.category_transition_edges", "Category transition edges", "Segments", count(db, "seg_category_transitions"), REASONS.segment);
    add("segments.category_transition_total", "Category transition observations", "Segments", scalar(db, "SELECT COALESCE(SUM(n), 0) FROM seg_category_transitions"), REASONS.segment);
  }

  if (tableExists(db, "seg_segment_categories")) {
    add("categories.rows", "Segment category rows", "Categories", count(db, "seg_segment_categories"), REASONS.category);
    const hasStatus = columnExists(db, "seg_segment_categories", "category_status");
    if (hasStatus) {
      const statusRows = db
        .prepare(
          `
          SELECT COALESCE(category_status, 'unknown') AS status, COUNT(*) AS n
          FROM seg_segment_categories
          GROUP BY COALESCE(category_status, 'unknown')
          ORDER BY status
        `,
        )
        .all() as Array<{ status: string; n: number }>;
      for (const row of statusRows) {
        add(`categories.status.${row.status}`, `Category status: ${row.status}`, "Category status", row.n, REASONS.category);
      }
    } else {
      add("categories.status.legacy_category_only", "Legacy category-only rows", "Category status", count(db, "seg_segment_categories"), REASONS.category);
    }

    const categoryRows = db
      .prepare(
        `
        SELECT COALESCE(category, 'uncategorized') AS category, COUNT(*) AS n
        FROM seg_segment_categories
        GROUP BY COALESCE(category, 'uncategorized')
        ORDER BY category
      `,
      )
      .all() as Array<{ category: string; n: number }>;
    for (const row of categoryRows) {
      add(`categories.primary.${row.category}`, `Primary category: ${row.category}`, "Category mix", row.n, REASONS.category);
    }
  }

  if (tableExists(db, "seg_seasons")) {
    add("phases.count", "Materialized phases", "Phases", count(db, "seg_seasons"), REASONS.phase);
    const seasons = db.prepare("SELECT start_ym, end_ym FROM seg_seasons").all() as Array<{ start_ym: string; end_ym: string }>;
    add("phases.total_months", "Months covered by phases", "Phases", seasons.reduce((total, row) => total + monthSpan(row.start_ym, row.end_ym), 0), REASONS.phase);
    add("phases.longest_months", "Longest phase in months", "Phases", Math.max(0, ...seasons.map((row) => monthSpan(row.start_ym, row.end_ym))), REASONS.phase);
  }

  if (tableExists(db, "cmp_people")) {
    add("comparison.people", "Comparison cohort people", "Comparison", count(db, "cmp_people"), REASONS.comparison);
    add("comparison.them_rows", "Them rows in comparison cohort", "Comparison", scalar(db, "SELECT COUNT(*) FROM cmp_people WHERE is_them = 1"), REASONS.comparison);
  }

  if (tableExists(db, "phrase_bigrams")) {
    add("phrases.bigrams", "Phrase bigrams", "Phrases", count(db, "phrase_bigrams"), REASONS.phrase);
  }
  if (tableExists(db, "phrase_trigrams")) {
    add("phrases.trigrams", "Phrase trigrams", "Phrases", count(db, "phrase_trigrams"), REASONS.phrase);
  }

  db.close();
  return {
    generated_at: new Date().toISOString(),
    db_path: displayPath(DB_PATH),
    db_generated_at: dbGeneratedAt,
    metrics,
  };
}

function buildReport(baseline: Snapshot, current: Snapshot, baselineInitialized: boolean): Report {
  const keys = Array.from(new Set([...Object.keys(baseline.metrics), ...Object.keys(current.metrics)])).sort();
  const metrics = keys.map((key): ReportMetric => {
    const oldMetric = baseline.metrics[key];
    const newMetric = current.metrics[key];
    const oldValue = oldMetric?.value ?? null;
    const newValue = newMetric?.value ?? null;
    const delta = oldValue == null || newValue == null ? null : newValue - oldValue;
    const deltaPct = delta == null || oldValue == null || oldValue === 0 ? (delta === 0 ? 0 : null) : (delta / oldValue) * 100;
    return {
      key,
      label: newMetric?.label ?? oldMetric?.label ?? key,
      group: newMetric?.group ?? oldMetric?.group ?? "Unknown",
      old: oldValue,
      new: newValue,
      delta,
      delta_pct: deltaPct,
      changed: oldValue !== newValue,
      reason: newMetric?.reason ?? oldMetric?.reason ?? "Metric added or removed.",
    };
  });

  const changed = metrics.filter((metric) => metric.changed);
  const finitePct = changed
    .map((metric) => metric.delta_pct)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const topDeltas = [...changed]
    .sort((a, b) => {
      const pctDiff = Math.abs(b.delta_pct ?? 0) - Math.abs(a.delta_pct ?? 0);
      if (pctDiff !== 0) return pctDiff;
      return Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0);
    })
    .slice(0, 12);

  return {
    generated_at: new Date().toISOString(),
    baseline_path: displayPath(BASELINE_PATH),
    current_path: displayPath(CURRENT_PATH),
    baseline_initialized: baselineInitialized,
    summary: {
      metric_count: metrics.length,
      changed_count: changed.length,
      largest_abs_delta_pct: finitePct.length ? Math.max(...finitePct.map((value) => Math.abs(value))) : null,
    },
    metrics,
    top_deltas: topDeltas,
  };
}

function tableExists(db: Database.Database, table: string) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function columnExists(db: Database.Database, table: string, column: string) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function count(db: Database.Database, table: string) {
  return scalar(db, `SELECT COUNT(*) FROM ${table}`);
}

function scalar(db: Database.Database, sql: string) {
  const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
  if (!row) return 0;
  const value = Object.values(row)[0];
  return Number(value ?? 0);
}

function stringScalar(db: Database.Database, sql: string) {
  const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
  if (!row) return null;
  const value = Object.values(row)[0];
  return typeof value === "string" ? value : value == null ? null : String(value);
}

function monthSpan(startYm: string, endYm: string) {
  const [startYear, startMonth] = startYm.split("-").map(Number);
  const [endYear, endMonth] = endYm.split("-").map(Number);
  if (!startYear || !startMonth || !endYear || !endMonth) return 0;
  return (endYear - startYear) * 12 + (endMonth - startMonth) + 1;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function writeJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function displayPath(path: string) {
  const rel = relative(PROJECT, path);
  return rel.startsWith("..") || rel === "" ? path : rel;
}
