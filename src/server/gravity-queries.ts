import { createServerFn } from "@tanstack/react-start";
import { realMessageWhere } from "~/lib/conversation/filters";
import { isExcludedTopicCategory } from "~/lib/conversation/topic-hygiene";
import { db, getDataGeneratedAt, withDbCache } from "~/lib/server-db";

const REAL_MESSAGE_WHERE = realMessageWhere("browsable_message", "m");
const MIN_CATEGORY_SEGMENTS = 12;
const MAX_PREVIEW_CHARS = 260;

export type Sender = "Me" | "Them";

export type GravityOverview = {
  generated_at: string;
  segments: number;
  messages: number;
  categories: number;
  me_start_share: number;
  me_message_share: number;
  shared_segment_share: number;
  strongest_me_pull: string;
  strongest_them_pull: string;
};

export type GravityExample = {
  segment_id: number;
  start_ts: number;
  starter: Sender;
  n_messages: number;
  me_messages: number;
  them_messages: number;
  topic_label: string | null;
  preview: string;
};

export type GravityCategory = {
  category: string;
  segments: number;
  messages: number;
  me_start_share: number;
  me_message_share: number;
  mutual_share: number;
  start_lift: number;
  message_lift: number;
  gravity_score: number;
  role: string;
  examples: GravityExample[];
};

export type GravityTransition = {
  from_category: string;
  to_category: string;
  starter: Sender;
  n: number;
  avg_gap_seconds: number;
  example_start_ts: number;
  example_preview: string;
};

export type GravityResult = {
  overview: GravityOverview;
  categories: GravityCategory[];
  transitions: GravityTransition[];
  me_pulls: GravityCategory[];
  them_pulls: GravityCategory[];
};

type SegmentRow = {
  id: number;
  start_ts: number;
  end_ts: number;
  category: string | null;
  topic_label: string | null;
};

type SegmentMessageRow = {
  segment_id: number;
  ts: number;
  is_from_me: number;
  text: string | null;
};

type SegmentAnalysis = {
  id: number;
  startTs: number;
  endTs: number;
  category: string;
  topicLabel: string | null;
  starter: Sender;
  nMessages: number;
  meMessages: number;
  themMessages: number;
  preview: string;
};

type CategoryAccumulator = {
  category: string;
  segments: number;
  messages: number;
  meStarts: number;
  themStarts: number;
  meMessages: number;
  themMessages: number;
  mutualSegments: number;
  examples: SegmentAnalysis[];
};

type TransitionAccumulator = {
  fromCategory: string;
  toCategory: string;
  starter: Sender;
  n: number;
  totalGapSeconds: number;
  example: SegmentAnalysis;
};

export const getGravity = createServerFn({ method: "GET" }).handler(
  async (): Promise<GravityResult> => {
    return withDbCache("gravity", () => {
      const segmentRows = db()
        .prepare(
          `
          SELECT s.id,
                 s.start_ts,
                 s.end_ts,
                 COALESCE(c.category, 'unclassified') AS category,
                 t.label AS topic_label
          FROM seg_segments s
          LEFT JOIN seg_segment_categories c ON c.segment_id = s.id
          LEFT JOIN seg_topics t ON t.id = s.topic_id
          ORDER BY s.start_ts ASC, s.id ASC
        `,
        )
        .all() as SegmentRow[];

      const messageRows = db()
        .prepare(
          `
          SELECT sms.segment_id, m.ts, m.is_from_me, m.text
          FROM seg_msg_segment sms
          JOIN messages m ON m.id = sms.msg_id
          WHERE ${REAL_MESSAGE_WHERE}
          ORDER BY sms.segment_id ASC, m.ts ASC, m.id ASC
        `,
        )
        .all() as SegmentMessageRow[];

      const messagesBySegment = new Map<number, SegmentMessageRow[]>();
      for (const row of messageRows) {
        const group = messagesBySegment.get(row.segment_id);
        if (group) group.push(row);
        else messagesBySegment.set(row.segment_id, [row]);
      }

      const segments = segmentRows
        .map((row) => analyzeSegment(row, messagesBySegment.get(row.id) ?? []))
        .filter((segment): segment is SegmentAnalysis => segment !== null);

      const categories = new Map<string, CategoryAccumulator>();
      let meStarts = 0;
      let meMessages = 0;
      let totalMessages = 0;
      let mutualSegments = 0;

      for (const segment of segments) {
        if (segment.starter === "Me") meStarts += 1;
        meMessages += segment.meMessages;
        totalMessages += segment.nMessages;
        if (segment.meMessages > 0 && segment.themMessages > 0) mutualSegments += 1;

        const slot = categorySlot(categories, segment.category);
        slot.segments += 1;
        slot.messages += segment.nMessages;
        if (segment.starter === "Me") slot.meStarts += 1;
        else slot.themStarts += 1;
        slot.meMessages += segment.meMessages;
        slot.themMessages += segment.themMessages;
        if (segment.meMessages > 0 && segment.themMessages > 0) slot.mutualSegments += 1;
        slot.examples.push(segment);
      }

      const overallStartShare = segments.length ? meStarts / segments.length : 0;
      const overallMessageShare = totalMessages ? meMessages / totalMessages : 0;
      const categoryResults = [...categories.values()]
        .filter((category) => category.segments >= MIN_CATEGORY_SEGMENTS)
        .filter((category) => !isExcludedTopicCategory(category.category))
        .map((category) => toGravityCategory(category, overallStartShare, overallMessageShare))
        .sort((a, b) => Math.abs(b.gravity_score) - Math.abs(a.gravity_score) || b.segments - a.segments);

      const transitions = buildTransitions(segments);
      const mePulls = categoryResults
        .filter((category) => category.gravity_score > 0)
        .sort((a, b) => b.gravity_score - a.gravity_score)
        .slice(0, 6);
      const themPulls = categoryResults
        .filter((category) => category.gravity_score < 0)
        .sort((a, b) => a.gravity_score - b.gravity_score)
        .slice(0, 6);

      return {
        overview: {
          generated_at: getDataGeneratedAt(),
          segments: segments.length,
          messages: totalMessages,
          categories: categoryResults.length,
          me_start_share: overallStartShare,
          me_message_share: overallMessageShare,
          shared_segment_share: segments.length ? mutualSegments / segments.length : 0,
          strongest_me_pull: mePulls[0]?.category ?? "n/a",
          strongest_them_pull: themPulls[0]?.category ?? "n/a",
        },
        categories: categoryResults.slice(0, 18),
        transitions,
        me_pulls: mePulls,
        them_pulls: themPulls,
      };
    });
  },
);

function analyzeSegment(row: SegmentRow, messages: SegmentMessageRow[]): SegmentAnalysis | null {
  if (!messages.length) return null;
  let meMessages = 0;
  let themMessages = 0;
  for (const message of messages) {
    if (message.is_from_me === 1) meMessages += 1;
    else themMessages += 1;
  }

  return {
    id: row.id,
    startTs: row.start_ts,
    endTs: row.end_ts,
    category: row.category ?? "unclassified",
    topicLabel: row.topic_label,
    starter: messages[0].is_from_me === 1 ? "Me" : "Them",
    nMessages: messages.length,
    meMessages,
    themMessages,
    preview: preview(messages),
  };
}

function categorySlot(categories: Map<string, CategoryAccumulator>, category: string) {
  const existing = categories.get(category);
  if (existing) return existing;
  const created: CategoryAccumulator = {
    category,
    segments: 0,
    messages: 0,
    meStarts: 0,
    themStarts: 0,
    meMessages: 0,
    themMessages: 0,
    mutualSegments: 0,
    examples: [],
  };
  categories.set(category, created);
  return created;
}

function toGravityCategory(
  category: CategoryAccumulator,
  overallStartShare: number,
  overallMessageShare: number,
): GravityCategory {
  const meStartShare = category.segments ? category.meStarts / category.segments : 0;
  const meMessageShare = category.messages ? category.meMessages / category.messages : 0;
  const startLift = meStartShare - overallStartShare;
  const messageLift = meMessageShare - overallMessageShare;
  const gravityScore = startLift * 0.65 + messageLift * 0.35;

  return {
    category: category.category,
    segments: category.segments,
    messages: category.messages,
    me_start_share: meStartShare,
    me_message_share: meMessageShare,
    mutual_share: category.segments ? category.mutualSegments / category.segments : 0,
    start_lift: startLift,
    message_lift: messageLift,
    gravity_score: gravityScore,
    role: roleFor(gravityScore, category.mutualSegments / category.segments),
    examples: category.examples
      .filter((example) => example.preview)
      .sort((a, b) => b.nMessages - a.nMessages || b.startTs - a.startTs)
      .slice(0, 2)
      .map(toExample),
  };
}

function buildTransitions(segments: SegmentAnalysis[]): GravityTransition[] {
  const transitions = new Map<string, TransitionAccumulator>();
  for (let i = 1; i < segments.length; i += 1) {
    const previous = segments[i - 1];
    const current = segments[i];
    if (previous.category === current.category) continue;

    const key = `${previous.category}\u0000${current.category}\u0000${current.starter}`;
    const gap = Math.max(0, current.startTs - previous.endTs);
    const existing = transitions.get(key);
    if (existing) {
      existing.n += 1;
      existing.totalGapSeconds += gap;
      if (current.nMessages > existing.example.nMessages && current.preview) existing.example = current;
    } else {
      transitions.set(key, {
        fromCategory: previous.category,
        toCategory: current.category,
        starter: current.starter,
        n: 1,
        totalGapSeconds: gap,
        example: current,
      });
    }
  }

  return [...transitions.values()]
    .filter((transition) => transition.n >= 4)
    .sort((a, b) => b.n - a.n || a.totalGapSeconds / a.n - b.totalGapSeconds / b.n)
    .slice(0, 18)
    .map((transition) => ({
      from_category: transition.fromCategory,
      to_category: transition.toCategory,
      starter: transition.starter,
      n: transition.n,
      avg_gap_seconds: transition.totalGapSeconds / transition.n,
      example_start_ts: transition.example.startTs,
      example_preview: transition.example.preview,
    }));
}

function roleFor(gravityScore: number, mutualShare: number) {
  if (Math.abs(gravityScore) < 0.015) return mutualShare >= 0.55 ? "shared field" : "low pull";
  if (gravityScore >= 0.05) return "Me pulls";
  if (gravityScore <= -0.05) return "Them pulls";
  return gravityScore > 0 ? "leans Me" : "leans Them";
}

function toExample(segment: SegmentAnalysis): GravityExample {
  return {
    segment_id: segment.id,
    start_ts: segment.startTs,
    starter: segment.starter,
    n_messages: segment.nMessages,
    me_messages: segment.meMessages,
    them_messages: segment.themMessages,
    topic_label: segment.topicLabel,
    preview: segment.preview,
  };
}

function preview(messages: SegmentMessageRow[]) {
  const parts = messages
    .map((message) => cleanText(message.text))
    .filter((text) => text.length > 0)
    .slice(0, 4);
  return truncate(parts.join(" / "), MAX_PREVIEW_CHARS);
}

function cleanText(text: string | null) {
  return (text ?? "")
    .replace(/\s+/g, " ")
    .replace(/\uFFFC/g, "")
    .trim();
}

function truncate(text: string, maxChars: number) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1).trim()}…`;
}
