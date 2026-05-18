import { createServerFn } from "@tanstack/react-start";
import { bucket, monthBounds } from "~/lib/conversation/time";
import { isExcludedTopicCategory } from "~/lib/conversation/topic-hygiene";
import { db, getDataGeneratedAt, withDbCache } from "~/lib/server-db";

const TARGET_SEASONS = 6;
const MIN_MONTHS_PER_SEASON = 4;
const MIN_SEGMENTS_PER_MONTH = 8;

export type SeasonCategory = {
  category: string;
  share: number;
  previous_share: number | null;
  delta_from_previous: number | null;
};

export type SeasonTopic = {
  topic_id: number;
  label: string | null;
  n: number;
  top_words: string[];
};

export type SeasonSegment = {
  id: number;
  start_ts: number;
  n_msgs: number;
  category: string;
  topic_label: string | null;
  preview: string;
};

export type Season = {
  id: number;
  start_ym: string;
  end_ym: string;
  n_months: number;
  total_segments: number;
  avg_segments_per_month: number;
  categories: SeasonCategory[];
  topics: SeasonTopic[];
  segments: SeasonSegment[];
};

export type SeasonMonth = {
  ym: string;
  season_id: number;
  total: number;
  dominant_category: string;
};

export type SeasonBreakpoint = {
  from_season_id: number;
  to_season_id: number;
  ym: string;
  shifts: SeasonCategory[];
};

export type SeasonOverview = {
  generated_at: string;
  months_total: number;
  months_analyzed: number;
  target_seasons: number;
  min_months_per_season: number;
  categories: string[];
  months: SeasonMonth[];
  seasons: Season[];
  breakpoints: SeasonBreakpoint[];
};

type CategoryCountRow = { ym: string; category: string; n: number };
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
  counts: Map<string, number>;
  vector: number[];
};

type SeasonRange = { start: number; end: number };

export const getSeasons = createServerFn({ method: "GET" }).handler(
  async (): Promise<SeasonOverview> => {
    return withDbCache("seasons", () => {
      const categoryRows = aggregateCategoryRows(
        (db()
        .prepare(
          `
          SELECT s.start_ts,
                 COALESCE(c.category, 'unclassified') AS category,
                 1 AS n
          FROM seg_segments s
          LEFT JOIN seg_segment_categories c ON c.segment_id = s.id
          ORDER BY s.start_ts ASC
        `,
        )
          .all() as Array<{ start_ts: number; category: string; n: number }>)
          .filter((row) => !isExcludedTopicCategory(row.category)),
      );

      const topicRows = aggregateTopicRows(
        (db()
        .prepare(
          `
          SELECT s.start_ts,
                 s.topic_id,
                 t.label,
                 t.top_words,
                 1 AS n
          FROM seg_segments s
          JOIN seg_topics t ON t.id = s.topic_id
          WHERE s.topic_id IS NOT NULL
          ORDER BY s.start_ts ASC
        `,
        )
          .all() as Array<Omit<TopicCountRow, "ym"> & { start_ts: number }>)
          .filter((row) => !isExcludedTopicCategory(row.label)),
      );

      const categories = [...new Set(categoryRows.map((r) => r.category))]
        .filter((category) => !isExcludedTopicCategory(category))
        .sort();
      const signalCategories = categories.filter((category) => category !== "small_talk" && category !== "unclassified");
      const months = buildMonths(categoryRows, signalCategories).filter(
        (month) => month.total >= MIN_SEGMENTS_PER_MONTH,
      );
      const k = Math.min(TARGET_SEASONS, Math.floor(months.length / MIN_MONTHS_PER_SEASON));
      const ranges = materializedRanges(months) ?? optimalRanges(months, Math.max(1, k), MIN_MONTHS_PER_SEASON);
      const monthToSeason = new Map<string, number>();
      const topicByYm = groupTopics(topicRows);
      const seasons = ranges.map((range, index) => {
        for (let i = range.start; i <= range.end; i += 1) monthToSeason.set(months[i].ym, index);
        return buildSeason(index, range.start, range.end, months, categories, topicByYm);
      });

      const segmentsBySeason = representativeSegments(seasons);
      for (const season of seasons) {
        season.segments = segmentsBySeason.get(season.id) ?? [];
      }

      return {
        generated_at: getDataGeneratedAt(),
        months_total: new Set(categoryRows.map((r) => r.ym)).size,
        months_analyzed: months.length,
        target_seasons: seasons.length,
        min_months_per_season: MIN_MONTHS_PER_SEASON,
        categories,
        months: months.map((month) => ({
          ym: month.ym,
          season_id: monthToSeason.get(month.ym) ?? 0,
          total: month.total,
          dominant_category: dominantCategory(month),
        })),
        seasons,
        breakpoints: buildBreakpoints(seasons),
      };
    });
  },
);

function aggregateCategoryRows(rows: Array<{ start_ts: number; category: string; n: number }>): CategoryCountRow[] {
  const byKey = new Map<string, CategoryCountRow>();
  for (const row of rows) {
    const ym = bucket(row.start_ts, "ym");
    const key = `${ym}:${row.category}`;
    const slot = byKey.get(key) ?? { ym, category: row.category, n: 0 };
    slot.n += row.n;
    byKey.set(key, slot);
  }
  return [...byKey.values()].sort((a, b) => a.ym.localeCompare(b.ym) || b.n - a.n);
}

function aggregateTopicRows(rows: Array<Omit<TopicCountRow, "ym"> & { start_ts: number }>): TopicCountRow[] {
  const byKey = new Map<string, TopicCountRow>();
  for (const row of rows) {
    const ym = bucket(row.start_ts, "ym");
    const key = `${ym}:${row.topic_id}`;
    const slot = byKey.get(key) ?? {
      ym,
      topic_id: row.topic_id,
      label: row.label,
      top_words: row.top_words,
      n: 0,
    };
    slot.n += row.n;
    byKey.set(key, slot);
  }
  return [...byKey.values()]
    .filter((row) => row.n >= 2)
    .sort((a, b) => a.ym.localeCompare(b.ym) || b.n - a.n);
}

function buildMonths(rows: CategoryCountRow[], categories: string[]): MonthSlot[] {
  const byYm = new Map<string, Omit<MonthSlot, "vector">>();
  for (const row of rows) {
    const slot = byYm.get(row.ym) ?? { ym: row.ym, total: 0, counts: new Map<string, number>() };
    slot.total += row.n;
    slot.counts.set(row.category, row.n);
    byYm.set(row.ym, slot);
  }
  return [...byYm.values()]
    .sort((a, b) => a.ym.localeCompare(b.ym))
    .map((slot) => ({
      ...slot,
      vector: categories.map((category) => (slot.counts.get(category) ?? 0) / slot.total),
    }));
}

function optimalRanges(months: MonthSlot[], k: number, minLength: number): SeasonRange[] {
  const n = months.length;
  if (k <= 1 || n < k * minLength) return [{ start: 0, end: n - 1 }];
  const cost = buildCostMatrix(months);
  const dp: number[][] = Array.from({ length: k + 1 }, () => Array(n).fill(Number.POSITIVE_INFINITY));
  const prev: number[][] = Array.from({ length: k + 1 }, () => Array(n).fill(-1));

  for (let end = minLength - 1; end < n; end += 1) {
    dp[1][end] = cost[0][end];
  }
  for (let group = 2; group <= k; group += 1) {
    for (let end = group * minLength - 1; end < n; end += 1) {
      for (let split = (group - 1) * minLength - 1; split <= end - minLength; split += 1) {
        const candidate = dp[group - 1][split] + cost[split + 1][end];
        if (candidate < dp[group][end]) {
          dp[group][end] = candidate;
          prev[group][end] = split;
        }
      }
    }
  }

  const ranges: Array<{ start: number; end: number }> = [];
  let end = n - 1;
  for (let group = k; group >= 1; group -= 1) {
    const split = prev[group][end];
    ranges.unshift({ start: split + 1, end });
    end = split;
  }
  return ranges;
}

function materializedRanges(months: MonthSlot[]): SeasonRange[] | null {
  const table = db().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'seg_seasons'").get();
  if (!table) return null;

  const rows = db()
    .prepare(
      `
      SELECT start_ym, end_ym
      FROM seg_seasons
      ORDER BY id ASC
    `,
    )
    .all() as Array<{ start_ym: string; end_ym: string }>;
  if (!rows.length) return null;

  const monthIndex = new Map(months.map((month, index) => [month.ym, index]));
  const ranges = rows
    .map((row) => {
      const start = monthIndex.get(row.start_ym);
      const end = monthIndex.get(row.end_ym);
      return start == null || end == null || end < start ? null : { start, end };
    })
    .filter((range): range is SeasonRange => range != null);

  return ranges.length ? ranges : null;
}

function buildCostMatrix(months: MonthSlot[]) {
  const n = months.length;
  const cost: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  for (let start = 0; start < n; start += 1) {
    const means = Array(months[start].vector.length).fill(0);
    for (let end = start; end < n; end += 1) {
      for (let c = 0; c < means.length; c += 1) means[c] += months[end].vector[c];
      const len = end - start + 1;
      let segmentCost = 0;
      for (let i = start; i <= end; i += 1) {
        for (let c = 0; c < means.length; c += 1) {
          const diff = months[i].vector[c] - means[c] / len;
          segmentCost += diff * diff;
        }
      }
      cost[start][end] = segmentCost;
    }
  }
  return cost;
}

function buildSeason(
  id: number,
  start: number,
  end: number,
  months: MonthSlot[],
  categories: string[],
  topicByYm: Map<string, TopicCountRow[]>,
): Season {
  const counts = new Map<string, number>();
  let total = 0;
  for (let i = start; i <= end; i += 1) {
    total += months[i].total;
    for (const [category, n] of months[i].counts.entries()) {
      counts.set(category, (counts.get(category) ?? 0) + n);
    }
  }
  const previousCounts =
    start > 0 ? aggregateCounts(months, Math.max(0, start - (end - start + 1)), start - 1) : null;
  const previousTotal = previousCounts
    ? [...previousCounts.values()].reduce((sum, n) => sum + n, 0)
    : 0;

  const topics = new Map<number, TopicCountRow & { total_n: number }>();
  for (let i = start; i <= end; i += 1) {
    for (const topic of topicByYm.get(months[i].ym) ?? []) {
      const existing = topics.get(topic.topic_id);
      if (existing) existing.total_n += topic.n;
      else topics.set(topic.topic_id, { ...topic, total_n: topic.n });
    }
  }

  return {
    id,
    start_ym: months[start].ym,
    end_ym: months[end].ym,
    n_months: end - start + 1,
    total_segments: total,
    avg_segments_per_month: Math.round((total / (end - start + 1)) * 10) / 10,
    categories: categories
      .map((category) => {
        const share = (counts.get(category) ?? 0) / total;
        const previousShare =
          previousCounts && previousTotal > 0
            ? (previousCounts.get(category) ?? 0) / previousTotal
            : null;
        return {
          category,
          share,
          previous_share: previousShare,
          delta_from_previous: previousShare == null ? null : share - previousShare,
        };
      })
      .sort((a, b) => b.share - a.share)
      .slice(0, 6),
    topics: [...topics.values()]
      .sort((a, b) => b.total_n - a.total_n)
      .slice(0, 6)
      .map((topic) => ({
        topic_id: topic.topic_id,
        label: topic.label,
        n: topic.total_n,
        top_words: safeJsonArray(topic.top_words).slice(0, 5),
      })),
    segments: [],
  };
}

function aggregateCounts(months: MonthSlot[], start: number, end: number) {
  const counts = new Map<string, number>();
  for (let i = start; i <= end; i += 1) {
    for (const [category, n] of months[i].counts.entries()) {
      counts.set(category, (counts.get(category) ?? 0) + n);
    }
  }
  return counts;
}

function groupTopics(rows: TopicCountRow[]) {
  const byYm = new Map<string, TopicCountRow[]>();
  for (const row of rows) {
    const slot = byYm.get(row.ym) ?? [];
    slot.push(row);
    byYm.set(row.ym, slot);
  }
  return byYm;
}

function representativeSegments(seasons: Season[]) {
  const bySeason = new Map<number, SeasonSegment[]>();
  const stmt = db().prepare(
    `
    SELECT s.id, s.start_ts, s.n_msgs,
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
    WHERE s.start_ts >= ? AND s.start_ts < ?
    ORDER BY s.n_msgs DESC
    LIMIT 3
  `,
  );
  for (const season of seasons) {
    const start = monthBounds(season.start_ym).start;
    const end = monthBounds(season.end_ym).end;
    const rows = stmt.all(start, end) as Array<SeasonSegment & { preview: string | null }>;
    bySeason.set(
      season.id,
      rows.map((row) => ({ ...row, preview: row.preview ?? "" })),
    );
  }
  return bySeason;
}

function buildBreakpoints(seasons: Season[]): SeasonBreakpoint[] {
  const breakpoints: SeasonBreakpoint[] = [];
  for (let i = 1; i < seasons.length; i += 1) {
    const season = seasons[i];
    breakpoints.push({
      from_season_id: i - 1,
      to_season_id: i,
      ym: season.start_ym,
      shifts: season.categories
        .filter((category) => category.delta_from_previous != null)
        .sort((a, b) => Math.abs(b.delta_from_previous ?? 0) - Math.abs(a.delta_from_previous ?? 0))
        .slice(0, 4),
    });
  }
  return breakpoints;
}

function dominantCategory(month: MonthSlot) {
  let topCategory = "unknown";
  let topCount = 0;
  for (const [category, n] of month.counts.entries()) {
    if (category === "small_talk" || category === "unclassified") continue;
    if (n > topCount) {
      topCategory = category;
      topCount = n;
    }
  }
  return topCategory === "unknown" ? "small_talk" : topCategory;
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
