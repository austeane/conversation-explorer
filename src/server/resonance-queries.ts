import { createServerFn } from "@tanstack/react-start";
import { realMessageWhere } from "~/lib/conversation/filters";
import { messageScopeInput, messageScopeWhere, type MessageScope } from "~/lib/conversation/scope";
import { db, getDataGeneratedAt, withDbCache } from "~/lib/server-db";
import { resolveMessageScope } from "~/server/scope";

const REAL_MESSAGE_WHERE = realMessageWhere("browsable_message", "m");
const TURN_GAP_SECONDS = 20 * 60;
const REPLY_WINDOW_SECONDS = 24 * 60 * 60;
const FAST_REPLY_SECONDS = 60 * 60;
const TOP_CELLS = 24;

export type Sender = "Me" | "Them";
export type MoveKind =
  | "affection"
  | "care"
  | "question"
  | "logistics"
  | "play"
  | "object"
  | "repair"
  | "strain"
  | "gratitude"
  | "status"
  | "ambient";

export type ResonanceOverview = {
  generated_at: string;
  real_messages: number;
  turns: number;
  reply_pairs: number;
  median_reply_seconds: number;
  mirror_rate: number;
  fast_reply_rate: number;
  avg_overlap: number;
  strongest_evocation: string;
};

export type ResonanceMonth = {
  ym: string;
  pairs: number;
  mirror_rate: number;
  fast_rate: number;
  avg_overlap: number;
  resonance_score: number;
};

export type ResonanceExample = {
  source_ts: number;
  source_ymd: string;
  reply_ts: number;
  reply_ymd: string;
  source_sender: Sender;
  reply_sender: Sender;
  source_kind: MoveKind;
  reply_kind: MoveKind;
  source_text: string;
  reply_text: string;
  reply_seconds: number;
  overlap: number;
};

export type ResonanceCell = {
  key: string;
  source_sender: Sender;
  reply_sender: Sender;
  source_kind: MoveKind;
  reply_kind: MoveKind;
  source_label: string;
  reply_label: string;
  count: number;
  source_total: number;
  rate: number;
  expected_rate: number;
  lift: number;
  median_reply_seconds: number;
  avg_overlap: number;
  examples: ResonanceExample[];
};

export type ResonanceProfile = {
  key: string;
  source_sender: Sender;
  reply_sender: Sender;
  source_kind: MoveKind;
  source_label: string;
  total: number;
  mirror_rate: number;
  fast_rate: number;
  avg_overlap: number;
  top_replies: ResonanceCell[];
};

export type ResonanceResult = {
  overview: ResonanceOverview;
  months: ResonanceMonth[];
  profiles: ResonanceProfile[];
  cells: ResonanceCell[];
};

type MessageRow = {
  id: number;
  ts: number;
  ym: string;
  ymd: string;
  is_from_me: number;
  has_attachment: number;
  text: string | null;
};

type Turn = {
  id: number;
  startTs: number;
  endTs: number;
  ym: string;
  ymd: string;
  sender: Sender;
  text: string;
  tokens: Set<string>;
  kind: MoveKind;
  messages: number;
};

type TurnBuilder = {
  id: number;
  startTs: number;
  endTs: number;
  ym: string;
  ymd: string;
  sender: Sender;
  texts: string[];
  tokens: Set<string>;
  kindCounts: Map<MoveKind, number>;
  messages: number;
};

type Pair = {
  ym: string;
  source: Turn;
  reply: Turn;
  replySeconds: number;
  overlap: number;
};

type CellAccumulator = {
  key: string;
  sourceSender: Sender;
  replySender: Sender;
  sourceKind: MoveKind;
  replyKind: MoveKind;
  count: number;
  sourceTotal: number;
  replySeconds: number[];
  overlapTotal: number;
  examples: ResonanceExample[];
};

type ProfileAccumulator = {
  sourceSender: Sender;
  replySender: Sender;
  sourceKind: MoveKind;
  pairs: Pair[];
};

type MonthAccumulator = {
  ym: string;
  pairs: number;
  mirrors: number;
  fast: number;
  overlapTotal: number;
};

const MOVE_META: Record<MoveKind, { label: string; priority: number }> = {
  repair: { label: "Repair", priority: 100 },
  strain: { label: "Strain", priority: 95 },
  affection: { label: "Affection", priority: 90 },
  care: { label: "Care", priority: 85 },
  gratitude: { label: "Gratitude", priority: 80 },
  logistics: { label: "Logistics", priority: 75 },
  question: { label: "Question", priority: 70 },
  play: { label: "Play", priority: 65 },
  object: { label: "Object", priority: 55 },
  status: { label: "Status", priority: 45 },
  ambient: { label: "Ambient", priority: 0 },
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
  "that",
  "the",
  "them",
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

export const getResonance = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => messageScopeInput.parse(d ?? {}))
  .handler(async ({ data }): Promise<ResonanceResult> => {
    const resolved = resolveMessageScope(data);
    return withDbCache(`resonance:${JSON.stringify(resolved)}`, () => {
      const scanScope = { ...resolved, sender: "both" as const };
      const scope = messageScopeWhere(scanScope, "m", [REAL_MESSAGE_WHERE]);
      const rows = db()
        .prepare(
          `
          SELECT m.id, m.ts, m.ym, m.ymd, m.is_from_me, m.has_attachment, m.text
          FROM messages m
          ${scope.sql}
          ORDER BY m.ts ASC, m.id ASC
        `,
        )
        .all(...scope.args) as MessageRow[];

      const turns = buildTurns(rows);
      const sourceTurns = turns.filter((turn) => senderMatches(turn.sender, resolved.sender));
      const pairs = buildPairs(turns).filter((pair) => senderMatches(pair.source.sender, resolved.sender));
      const months = buildMonths(pairs);
      const { cells, profiles } = buildCellsAndProfiles(pairs);
      const replySeconds = pairs.map((pair) => pair.replySeconds);

      return {
        overview: {
          generated_at: getDataGeneratedAt(),
          real_messages: rows.filter((row) => senderMatches(senderFor(row), resolved.sender)).length,
          turns: sourceTurns.length,
          reply_pairs: pairs.length,
          median_reply_seconds: median(replySeconds) ?? 0,
          mirror_rate: rate(pairs.filter((pair) => pair.source.kind === pair.reply.kind).length, pairs.length),
          fast_reply_rate: rate(pairs.filter((pair) => pair.replySeconds <= FAST_REPLY_SECONDS).length, pairs.length),
          avg_overlap: round(avg(pairs.map((pair) => pair.overlap))),
          strongest_evocation: cells[0] ? `${cells[0].source_label} -> ${cells[0].reply_label}` : "n/a",
        },
        months,
        profiles,
        cells,
      };
    });
  });

function buildTurns(rows: MessageRow[]): Turn[] {
  const turns: Turn[] = [];
  let current: TurnBuilder | null = null;
  let nextId = 1;

  for (const row of rows) {
    const sender: Sender = row.is_from_me === 1 ? "Me" : "Them";
    const text = cleanText(row.text);
    const messageKinds = classifyKinds(row, text);

    if (!current || current.sender !== sender || row.ts - current.endTs > TURN_GAP_SECONDS) {
      if (current) turns.push(finishTurn(current));
      current = {
        id: nextId,
        startTs: row.ts,
        endTs: row.ts,
        ym: row.ym,
        ymd: row.ymd,
        sender,
        texts: [],
        tokens: new Set(),
        kindCounts: new Map(),
        messages: 0,
      };
      nextId += 1;
    }

    current.endTs = row.ts;
    current.messages += 1;
    if (text) current.texts.push(text);
    for (const token of tokenize(text)) current.tokens.add(token);
    for (const kind of messageKinds) {
      current.kindCounts.set(kind, (current.kindCounts.get(kind) ?? 0) + 1);
    }
  }

  if (current) turns.push(finishTurn(current));
  return turns.filter((turn) => turn.text || turn.kind === "object");
}

function finishTurn(turn: TurnBuilder): Turn {
  return {
    id: turn.id,
    startTs: turn.startTs,
    endTs: turn.endTs,
    ym: turn.ym,
    ymd: turn.ymd,
    sender: turn.sender,
    text: turn.texts.join(" / ").slice(0, 260) || "[attachment]",
    tokens: turn.tokens,
    kind: dominantKind(turn.kindCounts),
    messages: turn.messages,
  };
}

function dominantKind(counts: Map<MoveKind, number>): MoveKind {
  let best: MoveKind = "ambient";
  let bestScore = 0;
  for (const [kind, count] of counts.entries()) {
    const score = count * 20 + MOVE_META[kind].priority;
    if (score > bestScore) {
      best = kind;
      bestScore = score;
    }
  }
  return best;
}

function buildPairs(turns: Turn[]): Pair[] {
  const pairs: Pair[] = [];
  for (let i = 0; i < turns.length - 1; i += 1) {
    const source = turns[i];
    const reply = turns[i + 1];
    if (source.sender === reply.sender) continue;
    const replySeconds = reply.startTs - source.endTs;
    if (replySeconds < 0 || replySeconds > REPLY_WINDOW_SECONDS) continue;
    pairs.push({
      ym: reply.ym,
      source,
      reply,
      replySeconds,
      overlap: lexicalOverlap(source.tokens, reply.tokens),
    });
  }
  return pairs;
}

function buildMonths(pairs: Pair[]): ResonanceMonth[] {
  const months = new Map<string, MonthAccumulator>();
  for (const pair of pairs) {
    const month = months.get(pair.ym) ?? { ym: pair.ym, pairs: 0, mirrors: 0, fast: 0, overlapTotal: 0 };
    month.pairs += 1;
    month.mirrors += pair.source.kind === pair.reply.kind ? 1 : 0;
    month.fast += pair.replySeconds <= FAST_REPLY_SECONDS ? 1 : 0;
    month.overlapTotal += pair.overlap;
    months.set(pair.ym, month);
  }
  return [...months.values()]
    .sort((a, b) => a.ym.localeCompare(b.ym))
    .map((month) => {
      const mirrorRate = rate(month.mirrors, month.pairs);
      const fastRate = rate(month.fast, month.pairs);
      const avgOverlap = month.pairs ? month.overlapTotal / month.pairs : 0;
      return {
        ym: month.ym,
        pairs: month.pairs,
        mirror_rate: round(mirrorRate),
        fast_rate: round(fastRate),
        avg_overlap: round(avgOverlap),
        resonance_score: round(mirrorRate * 0.38 + fastRate * 0.22 + avgOverlap * 0.4),
      };
    });
}

function buildCellsAndProfiles(pairs: Pair[]) {
  const sourceTotals = new Map<string, number>();
  const replyBase = new Map<string, Map<MoveKind, number>>();
  const cells = new Map<string, CellAccumulator>();
  const profiles = new Map<string, ProfileAccumulator>();

  for (const pair of pairs) {
    const sourceKey = `${pair.source.sender}:${pair.reply.sender}:${pair.source.kind}`;
    const replyBaseKey = `${pair.source.sender}:${pair.reply.sender}`;
    sourceTotals.set(sourceKey, (sourceTotals.get(sourceKey) ?? 0) + 1);
    const base = replyBase.get(replyBaseKey) ?? new Map<MoveKind, number>();
    base.set(pair.reply.kind, (base.get(pair.reply.kind) ?? 0) + 1);
    replyBase.set(replyBaseKey, base);

    const profile = profiles.get(sourceKey) ?? {
      sourceSender: pair.source.sender,
      replySender: pair.reply.sender,
      sourceKind: pair.source.kind,
      pairs: [],
    };
    profile.pairs.push(pair);
    profiles.set(sourceKey, profile);

    const cellKey = `${sourceKey}:${pair.reply.kind}`;
    const cell = cells.get(cellKey) ?? {
      key: cellKey,
      sourceSender: pair.source.sender,
      replySender: pair.reply.sender,
      sourceKind: pair.source.kind,
      replyKind: pair.reply.kind,
      count: 0,
      sourceTotal: 0,
      replySeconds: [],
      overlapTotal: 0,
      examples: [],
    };
    cell.count += 1;
    cell.replySeconds.push(pair.replySeconds);
    cell.overlapTotal += pair.overlap;
    if (cell.examples.length < 2) cell.examples.push(toExample(pair));
    cells.set(cellKey, cell);
  }

  const totalByDirection = new Map<string, number>();
  for (const [direction, counts] of replyBase.entries()) {
    totalByDirection.set(direction, [...counts.values()].reduce((sum, count) => sum + count, 0));
  }

  const resultCells = [...cells.values()]
    .map((cell) => {
      const sourceKey = `${cell.sourceSender}:${cell.replySender}:${cell.sourceKind}`;
      const directionKey = `${cell.sourceSender}:${cell.replySender}`;
      const sourceTotal = sourceTotals.get(sourceKey) ?? 0;
      const baseCount = replyBase.get(directionKey)?.get(cell.replyKind) ?? 0;
      const directionTotal = totalByDirection.get(directionKey) ?? 1;
      const expectedRate = baseCount / directionTotal;
      const observedRate = sourceTotal ? cell.count / sourceTotal : 0;
      return {
        key: cell.key,
        source_sender: cell.sourceSender,
        reply_sender: cell.replySender,
        source_kind: cell.sourceKind,
        reply_kind: cell.replyKind,
        source_label: MOVE_META[cell.sourceKind].label,
        reply_label: MOVE_META[cell.replyKind].label,
        count: cell.count,
        source_total: sourceTotal,
        rate: round(observedRate),
        expected_rate: round(expectedRate),
        lift: round(observedRate / Math.max(expectedRate, 0.001)),
        median_reply_seconds: median(cell.replySeconds) ?? 0,
        avg_overlap: round(cell.overlapTotal / cell.count),
        examples: cell.examples,
      };
    })
    .filter((cell) => cell.count >= 12 && cell.lift >= 1.12 && cell.reply_kind !== "ambient")
    .sort((a, b) => cellScore(b) - cellScore(a))
    .slice(0, TOP_CELLS);

  const resultProfiles = [...profiles.values()]
    .filter((profile) => profile.pairs.length >= 30 && profile.sourceKind !== "ambient")
    .map((profile) => {
      const profileCells = resultCells
        .filter(
          (cell) =>
            cell.source_sender === profile.sourceSender &&
            cell.reply_sender === profile.replySender &&
            cell.source_kind === profile.sourceKind,
        )
        .slice(0, 4);
      const mirrorCount = profile.pairs.filter((pair) => pair.source.kind === pair.reply.kind).length;
      const fastCount = profile.pairs.filter((pair) => pair.replySeconds <= FAST_REPLY_SECONDS).length;
      return {
        key: `${profile.sourceSender}:${profile.replySender}:${profile.sourceKind}`,
        source_sender: profile.sourceSender,
        reply_sender: profile.replySender,
        source_kind: profile.sourceKind,
        source_label: MOVE_META[profile.sourceKind].label,
        total: profile.pairs.length,
        mirror_rate: round(rate(mirrorCount, profile.pairs.length)),
        fast_rate: round(rate(fastCount, profile.pairs.length)),
        avg_overlap: round(avg(profile.pairs.map((pair) => pair.overlap))),
        top_replies: profileCells,
      };
    })
    .filter((profile) => profile.top_replies.length > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 12);

  return { cells: resultCells, profiles: resultProfiles };
}

function classifyKinds(row: MessageRow, text: string): MoveKind[] {
  const kinds: MoveKind[] = [];
  if (/\b(sorry|apologize|apologise|forgive|my bad|misunderstood|didn'?t mean|didnt mean|should have|i understand|that makes sense|talk about)\b/i.test(text)) kinds.push("repair");
  if (/\b(sad|anxious|anxiety|worried|worry|scared|afraid|hurt|cry|crying|upset|stress|stressed|hard|tired|exhausted|lonely|overwhelmed|frustrated|rough|bad day)\b/i.test(text)) kinds.push("strain");
  if (/\b(love you|i love|miss you|proud of you|sweetheart|darling|cute|beautiful|handsome|kiss|cuddle|snuggle|heart)\b/i.test(text)) kinds.push("affection");
  if (/\b(thank you|thanks|appreciate|grateful|thankful|means a lot)\b/i.test(text)) kinds.push("gratitude");
  if (/\b(how are you|how was your|how's your|are you ok|you okay|you ok|hope you|feel better|sleep well|rest|eat|safe|take care|checking in)\b/i.test(text)) kinds.push("care");
  if (/\b(when|where|tonight|tomorrow|today|time|meet|come over|coming over|dinner|lunch|breakfast|plans?|schedule|ride|pickup|pick up|drop off|reservation|flight|train|bus)\b/i.test(text)) kinds.push("logistics");
  if (text.includes("?") || /^(what|when|where|who|why|how|do you|did you|are you|can you|would you|could you)\b/i.test(text)) kinds.push("question");
  if (/\b(lol|lmao|haha|hehe|funny|silly|wild|ridiculous|joke|hilarious|game|wordle|factle|codenames|bananagrams|puzzle)\b/i.test(text)) kinds.push("play");
  if (row.has_attachment === 1 || /\b(photo|picture|pic|screenshot|link|look at|lookit|sent you|https?:\/\/)\b/i.test(text)) kinds.push("object");
  if (/\b(i'?m|i am|i just|just got|finished|woke up|going to|i think|i feel|i was|home|got home|made it|on my way|omw|leaving|arrived)\b/i.test(text)) kinds.push("status");
  return kinds.length ? kinds : ["ambient"];
}

function toExample(pair: Pair): ResonanceExample {
  return {
    source_ts: pair.source.endTs,
    source_ymd: pair.source.ymd,
    reply_ts: pair.reply.startTs,
    reply_ymd: pair.reply.ymd,
    source_sender: pair.source.sender,
    reply_sender: pair.reply.sender,
    source_kind: pair.source.kind,
    reply_kind: pair.reply.kind,
    source_text: pair.source.text,
    reply_text: pair.reply.text,
    reply_seconds: pair.replySeconds,
    overlap: pair.overlap,
  };
}

function lexicalOverlap(source: Set<string>, reply: Set<string>) {
  if (source.size === 0 || reply.size === 0) return 0;
  let overlap = 0;
  for (const token of source) {
    if (reply.has(token)) overlap += 1;
  }
  return overlap / Math.min(source.size, reply.size);
}

function tokenize(text: string) {
  return (
    text
      .toLowerCase()
      .replace(/[‘’]/g, "'")
      .replace(/https?:\/\/\S+/g, " ")
      .match(/[a-z][a-z']{2,}/g)
      ?.map((token) => token.replace(/'/g, ""))
      .filter((token) => token.length >= 3 && !STOPWORDS.has(token)) ?? []
  );
}

function cleanText(text: string | null) {
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

function cellScore(cell: ResonanceCell) {
  return Math.log2(Math.max(cell.lift, 1)) * Math.sqrt(cell.count) + cell.avg_overlap * 2;
}

function median(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function avg(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function rate(part: number, whole: number) {
  return whole ? part / whole : 0;
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}
