import { createServerFn } from "@tanstack/react-start";
import { bucket } from "~/lib/conversation/time";
import { excludedTopicLabelSqlAnd } from "~/lib/conversation/topic-hygiene";
import { db, getDataGeneratedAt, withDbCache } from "~/lib/server-db";
import { topicStabilitySql } from "~/server/topic-stability";

const GRAPH_WIDTH = 1000;
const GRAPH_HEIGHT = 660;
const MAX_VISIBLE_NODES = 72;
const MAX_VISIBLE_EDGES = 118;
const MAX_COMMUNITIES = 9;
const MAX_CORRIDORS = 16;
const MAX_BROKERS = 14;
const PAGERANK_DAMPING = 0.84;

export type Sender = "Me" | "Them";

export type ConstellationOverview = {
  generated_at: string;
  topics: number;
  visible_topics: number;
  corridors: number;
  communities: number;
  central_topic: string;
  strongest_corridor: string;
  bridge_topic: string;
};

export type ConstellationNode = {
  topic_id: number;
  label: string;
  category: string;
  community: number;
  x: number;
  y: number;
  radius: number;
  segments: number;
  messages: number;
  active_months: number;
  me_share: number;
  pagerank: number;
  broker_score: number;
  topic_stability: number | null;
  keywords: string[];
  snippets: ConstellationSnippet[];
};

export type ConstellationEdge = {
  id: string;
  from_id: number;
  to_id: number;
  from_label: string;
  to_label: string;
  from_x: number;
  from_y: number;
  to_x: number;
  to_y: number;
  weight: number;
  strength: number;
  lift: number;
  median_gap_seconds: number;
  community_jump: boolean;
};

export type ConstellationCommunity = {
  id: number;
  label: string;
  topics: number;
  segments: number;
  messages: number;
  dominant_category: string;
  top_nodes: ConstellationNode[];
  internal_weight: number;
  external_weight: number;
};

export type ConstellationCorridor = {
  edge: ConstellationEdge;
  sample_gap_seconds: number;
  from_snippets: ConstellationSnippet[];
  to_snippets: ConstellationSnippet[];
};

export type ConstellationSnippet = {
  ts: number;
  sender: Sender;
  text: string;
};

export type ConstellationResult = {
  overview: ConstellationOverview;
  nodes: ConstellationNode[];
  edges: ConstellationEdge[];
  communities: ConstellationCommunity[];
  corridors: ConstellationCorridor[];
  brokers: ConstellationNode[];
};

type SegmentRow = {
  id: number;
  topic_id: number;
  start_ts: number;
  ym: string;
  n_msgs: number;
  n_me: number;
  n_them: number;
  umap_x: number | null;
  umap_y: number | null;
  topic_label: string | null;
  top_words: string | null;
  top_phrases: string | null;
  representative_segment_id: number | null;
  category: string | null;
  topic_stability: number | null;
  topic_stability_min: number | null;
};

type LinkRow = {
  from_segment_id: number;
  to_segment_id: number;
  gap_seconds: number;
  from_topic_id: number;
  to_topic_id: number;
  from_msgs: number;
  to_msgs: number;
};

type TopicBuild = {
  topic_id: number;
  label: string;
  category: string;
  raw_x: number;
  raw_y: number;
  x: number;
  y: number;
  segments: number;
  messages: number;
  me: number;
  active_months: number;
  representative_segment_id: number;
  keywords: string[];
  pagerank: number;
  broker_score: number;
  topic_stability: number | null;
  community: number;
  snippets: ConstellationSnippet[];
};

type EdgeBuild = {
  from_id: number;
  to_id: number;
  weight: number;
  gaps: number[];
  lift: number;
  score: number;
  sample_from_segment_id: number;
  sample_to_segment_id: number;
  sample_gap_seconds: number;
  sample_score: number;
};

type SnippetRow = {
  ts: number;
  is_from_me: number;
  text: string | null;
};

export const getConstellations = createServerFn({ method: "GET" }).handler(
  async (): Promise<ConstellationResult> => {
    return withDbCache("constellations", () => {
      const rawSegmentRows = db()
        .prepare(
          `
          ${(() => {
            const stability = topicStabilitySql("s.topic_id", "constellation_stability");
            return `
          SELECT
            s.id,
            s.topic_id,
            s.start_ts,
            s.n_msgs,
            s.n_me,
            s.n_them,
            s.umap_x,
            s.umap_y,
            t.label AS topic_label,
            t.top_words,
            t.top_phrases,
            t.representative_segment_id,
            COALESCE(sc.category, tc.category, t.label, 'unlabeled') AS category,
            ${stability.select}
          FROM seg_segments s
          JOIN seg_topics t ON t.id = s.topic_id
          LEFT JOIN seg_topic_categories tc ON tc.topic_id = s.topic_id
          LEFT JOIN seg_segment_categories sc ON sc.segment_id = s.id
          ${stability.join}
          WHERE s.topic_id IS NOT NULL
            ${excludedTopicLabelSqlAnd("t.label")}
          ORDER BY s.start_ts ASC, s.id ASC
        `;
          })()}
        `,
        )
        .all() as Array<Omit<SegmentRow, "ym">>;
      const segmentRows: SegmentRow[] = rawSegmentRows.map((row) => ({ ...row, ym: bucket(row.start_ts, "ym") }));

      const linkRows = db()
        .prepare(
          `
          SELECT
            l.from_segment_id,
            l.to_segment_id,
            l.gap_seconds,
            a.topic_id AS from_topic_id,
            b.topic_id AS to_topic_id,
            a.n_msgs AS from_msgs,
            b.n_msgs AS to_msgs
          FROM seg_links l
          JOIN seg_segments a ON a.id = l.from_segment_id
          JOIN seg_segments b ON b.id = l.to_segment_id
          WHERE a.topic_id IS NOT NULL
            AND b.topic_id IS NOT NULL
            AND a.topic_id != b.topic_id
        `,
        )
        .all() as LinkRow[];

      const topics = buildTopics(segmentRows);
      const edgeMap = buildEdges(linkRows, topics);
      const pageRanks = pageRank(topics, [...edgeMap.values()]);
      for (const topic of topics) topic.pagerank = pageRanks.get(topic.topic_id) ?? 0;
      const communities = labelCommunities(topics, [...edgeMap.values()]);
      for (const topic of topics) topic.community = communities.get(topic.topic_id) ?? topic.topic_id;
      assignBrokerScores(topics, [...edgeMap.values()]);

      const visibleTopics = topics
        .slice()
        .sort((a, b) => topicVisibilityScore(b) - topicVisibilityScore(a))
        .slice(0, MAX_VISIBLE_NODES);
      const visibleIds = new Set(visibleTopics.map((topic) => topic.topic_id));
      const visibleEdges = [...edgeMap.values()]
        .filter((edge) => visibleIds.has(edge.from_id) && visibleIds.has(edge.to_id) && edge.weight >= 2)
        .sort((a, b) => b.score - a.score || b.weight - a.weight)
        .slice(0, MAX_VISIBLE_EDGES);

      layoutTopics(visibleTopics, visibleEdges);

      const nodes = visibleTopics.map(nodeResult);
      const nodeById = new Map(nodes.map((node) => [node.topic_id, node]));
      const edgeResults = visibleEdges.map((edge) => edgeResult(edge, nodeById)).filter((edge): edge is ConstellationEdge => Boolean(edge));
      const communitiesResult = buildCommunities(topics, edgeMap, nodeById);
      const corridors = buildCorridors(edgeResults, visibleEdges, nodeById);
      const brokers = hydrateNodes(
        topics
          .slice()
          .sort((a, b) => b.broker_score - a.broker_score || b.pagerank - a.pagerank)
          .filter((topic) => visibleIds.has(topic.topic_id))
          .slice(0, MAX_BROKERS),
      ).map(nodeResult);
      const central = nodes.slice().sort((a, b) => b.pagerank - a.pagerank)[0];
      const strongest = edgeResults[0];
      const bridge = brokers[0];

      return {
        overview: {
          generated_at: getDataGeneratedAt(),
          topics: topics.length,
          visible_topics: nodes.length,
          corridors: edgeResults.length,
          communities: communitiesResult.length,
          central_topic: central?.label ?? "n/a",
          strongest_corridor: strongest ? `${strongest.from_label} -> ${strongest.to_label}` : "n/a",
          bridge_topic: bridge?.label ?? "n/a",
        },
        nodes: hydrateNodesById(nodes, topics),
        edges: edgeResults,
        communities: communitiesResult,
        corridors,
        brokers,
      };
    });
  },
);

function buildTopics(rows: SegmentRow[]): TopicBuild[] {
  const grouped = groupBy(rows, (row) => String(row.topic_id));
  const topics = [...grouped.values()].map((topicRows) => {
    const first = topicRows[0];
    const messages = sum(topicRows.map((row) => row.n_msgs));
    const me = sum(topicRows.map((row) => row.n_me));
    const weightedX = sum(topicRows.map((row) => (row.umap_x ?? 0) * row.n_msgs));
    const weightedY = sum(topicRows.map((row) => (row.umap_y ?? 0) * row.n_msgs));
    const monthSet = new Set(topicRows.map((row) => row.ym));
    const representative = first.representative_segment_id && topicRows.some((row) => row.id === first.representative_segment_id)
      ? first.representative_segment_id
      : topicRows.slice().sort((a, b) => b.n_msgs - a.n_msgs)[0].id;
    return {
      topic_id: first.topic_id,
      label: topicTitle(first),
      category: cleanLabel(mostCommon(topicRows.map((row) => row.category ?? "unlabeled"))),
      raw_x: messages === 0 ? 0 : weightedX / messages,
      raw_y: messages === 0 ? 0 : weightedY / messages,
      x: 0,
      y: 0,
      segments: topicRows.length,
      messages,
      me,
      active_months: monthSet.size,
      representative_segment_id: representative,
      keywords: keywordsFromRow(first),
      pagerank: 0,
      broker_score: 0,
      topic_stability: first.topic_stability == null ? null : round(first.topic_stability),
      community: first.topic_id,
      snippets: [],
    };
  });

  const xs = topics.map((topic) => topic.raw_x);
  const ys = topics.map((topic) => topic.raw_y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  for (const topic of topics) {
    topic.x = scale(topic.raw_x, minX, maxX, 54, GRAPH_WIDTH - 54);
    topic.y = scale(topic.raw_y, minY, maxY, GRAPH_HEIGHT - 54, 54);
  }

  return topics;
}

function buildEdges(rows: LinkRow[], topics: TopicBuild[]) {
  const topicCounts = new Map(topics.map((topic) => [topic.topic_id, topic.segments]));
  const totalSegments = sum(topics.map((topic) => topic.segments));
  const edgeMap = new Map<string, EdgeBuild>();
  const outgoing = new Map<number, number>();

  for (const row of rows) {
    outgoing.set(row.from_topic_id, (outgoing.get(row.from_topic_id) ?? 0) + 1);
    const key = `${row.from_topic_id}->${row.to_topic_id}`;
    const existing = edgeMap.get(key) ?? {
      from_id: row.from_topic_id,
      to_id: row.to_topic_id,
      weight: 0,
      gaps: [],
      lift: 0,
      score: 0,
      sample_from_segment_id: row.from_segment_id,
      sample_to_segment_id: row.to_segment_id,
      sample_gap_seconds: row.gap_seconds,
      sample_score: row.from_msgs + row.to_msgs - Math.log1p(row.gap_seconds / 3600),
    };
    existing.weight += 1;
    existing.gaps.push(row.gap_seconds);
    const sampleScore = row.from_msgs + row.to_msgs - Math.log1p(row.gap_seconds / 3600);
    if (sampleScore > existing.sample_score) {
      existing.sample_from_segment_id = row.from_segment_id;
      existing.sample_to_segment_id = row.to_segment_id;
      existing.sample_gap_seconds = row.gap_seconds;
      existing.sample_score = sampleScore;
    }
    edgeMap.set(key, existing);
  }

  for (const edge of edgeMap.values()) {
    const sourceTransitions = outgoing.get(edge.from_id) ?? 1;
    const targetBase = (topicCounts.get(edge.to_id) ?? 1) / Math.max(1, totalSegments);
    const conditioned = edge.weight / sourceTransitions;
    edge.lift = targetBase === 0 ? 0 : conditioned / targetBase;
    edge.score = edge.weight * Math.log2(1 + Math.max(0, edge.lift));
  }

  return edgeMap;
}

function pageRank(topics: TopicBuild[], edges: EdgeBuild[]) {
  const ids = topics.map((topic) => topic.topic_id);
  const n = ids.length;
  const ranks = new Map(ids.map((id) => [id, 1 / n]));
  const outgoing = new Map<number, EdgeBuild[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.from_id) ?? [];
    list.push(edge);
    outgoing.set(edge.from_id, list);
  }

  for (let iteration = 0; iteration < 42; iteration += 1) {
    const next = new Map(ids.map((id) => [id, (1 - PAGERANK_DAMPING) / n]));
    let dangling = 0;
    for (const id of ids) {
      const rank = ranks.get(id) ?? 0;
      const out = outgoing.get(id) ?? [];
      const total = sum(out.map((edge) => edge.weight));
      if (total === 0) {
        dangling += rank;
        continue;
      }
      for (const edge of out) {
        next.set(edge.to_id, (next.get(edge.to_id) ?? 0) + PAGERANK_DAMPING * rank * (edge.weight / total));
      }
    }
    if (dangling > 0) {
      for (const id of ids) {
        next.set(id, (next.get(id) ?? 0) + PAGERANK_DAMPING * dangling / n);
      }
    }
    ranks.clear();
    for (const [id, value] of next.entries()) ranks.set(id, value);
  }

  return ranks;
}

function labelCommunities(topics: TopicBuild[], edges: EdgeBuild[]) {
  const labels = new Map(topics.map((topic) => [topic.topic_id, topic.topic_id]));
  const neighbors = new Map<number, Array<{ id: number; weight: number }>>();
  for (const edge of edges) {
    neighbors.set(edge.from_id, [...(neighbors.get(edge.from_id) ?? []), { id: edge.to_id, weight: edge.weight }]);
    neighbors.set(edge.to_id, [...(neighbors.get(edge.to_id) ?? []), { id: edge.from_id, weight: edge.weight }]);
  }
  const ordered = topics.slice().sort((a, b) => b.segments - a.segments || a.topic_id - b.topic_id);
  for (let iteration = 0; iteration < 24; iteration += 1) {
    for (const topic of ordered) {
      const counts = new Map<number, number>();
      for (const neighbor of neighbors.get(topic.topic_id) ?? []) {
        const label = labels.get(neighbor.id) ?? neighbor.id;
        counts.set(label, (counts.get(label) ?? 0) + neighbor.weight);
      }
      const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
      if (best) labels.set(topic.topic_id, best[0]);
    }
  }

  const labelCounts = new Map<number, number>();
  for (const label of labels.values()) labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  const majorLabels = [...labelCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_COMMUNITIES)
    .map(([label], index) => [label, index] as const);
  const remap = new Map(majorLabels);
  for (const topic of topics) {
    const label = labels.get(topic.topic_id) ?? topic.topic_id;
    labels.set(topic.topic_id, remap.get(label) ?? MAX_COMMUNITIES - 1);
  }
  if (new Set(labels.values()).size >= 3) return labels;
  return categoryCommunities(topics);
}

function categoryCommunities(topics: TopicBuild[]) {
  const grouped = groupBy(topics, (topic) => topic.category || "unlabeled");
  const categoryIds = [...grouped.entries()]
    .sort((a, b) => sum(b[1].map((topic) => topic.segments)) - sum(a[1].map((topic) => topic.segments)))
    .slice(0, MAX_COMMUNITIES)
    .map(([category], index) => [category, index] as const);
  const categoryMap = new Map(categoryIds);
  return new Map(topics.map((topic) => [topic.topic_id, categoryMap.get(topic.category) ?? MAX_COMMUNITIES - 1]));
}

function assignBrokerScores(topics: TopicBuild[], edges: EdgeBuild[]) {
  const byId = new Map(topics.map((topic) => [topic.topic_id, topic]));
  const totals = new Map<number, { cross: number; all: number; communities: Set<number> }>();
  for (const edge of edges) {
    const from = byId.get(edge.from_id);
    const to = byId.get(edge.to_id);
    if (!from || !to) continue;
    for (const [node, other] of [[from, to], [to, from]] as const) {
      const bucket = totals.get(node.topic_id) ?? { cross: 0, all: 0, communities: new Set<number>() };
      bucket.all += edge.weight;
      if (node.community !== other.community) {
        bucket.cross += edge.weight;
        bucket.communities.add(other.community);
      }
      totals.set(node.topic_id, bucket);
    }
  }
  for (const topic of topics) {
    const bucket = totals.get(topic.topic_id);
    if (!bucket || bucket.all === 0) {
      topic.broker_score = 0;
    } else {
      topic.broker_score = (bucket.cross / bucket.all) * Math.log1p(bucket.cross) * Math.max(1, bucket.communities.size);
    }
  }
}

function layoutTopics(topics: TopicBuild[], edges: EdgeBuild[]) {
  const byId = new Map(topics.map((topic) => [topic.topic_id, topic]));
  const anchors = new Map(topics.map((topic) => [topic.topic_id, { x: topic.x, y: topic.y }]));
  const maxWeight = Math.max(...edges.map((edge) => edge.weight), 1);
  for (let iteration = 0; iteration < 70; iteration += 1) {
    const forces = new Map(topics.map((topic) => [topic.topic_id, { x: 0, y: 0 }]));
    for (let i = 0; i < topics.length; i += 1) {
      for (let j = i + 1; j < topics.length; j += 1) {
        const a = topics[i];
        const b = topics[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d2 = Math.max(160, dx * dx + dy * dy);
        const force = Math.min(1.15, 260 / d2);
        const fx = dx * force;
        const fy = dy * force;
        forces.get(a.topic_id)!.x += fx;
        forces.get(a.topic_id)!.y += fy;
        forces.get(b.topic_id)!.x -= fx;
        forces.get(b.topic_id)!.y -= fy;
      }
    }
    for (const edge of edges) {
      const a = byId.get(edge.from_id);
      const b = byId.get(edge.to_id);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const pull = 0.0011 * Math.sqrt(edge.weight / maxWeight);
      forces.get(a.topic_id)!.x += dx * pull;
      forces.get(a.topic_id)!.y += dy * pull;
      forces.get(b.topic_id)!.x -= dx * pull;
      forces.get(b.topic_id)!.y -= dy * pull;
    }
    for (const topic of topics) {
      const force = forces.get(topic.topic_id)!;
      const anchor = anchors.get(topic.topic_id)!;
      force.x += (anchor.x - topic.x) * 0.045;
      force.y += (anchor.y - topic.y) * 0.045;
      topic.x = clamp(topic.x + force.x * 0.28, 44, GRAPH_WIDTH - 44);
      topic.y = clamp(topic.y + force.y * 0.28, 44, GRAPH_HEIGHT - 44);
    }
  }
}

function nodeResult(topic: TopicBuild): ConstellationNode {
  return {
    topic_id: topic.topic_id,
    label: topic.label,
    category: topic.category,
    community: topic.community,
    x: round(topic.x),
    y: round(topic.y),
    radius: round(5 + Math.sqrt(topic.segments) * 1.55 + topic.pagerank * 52),
    segments: topic.segments,
    messages: topic.messages,
    active_months: topic.active_months,
    me_share: topic.messages === 0 ? 0 : topic.me / topic.messages,
    pagerank: topic.pagerank,
    broker_score: topic.broker_score,
    topic_stability: topic.topic_stability,
    keywords: topic.keywords,
    snippets: topic.snippets,
  };
}

function edgeResult(edge: EdgeBuild, nodes: Map<number, ConstellationNode>): ConstellationEdge | null {
  const from = nodes.get(edge.from_id);
  const to = nodes.get(edge.to_id);
  if (!from || !to) return null;
  return {
    id: `${edge.from_id}-${edge.to_id}`,
    from_id: edge.from_id,
    to_id: edge.to_id,
    from_label: from.label,
    to_label: to.label,
    from_x: from.x,
    from_y: from.y,
    to_x: to.x,
    to_y: to.y,
    weight: edge.weight,
    strength: round(edge.score),
    lift: round(edge.lift),
    median_gap_seconds: median(edge.gaps) ?? 0,
    community_jump: from.community !== to.community,
  };
}

function buildCommunities(
  topics: TopicBuild[],
  edgeMap: Map<string, EdgeBuild>,
  visibleNodeById: Map<number, ConstellationNode>,
): ConstellationCommunity[] {
  const visible = new Set(visibleNodeById.keys());
  const groups = groupBy(topics.filter((topic) => visible.has(topic.topic_id)), (topic) => String(topic.community));
  return [...groups.entries()]
    .map(([id, group]) => {
      const community = Number(id);
      let internalWeight = 0;
      let externalWeight = 0;
      for (const edge of edgeMap.values()) {
        const from = visibleNodeById.get(edge.from_id);
        const to = visibleNodeById.get(edge.to_id);
        if (!from || !to) continue;
        if (from.community === community && to.community === community) internalWeight += edge.weight;
        if ((from.community === community) !== (to.community === community)) externalWeight += edge.weight;
      }
      const topNodes = group.slice().sort((a, b) => b.pagerank - a.pagerank).slice(0, 5).map(nodeResult);
      return {
        id: community,
        label: communityLabel(group),
        topics: group.length,
        segments: sum(group.map((topic) => topic.segments)),
        messages: sum(group.map((topic) => topic.messages)),
        dominant_category: cleanLabel(mostCommon(group.map((topic) => topic.category))),
        top_nodes: topNodes,
        internal_weight: internalWeight,
        external_weight: externalWeight,
      };
    })
    .sort((a, b) => b.topics - a.topics || b.segments - a.segments);
}

function buildCorridors(edges: ConstellationEdge[], edgeBuilds: EdgeBuild[], nodeById: Map<number, ConstellationNode>): ConstellationCorridor[] {
  const buildById = new Map(edgeBuilds.map((edge) => [`${edge.from_id}-${edge.to_id}`, edge]));
  return edges.slice(0, MAX_CORRIDORS).map((edge) => {
    const build = buildById.get(edge.id)!;
    return {
      edge,
      sample_gap_seconds: build.sample_gap_seconds,
      from_snippets: snippetsForSegment(build.sample_from_segment_id),
      to_snippets: snippetsForSegment(build.sample_to_segment_id),
    };
  }).filter((corridor) => nodeById.has(corridor.edge.from_id) && nodeById.has(corridor.edge.to_id));
}

function hydrateNodesById(nodes: ConstellationNode[], topics: TopicBuild[]) {
  const topicById = new Map(topics.map((topic) => [topic.topic_id, topic]));
  const hydrateIds = new Set(nodes.slice().sort((a, b) => b.pagerank - a.pagerank).slice(0, 20).map((node) => node.topic_id));
  hydrateNodes([...hydrateIds].map((id) => topicById.get(id)).filter((topic): topic is TopicBuild => Boolean(topic)));
  return nodes.map((node) => ({
    ...node,
    snippets: topicById.get(node.topic_id)?.snippets ?? [],
  }));
}

function hydrateNodes(topics: TopicBuild[]) {
  for (const topic of topics) {
    if (!topic.snippets.length) topic.snippets = snippetsForSegment(topic.representative_segment_id);
  }
  return topics;
}

function snippetsForSegment(segmentId: number): ConstellationSnippet[] {
  const rows = db()
    .prepare(
      `
      SELECT m.ts, m.is_from_me, m.text
      FROM seg_msg_segment sms
      JOIN messages m ON m.id = sms.msg_id
      WHERE sms.segment_id = ?
        AND m.text IS NOT NULL
        AND trim(m.text) != ''
      ORDER BY m.ts ASC, m.id ASC
      LIMIT 3
    `,
    )
    .all(segmentId) as SnippetRow[];
  return rows.map((row) => {
    const sender: Sender = row.is_from_me ? "Me" : "Them";
    return {
      ts: row.ts,
      sender,
      text: preview(row.text),
    };
  });
}

function topicVisibilityScore(topic: TopicBuild) {
  return topic.pagerank * 650 + topic.broker_score * 7 + Math.log1p(topic.segments) * 9 + topic.active_months * 0.35;
}

function communityLabel(topics: TopicBuild[]) {
  const labels = topics
    .slice()
    .sort((a, b) => b.pagerank - a.pagerank)
    .slice(0, 2)
    .map((topic) => topic.label.split(":")[0]);
  return labels.join(" / ");
}

function topicTitle(row: SegmentRow) {
  const base = cleanLabel(row.topic_label ?? row.category ?? "topic");
  const detail = [...parseList(row.top_phrases), ...parseList(row.top_words)]
    .filter((item, index, arr) => item.length > 2 && item !== base && arr.indexOf(item) === index)
    .slice(0, 2)
    .join(", ");
  return detail ? `${base}: ${detail}` : base;
}

function keywordsFromRow(row: SegmentRow) {
  return [...parseList(row.top_phrases), ...parseList(row.top_words)]
    .filter((item, index, arr) => item.length > 2 && arr.indexOf(item) === index)
    .slice(0, 7);
}

function parseList(value: string | null) {
  const raw = (value ?? "").trim();
  if (!raw) return [];
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((item) => cleanLabel(String(item))).filter(Boolean);
    } catch {
      // Fall through for non-JSON generated strings.
    }
  }
  return raw.split(/[,|]/).map(cleanLabel).filter(Boolean);
}

function cleanLabel(value: string) {
  return value
    .replace(/[[\]"]/g, "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function groupBy<T>(items: T[], keyFn: (item: T) => string) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}

function mostCommon(values: string[]) {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "unlabeled";
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function scale(value: number, min: number, max: number, outMin: number, outMax: number) {
  if (max === min) return (outMin + outMax) / 2;
  return outMin + ((value - min) / (max - min)) * (outMax - outMin);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function preview(text: string | null) {
  const cleaned = (text ?? "").replace(/\s+/g, " ").trim();
  return cleaned.length > 180 ? `${cleaned.slice(0, 177)}...` : cleaned;
}
