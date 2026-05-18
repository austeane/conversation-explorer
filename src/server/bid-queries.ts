import { createServerFn } from "@tanstack/react-start";
import { realMessageWhere } from "~/lib/conversation/filters";
import { messageScopeInput, messageScopeWhere } from "~/lib/conversation/scope";
import { db, getDataGeneratedAt, withDbCache } from "~/lib/server-db";
import { resolveMessageScope } from "~/server/scope";

const REAL_MESSAGE_WHERE = realMessageWhere("browsable_message", "m");
const ONE_HOUR = 60 * 60;
const SIX_HOURS = 6 * ONE_HOUR;
const ONE_DAY = 24 * ONE_HOUR;

export type Sender = "Me" | "Them";

export type BidOverview = {
  generated_at: string;
  real_messages: number;
  bid_messages: number;
  bid_instances: number;
  response_share_6h: number;
  median_response_seconds: number | null;
};

export type BidTypeStats = {
  key: string;
  label: string;
  description: string;
  total: number;
  me: number;
  them: number;
  response_share_1h: number;
  response_share_6h: number;
  median_response_seconds: number | null;
};

export type QuestionShape = {
  key: string;
  label: string;
  count: number;
  me: number;
  them: number;
  response_share_6h: number;
};

export type BidExchange = {
  bid_ts: number;
  bid_ymd: string;
  response_ts: number | null;
  response_ymd: string | null;
  sender: Sender;
  responder: Sender | null;
  type: string;
  gap_seconds: number | null;
  bid_preview: string;
  response_preview: string | null;
};

export type BidsResult = {
  overview: BidOverview;
  types: BidTypeStats[];
  question_shapes: QuestionShape[];
  fast_exchanges: BidExchange[];
  long_hanging: BidExchange[];
};

type MessageRow = {
  id: number;
  ts: number;
  ymd: string;
  is_from_me: number;
  text: string | null;
  has_attachment: number;
  rich_link_url: string | null;
};

type BidTypeDefinition = {
  key: string;
  label: string;
  description: string;
  test: (row: MessageRow, lower: string) => boolean;
};

type BidAccumulator = {
  key: string;
  label: string;
  description: string;
  total: number;
  me: number;
  them: number;
  response1h: number;
  response6h: number;
  responseGaps: number[];
};

type ShapeAccumulator = {
  key: string;
  label: string;
  count: number;
  me: number;
  them: number;
  response6h: number;
};

const BID_TYPES: BidTypeDefinition[] = [
  {
    key: "question",
    label: "Direct questions",
    description: "Question marks and explicit question openings.",
    test: (_row, lower) =>
      lower.includes("?") ||
      /^(what|when|where|why|how|who|do|does|did|are|is|can|could|would|should|will)\b/.test(lower),
  },
  {
    key: "logistics",
    label: "Logistics bids",
    description: "Coordination around where, when, timing, pickup, and plans.",
    test: (_row, lower) =>
      /\b(what time|when|where|meet|pickup|pick up|drop off|come over|heading|on my way|free|available|tonight|tomorrow|schedule|plan)\b/.test(lower),
  },
  {
    key: "invitation",
    label: "Invitations",
    description: "Offers to do something together or asks to opt into a plan.",
    test: (_row, lower) =>
      /\b(want to|wanna|do you want|should we|could we|can we|let's|lets|come over|hang out|join me)\b/.test(lower),
  },
  {
    key: "care",
    label: "Care checks",
    description: "Checking on state, feelings, recovery, or how the day went.",
    test: (_row, lower) =>
      /\b(how are you|how was|are you okay|you ok|feel better|hope you|checking in|did you sleep|how'd you sleep)\b/.test(lower),
  },
  {
    key: "affection",
    label: "Affection bids",
    description: "Love, missing, pride, and explicitly warm bids for return warmth.",
    test: (_row, lower) =>
      /\b(love you|love tons|love lots|love much|miss you|proud of you|excited to see|can't wait to see|cant wait to see)\b/.test(lower),
  },
  {
    key: "repair",
    label: "Repair bids",
    description: "Apologies and repair attempts that ask the room to rebalance.",
    test: (_row, lower) => /\b(sorry|apologize|apologise|my bad|forgive)\b/.test(lower),
  },
  {
    key: "shared_object",
    label: "Shared objects",
    description: "Links, attachments, and media dropped into the thread.",
    test: (row, lower) => row.has_attachment === 1 || Boolean(row.rich_link_url) || /https?:\/\//.test(lower),
  },
];

const QUESTION_LABELS: Record<string, string> = {
  how: "How",
  what: "What",
  when: "When",
  where: "Where",
  why: "Why",
  who: "Who",
  can_could: "Can/could",
  would_should: "Would/should",
  do_did: "Do/did",
  are_is: "Are/is",
  will: "Will",
  other: "Other",
};

export const getBids = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => messageScopeInput.parse(d ?? {}))
  .handler(async ({ data }): Promise<BidsResult> => {
    const resolved = resolveMessageScope(data);
    return withDbCache(`bids:${JSON.stringify(resolved)}`, () => {
      const scanScope = { ...resolved, sender: "both" as const };
      const scope = messageScopeWhere(scanScope, "m", [REAL_MESSAGE_WHERE]);
      const rows = db()
        .prepare(
          `
          SELECT m.id, m.ts, m.ymd, m.is_from_me, m.text, m.has_attachment, m.rich_link_url
          FROM messages m
          ${scope.sql}
          ORDER BY m.ts ASC
        `,
        )
        .all(...scope.args) as MessageRow[];

      const nextOtherIndex = computeNextOtherIndexes(rows);
      const typeStats = new Map(BID_TYPES.map((type) => [type.key, createBidAccumulator(type)]));
      const questionStats = new Map<string, ShapeAccumulator>();
      const fastExchanges: BidExchange[] = [];
      const longHanging: BidExchange[] = [];
      const allGaps: number[] = [];
      const bidMessageIds = new Set<number>();
      let bidInstances = 0;
      let responsesWithin6h = 0;

      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        if (!senderMatches(row, resolved.sender)) continue;
        const lower = normalize(row.text);
        const matched = BID_TYPES.filter((type) => type.test(row, lower));
        if (matched.length === 0) continue;

        bidMessageIds.add(row.id);
        const responseIndex = nextOtherIndex[i];
        const response = responseIndex == null ? null : rows[responseIndex];
        const gap = response ? response.ts - row.ts : null;
        const sender = senderFor(row);
        const responder = response ? senderFor(response) : null;

        for (const type of matched) {
          bidInstances += 1;
          const stat = typeStats.get(type.key)!;
          stat.total += 1;
          if (sender === "Me") stat.me += 1;
          else stat.them += 1;
          if (gap != null) {
            allGaps.push(gap);
            stat.responseGaps.push(gap);
            if (gap <= ONE_HOUR) stat.response1h += 1;
            if (gap <= SIX_HOURS) {
              stat.response6h += 1;
              responsesWithin6h += 1;
            }
          }

          const exchange = createExchange(type.label, row, response, gap, sender, responder);
          if (gap != null && gap >= 10 && gap <= 10 * 60 && isReadableExchange(exchange)) {
            fastExchanges.push(exchange);
          }
          if ((gap == null || gap >= ONE_DAY) && isLongHangingExchange(exchange)) {
            longHanging.push(exchange);
          }
        }

        if (matched.some((type) => type.key === "question")) {
          const shapeKey = questionShape(lower);
          const shape = questionStats.get(shapeKey) ?? {
            key: shapeKey,
            label: QUESTION_LABELS[shapeKey] ?? "Other",
            count: 0,
            me: 0,
            them: 0,
            response6h: 0,
          };
          shape.count += 1;
          if (sender === "Me") shape.me += 1;
          else shape.them += 1;
          if (gap != null && gap <= SIX_HOURS) shape.response6h += 1;
          questionStats.set(shapeKey, shape);
        }
      }

      return {
        overview: {
          generated_at: getDataGeneratedAt(),
          real_messages: rows.filter((row) => senderMatches(row, resolved.sender)).length,
          bid_messages: bidMessageIds.size,
          bid_instances: bidInstances,
          response_share_6h: bidInstances ? responsesWithin6h / bidInstances : 0,
          median_response_seconds: median(allGaps),
        },
        types: [...typeStats.values()]
          .filter((stat) => stat.total > 0)
          .map((stat) => ({
            key: stat.key,
            label: stat.label,
            description: stat.description,
            total: stat.total,
            me: stat.me,
            them: stat.them,
            response_share_1h: stat.total ? stat.response1h / stat.total : 0,
            response_share_6h: stat.total ? stat.response6h / stat.total : 0,
            median_response_seconds: median(stat.responseGaps),
          }))
          .sort((a, b) => b.total - a.total),
        question_shapes: [...questionStats.values()]
          .map((shape) => ({
            key: shape.key,
            label: shape.label,
            count: shape.count,
            me: shape.me,
            them: shape.them,
            response_share_6h: shape.count ? shape.response6h / shape.count : 0,
          }))
          .sort((a, b) => b.count - a.count),
        fast_exchanges: fastExchanges
          .sort((a, b) => (a.gap_seconds ?? 0) - (b.gap_seconds ?? 0))
          .slice(0, 16),
        long_hanging: longHanging
          .sort((a, b) => (b.gap_seconds ?? Number.POSITIVE_INFINITY) - (a.gap_seconds ?? Number.POSITIVE_INFINITY))
          .slice(0, 16),
      };
    });
  });

function computeNextOtherIndexes(rows: MessageRow[]) {
  const out = Array<number | null>(rows.length).fill(null);
  let nextMe: number | null = null;
  let nextThem: number | null = null;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    out[i] = row.is_from_me === 1 ? nextThem : nextMe;
    if (row.is_from_me === 1) nextMe = i;
    else nextThem = i;
  }
  return out;
}

function createBidAccumulator(type: BidTypeDefinition): BidAccumulator {
  return {
    key: type.key,
    label: type.label,
    description: type.description,
    total: 0,
    me: 0,
    them: 0,
    response1h: 0,
    response6h: 0,
    responseGaps: [],
  };
}

function createExchange(
  type: string,
  bid: MessageRow,
  response: MessageRow | null,
  gap: number | null,
  sender: Sender,
  responder: Sender | null,
): BidExchange {
  return {
    bid_ts: bid.ts,
    bid_ymd: bid.ymd,
    response_ts: response?.ts ?? null,
    response_ymd: response?.ymd ?? null,
    sender,
    responder,
    type,
    gap_seconds: gap,
    bid_preview: cleanPreview(bid.text, bid.has_attachment),
    response_preview: response ? cleanPreview(response.text, response.has_attachment) : null,
  };
}

function hasPreview(exchange: BidExchange) {
  return exchange.bid_preview !== "No text body" && exchange.bid_preview !== "Attachment";
}

function isReadableExchange(exchange: BidExchange) {
  return hasPreview(exchange) && !isUrlHeavy(exchange.bid_preview) && !isUrlHeavy(exchange.response_preview ?? "");
}

function isLongHangingExchange(exchange: BidExchange) {
  return (
    hasPreview(exchange) &&
    exchange.type !== "Shared objects" &&
    !isUrlHeavy(exchange.bid_preview) &&
    !isUrlHeavy(exchange.response_preview ?? "")
  );
}

function isUrlHeavy(preview: string) {
  return /^https?:\/\//.test(preview) || preview.includes("icloud.com") || preview.includes("maps.app.goo");
}

function questionShape(lower: string) {
  const match = lower.match(/\b(how|what|when|where|why|who|can|could|would|should|do|did|does|are|is|will)\b/);
  const token = match?.[1];
  if (!token) return "other";
  if (token === "can" || token === "could") return "can_could";
  if (token === "would" || token === "should") return "would_should";
  if (token === "do" || token === "did" || token === "does") return "do_did";
  if (token === "are" || token === "is") return "are_is";
  return token;
}

function normalize(text: string | null) {
  return (text ?? "")
    .toLowerCase()
    .replace(/[‘’‛ʼ]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanPreview(text: string | null, hasAttachment: number) {
  if (!text || !text.trim()) return hasAttachment ? "Attachment" : "No text body";
  return text.replace(/\s+/g, " ").trim().slice(0, 220);
}

function senderFor(row: MessageRow): Sender {
  return row.is_from_me === 1 ? "Me" : "Them";
}

function senderMatches(row: MessageRow, sender: "me" | "them" | "both" = "both") {
  if (sender === "both") return true;
  return sender === "me" ? row.is_from_me === 1 : row.is_from_me === 0;
}

function median(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
