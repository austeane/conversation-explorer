import { createServerFn } from "@tanstack/react-start";
import { realMessageWhere } from "~/lib/conversation/filters";
import { messageScopeInput, messageScopeWhere, type MessageScope } from "~/lib/conversation/scope";
import { db, getDataGeneratedAt, withDbCache } from "~/lib/server-db";
import { resolveMessageScope } from "~/server/scope";
import { classifyMove, type MoveKind as ClassifiedMoveKind } from "./move-classifier";

const REAL_MESSAGE_WHERE = realMessageWhere("text_turn", "m");
const TURN_GAP_SECONDS = 20 * 60;
const REPLY_WINDOW_SECONDS = 24 * 60 * 60;
const MIN_TOKEN_COUNT = 10;
const MAX_CUES = 18;
const MAX_EXAMPLES = 12;

const MOVE_KINDS = [
  "affection",
  "care",
  "question",
  "logistics",
  "play",
  "repair",
  "strain",
  "object",
  "status",
] as const;

export type InfoMoveKind = (typeof MOVE_KINDS)[number];
export type InfoDirectionKey = "me_to_them" | "them_to_me";
export type Sender = "Me" | "Them";

export type InformationOverview = {
  generated_at: string;
  real_messages: number;
  turns: number;
  reply_pairs: number;
  me_to_them_bits: number;
  them_to_me_bits: number;
  shared_cues: number;
  strongest_cue: string;
};

export type InformationMatrixCell = {
  source: InfoMoveKind;
  reply: InfoMoveKind;
  source_label: string;
  reply_label: string;
  count: number;
  probability: number;
  lift: number;
  contribution_bits: number;
};

export type InformationChannelRow = {
  source: InfoMoveKind;
  label: string;
  count: number;
  entropy: number;
  top_reply: string;
  top_lift: number;
};

export type InformationChannel = {
  direction: InfoDirectionKey;
  label: string;
  pairs: number;
  reply_entropy: number;
  conditional_entropy: number;
  mutual_information: number;
  uncertainty_reduction: number;
  rows: InformationChannelRow[];
  cells: InformationMatrixCell[];
};

export type InformationCue = {
  key: string;
  direction: InfoDirectionKey;
  direction_label: string;
  token: string;
  reply_kind: InfoMoveKind;
  reply_label: string;
  count: number;
  lift: number;
  contribution_bits: number;
};

export type InformationMonth = {
  ym: string;
  pairs: number;
  entropy: number;
  predictability: number;
  dominant_reply: string;
};

export type InformationExample = {
  key: string;
  cue: string;
  direction_label: string;
  reply_label: string;
  lift: number;
  source_ts: number;
  source_ymd: string;
  reply_ts: number;
  reply_ymd: string;
  source_sender: Sender;
  reply_sender: Sender;
  source_text: string;
  reply_text: string;
};

export type InformationResult = {
  overview: InformationOverview;
  channels: InformationChannel[];
  cues: InformationCue[];
  months: InformationMonth[];
  examples: InformationExample[];
};

type MessageRow = {
  ts: number;
  ym: string;
  ymd: string;
  is_from_me: number;
  text: string | null;
  word_count: number;
  has_attachment: number;
};

type Turn = {
  id: number;
  ts: number;
  ym: string;
  ymd: string;
  sender: Sender;
  text: string;
  hasAttachment: boolean;
  kind: InfoMoveKind;
  tokens: string[];
};

type Pair = {
  id: number;
  direction: InfoDirectionKey;
  source: Turn;
  reply: Turn;
  gapSeconds: number;
};

type TokenAccumulator = {
  token: string;
  direction: InfoDirectionKey;
  count: number;
  replyCounts: Record<InfoMoveKind, number>;
  examplePairs: Pair[];
};

const MOVE_LABELS: Record<InfoMoveKind, string> = {
  affection: "Affection",
  care: "Care",
  question: "Question",
  logistics: "Logistics",
  play: "Play",
  repair: "Repair",
  strain: "Strain",
  object: "Object",
  status: "Status",
};

const DIRECTION_LABELS: Record<InfoDirectionKey, string> = {
  me_to_them: "Me -> Them",
  them_to_me: "Them -> Me",
};

const STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "and",
  "are",
  "because",
  "been",
  "but",
  "can",
  "could",
  "did",
  "didnt",
  "does",
  "dont",
  "even",
  "for",
  "from",
  "going",
  "have",
  "here",
  "how",
  "just",
  "know",
  "like",
  "more",
  "not",
  "okay",
  "really",
  "that",
  "the",
  "then",
  "there",
  "they",
  "this",
  "was",
  "what",
  "when",
  "where",
  "with",
  "would",
  "you",
  "your",
]);

export const getInformation = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => messageScopeInput.parse(d ?? {}))
  .handler(async ({ data }): Promise<InformationResult> => {
    const resolved = resolveMessageScope(data);
    return withDbCache(`information:${JSON.stringify(resolved)}`, () => {
      const scanScope = { ...resolved, sender: "both" as const };
      const scope = messageScopeWhere(scanScope, "m", [REAL_MESSAGE_WHERE]);
      const rows = db()
        .prepare(
          `
          SELECT m.ts, m.ym, m.ymd, m.is_from_me, m.text, m.word_count, m.has_attachment
          FROM messages m
          ${scope.sql}
          ORDER BY m.ts ASC, m.id ASC
        `,
        )
        .all(...scope.args) as MessageRow[];

      const turns = buildTurns(rows);
      const sourceTurns = turns.filter((turn) => senderMatches(turn.sender, resolved.sender));
      const pairs = buildPairs(turns).filter((pair) => senderMatches(pair.source.sender, resolved.sender));
      const channels = buildChannels(pairs);
      const cues = buildCues(pairs, channels);
      const months = buildMonths(pairs);
      const examples = buildExamples(cues, pairs);
      const strongestCue = cues[0];

      return {
        overview: {
          generated_at: getDataGeneratedAt(),
          real_messages: rows.filter((row) => senderMatches(senderFor(row), resolved.sender)).length,
          turns: sourceTurns.length,
          reply_pairs: pairs.length,
          me_to_them_bits: round(channels.find((channel) => channel.direction === "me_to_them")?.mutual_information ?? 0),
          them_to_me_bits: round(channels.find((channel) => channel.direction === "them_to_me")?.mutual_information ?? 0),
          shared_cues: cues.length,
          strongest_cue: strongestCue ? `${strongestCue.token} -> ${strongestCue.reply_label}` : "n/a",
        },
        channels,
        cues,
        months,
        examples,
      };
    });
  });

function buildTurns(rows: MessageRow[]) {
  const turns: Turn[] = [];
  let current: Omit<Turn, "kind" | "tokens"> | null = null;

  for (const row of rows) {
    const sender: Sender = row.is_from_me === 1 ? "Me" : "Them";
    const text = clean(row.text);
    if (!text && row.has_attachment !== 1) continue;

    if (current && current.sender === sender && row.ts - current.ts <= TURN_GAP_SECONDS) {
      current.ts = row.ts;
      current.text = appendText(current.text, text || "[attachment]");
      current.hasAttachment = current.hasAttachment || row.has_attachment === 1;
      continue;
    }

    if (current) turns.push(finalizeTurn(current));
    current = {
      id: turns.length,
      ts: row.ts,
      ym: row.ym,
      ymd: row.ymd,
      sender,
      text: text || "[attachment]",
      hasAttachment: row.has_attachment === 1,
    };
  }

  if (current) turns.push(finalizeTurn(current));
  return turns;
}

function finalizeTurn(turn: Omit<Turn, "kind" | "tokens">): Turn {
  const tokens = tokenize(turn.text);
  return {
    ...turn,
    kind: classifyTurn(turn.text, turn.hasAttachment),
    tokens,
  };
}

function buildPairs(turns: Turn[]) {
  const pairs: Pair[] = [];
  for (let index = 0; index < turns.length - 1; index += 1) {
    const source = turns[index];
    const reply = turns[index + 1];
    if (source.sender === reply.sender) continue;
    const gapSeconds = reply.ts - source.ts;
    if (gapSeconds < 0 || gapSeconds > REPLY_WINDOW_SECONDS) continue;
    pairs.push({
      id: pairs.length,
      direction: source.sender === "Me" ? "me_to_them" : "them_to_me",
      source,
      reply,
      gapSeconds,
    });
  }
  return pairs;
}

function buildChannels(pairs: Pair[]): InformationChannel[] {
  return (["me_to_them", "them_to_me"] as InfoDirectionKey[]).map((direction) => {
    const directionPairs = pairs.filter((pair) => pair.direction === direction);
    const replyCounts = kindCounts(directionPairs.map((pair) => pair.reply.kind));
    const sourceCounts = kindCounts(directionPairs.map((pair) => pair.source.kind));
    const replyEntropy = entropy(replyCounts);
    const rows = MOVE_KINDS.map((source) => channelRow(source, directionPairs, replyCounts));
    const conditionalEntropy = directionPairs.length
      ? sum(rows.map((row) => (row.count / directionPairs.length) * row.entropy))
      : 0;
    const cells = MOVE_KINDS.flatMap((source) =>
      MOVE_KINDS.map((reply) => matrixCell(source, reply, directionPairs, sourceCounts, replyCounts)),
    );
    return {
      direction,
      label: DIRECTION_LABELS[direction],
      pairs: directionPairs.length,
      reply_entropy: round(replyEntropy),
      conditional_entropy: round(conditionalEntropy),
      mutual_information: round(Math.max(0, replyEntropy - conditionalEntropy)),
      uncertainty_reduction: round(replyEntropy ? Math.max(0, (replyEntropy - conditionalEntropy) / replyEntropy) : 0),
      rows,
      cells,
    };
  });
}

function channelRow(source: InfoMoveKind, pairs: Pair[], replyCounts: Record<InfoMoveKind, number>): InformationChannelRow {
  const sourcePairs = pairs.filter((pair) => pair.source.kind === source);
  const counts = kindCounts(sourcePairs.map((pair) => pair.reply.kind));
  const top = MOVE_KINDS.slice().sort((a, b) => counts[b] - counts[a])[0];
  const topRate = sourcePairs.length ? counts[top] / sourcePairs.length : 0;
  const baseRate = pairs.length ? replyCounts[top] / pairs.length : 0;
  return {
    source,
    label: MOVE_LABELS[source],
    count: sourcePairs.length,
    entropy: round(entropy(counts)),
    top_reply: MOVE_LABELS[top],
    top_lift: round(baseRate ? topRate / baseRate : 0),
  };
}

function matrixCell(
  source: InfoMoveKind,
  reply: InfoMoveKind,
  pairs: Pair[],
  sourceCounts: Record<InfoMoveKind, number>,
  replyCounts: Record<InfoMoveKind, number>,
): InformationMatrixCell {
  const count = pairs.filter((pair) => pair.source.kind === source && pair.reply.kind === reply).length;
  const total = Math.max(pairs.length, 1);
  const pxy = count / total;
  const px = sourceCounts[source] / total;
  const py = replyCounts[reply] / total;
  const lift = px && py ? pxy / (px * py) : 0;
  const contribution = pxy && lift > 0 ? pxy * Math.log2(lift) : 0;
  return {
    source,
    reply,
    source_label: MOVE_LABELS[source],
    reply_label: MOVE_LABELS[reply],
    count,
    probability: round(pxy),
    lift: round(lift),
    contribution_bits: round(contribution),
  };
}

function buildCues(pairs: Pair[], channels: InformationChannel[]) {
  const accumulators = new Map<string, TokenAccumulator>();
  const replyBase = new Map<InfoDirectionKey, Record<InfoMoveKind, number>>();
  for (const channel of channels) {
    replyBase.set(channel.direction, kindCounts(pairs.filter((pair) => pair.direction === channel.direction).map((pair) => pair.reply.kind)));
  }

  for (const pair of pairs) {
    const seen = new Set(pair.source.tokens.filter(isCueToken));
    for (const token of seen) {
      const key = `${pair.direction}:${token}`;
      let accumulator = accumulators.get(key);
      if (!accumulator) {
        accumulator = {
          token,
          direction: pair.direction,
          count: 0,
          replyCounts: emptyCounts(),
          examplePairs: [],
        };
        accumulators.set(key, accumulator);
      }
      accumulator.count++;
      accumulator.replyCounts[pair.reply.kind]++;
      if (accumulator.examplePairs.length < 4) accumulator.examplePairs.push(pair);
    }
  }

  const cues: InformationCue[] = [];
  for (const accumulator of accumulators.values()) {
    if (accumulator.count < MIN_TOKEN_COUNT) continue;
    const directionPairs = pairs.filter((pair) => pair.direction === accumulator.direction);
    const baseCounts = replyBase.get(accumulator.direction) ?? emptyCounts();
    for (const reply of MOVE_KINDS) {
      const tokenRate = accumulator.replyCounts[reply] / accumulator.count;
      const baseRate = directionPairs.length ? baseCounts[reply] / directionPairs.length : 0;
      if (accumulator.replyCounts[reply] < 8) continue;
      if (!baseRate || tokenRate < 0.18) continue;
      const lift = tokenRate / baseRate;
      if (lift < 1.55) continue;
      const contribution = (accumulator.count / Math.max(directionPairs.length, 1)) * tokenRate * Math.log2(lift);
      if (contribution < 0.005) continue;
      cues.push({
        key: `${accumulator.direction}-${accumulator.token}-${reply}`,
        direction: accumulator.direction,
        direction_label: DIRECTION_LABELS[accumulator.direction],
        token: accumulator.token,
        reply_kind: reply,
        reply_label: MOVE_LABELS[reply],
        count: accumulator.replyCounts[reply],
        lift: round(lift),
        contribution_bits: round(contribution),
      });
    }
  }

  return cues
    .sort((a, b) => b.contribution_bits - a.contribution_bits || b.lift - a.lift)
    .slice(0, MAX_CUES);
}

function buildMonths(pairs: Pair[]): InformationMonth[] {
  const grouped = new Map<string, Pair[]>();
  for (const pair of pairs) {
    const list = grouped.get(pair.source.ym) ?? [];
    list.push(pair);
    grouped.set(pair.source.ym, list);
  }
  return [...grouped.entries()].map(([ym, monthPairs]) => {
    const counts = kindCounts(monthPairs.map((pair) => pair.reply.kind));
    const h = entropy(counts);
    const dominant = MOVE_KINDS.slice().sort((a, b) => counts[b] - counts[a])[0];
    return {
      ym,
      pairs: monthPairs.length,
      entropy: round(h),
      predictability: round(1 - h / Math.log2(MOVE_KINDS.length)),
      dominant_reply: MOVE_LABELS[dominant],
    };
  });
}

function buildExamples(cues: InformationCue[], pairs: Pair[]): InformationExample[] {
  const examples: InformationExample[] = [];
  const usedPairIds = new Set<number>();

  for (const cue of cues) {
    const pair = pairs.find((candidate) =>
      candidate.direction === cue.direction
      && candidate.reply.kind === cue.reply_kind
      && candidate.source.tokens.includes(cue.token)
      && !usedPairIds.has(candidate.id)
    );
    if (!pair) continue;
    usedPairIds.add(pair.id);
    examples.push({
      key: `${cue.key}-${pair.id}`,
      cue: cue.token,
      direction_label: cue.direction_label,
      reply_label: cue.reply_label,
      lift: cue.lift,
      source_ts: pair.source.ts,
      source_ymd: pair.source.ymd,
      reply_ts: pair.reply.ts,
      reply_ymd: pair.reply.ymd,
      source_sender: pair.source.sender,
      reply_sender: pair.reply.sender,
      source_text: preview(pair.source.text),
      reply_text: preview(pair.reply.text),
    });
    if (examples.length >= MAX_EXAMPLES) break;
  }

  return examples;
}

function classifyTurn(text: string, hasAttachment: boolean): InfoMoveKind {
  return toInformationKind(classifyMove({ text, has_attachment: hasAttachment ? 1 : 0 }).kind);
}

function toInformationKind(kind: ClassifiedMoveKind): InfoMoveKind {
  if (kind === "vulnerable") return "strain";
  if (kind === "arrival" || kind === "gratitude" || kind === "ambient") return "status";
  return kind;
}

function kindCounts(kinds: InfoMoveKind[]) {
  const counts = emptyCounts();
  for (const kind of kinds) counts[kind]++;
  return counts;
}

function emptyCounts() {
  return Object.fromEntries(MOVE_KINDS.map((kind) => [kind, 0])) as Record<InfoMoveKind, number>;
}

function entropy(counts: Record<InfoMoveKind, number>) {
  const total = sum(Object.values(counts));
  if (!total) return 0;
  let h = 0;
  for (const count of Object.values(counts)) {
    if (!count) continue;
    const p = count / total;
    h -= p * Math.log2(p);
  }
  return h;
}

function tokenize(text: string) {
  return text
    .toLowerCase()
    .replace(/[']/g, "")
    .match(/[a-z0-9]{2,}/g) ?? [];
}

function isCueToken(token: string) {
  return token.length >= 3 && token.length <= 18 && !STOPWORDS.has(token) && !/^[0-9]+$/.test(token);
}

function clean(text: string | null) {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function senderFor(row: MessageRow): Sender {
  return row.is_from_me === 1 ? "Me" : "Them";
}

function senderMatches(sender: Sender, scopeSender: MessageScope["sender"]) {
  if (scopeSender === "me") return sender === "Me";
  if (scopeSender === "them") return sender === "Them";
  return true;
}

function appendText(left: string, right: string) {
  if (!right) return left;
  if (!left) return right;
  const next = `${left} ${right}`;
  return next.length > 900 ? `${next.slice(0, 897)}...` : next;
}

function preview(text: string) {
  const cleaned = clean(text);
  return cleaned.length > 180 ? `${cleaned.slice(0, 177)}...` : cleaned;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}
