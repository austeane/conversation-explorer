import { createServerFn } from "@tanstack/react-start";
import { realMessageWhere } from "~/lib/conversation/filters";
import { messageScopeInput, messageScopeWhere, type MessageScope } from "~/lib/conversation/scope";
import { db, getDataGeneratedAt, withDbCache } from "~/lib/server-db";
import { resolveMessageScope } from "~/server/scope";

const REAL_MESSAGE_WHERE = realMessageWhere("browsable_message", "m");
const TURN_GAP_SECONDS = 20 * 60;
const REPLY_WINDOW_SECONDS = 24 * 60 * 60;
const MIN_SOURCE_HIGH = 35;
const TOP_EXAMPLES = 18;

export type Sender = "Me" | "Them";
export type DirectionKey = "me_to_them" | "them_to_me";
export type MirrorFeatureKey =
  | "length"
  | "questions"
  | "warmth"
  | "humor"
  | "strain"
  | "repair"
  | "planning"
  | "emoji"
  | "attachments";

export type MirrorOverview = {
  generated_at: string;
  real_messages: number;
  turns: number;
  reply_pairs: number;
  feature_tests: number;
  stronger_direction: string;
  strongest_mirror: string;
  strongest_asymmetry: string;
  strongest_asymmetry_gap: number;
  average_me_to_them: number;
  average_them_to_me: number;
};

export type MirrorDirection = {
  key: DirectionKey;
  source_sender: Sender;
  reply_sender: Sender;
  source_high_pairs: number;
  conditioned_rate: number;
  base_rate: number;
  lift: number;
  delta: number;
  correlation: number;
  median_reply_seconds: number;
  median_other_seconds: number;
};

export type MirrorFeature = {
  key: MirrorFeatureKey;
  label: string;
  description: string;
  me_to_them: MirrorDirection;
  them_to_me: MirrorDirection;
  asymmetry: number;
};

export type MirrorMonth = {
  ym: string;
  pairs: number;
  me_to_them_pairs: number;
  them_to_me_pairs: number;
  me_to_them_score: number;
  them_to_me_score: number;
  mutual_score: number;
};

export type MirrorExample = {
  feature: string;
  source_sender: Sender;
  reply_sender: Sender;
  source_ts: number;
  source_ymd: string;
  reply_ts: number;
  reply_ymd: string;
  reply_seconds: number;
  source_value: string;
  reply_value: string;
  source_text: string;
  reply_text: string;
  lift: number;
};

export type MirrorResult = {
  overview: MirrorOverview;
  months: MirrorMonth[];
  features: MirrorFeature[];
  examples: MirrorExample[];
};

type MessageRow = {
  id: number;
  ts: number;
  ym: string;
  ymd: string;
  date_iso: string;
  is_from_me: number;
  word_count: number;
  has_attachment: number;
  rich_link_url: string | null;
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
  messages: number;
  words: number;
  hasAttachment: boolean;
  values: Record<MirrorFeatureKey, number>;
};

type TurnBuilder = {
  id: number;
  startTs: number;
  endTs: number;
  ym: string;
  ymd: string;
  sender: Sender;
  texts: string[];
  messages: number;
  words: number;
  hasAttachment: boolean;
};

type Pair = {
  ym: string;
  source: Turn;
  reply: Turn;
  replySeconds: number;
};

type Thresholds = Record<Sender, Record<MirrorFeatureKey, number>>;

type FeatureSpec = {
  key: MirrorFeatureKey;
  label: string;
  description: string;
  binary?: boolean;
  valueLabel: (value: number) => string;
};

const FEATURES: FeatureSpec[] = [
  {
    key: "length",
    label: "Long turns",
    description: "Reply length rises when the source turn is unusually long for that sender.",
    valueLabel: (value) => `${Math.max(0, Math.round(Math.expm1(value)))} words`,
  },
  {
    key: "questions",
    label: "Questions",
    description: "Questions beget questions rather than ending the local volley.",
    binary: true,
    valueLabel: (value) => (value > 0 ? "question" : "no question"),
  },
  {
    key: "warmth",
    label: "Warmth",
    description: "Affection, appreciation, care, or sweetness is answered in kind.",
    binary: true,
    valueLabel: (value) => (value > 0 ? "warm cue" : "no warm cue"),
  },
  {
    key: "humor",
    label: "Humor",
    description: "Jokes, laughter, and playful markers pull more play into the reply.",
    binary: true,
    valueLabel: (value) => (value > 0 ? "play cue" : "no play cue"),
  },
  {
    key: "strain",
    label: "Strain",
    description: "Stress, sadness, anxiety, or difficulty is met with matching emotional weight.",
    binary: true,
    valueLabel: (value) => (value > 0 ? "strain cue" : "no strain cue"),
  },
  {
    key: "repair",
    label: "Repair",
    description: "Apology, clarification, care, or gratitude invites repair/care language back.",
    binary: true,
    valueLabel: (value) => (value > 0 ? "repair cue" : "no repair cue"),
  },
  {
    key: "planning",
    label: "Planning",
    description: "Coordination, timing, and logistics stay in the same practical register.",
    binary: true,
    valueLabel: (value) => (value > 0 ? "planning cue" : "no planning cue"),
  },
  {
    key: "emoji",
    label: "Emoji",
    description: "Graphic affect and emoji-like texture are echoed in the next turn.",
    binary: true,
    valueLabel: (value) => (value > 0 ? "emoji" : "no emoji"),
  },
  {
    key: "attachments",
    label: "Objects",
    description: "Images, links, and sent objects make the reply more likely to include an object too.",
    binary: true,
    valueLabel: (value) => (value > 0 ? "object" : "no object"),
  },
];

const LEXICONS = {
  warmth: /\b(love|miss|proud|sweet|cute|beautiful|handsome|excited|cuddle|snuggle|kiss|sweetheart|darling|adorable|lovely|heart|thank you|thanks|appreciate|grateful|thankful)\b/gi,
  humor: /\b(lol|lmao|haha|hehe|funny|silly|wild|ridiculous|joke|hilarious)\b/gi,
  strain: /\b(sad|anxious|anxiety|worried|worry|scared|afraid|hurt|cry|crying|upset|stress|stressed|hard|tired|exhausted|lonely|overwhelmed|frustrated|rough|bad day)\b/gi,
  repair: /\b(sorry|apologize|apologise|forgive|my bad|misunderstood|didn'?t mean|didnt mean|should have|i understand|that makes sense|talk about|hope you|feel better|sleep well|take care|checking in)\b/gi,
  planning: /\b(when|where|tonight|tomorrow|today|time|meet|come over|coming over|dinner|lunch|plans?|schedule|ride|pickup|pick up|drop off|book|reservation)\b/gi,
};

export const getMirrors = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => messageScopeInput.parse(d ?? {}))
  .handler(async ({ data }): Promise<MirrorResult> => {
    const resolved = resolveMessageScope(data);
    return withDbCache(`mirrors:${JSON.stringify(resolved)}`, () => {
      const scanScope = { ...resolved, sender: "both" as const };
      const scope = messageScopeWhere(scanScope, "m", [REAL_MESSAGE_WHERE]);
      const rows = db()
        .prepare(
          `
          SELECT m.id, m.ts, m.ym, m.ymd, m.date_iso, m.is_from_me, m.word_count, m.has_attachment, m.rich_link_url, m.text
          FROM messages m
          ${scope.sql}
          ORDER BY m.ts ASC, m.id ASC
        `,
        )
        .all(...scope.args) as MessageRow[];

      const turns = buildTurns(rows);
      const sourceTurns = turns.filter((turn) => senderMatches(turn.sender, resolved.sender));
      const pairs = buildReplyPairs(turns).filter((pair) => senderMatches(pair.source.sender, resolved.sender));
      const thresholds = buildThresholds(turns);
      const features = FEATURES.map((feature) => featureResult(feature, pairs, thresholds))
        .sort((a, b) => Math.max(b.me_to_them.delta, b.them_to_me.delta) - Math.max(a.me_to_them.delta, a.them_to_me.delta));
      const months = buildMonths(pairs, thresholds);
      const examples = buildExamples(features, pairs, thresholds);
      const meAverage = average(features.map((feature) => Math.max(0, feature.me_to_them.delta)));
      const themAverage = average(features.map((feature) => Math.max(0, feature.them_to_me.delta)));
      const strongest = features
        .flatMap((feature) => [feature.me_to_them, feature.them_to_me].map((direction) => ({ feature, direction })))
        .sort((a, b) => b.direction.delta - a.direction.delta || b.direction.lift - a.direction.lift)[0];
      const asymmetry = [...features].sort((a, b) => b.asymmetry - a.asymmetry)[0];

      return {
        overview: {
          generated_at: getDataGeneratedAt(),
          real_messages: rows.filter((row) => senderMatches(senderFor(row), resolved.sender)).length,
          turns: sourceTurns.length,
          reply_pairs: pairs.length,
          feature_tests: features.length * 2,
          stronger_direction: meAverage >= themAverage ? "Them mirrors Me" : "Me mirrors Them",
          strongest_mirror: strongest ? `${strongest.direction.reply_sender} echoes ${strongest.direction.source_sender} ${strongest.feature.label}` : "n/a",
          strongest_asymmetry: asymmetry ? asymmetry.label : "n/a",
          strongest_asymmetry_gap: asymmetry?.asymmetry ?? 0,
          average_me_to_them: meAverage,
          average_them_to_me: themAverage,
        },
        months,
        features,
        examples,
      };
    });
  });

function buildTurns(rows: MessageRow[]) {
  const turns: Turn[] = [];
  let current: TurnBuilder | null = null;

  for (const row of rows) {
    const sender = senderFor(row);
    if (!current || current.sender !== sender || row.ts - current.endTs > TURN_GAP_SECONDS) {
      if (current) turns.push(finishTurn(current));
      current = {
        id: row.id,
        startTs: row.ts,
        endTs: row.ts,
        ym: row.ym,
        ymd: row.ymd,
        sender,
        texts: [],
        messages: 0,
        words: 0,
        hasAttachment: false,
      };
    }

    current.endTs = row.ts;
    current.texts.push(stripUrls(row.text ?? ""));
    current.messages += 1;
    current.words += row.word_count;
    current.hasAttachment = current.hasAttachment || row.has_attachment === 1 || Boolean(row.rich_link_url);
  }

  if (current) turns.push(finishTurn(current));
  return turns;
}

function finishTurn(turn: TurnBuilder): Turn {
  const text = turn.texts.join(" ").replace(/\s+/g, " ").trim();
  const values: Record<MirrorFeatureKey, number> = {
    length: Math.log1p(turn.words),
    questions: /\?/.test(text) ? 1 : 0,
    warmth: countMatches(text, LEXICONS.warmth),
    humor: countMatches(text, LEXICONS.humor),
    strain: countMatches(text, LEXICONS.strain),
    repair: countMatches(text, LEXICONS.repair),
    planning: countMatches(text, LEXICONS.planning),
    emoji: emojiCount(text),
    attachments: turn.hasAttachment ? 1 : 0,
  };

  return {
    id: turn.id,
    startTs: turn.startTs,
    endTs: turn.endTs,
    ym: turn.ym,
    ymd: turn.ymd,
    sender: turn.sender,
    text,
    messages: turn.messages,
    words: turn.words,
    hasAttachment: turn.hasAttachment,
    values,
  };
}

function buildReplyPairs(turns: Turn[]) {
  const pairs: Pair[] = [];
  for (let i = 1; i < turns.length; i += 1) {
    const source = turns[i - 1];
    const reply = turns[i];
    const replySeconds = reply.startTs - source.endTs;
    if (source.sender === reply.sender || replySeconds < 0 || replySeconds > REPLY_WINDOW_SECONDS) continue;
    pairs.push({
      ym: reply.ym,
      source,
      reply,
      replySeconds,
    });
  }
  return pairs;
}

function buildThresholds(turns: Turn[]): Thresholds {
  const result = {
    Me: {} as Record<MirrorFeatureKey, number>,
    Them: {} as Record<MirrorFeatureKey, number>,
  };

  for (const sender of ["Me", "Them"] as const) {
    const senderTurns = turns.filter((turn) => turn.sender === sender);
    for (const feature of FEATURES) {
      if (feature.binary) {
        result[sender][feature.key] = 0.5;
        continue;
      }
      result[sender][feature.key] = quantile(senderTurns.map((turn) => turn.values[feature.key]), 0.75);
    }
  }

  return result;
}

function featureResult(feature: FeatureSpec, pairs: Pair[], thresholds: Thresholds): MirrorFeature {
  const meToThem = directionResult(feature, "Me", "Them", "me_to_them", pairs, thresholds);
  const themToMe = directionResult(feature, "Them", "Me", "them_to_me", pairs, thresholds);
  return {
    key: feature.key,
    label: feature.label,
    description: feature.description,
    me_to_them: meToThem,
    them_to_me: themToMe,
    asymmetry: Math.abs(meToThem.delta - themToMe.delta),
  };
}

function directionResult(
  feature: FeatureSpec,
  sourceSender: Sender,
  replySender: Sender,
  key: DirectionKey,
  pairs: Pair[],
  thresholds: Thresholds,
): MirrorDirection {
  const directionPairs = pairs.filter((pair) => pair.source.sender === sourceSender && pair.reply.sender === replySender);
  const sourceHigh = directionPairs.filter((pair) => isHigh(pair.source, feature.key, thresholds));
  const sourceLow = directionPairs.filter((pair) => !isHigh(pair.source, feature.key, thresholds));
  const replyHighBase = directionPairs.filter((pair) => isHigh(pair.reply, feature.key, thresholds)).length / Math.max(1, directionPairs.length);
  const replyHighConditioned = sourceHigh.filter((pair) => isHigh(pair.reply, feature.key, thresholds)).length / Math.max(1, sourceHigh.length);
  const sourceHighReplySeconds = sourceHigh.map((pair) => pair.replySeconds);
  const sourceLowReplySeconds = sourceLow.map((pair) => pair.replySeconds);

  return {
    key,
    source_sender: sourceSender,
    reply_sender: replySender,
    source_high_pairs: sourceHigh.length,
    conditioned_rate: sourceHigh.length >= MIN_SOURCE_HIGH ? replyHighConditioned : 0,
    base_rate: replyHighBase,
    lift: sourceHigh.length >= MIN_SOURCE_HIGH && replyHighBase > 0 ? replyHighConditioned / replyHighBase : 0,
    delta: sourceHigh.length >= MIN_SOURCE_HIGH ? replyHighConditioned - replyHighBase : 0,
    correlation: correlation(
      directionPairs.map((pair) => zValue(pair.source, feature.key, thresholds)),
      directionPairs.map((pair) => zValue(pair.reply, feature.key, thresholds)),
    ),
    median_reply_seconds: median(sourceHighReplySeconds) ?? 0,
    median_other_seconds: median(sourceLowReplySeconds) ?? 0,
  };
}

function buildMonths(pairs: Pair[], thresholds: Thresholds): MirrorMonth[] {
  const months = new Map<string, Pair[]>();
  for (const pair of pairs) {
    const existing = months.get(pair.ym) ?? [];
    existing.push(pair);
    months.set(pair.ym, existing);
  }

  return [...months.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([ym, monthPairs]) => {
      const meToThem = monthPairs.filter((pair) => pair.source.sender === "Me");
      const themToMe = monthPairs.filter((pair) => pair.source.sender === "Them");
      const meScore = mirrorScoreForPairs(meToThem, thresholds);
      const themScore = mirrorScoreForPairs(themToMe, thresholds);
      return {
        ym,
        pairs: monthPairs.length,
        me_to_them_pairs: meToThem.length,
        them_to_me_pairs: themToMe.length,
        me_to_them_score: meScore,
        them_to_me_score: themScore,
        mutual_score: (meScore + themScore) / 2,
      };
    });
}

function mirrorScoreForPairs(pairs: Pair[], thresholds: Thresholds) {
  let sourceHighSignals = 0;
  let mirroredSignals = 0;
  for (const pair of pairs) {
    for (const feature of FEATURES) {
      if (!isHigh(pair.source, feature.key, thresholds)) continue;
      sourceHighSignals += 1;
      if (isHigh(pair.reply, feature.key, thresholds)) mirroredSignals += 1;
    }
  }
  return sourceHighSignals === 0 ? 0 : mirroredSignals / sourceHighSignals;
}

function buildExamples(features: MirrorFeature[], pairs: Pair[], thresholds: Thresholds): MirrorExample[] {
  const examples: MirrorExample[] = [];
  for (const feature of features) {
    const spec = FEATURES.find((item) => item.key === feature.key);
    if (!spec) continue;
    for (const direction of [feature.me_to_them, feature.them_to_me]) {
      if (direction.delta <= 0 || direction.source_high_pairs < MIN_SOURCE_HIGH) continue;
      const pair = pairs
        .filter((item) => item.source.sender === direction.source_sender && item.reply.sender === direction.reply_sender)
        .filter((item) => isHigh(item.source, feature.key, thresholds) && isHigh(item.reply, feature.key, thresholds))
        .sort((a, b) => exampleScore(b, feature.key) - exampleScore(a, feature.key))[0];
      if (!pair) continue;
      examples.push({
        feature: feature.label,
        source_sender: direction.source_sender,
        reply_sender: direction.reply_sender,
        source_ts: pair.source.startTs,
        source_ymd: pair.source.ymd,
        reply_ts: pair.reply.startTs,
        reply_ymd: pair.reply.ymd,
        reply_seconds: pair.replySeconds,
        source_value: spec.valueLabel(pair.source.values[feature.key]),
        reply_value: spec.valueLabel(pair.reply.values[feature.key]),
        source_text: preview(pair.source.text, 180),
        reply_text: preview(pair.reply.text, 180),
        lift: direction.lift,
      });
    }
  }

  return examples
    .sort((a, b) => b.lift - a.lift || a.reply_seconds - b.reply_seconds)
    .slice(0, TOP_EXAMPLES);
}

function exampleScore(pair: Pair, feature: MirrorFeatureKey) {
  return pair.source.values[feature] + pair.reply.values[feature] + Math.max(0, 8 - Math.log1p(pair.replySeconds));
}

function isHigh(turn: Turn, feature: MirrorFeatureKey, thresholds: Thresholds) {
  return turn.values[feature] > thresholds[turn.sender][feature];
}

function zValue(turn: Turn, feature: MirrorFeatureKey, thresholds: Thresholds) {
  return turn.values[feature] > thresholds[turn.sender][feature] ? 1 : 0;
}

function senderFor(row: MessageRow): Sender {
  return row.is_from_me === 1 ? "Me" : "Them";
}

function senderMatches(sender: Sender, scopeSender: MessageScope["sender"]) {
  if (scopeSender === "me") return sender === "Me";
  if (scopeSender === "them") return sender === "Them";
  return true;
}

function countMatches(text: string, regex: RegExp) {
  return text.match(regex)?.length ?? 0;
}

function emojiCount(text: string) {
  return text.match(/\p{Extended_Pictographic}/gu)?.length ?? 0;
}

function correlation(x: number[], y: number[]) {
  if (x.length !== y.length || x.length < 3) return 0;
  const xMean = average(x);
  const yMean = average(y);
  let numerator = 0;
  let xDenominator = 0;
  let yDenominator = 0;
  for (let i = 0; i < x.length; i += 1) {
    const xDelta = x[i] - xMean;
    const yDelta = y[i] - yMean;
    numerator += xDelta * yDelta;
    xDenominator += xDelta ** 2;
    yDenominator += yDelta ** 2;
  }
  const denominator = Math.sqrt(xDenominator * yDenominator);
  return denominator === 0 ? 0 : numerator / denominator;
}

function quantile(values: number[], q: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)));
  return sorted[index];
}

function median(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function average(values: number[]) {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

function stripUrls(text: string) {
  return text.replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim();
}

function preview(text: string, maxLength: number) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 1).trimEnd()}…`;
}
