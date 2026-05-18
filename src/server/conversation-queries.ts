/**
 * Server functions for the /conversations page.
 *
 * All `seg_*` tables are produced by the Python ETL pipeline:
 *   scripts/embed.py      — per-message sentence embeddings (BGE-small)
 *   scripts/segment.py    — temporal + TextTiling segmentation
 *   scripts/disentangle.py — Louvain on time-decayed cosine sim graph
 *   scripts/topic_model.py — BERTopic on segment embeddings
 *   scripts/label_topics.py — zero-shot or LLM category labelling
 *   scripts/transitions.py  — segment-to-segment transition aggregation
 *
 * See NOTES_CONVERSATIONS.md for schema + reasoning.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { bucket, monthBounds } from "~/lib/conversation/time";
import { db } from "~/lib/server-db";

export type SegmentRow = {
  id: number;
  start_ts: number;
  end_ts: number;
  n_msgs: number;
  n_me: number;
  n_them: number;
  topic_id: number | null;
  topic_label: string | null;
  category: string | null;
  category_confidence: number | null;
  category_status: string | null;
  category_reason: string | null;
  secondary_category: string | null;
  secondary_confidence: number | null;
  secondary_score: number | null;
  method: string | null;
  signals: string[];
  umap_x: number | null;
  umap_y: number | null;
  preview: string;
};

export type TopicRow = {
  id: number;
  label: string | null;
  n_segments: number;
  top_words: string[];
  top_phrases: string[];
  representative_segment_id: number | null;
  category_confidence: number | null;
  category_method: string | null;
  umap_x: number | null;
  umap_y: number | null;
};

const TOPIC_QUERY_BASE = `
  SELECT t.id, t.label, t.n_segments, t.top_words, t.top_phrases, t.representative_segment_id,
         tc.confidence AS category_confidence, tc.method AS category_method,
         AVG(s.umap_x) AS umap_x, AVG(s.umap_y) AS umap_y
  FROM seg_topics t
  LEFT JOIN seg_topic_categories tc ON tc.topic_id = t.id
  LEFT JOIN seg_segments s
    ON s.topic_id = t.id
   AND s.umap_x IS NOT NULL
   AND s.umap_y IS NOT NULL
  GROUP BY t.id
  ORDER BY t.n_segments DESC
`;

export const listTopics = createServerFn({ method: "GET" }).handler(
  async (): Promise<TopicRow[]> => {
    const rows = db().prepare(TOPIC_QUERY_BASE).all() as Array<{
      id: number;
      label: string | null;
      n_segments: number;
      top_words: string;
      top_phrases: string;
      representative_segment_id: number | null;
      category_confidence: number | null;
      category_method: string | null;
      umap_x: number | null;
      umap_y: number | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      n_segments: r.n_segments,
      top_words: safeJsonArray(r.top_words),
      top_phrases: safeJsonArray(r.top_phrases),
      representative_segment_id: r.representative_segment_id,
      category_confidence: r.category_confidence,
      category_method: r.category_method,
      umap_x: r.umap_x,
      umap_y: r.umap_y,
    }));
  },
);

const listSegmentsInput = z.object({
  topicId: z.number().int().nullable().optional(),
  category: z.string().nullable().optional(),
  ymStart: z.string().regex(/^\d{4}-\d{2}$/).nullable().optional(),
  ymEnd: z.string().regex(/^\d{4}-\d{2}$/).nullable().optional(),
  minMsgs: z.number().int().min(1).default(4),
  limit: z.number().int().min(1).max(200).default(60),
  offset: z.number().int().min(0).default(0),
  order: z.enum(["recent", "longest", "topic_central"]).default("recent"),
});

export const listSegments = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => listSegmentsInput.parse(d))
  .handler(async ({ data }) => {
    const where: string[] = ["s.n_msgs >= ?"];
    const args: any[] = [data.minMsgs];
    if (data.topicId != null) {
      where.push("s.topic_id = ?");
      args.push(data.topicId);
    }
    if (data.category) {
      if (data.category === "unclassified") {
        where.push("(c.category IS NULL OR c.category_status != 'classified')");
      } else {
        where.push("c.category = ? AND c.category_status = 'classified'");
        args.push(data.category);
      }
    }
    if (data.ymStart) {
      where.push("s.start_ts >= ?");
      args.push(monthBounds(data.ymStart).start);
    }
    if (data.ymEnd) {
      where.push("s.start_ts < ?");
      args.push(monthBounds(data.ymEnd).end);
    }
    const order =
      data.order === "longest"
        ? "s.n_msgs DESC"
        : data.order === "topic_central"
          ? "s.n_msgs DESC"
          : "s.start_ts DESC";

    const sql = `
      SELECT s.id, s.start_ts, s.end_ts, s.n_msgs, s.n_me, s.n_them,
             s.topic_id, t.label AS topic_label, c.category,
             c.confidence AS category_confidence, c.category_status,
             c.category_reason, c.secondary_category, c.secondary_confidence,
             c.secondary_score, c.method, c.signals,
             s.umap_x, s.umap_y,
             (
               SELECT GROUP_CONCAT(SUBSTR(m.text, 1, 80), ' • ')
               FROM (
                 SELECT m2.text
                 FROM seg_msg_segment sm2
                 JOIN messages m2 ON m2.id = sm2.msg_id
                 WHERE sm2.segment_id = s.id
                   AND m2.text IS NOT NULL AND length(trim(m2.text)) > 0
                 ORDER BY m2.ts ASC LIMIT 3
               ) m
             ) AS preview
      FROM seg_segments s
      LEFT JOIN seg_topics t ON t.id = s.topic_id
      LEFT JOIN seg_segment_categories c ON c.segment_id = s.id
      WHERE ${where.join(" AND ")}
      ORDER BY ${order}
      LIMIT ? OFFSET ?
    `;
    args.push(data.limit, data.offset);
    const rows = db().prepare(sql).all(...args) as Array<
      Omit<SegmentRow, "signals" | "preview"> & { signals: string | null; preview: string | null }
    >;

    const totalSql = `
      SELECT COUNT(*) AS n
      FROM seg_segments s
      LEFT JOIN seg_segment_categories c ON c.segment_id = s.id
      WHERE ${where.join(" AND ")}
    `;
    const total = db().prepare(totalSql).get(...args.slice(0, -2)) as { n: number };

    return {
      rows: rows.map((r) => ({
        ...r,
        signals: safeJsonArray<string>(r.signals),
        preview: r.preview ?? "",
      })),
      total: total.n,
    };
  });

const getSegmentInput = z.object({ id: z.number().int() });

export type SegmentDetail = {
  segment: SegmentRow & {
    topic_top_words: string[];
    topic_top_phrases: string[];
  };
  messages: Array<{
    id: number;
    ts: number;
    is_from_me: number;
    text: string;
    has_attachment: number;
    reply_to_guid: string | null;
    thread_idx: number | null;
  }>;
  threads: Array<{
    community_idx: number;
    n_msgs: number;
    msg_ids: number[];
  }>;
};

export const getSegment = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => getSegmentInput.parse(d))
  .handler(async ({ data }): Promise<SegmentDetail | null> => {
    const seg = db()
      .prepare(
        `
        SELECT s.id, s.start_ts, s.end_ts, s.n_msgs, s.n_me, s.n_them,
               s.topic_id, t.label AS topic_label, c.category,
               c.confidence AS category_confidence, c.category_status,
               c.category_reason, c.secondary_category, c.secondary_confidence,
               c.secondary_score, c.method, c.signals,
               s.umap_x, s.umap_y,
               t.top_words AS topic_top_words,
               t.top_phrases AS topic_top_phrases
        FROM seg_segments s
        LEFT JOIN seg_topics t ON t.id = s.topic_id
        LEFT JOIN seg_segment_categories c ON c.segment_id = s.id
        WHERE s.id = ?
      `,
      )
      .get(data.id) as
      | (Omit<SegmentRow, "signals"> & {
          signals: string | null;
          topic_top_words: string | null;
          topic_top_phrases: string | null;
        })
      | undefined;
    if (!seg) return null;

    const messages = db()
      .prepare(
        `
        SELECT m.id, m.ts, m.is_from_me, m.text, m.has_attachment, m.reply_to_guid
        FROM seg_msg_segment sm
        JOIN messages m ON m.id = sm.msg_id
        WHERE sm.segment_id = ?
        ORDER BY m.ts ASC
      `,
      )
      .all(data.id) as Array<{
        id: number;
        ts: number;
        is_from_me: number;
        text: string | null;
        has_attachment: number;
        reply_to_guid: string | null;
      }>;

    const threadRows = db()
      .prepare(
        `
        SELECT community_idx, n_msgs, msg_ids
        FROM seg_threads
        WHERE segment_id = ?
        ORDER BY community_idx
      `,
      )
      .all(data.id) as Array<{
        community_idx: number;
        n_msgs: number;
        msg_ids: string;
      }>;

    const threads = threadRows.map((t) => ({
      community_idx: t.community_idx,
      n_msgs: t.n_msgs,
      msg_ids: safeJsonArray<number>(t.msg_ids),
    }));

    // Map message id -> thread index
    const msgToThread = new Map<number, number>();
    for (const t of threads) {
      for (const id of t.msg_ids) msgToThread.set(id, t.community_idx);
    }

    return {
      segment: {
        id: seg.id,
        start_ts: seg.start_ts,
        end_ts: seg.end_ts,
        n_msgs: seg.n_msgs,
        n_me: seg.n_me,
        n_them: seg.n_them,
        topic_id: seg.topic_id,
        topic_label: seg.topic_label,
        category: seg.category,
        category_confidence: seg.category_confidence,
        category_status: seg.category_status,
        category_reason: seg.category_reason,
        secondary_category: seg.secondary_category,
        secondary_confidence: seg.secondary_confidence,
        secondary_score: seg.secondary_score,
        method: seg.method,
        signals: safeJsonArray<string>(seg.signals),
        umap_x: seg.umap_x,
        umap_y: seg.umap_y,
        preview: "",
        topic_top_words: safeJsonArray<string>(seg.topic_top_words),
        topic_top_phrases: safeJsonArray<string>(seg.topic_top_phrases),
      },
      messages: messages.map((m) => ({
        id: m.id,
        ts: m.ts,
        is_from_me: m.is_from_me,
        text: m.text ?? "",
        has_attachment: m.has_attachment,
        reply_to_guid: m.reply_to_guid,
        thread_idx: msgToThread.get(m.id) ?? null,
      })),
      threads,
    };
  });

export type CategoryShareRow = { ym: string; total: number } & Record<string, number | string>;

export const getCategoryShareOverTime = createServerFn({ method: "GET" }).handler(
  async (): Promise<CategoryShareRow[]> => {
    const rows = db()
      .prepare(
        `
        SELECT s.start_ts,
               CASE
                 WHEN c.category_status = 'classified' THEN COALESCE(c.category, 'unclassified')
                 ELSE 'unclassified'
               END AS category,
               1 AS n
        FROM seg_segments s
        LEFT JOIN seg_segment_categories c ON c.segment_id = s.id
        ORDER BY s.start_ts ASC
      `,
      )
      .all() as Array<{ start_ts: number; category: string; n: number }>;

    const byYm = new Map<string, Record<string, number>>();
    for (const r of rows) {
      const ym = bucket(r.start_ts, "ym");
      const slot = byYm.get(ym) ?? {};
      slot[r.category] = (slot[r.category] ?? 0) + r.n;
      byYm.set(ym, slot);
    }
    const out: CategoryShareRow[] = [];
    for (const [ym, slot] of byYm.entries()) {
      const total = Object.values(slot).reduce((a, b) => a + b, 0);
      out.push({ ym, total, ...slot });
    }
    out.sort((a, b) => a.ym.localeCompare(b.ym));
    return out;
  },
);

export type CategoryTransition = {
  from: string;
  to: string;
  n: number;
  mean_gap_seconds: number;
};

export const getCategoryTransitions = createServerFn({ method: "GET" }).handler(
  async (): Promise<CategoryTransition[]> => {
    const rows = db()
      .prepare(
        `SELECT from_cat AS "from", to_cat AS "to", n, mean_gap_seconds FROM seg_category_transitions ORDER BY n DESC`,
      )
      .all() as CategoryTransition[];
    return rows;
  },
);

export type CategorySummary = { category: string; n: number };

export const getCategorySummary = createServerFn({ method: "GET" }).handler(
  async (): Promise<CategorySummary[]> => {
    const rows = db()
      .prepare(
        `
        SELECT CASE
                 WHEN category_status = 'classified' THEN COALESCE(category, 'unclassified')
                 ELSE 'unclassified'
               END AS category,
               COUNT(*) AS n
        FROM seg_segment_categories
        GROUP BY 1
        ORDER BY n DESC
        `,
      )
      .all() as CategorySummary[];
    return rows;
  },
);

export type ConversationsOverview = {
  n_segments: number;
  n_topics: number;
  n_threads: number;
  n_topic_outliers: number;
  n_secondary_categories: number;
  n_low_confidence: number;
  mean_labeled_confidence: number;
  mean_segment_msgs: number;
  median_segment_msgs: number;
  longest_segment_msgs: number;
  category_summary: CategorySummary[];
};

export const getConversationsOverview = createServerFn({ method: "GET" }).handler(
  async (): Promise<ConversationsOverview> => {
    const stats = db()
      .prepare(
        `SELECT COUNT(*) AS n, AVG(n_msgs) AS mean_msgs, MAX(n_msgs) AS max_msgs FROM seg_segments`,
      )
      .get() as { n: number; mean_msgs: number; max_msgs: number };
    const median = db()
      .prepare(
        `SELECT n_msgs FROM seg_segments ORDER BY n_msgs LIMIT 1 OFFSET (SELECT COUNT(*)/2 FROM seg_segments)`,
      )
      .get() as { n_msgs: number } | undefined;
    const topics = db().prepare(`SELECT COUNT(*) AS n FROM seg_topics`).get() as { n: number };
    const threads = db().prepare(`SELECT COUNT(*) AS n FROM seg_threads`).get() as { n: number };
    const categoryStats = db()
      .prepare(
        `
        SELECT
          SUM(CASE WHEN s.topic_id IS NULL THEN 1 ELSE 0 END) AS topic_outliers,
          SUM(CASE WHEN c.secondary_category IS NOT NULL THEN 1 ELSE 0 END) AS secondary_categories,
          SUM(CASE WHEN c.category_status != 'topic_outlier' AND c.confidence < 0.6 THEN 1 ELSE 0 END) AS low_confidence,
          AVG(CASE WHEN c.category_status != 'topic_outlier' AND c.confidence > 0 THEN c.confidence END) AS mean_labeled_confidence
        FROM seg_segments s
        LEFT JOIN seg_segment_categories c ON c.segment_id = s.id
      `,
      )
      .get() as {
      topic_outliers: number | null;
      secondary_categories: number | null;
      low_confidence: number | null;
      mean_labeled_confidence: number | null;
    };
    const cats = db()
      .prepare(
        `
        SELECT CASE
                 WHEN category_status = 'classified' THEN COALESCE(category, 'unclassified')
                 ELSE 'unclassified'
               END AS category,
               COUNT(*) AS n
        FROM seg_segment_categories
        GROUP BY 1
        ORDER BY n DESC
        `,
      )
      .all() as CategorySummary[];
    return {
      n_segments: stats.n,
      n_topics: topics.n,
      n_threads: threads.n,
      n_topic_outliers: categoryStats.topic_outliers ?? 0,
      n_secondary_categories: categoryStats.secondary_categories ?? 0,
      n_low_confidence: categoryStats.low_confidence ?? 0,
      mean_labeled_confidence: Math.round((categoryStats.mean_labeled_confidence ?? 0) * 100) / 100,
      mean_segment_msgs: Math.round((stats.mean_msgs ?? 0) * 10) / 10,
      median_segment_msgs: median?.n_msgs ?? 0,
      longest_segment_msgs: stats.max_msgs ?? 0,
      category_summary: cats,
    };
  },
);

function safeJsonArray<T = string>(s: string | null | undefined): T[] {
  if (!s) return [];
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}
