import { createServerFn } from "@tanstack/react-start";
import {
  addMessageScopeFilters,
  messageScopeInput,
  type MessageScope,
} from "~/lib/conversation/scope";
import { bucket } from "~/lib/conversation/time";
import { isExcludedTopicCategory } from "~/lib/conversation/topic-hygiene";
import { db, getDataGeneratedAt, withDbCache } from "~/lib/server-db";
import { resolveMessageScope } from "~/server/scope";

const ROLLING_WINDOW_MONTHS = 6;
const MIN_SEGMENTS_PER_MONTH = 10;
const TOP_MONTHS = 8;

export type TurningPointCategory = {
  category: string;
  n: number;
  share: number;
  baseline_share: number;
  delta: number;
};

export type TurningPointTopic = {
  topic_id: number;
  label: string | null;
  n: number;
  share: number;
  top_words: string[];
};

export type TurningPointSegment = {
  id: number;
  start_ts: number;
  end_ts: number;
  n_msgs: number;
  category: string;
  topic_label: string | null;
  preview: string;
};

export type TurningPointMonth = {
  ym: string;
  total: number;
  baseline_total: number;
  divergence: number;
  categories: TurningPointCategory[];
  topics: TurningPointTopic[];
  segments: TurningPointSegment[];
};

export type CategorySurge = {
  ym: string;
  category: string;
  n: number;
  share: number;
  baseline_share: number;
  delta: number;
};

export type TopicArrival = {
  ym: string;
  topic_id: number;
  label: string | null;
  n: number;
  share: number;
  months_since_seen: number | null;
  top_words: string[];
};

export type TurningPointOverview = {
  generated_at: string;
  window_months: number;
  months_total: number;
  months_analyzed: number;
  min_segments_per_month: number;
  top_months: TurningPointMonth[];
  monthly_divergence: Array<{ ym: string; divergence: number; total: number }>;
  category_surges: CategorySurge[];
  topic_arrivals: TopicArrival[];
};

type CategoryCountRow = {
  ym: string;
  category: string;
  n: number;
};

type TopicCountRow = {
  ym: string;
  topic_id: number;
  label: string | null;
  top_words: string | null;
  n: number;
};

type MonthSlot = {
  ym: string;
  total: number;
  categories: Map<string, number>;
  topics: TopicCountRow[];
};

type CategorySegmentRow = {
  start_ts: number;
  category: string;
};

type TopicSegmentRow = {
  start_ts: number;
  topic_id: number;
  label: string | null;
  top_words: string | null;
};

export const getTurningPoints = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => messageScopeInput.parse(d ?? {}))
  .handler(async ({ data }): Promise<TurningPointOverview> => {
    const resolved = resolveMessageScope(data);
    return withDbCache(`turning-points:${JSON.stringify(resolved)}`, () => {
    const segmentScope = segmentScopeFilter(resolved);

    const categorySegmentRows = db()
      .prepare(
        `
        SELECT s.start_ts,
               COALESCE(c.category, 'unclassified') AS category
        FROM seg_segments s
        LEFT JOIN seg_segment_categories c ON c.segment_id = s.id
        ${segmentScope.condition ? `WHERE ${segmentScope.condition}` : ""}
        ORDER BY s.start_ts ASC
      `,
      )
      .all(...segmentScope.args) as CategorySegmentRow[];

    const topicSegmentRows = db()
      .prepare(
        `
        SELECT s.start_ts,
               s.topic_id,
               t.label,
               t.top_words
        FROM seg_segments s
        JOIN seg_topics t ON t.id = s.topic_id
        WHERE s.topic_id IS NOT NULL
          ${segmentScope.condition ? `AND ${segmentScope.condition}` : ""}
        ORDER BY s.start_ts ASC
      `,
      )
      .all(...segmentScope.args) as TopicSegmentRow[];

    const categoryRows = summarizeCategoryRows(
      categorySegmentRows.filter((row) => !isExcludedTopicCategory(row.category)),
    );
    const topicRows = summarizeTopicRows(
      topicSegmentRows.filter((row) => !isExcludedTopicCategory(row.label)),
    );
    const months = buildMonths(categoryRows, topicRows);
    const categories = [...new Set(categoryRows.map((r) => r.category))];
    const rankedMonths: TurningPointMonth[] = [];
    const monthlyDivergence: Array<{ ym: string; divergence: number; total: number }> = [];
    const surges: CategorySurge[] = [];

    for (let i = 0; i < months.length; i += 1) {
      const month = months[i];
      if (month.total < MIN_SEGMENTS_PER_MONTH) continue;

      const baseline = aggregateBaseline(months, i, ROLLING_WINDOW_MONTHS);
      if (baseline.total < MIN_SEGMENTS_PER_MONTH) continue;

      const divergence = jsDivergence(month.categories, month.total, baseline.categories, baseline.total, categories);
      const monthCategories = categories
        .map((category) => {
          const n = month.categories.get(category) ?? 0;
          const share = n / month.total;
          const baselineShare = (baseline.categories.get(category) ?? 0) / baseline.total;
          return {
            category,
            n,
            share,
            baseline_share: baselineShare,
            delta: share - baselineShare,
          };
        })
        .filter((c) => c.n > 0 || Math.abs(c.delta) >= 0.03)
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

      monthlyDivergence.push({ ym: month.ym, divergence, total: month.total });
      for (const c of monthCategories) {
        if (c.n >= 2 && c.delta >= 0.06) {
          surges.push({ ym: month.ym, ...c });
        }
      }

      rankedMonths.push({
        ym: month.ym,
        total: month.total,
        baseline_total: baseline.total,
        divergence,
        categories: monthCategories.slice(0, 6),
        topics: topTopics(month),
        segments: [],
      });
    }

    rankedMonths.sort((a, b) => b.divergence - a.divergence);
    const topMonths = rankedMonths.slice(0, TOP_MONTHS);
    const segmentLookup = representativeSegments(topMonths.map((m) => m.ym), resolved);
    for (const month of topMonths) {
      month.segments = segmentLookup.get(month.ym) ?? [];
    }

    surges.sort((a, b) => b.delta - a.delta || b.n - a.n);

    const result = {
      generated_at: getDataGeneratedAt(),
      window_months: ROLLING_WINDOW_MONTHS,
      months_total: months.length,
      months_analyzed: monthlyDivergence.length,
      min_segments_per_month: MIN_SEGMENTS_PER_MONTH,
      top_months: topMonths,
      monthly_divergence: monthlyDivergence,
      category_surges: surges.slice(0, 14),
      topic_arrivals: topicArrivals(months).slice(0, 14),
    };
    return result;
    });
  },
);

function summarizeCategoryRows(rows: CategorySegmentRow[]): CategoryCountRow[] {
  const counts = new Map<string, CategoryCountRow>();
  for (const row of rows) {
    const ym = bucket(row.start_ts, "ym");
    const key = `${ym}\0${row.category}`;
    const existing = counts.get(key) ?? { ym, category: row.category, n: 0 };
    existing.n += 1;
    counts.set(key, existing);
  }
  return [...counts.values()].sort((a, b) => a.ym.localeCompare(b.ym) || b.n - a.n);
}

function summarizeTopicRows(rows: TopicSegmentRow[]): TopicCountRow[] {
  const counts = new Map<string, TopicCountRow>();
  for (const row of rows) {
    const ym = bucket(row.start_ts, "ym");
    const key = `${ym}\0${row.topic_id}`;
    const existing = counts.get(key) ?? {
      ym,
      topic_id: row.topic_id,
      label: row.label,
      top_words: row.top_words,
      n: 0,
    };
    existing.n += 1;
    counts.set(key, existing);
  }
  return [...counts.values()]
    .filter((row) => row.n >= 2)
    .sort((a, b) => a.ym.localeCompare(b.ym) || b.n - a.n);
}

function buildMonths(categoryRows: CategoryCountRow[], topicRows: TopicCountRow[]): MonthSlot[] {
  const byYm = new Map<string, MonthSlot>();
  for (const row of categoryRows) {
    const slot = byYm.get(row.ym) ?? {
      ym: row.ym,
      total: 0,
      categories: new Map<string, number>(),
      topics: [],
    };
    slot.total += row.n;
    slot.categories.set(row.category, row.n);
    byYm.set(row.ym, slot);
  }
  for (const row of topicRows) {
    const slot = byYm.get(row.ym);
    if (slot) slot.topics.push(row);
  }
  return [...byYm.values()].sort((a, b) => a.ym.localeCompare(b.ym));
}

function aggregateBaseline(months: MonthSlot[], currentIndex: number, windowMonths: number) {
  const start = Math.max(0, currentIndex - windowMonths);
  const categories = new Map<string, number>();
  let total = 0;
  for (let i = start; i < currentIndex; i += 1) {
    total += months[i].total;
    for (const [category, n] of months[i].categories.entries()) {
      categories.set(category, (categories.get(category) ?? 0) + n);
    }
  }
  return { total, categories };
}

function jsDivergence(
  current: Map<string, number>,
  currentTotal: number,
  baseline: Map<string, number>,
  baselineTotal: number,
  categories: string[],
) {
  let total = 0;
  for (const category of categories) {
    const p = (current.get(category) ?? 0) / currentTotal;
    const q = (baseline.get(category) ?? 0) / baselineTotal;
    const m = (p + q) / 2;
    if (p > 0 && m > 0) total += 0.5 * p * Math.log2(p / m);
    if (q > 0 && m > 0) total += 0.5 * q * Math.log2(q / m);
  }
  return total;
}

function topTopics(month: MonthSlot): TurningPointTopic[] {
  return [...month.topics]
    .sort((a, b) => b.n - a.n)
    .slice(0, 5)
    .map((t) => ({
      topic_id: t.topic_id,
      label: t.label,
      n: t.n,
      share: t.n / month.total,
      top_words: safeJsonArray(t.top_words).slice(0, 5),
    }));
}

function representativeSegments(yms: string[], scope: MessageScope) {
  const byYm = new Map<string, TurningPointSegment[]>();
  if (yms.length === 0) return byYm;
  const ymSet = new Set(yms);
  const segmentScope = segmentScopeFilter(scope);

  const rows = db().prepare(
    `
    SELECT s.id, s.start_ts, s.end_ts, s.n_msgs,
           COALESCE(c.category, 'unclassified') AS category,
           t.label AS topic_label,
           (
             SELECT GROUP_CONCAT(SUBSTR(m.text, 1, 90), ' • ')
             FROM (
               SELECT m2.text
               FROM seg_msg_segment sm2
               JOIN messages m2 ON m2.id = sm2.msg_id
               WHERE sm2.segment_id = s.id
                 AND m2.text IS NOT NULL AND length(trim(m2.text)) > 0
               ORDER BY m2.ts ASC
               LIMIT 3
             ) m
           ) AS preview
    FROM seg_segments s
    LEFT JOIN seg_segment_categories c ON c.segment_id = s.id
    LEFT JOIN seg_topics t ON t.id = s.topic_id
    ${segmentScope.condition ? `WHERE ${segmentScope.condition}` : ""}
    ORDER BY s.n_msgs DESC
    LIMIT 500
  `,
  ).all(...segmentScope.args) as Array<TurningPointSegment & { preview: string | null }>;

  for (const row of rows) {
    const ym = bucket(row.start_ts, "ym");
    if (!ymSet.has(ym)) continue;
    const existing = byYm.get(ym) ?? [];
    if (existing.length >= 4) continue;
    existing.push({ ...row, preview: row.preview ?? "" });
    byYm.set(ym, existing);
  }
  return byYm;
}

function segmentScopeFilter(scope: MessageScope) {
  const where: string[] = [];
  const args: Array<string | number> = [];
  addMessageScopeFilters(where, args, scope, "m_scope");
  if (where.length === 0) return { condition: "", args };
  return {
    condition: `
      EXISTS (
        SELECT 1
        FROM seg_msg_segment sm_scope
        JOIN messages m_scope ON m_scope.id = sm_scope.msg_id
        WHERE sm_scope.segment_id = s.id
          AND ${where.join(" AND ")}
      )
    `,
    args,
  };
}

function topicArrivals(months: MonthSlot[]): TopicArrival[] {
  const seen = new Map<number, number>();
  const arrivals: TopicArrival[] = [];
  for (let i = 0; i < months.length; i += 1) {
    const month = months[i];
    for (const topic of month.topics) {
      if (topic.n < 3) continue;
      const previous = seen.get(topic.topic_id);
      const gap = previous == null ? null : i - previous;
      if (i >= 3 && (previous == null || (gap != null && gap >= 10))) {
        arrivals.push({
          ym: month.ym,
          topic_id: topic.topic_id,
          label: topic.label,
          n: topic.n,
          share: topic.n / month.total,
          months_since_seen: gap,
          top_words: safeJsonArray(topic.top_words).slice(0, 6),
        });
      }
      seen.set(topic.topic_id, i);
    }
  }
  arrivals.sort((a, b) => b.n - a.n || b.share - a.share);
  return arrivals;
}

function safeJsonArray<T = string>(s: string | null | undefined): T[] {
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}
