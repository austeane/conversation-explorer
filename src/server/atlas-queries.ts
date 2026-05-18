import { createServerFn } from "@tanstack/react-start";
import { excludedTopicLabelSqlAnd } from "~/lib/conversation/topic-hygiene";
import { db, withDbCache } from "~/lib/server-db";
import { topicStabilitySql } from "~/server/topic-stability";

const MAP_WIDTH = 1000;
const MAP_HEIGHT = 620;
const GRID_COLUMNS = 42;
const GRID_ROWS = 26;
const MAX_POINTS = 260;
const MAX_ISLANDS = 28;
const MAX_BRIDGES = 18;
const MAX_EXAMPLES = 18;

export type Sender = "Me" | "Them";

export type AtlasOverview = {
  generated_at: string;
  mapped_segments: number;
  topic_islands: number;
  categories: number;
  month_steps: number;
  densest_category: string;
  largest_island: string;
  longest_bridge: string;
};

export type AtlasBounds = {
  min_x: number;
  max_x: number;
  min_y: number;
  max_y: number;
};

export type AtlasTile = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  count: number;
  intensity: number;
  category: string;
  diversity: number;
  me_share: number;
  avg_ts: number;
};

export type AtlasPoint = {
  id: number;
  x: number;
  y: number;
  radius: number;
  category: string;
  topic_label: string;
  n_msgs: number;
  me_share: number;
  start_ts: number;
  topic_stability: number | null;
};

export type AtlasIsland = {
  topic_id: number;
  label: string;
  category: string;
  x: number;
  y: number;
  radius: number;
  segments: number;
  messages: number;
  me_share: number;
  first_ts: number;
  last_ts: number;
  keywords: string[];
  topic_stability: number | null;
  representative: AtlasSegmentExample | null;
};

export type AtlasBridge = {
  from_id: number;
  to_id: number;
  from_x: number;
  from_y: number;
  to_x: number;
  to_y: number;
  from_category: string;
  to_category: string;
  from_label: string;
  to_label: string;
  gap_seconds: number;
  semantic_distance: number;
  score: number;
  from_preview: string;
  to_preview: string;
};

export type AtlasMonth = {
  ym: string;
  x: number;
  y: number;
  segments: number;
  category: string;
};

export type AtlasAttachmentDensity = {
  segment_id: number;
  x: number;
  y: number;
  count: number;
  radius: number;
  label: string;
};

export type AtlasSegmentExample = {
  id: number;
  x: number;
  y: number;
  category: string;
  topic_label: string;
  n_msgs: number;
  me_share: number;
  start_ts: number;
  end_ts: number;
  snippets: Array<{
    ts: number;
    sender: Sender;
    text: string;
  }>;
};

export type AtlasResult = {
  overview: AtlasOverview;
  bounds: AtlasBounds;
  tiles: AtlasTile[];
  points: AtlasPoint[];
  islands: AtlasIsland[];
  bridges: AtlasBridge[];
  months: AtlasMonth[];
  attachment_density: AtlasAttachmentDensity[];
  examples: AtlasSegmentExample[];
};

type SegmentRow = {
  id: number;
  start_ts: number;
  end_ts: number;
  n_msgs: number;
  n_me: number;
  n_them: number;
  topic_id: number | null;
  umap_x: number;
  umap_y: number;
  topic_label: string | null;
  top_words: string | null;
  top_phrases: string | null;
  category: string | null;
  confidence: number | null;
  topic_stability: number | null;
  topic_stability_min: number | null;
};

type LinkRow = {
  from_segment_id: number;
  to_segment_id: number;
  gap_seconds: number;
  from_category: string | null;
  to_category: string | null;
  from_x: number;
  from_y: number;
  to_x: number;
  to_y: number;
  from_msgs: number;
  to_msgs: number;
  from_label: string | null;
  to_label: string | null;
  from_top_words: string | null;
  from_top_phrases: string | null;
  to_top_words: string | null;
  to_top_phrases: string | null;
};

type MessageSnippetRow = {
  ts: number;
  is_from_me: number;
  text: string | null;
};

type NormalizedSegment = SegmentRow & {
  x: number;
  y: number;
  category_label: string;
  label: string;
};

type TileAccumulator = {
  col: number;
  row: number;
  count: number;
  messages: number;
  me: number;
  tsTotal: number;
  categories: Map<string, number>;
};

type IslandAccumulator = {
  topicId: number;
  label: string;
  category: string;
  rows: NormalizedSegment[];
  messages: number;
  me: number;
  keywords: string[];
  representativeId: number | null;
};

export const getAtlas = createServerFn({ method: "GET" }).handler(
  async (): Promise<AtlasResult> => {
    return withDbCache("atlas", () => {
      const generated = db().prepare("SELECT v FROM meta WHERE k = 'generated_at'").get() as { v: string } | undefined;
      const rows = db()
        .prepare(
          `
          SELECT
            s.id,
            s.start_ts,
            s.end_ts,
            s.n_msgs,
            s.n_me,
            s.n_them,
            s.topic_id,
            s.umap_x,
            s.umap_y,
            t.label AS topic_label,
            t.top_words,
            t.top_phrases,
            COALESCE(sc.category, tc.category, t.label, 'unlabeled') AS category,
            COALESCE(sc.confidence, tc.confidence, 0) AS confidence,
            ${topicStabilitySql("s.topic_id", "atlas_stability").select}
          FROM seg_segments s
          LEFT JOIN seg_topics t ON t.id = s.topic_id
          LEFT JOIN seg_segment_categories sc ON sc.segment_id = s.id
          LEFT JOIN seg_topic_categories tc ON tc.topic_id = s.topic_id
          ${topicStabilitySql("s.topic_id", "atlas_stability").join}
          WHERE s.umap_x IS NOT NULL AND s.umap_y IS NOT NULL
            ${excludedTopicLabelSqlAnd("COALESCE(sc.category, tc.category, t.label)")}
          ORDER BY s.start_ts ASC, s.id ASC
        `,
        )
        .all() as SegmentRow[];

      const bounds = buildBounds(rows);
      const segments = rows.map((row) => normalizeSegment(row, bounds));
      const tiles = buildTiles(segments);
      const islands = buildIslands(segments);
      const bridges = buildBridges(bounds);
      const months = buildMonths(segments);
      const attachmentDensity = buildAttachmentDensity(segments);
      const examples = buildExamples(segments, islands, bridges);
      const categories = new Set(segments.map((segment) => segment.category_label));
      const densestCategory = mostCommon(segments.map((segment) => segment.category_label));

      return {
        overview: {
          generated_at: generated?.v ?? "unknown",
          mapped_segments: segments.length,
          topic_islands: islands.length,
          categories: categories.size,
          month_steps: months.length,
          densest_category: densestCategory,
          largest_island: islands[0]?.label ?? "n/a",
          longest_bridge: bridges[0] ? `${bridges[0].from_label} -> ${bridges[0].to_label}` : "n/a",
        },
        bounds,
        tiles,
        points: buildPoints(segments),
        islands,
        bridges,
        months,
        attachment_density: attachmentDensity,
        examples,
      };
    });
  },
);

function buildBounds(rows: SegmentRow[]): AtlasBounds {
  return {
    min_x: Math.min(...rows.map((row) => row.umap_x)),
    max_x: Math.max(...rows.map((row) => row.umap_x)),
    min_y: Math.min(...rows.map((row) => row.umap_y)),
    max_y: Math.max(...rows.map((row) => row.umap_y)),
  };
}

function normalizeSegment(row: SegmentRow, bounds: AtlasBounds): NormalizedSegment {
  return {
    ...row,
    x: scale(row.umap_x, bounds.min_x, bounds.max_x, 24, MAP_WIDTH - 24),
    y: scale(row.umap_y, bounds.min_y, bounds.max_y, MAP_HEIGHT - 24, 24),
    category_label: cleanCategory(row.category),
    label: topicTitle(row),
  };
}

function buildTiles(segments: NormalizedSegment[]): AtlasTile[] {
  const tiles = new Map<string, TileAccumulator>();
  const cellWidth = MAP_WIDTH / GRID_COLUMNS;
  const cellHeight = MAP_HEIGHT / GRID_ROWS;

  for (const segment of segments) {
    const col = Math.max(0, Math.min(GRID_COLUMNS - 1, Math.floor(segment.x / cellWidth)));
    const row = Math.max(0, Math.min(GRID_ROWS - 1, Math.floor(segment.y / cellHeight)));
    const key = `${col}-${row}`;
    const tile = tiles.get(key) ?? {
      col,
      row,
      count: 0,
      messages: 0,
      me: 0,
      tsTotal: 0,
      categories: new Map<string, number>(),
    };
    tile.count += 1;
    tile.messages += segment.n_msgs;
    tile.me += segment.n_me;
    tile.tsTotal += segment.start_ts;
    tile.categories.set(segment.category_label, (tile.categories.get(segment.category_label) ?? 0) + 1);
    tiles.set(key, tile);
  }

  const maxCount = Math.max(...[...tiles.values()].map((tile) => tile.count), 1);
  return [...tiles.values()]
    .map((tile) => ({
      id: `${tile.col}-${tile.row}`,
      x: round(tile.col * cellWidth),
      y: round(tile.row * cellHeight),
      width: round(cellWidth + 0.4),
      height: round(cellHeight + 0.4),
      count: tile.count,
      intensity: round(tile.count / maxCount),
      category: topCategory(tile.categories),
      diversity: round(entropy([...tile.categories.values()])),
      me_share: round(tile.me / Math.max(1, tile.messages)),
      avg_ts: Math.round(tile.tsTotal / Math.max(1, tile.count)),
    }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

function buildPoints(segments: NormalizedSegment[]): AtlasPoint[] {
  return [...segments]
    .sort((a, b) => b.n_msgs - a.n_msgs || a.start_ts - b.start_ts)
    .slice(0, MAX_POINTS)
    .map((segment) => ({
      id: segment.id,
      x: round(segment.x),
      y: round(segment.y),
      radius: round(Math.max(2.3, Math.min(8, Math.sqrt(segment.n_msgs) * 0.72))),
      category: segment.category_label,
      topic_label: segment.label,
      n_msgs: segment.n_msgs,
      me_share: round(segment.n_me / Math.max(1, segment.n_msgs)),
      start_ts: segment.start_ts,
      topic_stability: segment.topic_stability == null ? null : round(segment.topic_stability),
    }));
}

function buildIslands(segments: NormalizedSegment[]): AtlasIsland[] {
  const groups = new Map<number, IslandAccumulator>();
  for (const segment of segments) {
    if (segment.topic_id === null) continue;
    const group = groups.get(segment.topic_id) ?? {
      topicId: segment.topic_id,
      label: segment.label,
      category: segment.category_label,
      rows: [],
      messages: 0,
      me: 0,
      keywords: keywordsFromSegment(segment),
      representativeId: null,
    };
    group.rows.push(segment);
    group.messages += segment.n_msgs;
    group.me += segment.n_me;
    if (segment.n_msgs > (group.rows.find((row) => row.id === group.representativeId)?.n_msgs ?? -1)) {
      group.representativeId = segment.id;
    }
    groups.set(segment.topic_id, group);
  }

  return [...groups.values()]
    .filter((group) => group.rows.length >= 10)
    .map((group) => {
      const x = mean(group.rows.map((row) => row.x));
      const y = mean(group.rows.map((row) => row.y));
      const radius = Math.max(16, Math.min(78, mean(group.rows.map((row) => distance(row.x, row.y, x, y))) * 1.45 + Math.sqrt(group.rows.length) * 2));
      const representative = group.representativeId ? segmentExample(group.rows.find((row) => row.id === group.representativeId) ?? group.rows[0]) : null;
      return {
        topic_id: group.topicId,
        label: group.label,
        category: group.category,
        x: round(x),
        y: round(y),
        radius: round(radius),
        segments: group.rows.length,
        messages: group.messages,
        me_share: round(group.me / Math.max(1, group.messages)),
        first_ts: Math.min(...group.rows.map((row) => row.start_ts)),
        last_ts: Math.max(...group.rows.map((row) => row.end_ts)),
        keywords: group.keywords.slice(0, 8),
        topic_stability: group.rows[0].topic_stability == null ? null : round(group.rows[0].topic_stability),
        representative,
      };
    })
    .sort((a, b) => b.segments - a.segments || b.messages - a.messages)
    .slice(0, MAX_ISLANDS);
}

function buildBridges(bounds: AtlasBounds): AtlasBridge[] {
  const links = db()
    .prepare(
      `
      SELECT
        l.from_segment_id,
        l.to_segment_id,
        l.gap_seconds,
        l.from_category,
        l.to_category,
        sf.umap_x AS from_x,
        sf.umap_y AS from_y,
        st.umap_x AS to_x,
        st.umap_y AS to_y,
        sf.n_msgs AS from_msgs,
        st.n_msgs AS to_msgs,
        COALESCE(tf.label, l.from_category, 'unlabeled') AS from_label,
        COALESCE(tt.label, l.to_category, 'unlabeled') AS to_label,
        tf.top_words AS from_top_words,
        tf.top_phrases AS from_top_phrases,
        tt.top_words AS to_top_words,
        tt.top_phrases AS to_top_phrases
      FROM seg_links l
      JOIN seg_segments sf ON sf.id = l.from_segment_id
      JOIN seg_segments st ON st.id = l.to_segment_id
      LEFT JOIN seg_topics tf ON tf.id = sf.topic_id
      LEFT JOIN seg_topics tt ON tt.id = st.topic_id
      WHERE sf.umap_x IS NOT NULL AND sf.umap_y IS NOT NULL
        AND st.umap_x IS NOT NULL AND st.umap_y IS NOT NULL
      `,
    )
    .all() as LinkRow[];

  return links
    .map((link) => {
      const fromX = scale(link.from_x, bounds.min_x, bounds.max_x, 24, MAP_WIDTH - 24);
      const fromY = scale(link.from_y, bounds.min_y, bounds.max_y, MAP_HEIGHT - 24, 24);
      const toX = scale(link.to_x, bounds.min_x, bounds.max_x, 24, MAP_WIDTH - 24);
      const toY = scale(link.to_y, bounds.min_y, bounds.max_y, MAP_HEIGHT - 24, 24);
      const semanticDistance = distance(fromX, fromY, toX, toY);
      const categorySwitch = cleanCategory(link.from_category) === cleanCategory(link.to_category) ? 0 : 1;
      const score = semanticDistance * (1 + categorySwitch * 0.28) * Math.log1p(Math.min(link.from_msgs, link.to_msgs) + 4);
      return {
        from_id: link.from_segment_id,
        to_id: link.to_segment_id,
        from_x: round(fromX),
        from_y: round(fromY),
        to_x: round(toX),
        to_y: round(toY),
        from_category: cleanCategory(link.from_category),
        to_category: cleanCategory(link.to_category),
        from_label: topicTitleFromParts(link.from_label, link.from_category, link.from_top_words, link.from_top_phrases),
        to_label: topicTitleFromParts(link.to_label, link.to_category, link.to_top_words, link.to_top_phrases),
        gap_seconds: link.gap_seconds,
        semantic_distance: round(semanticDistance),
        score: round(score),
      };
    })
    .filter((bridge) => bridge.semantic_distance > 170 && bridge.gap_seconds < 24 * 60 * 60)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_BRIDGES)
    .map((bridge) => ({
      ...bridge,
      from_preview: previewForSegment(bridge.from_id),
      to_preview: previewForSegment(bridge.to_id),
    }));
}

function buildMonths(segments: NormalizedSegment[]): AtlasMonth[] {
  const months = new Map<string, NormalizedSegment[]>();
  for (const segment of segments) {
    const ym = ymFromTs(segment.start_ts);
    const month = months.get(ym) ?? [];
    month.push(segment);
    months.set(ym, month);
  }

  return [...months.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([ym, monthSegments]) => ({
      ym,
      x: round(mean(monthSegments.map((segment) => segment.x))),
      y: round(mean(monthSegments.map((segment) => segment.y))),
      segments: monthSegments.length,
      category: mostCommon(monthSegments.map((segment) => segment.category_label)),
    }));
}

function buildAttachmentDensity(segments: NormalizedSegment[]): AtlasAttachmentDensity[] {
  const hasAttachmentClusters = Boolean(
    db()
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'seg_attachment_clusters'")
      .get(),
  );
  if (!hasAttachmentClusters) return [];

  const bySegment = new Map(segments.map((segment) => [segment.id, segment]));
  const rows = db()
    .prepare(
      `
      SELECT segment_id, COUNT(*) AS count, MIN(cluster_label) AS label
      FROM seg_attachment_clusters
      WHERE segment_id IS NOT NULL
      GROUP BY segment_id
      ORDER BY count DESC, segment_id ASC
      LIMIT 80
      `,
    )
    .all() as Array<{ segment_id: number; count: number; label: string | null }>;

  return rows
    .map((row) => {
      const segment = bySegment.get(row.segment_id);
      if (!segment) return null;
      return {
        segment_id: row.segment_id,
        x: round(segment.x),
        y: round(segment.y),
        count: row.count,
        radius: round(Math.max(5, Math.min(24, 4 + Math.sqrt(row.count) * 4))),
        label: row.label ?? "attachment cluster",
      };
    })
    .filter((row): row is AtlasAttachmentDensity => Boolean(row));
}

function buildExamples(segments: NormalizedSegment[], islands: AtlasIsland[], bridges: AtlasBridge[]) {
  const ids = new Set<number>();
  for (const island of islands.slice(0, 10)) {
    if (island.representative) ids.add(island.representative.id);
  }
  for (const bridge of bridges.slice(0, 6)) {
    ids.add(bridge.from_id);
    ids.add(bridge.to_id);
  }
  for (const segment of [...segments].sort((a, b) => b.n_msgs - a.n_msgs)) {
    if (ids.size >= MAX_EXAMPLES) break;
    ids.add(segment.id);
  }

  return [...ids]
    .map((id) => segments.find((segment) => segment.id === id))
    .filter((segment): segment is NormalizedSegment => Boolean(segment))
    .map(segmentExample)
    .sort((a, b) => b.n_msgs - a.n_msgs)
    .slice(0, MAX_EXAMPLES);
}

function segmentExample(segment: NormalizedSegment): AtlasSegmentExample {
  return {
    id: segment.id,
    x: round(segment.x),
    y: round(segment.y),
    category: segment.category_label,
    topic_label: segment.label,
    n_msgs: segment.n_msgs,
    me_share: round(segment.n_me / Math.max(1, segment.n_msgs)),
    start_ts: segment.start_ts,
    end_ts: segment.end_ts,
    snippets: snippetsForSegment(segment.id),
  };
}

function snippetsForSegment(segmentId: number) {
  const rows = db()
    .prepare(
      `
      SELECT m.ts, m.is_from_me, m.text
      FROM seg_msg_segment sm
      JOIN messages m ON m.id = sm.msg_id
      WHERE sm.segment_id = ?
        AND m.text IS NOT NULL
        AND trim(m.text) != ''
      ORDER BY m.ts ASC, m.id ASC
      LIMIT 4
      `,
    )
    .all(segmentId) as MessageSnippetRow[];

  return rows.map((row) => ({
    ts: row.ts,
    sender: row.is_from_me === 1 ? "Me" as const : "Them" as const,
    text: preview(stripUrls(row.text ?? ""), 150),
  }));
}

function previewForSegment(segmentId: number) {
  return snippetsForSegment(segmentId).map((snippet) => snippet.text).join(" / ");
}

function keywordsFromSegment(segment: SegmentRow) {
  const words = parseStringArray(segment.top_words);
  const phrases = parseStringArray(segment.top_phrases);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of [...phrases, ...words]) {
    const clean = cleanLabel(item);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    result.push(clean);
  }
  return result.slice(0, 10);
}

function parseStringArray(value: string | null) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
}

function topCategory(categories: Map<string, number>) {
  return [...categories.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "unlabeled";
}

function mostCommon(values: string[]) {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return topCategory(counts);
}

function entropy(counts: number[]) {
  const total = counts.reduce((sum, value) => sum + value, 0);
  if (total === 0 || counts.length <= 1) return 0;
  const raw = counts.reduce((sum, count) => {
    const p = count / total;
    return p === 0 ? sum : sum - p * Math.log2(p);
  }, 0);
  return raw / Math.log2(counts.length);
}

function cleanCategory(value: string | null | undefined) {
  return (value || "unlabeled").replace(/\s+/g, "_").toLowerCase();
}

function cleanLabel(value: string) {
  return value.replace(/_/g, " ").replace(/\s+/g, " ").trim();
}

function topicTitle(segment: SegmentRow) {
  const base = cleanLabel(segment.topic_label ?? segment.category ?? "unlabeled");
  const terms = keywordsFromSegment(segment).slice(0, 2);
  if (terms.length === 0) return base;
  return `${base}: ${terms.join(", ")}`;
}

function topicTitleFromParts(label: string | null, category: string | null, topWords: string | null, topPhrases: string | null) {
  const base = cleanLabel(label ?? category ?? "unlabeled");
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const item of [...parseStringArray(topPhrases), ...parseStringArray(topWords)]) {
    const clean = cleanLabel(item);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    terms.push(clean);
    if (terms.length >= 2) break;
  }
  return terms.length > 0 ? `${base}: ${terms.join(", ")}` : base;
}

function scale(value: number, inMin: number, inMax: number, outMin: number, outMax: number) {
  if (inMax === inMin) return (outMin + outMax) / 2;
  return outMin + ((value - inMin) / (inMax - inMin)) * (outMax - outMin);
}

function distance(ax: number, ay: number, bx: number, by: number) {
  return Math.sqrt((ax - bx) ** 2 + (ay - by) ** 2);
}

function mean(values: number[]) {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function stripUrls(text: string) {
  return text.replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim();
}

function preview(text: string, maxLength: number) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 1).trimEnd()}…`;
}

function ymFromTs(ts: number) {
  return new Date(ts * 1000).toISOString().slice(0, 7);
}
