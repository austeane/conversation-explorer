import { createServerFn } from "@tanstack/react-start";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { db, withDbCache } from "~/lib/server-db";

export type MethodOverview = {
  generated_at: string | null;
  segment_count: number;
  topic_outlier_count: number;
  phase_count: number;
  phase_method: string | null;
  category_status_available: boolean;
  category_status_counts: Array<{ status: string; n: number }>;
  topic_stability: {
    exists: boolean;
    topics: number;
    mean: number | null;
    min: number | null;
    low_count: number;
    method: string | null;
  };
  eval_report: {
    exists: boolean;
    path: string;
    summary: string | null;
    overall: {
      total: number;
      accuracy: number;
      macro_f1: number;
    } | null;
    suites: Array<{
      name: string;
      total: number;
      accuracy: number;
      macro_f1: number;
    }>;
  };
  eval_labels: {
    current_total: number;
    target_total: number;
    suites: Array<{
      name: string;
      current: number;
      target: number;
      remaining: number;
      path: string;
    }>;
  };
  migration_report: {
    exists: boolean;
    path: string | null;
    summary: string | null;
    metric_count: number;
    changed_count: number;
    largest_abs_delta_pct: number | null;
    baseline_initialized: boolean;
    top_deltas: Array<{
      key: string;
      label: string;
      old: number | null;
      new: number | null;
      delta_pct: number | null;
      reason: string;
    }>;
  };
};

export const getMethodOverview = createServerFn({ method: "GET" }).handler(async (): Promise<MethodOverview> => {
  return withDbCache("methods", () => {
    const d = db();
    const generated = d.prepare("SELECT v FROM meta WHERE k = 'generated_at'").get() as { v: string } | undefined;
    const segmentCount = d.prepare("SELECT COUNT(*) AS n FROM seg_segments").get() as { n: number };
    const topicOutliers = d.prepare("SELECT COUNT(*) AS n FROM seg_segments WHERE topic_id IS NULL").get() as { n: number };
    const hasSeasons = Boolean(d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'seg_seasons'").get());
    const phaseSummary = hasSeasons
      ? (d
          .prepare("SELECT COUNT(*) AS n, MAX(method) AS method FROM seg_seasons")
          .get() as { n: number; method: string | null })
      : { n: 0, method: null };
    const categoryColumns = d.prepare("PRAGMA table_info(seg_segment_categories)").all() as Array<{ name: string }>;
    const hasCategoryStatus = categoryColumns.some((column) => column.name === "category_status");
    const statusCounts = hasCategoryStatus
      ? (d
          .prepare(
            `
            SELECT COALESCE(category_status, 'unknown') AS status, COUNT(*) AS n
            FROM seg_segment_categories
            GROUP BY COALESCE(category_status, 'unknown')
            ORDER BY n DESC
          `,
          )
          .all() as Array<{ status: string; n: number }>)
      : [
          {
            status: "legacy_category_only",
            n: (d.prepare("SELECT COUNT(*) AS n FROM seg_segment_categories").get() as { n: number }).n,
          },
        ];

    return {
      generated_at: generated?.v ?? null,
      segment_count: segmentCount.n,
      topic_outlier_count: topicOutliers.n,
      phase_count: phaseSummary.n,
      phase_method: phaseSummary.method,
      category_status_available: hasCategoryStatus,
      category_status_counts: statusCounts,
      topic_stability: topicStabilitySummary(d),
      eval_report: readEvalReport(),
      eval_labels: readEvalLabelProgress(),
      migration_report: latestMigrationReport(),
    };
  });
});

const EVAL_LABEL_TARGETS = [
  { name: "segment_categories", file: "segment_categories.jsonl", target: 200 },
  { name: "turn_moves", file: "turn_moves.jsonl", target: 200 },
  { name: "strain_repair", file: "strain_repair.jsonl", target: 100 },
  { name: "restart_openers", file: "restart_openers.jsonl", target: 100 },
] as const;

function topicStabilitySummary(d: ReturnType<typeof db>): MethodOverview["topic_stability"] {
  const table = d.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'seg_topic_stability'").get();
  if (!table) {
    return { exists: false, topics: 0, mean: null, min: null, low_count: 0, method: null };
  }

  const row = d
    .prepare(
      `
      SELECT
        COUNT(*) AS topics,
        AVG(jaccard_mean) AS mean,
        MIN(jaccard_mean) AS min,
        SUM(CASE WHEN jaccard_mean < 0.6 THEN 1 ELSE 0 END) AS low_count,
        MAX(method) AS method
      FROM seg_topic_stability
      `,
    )
    .get() as { topics: number; mean: number | null; min: number | null; low_count: number | null; method: string | null };

  return {
    exists: true,
    topics: row.topics,
    mean: row.mean,
    min: row.min,
    low_count: row.low_count ?? 0,
    method: row.method,
  };
}

function readEvalReport() {
  const path = join(process.cwd(), "data/eval/report.json");
  if (!existsSync(path)) return { exists: false, path: displayPath(path), summary: null, overall: null, suites: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      summary?: string;
      generated_at?: string;
      overall?: { total?: number; accuracy?: number; macro_f1?: number };
      suites?: Array<{ name?: string; total?: number; accuracy?: number; macro_f1?: number }>;
    };
    return {
      exists: true,
      path: displayPath(path),
      summary: parsed.summary ?? (parsed.generated_at ? `Generated ${parsed.generated_at}` : "Report present"),
      overall: parsed.overall
        ? {
            total: parsed.overall.total ?? 0,
            accuracy: parsed.overall.accuracy ?? 0,
            macro_f1: parsed.overall.macro_f1 ?? 0,
          }
        : null,
      suites: (parsed.suites ?? []).map((suite) => ({
        name: suite.name ?? "unknown",
        total: suite.total ?? 0,
        accuracy: suite.accuracy ?? 0,
        macro_f1: suite.macro_f1 ?? 0,
      })),
    };
  } catch (err) {
    return {
      exists: true,
      path: displayPath(path),
      summary: `Could not parse report: ${(err as Error).message}`,
      overall: null,
      suites: [],
    };
  }
}

function readEvalLabelProgress(): MethodOverview["eval_labels"] {
  const base = join(process.cwd(), "data/eval");
  const suites = EVAL_LABEL_TARGETS.map((suite) => {
    const path = join(base, suite.file);
    const current = countJsonlRows(path);
    return {
      name: suite.name,
      current,
      target: suite.target,
      remaining: Math.max(0, suite.target - current),
      path: displayPath(path),
    };
  });
  return {
    current_total: suites.reduce((sum, suite) => sum + suite.current, 0),
    target_total: suites.reduce((sum, suite) => sum + suite.target, 0),
    suites,
  };
}

function countJsonlRows(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf-8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0).length;
}

function latestMigrationReport() {
  const dir = join(process.cwd(), "data/migration");
  if (!existsSync(dir)) return emptyMigrationReport();
  const reports = readdirSync(dir)
    .filter((name) => /^report.*\.json$/.test(name))
    .sort();
  const latest = reports[reports.length - 1];
  if (!latest) return emptyMigrationReport();

  const path = join(dir, latest);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      baseline_initialized?: boolean;
      summary?: {
        metric_count?: number;
        changed_count?: number;
        largest_abs_delta_pct?: number | null;
      };
      top_deltas?: Array<{
        key?: string;
        label?: string;
        old?: number | null;
        new?: number | null;
        delta_pct?: number | null;
        reason?: string;
      }>;
    };
    const metricCount = parsed.summary?.metric_count ?? 0;
    const changedCount = parsed.summary?.changed_count ?? 0;
    const initialized = Boolean(parsed.baseline_initialized);
    return {
      exists: true,
      path: displayPath(path),
      summary:
        `${changedCount} of ${metricCount} metrics changed` +
        (initialized ? " (baseline initialized from current DB)" : ""),
      metric_count: metricCount,
      changed_count: changedCount,
      largest_abs_delta_pct: parsed.summary?.largest_abs_delta_pct ?? null,
      baseline_initialized: initialized,
      top_deltas: (parsed.top_deltas ?? []).slice(0, 8).map((row) => ({
        key: row.key ?? "unknown",
        label: row.label ?? row.key ?? "Unknown metric",
        old: typeof row.old === "number" ? row.old : null,
        new: typeof row.new === "number" ? row.new : null,
        delta_pct: typeof row.delta_pct === "number" ? row.delta_pct : null,
        reason: row.reason ?? "Metric changed.",
      })),
    };
  } catch (err) {
    return {
      exists: true,
      path,
      summary: `Could not parse report: ${(err as Error).message}`,
      metric_count: 0,
      changed_count: 0,
      largest_abs_delta_pct: null,
      baseline_initialized: false,
      top_deltas: [],
    };
  }
}

function emptyMigrationReport() {
  return {
    exists: false,
    path: null,
    summary: null,
    metric_count: 0,
    changed_count: 0,
    largest_abs_delta_pct: null,
    baseline_initialized: false,
    top_deltas: [],
  };
}

function displayPath(path: string) {
  const rel = relative(process.cwd(), path);
  return rel.startsWith("..") || rel === "" ? path : rel;
}
