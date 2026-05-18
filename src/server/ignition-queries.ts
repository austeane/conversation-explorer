import { createServerFn } from "@tanstack/react-start";
import { realMessageWhere } from "~/lib/conversation/filters";
import { messageScopeInput, messageScopeWhere, type MessageScope } from "~/lib/conversation/scope";
import { db, getDataGeneratedAt, withDbCache } from "~/lib/server-db";
import { resolveMessageScope } from "./scope";

const REAL_MESSAGE_WHERE = realMessageWhere("browsable_message", "m");
const SILENCE_GAP_SECONDS = 6 * 60 * 60;
const IGNITION_WINDOW_SECONDS = 4 * 60 * 60;
const RESPONSE_WINDOW_SECONDS = 24 * 60 * 60;
const FAST_REPLY_SECONDS = 2 * 60 * 60;
const TOP_ATTEMPTS = 24;

export type Sender = "Me" | "Them";

export type IgnitionOverview = {
  generated_at: string;
  real_messages: number;
  attempts: number;
  ignitions: number;
  ignition_rate: number;
  median_reply_seconds: number | null;
  me_ignition_rate: number;
  them_ignition_rate: number;
  strongest_kind: string;
  strongest_kind_rate: number;
};

export type IgnitionMonth = {
  ym: string;
  attempts: number;
  ignitions: number;
  ignition_rate: number;
  me_attempts: number;
  them_attempts: number;
  max_score: number;
};

export type IgnitionKind = {
  key: string;
  label: string;
  description: string;
  attempts: number;
  ignitions: number;
  ignition_rate: number;
  me_attempts: number;
  them_attempts: number;
  median_reply_seconds: number | null;
  median_messages_4h: number;
  avg_score: number;
  examples: IgnitionAttempt[];
};

export type IgnitionAttempt = {
  id: number;
  ts: number;
  ymd: string;
  ym: string;
  sender: Sender;
  kind: string;
  label: string;
  preview: string;
  reply_preview: string | null;
  reply_ymd: string | null;
  reply_sender: Sender | null;
  gap_seconds: number;
  reply_seconds: number | null;
  messages_4h: number;
  other_messages_4h: number;
  words_4h: number;
  messages_24h: number;
  score: number;
  ignited: boolean;
};

export type IgnitionResult = {
  overview: IgnitionOverview;
  months: IgnitionMonth[];
  kinds: IgnitionKind[];
  top_attempts: IgnitionAttempt[];
  quiet_misses: IgnitionAttempt[];
};

type MessageRow = {
  id: number;
  ts: number;
  ymd: string;
  ym: string;
  is_from_me: number;
  word_count: number;
  has_attachment: number;
  text: string | null;
};

type KindDefinition = {
  key: string;
  label: string;
  description: string;
  matches: (row: MessageRow, text: string) => boolean;
};

type KindAccumulator = {
  key: string;
  label: string;
  description: string;
  attempts: IgnitionAttempt[];
};

type MonthAccumulator = {
  ym: string;
  attempts: number;
  ignitions: number;
  meAttempts: number;
  themAttempts: number;
  maxScore: number;
};

const KIND_DEFINITIONS: KindDefinition[] = [
  {
    key: "repair",
    label: "Repair openers",
    description: "Apologies, clarifications, and attempts to reopen with accountability.",
    matches: (_row, text) => /\b(sorry|apologize|apologise|forgive|my bad|didn'?t mean|misunderstood|i understand|that makes sense)\b/i.test(text),
  },
  {
    key: "care",
    label: "Care checks",
    description: "Openers that ask after safety, sleep, health, feelings, or the day.",
    matches: (_row, text) => /\b(how are you|how was your|are you ok|you okay|you ok|hope you|feel better|sleep well|safe|take care|checking in|did you eat)\b/i.test(text),
  },
  {
    key: "affection",
    label: "Affection pings",
    description: "Warmth-first reopenings: love, missing, pride, sweetness, or closeness.",
    matches: (_row, text) => /\b(love you|i love|miss you|proud of you|sweetheart|darling|cute|beautiful|handsome|kiss|cuddle|snuggle)\b/i.test(text),
  },
  {
    key: "planning",
    label: "Planning moves",
    description: "Coordination, calendars, food, rides, arrivals, and concrete next actions.",
    matches: (_row, text) => /\b(when|where|tonight|tomorrow|today|time|meet|come over|coming over|dinner|lunch|breakfast|plans?|schedule|ride|pickup|pick up|drop off|book|reservation)\b/i.test(text),
  },
  {
    key: "question",
    label: "Questions",
    description: "Direct questions that invite the next turn without necessarily carrying affect.",
    matches: (_row, text) => text.includes("?") || /^(what|when|where|who|why|how|do you|did you|are you|can you|would you|could you)\b/i.test(text),
  },
  {
    key: "play",
    label: "Play sparks",
    description: "Humor, games, memes, and playful small objects that make reply easy.",
    matches: (_row, text) => /\b(lol|lmao|haha|hehe|funny|silly|wild|ridiculous|joke|hilarious|codenames|wordle|factle|game)\b/i.test(text),
  },
  {
    key: "object",
    label: "Object drops",
    description: "Photos, links, attachments, screenshots, or look-at-this messages.",
    matches: (row, text) => row.has_attachment === 1 || /\b(photo|picture|pic|screenshot|link|look at|lookit|sent you|https?:\/\/)\b/i.test(text),
  },
  {
    key: "arrival",
    label: "Arrival status",
    description: "Home, leaving, on-my-way, location, and movement status reopeners.",
    matches: (_row, text) => /\b(home|got home|made it|on my way|omw|leaving|heading|headed|arrived|there yet|almost there|at work|at school)\b/i.test(text),
  },
  {
    key: "status",
    label: "Life updates",
    description: "Low-friction updates about the sender's current state or what just happened.",
    matches: (_row, text) => /\b(i'?m|i am|i just|just got|finished|woke up|going to|i think|i feel|i was)\b/i.test(text),
  },
];

export const getIgnition = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => messageScopeInput.parse(d ?? {}))
  .handler(async ({ data }): Promise<IgnitionResult> => {
    const resolved = resolveMessageScope(data);
    return withDbCache(`ignition:${JSON.stringify(resolved)}`, () => {
      const scanScope: MessageScope = { ...resolved, sender: "both" };
      const scope = messageScopeWhere(scanScope, "m", [REAL_MESSAGE_WHERE]);
      const rows = db()
        .prepare(
          `
          SELECT m.id, m.ts, m.ymd, m.ym, m.is_from_me, m.word_count, m.has_attachment, m.text
          FROM messages m
          ${scope.sql}
          ORDER BY m.ts ASC, m.id ASC
        `,
        )
        .all(...scope.args) as MessageRow[];

      const attempts = buildAttempts(rows).filter((attempt) => senderMatches(attempt.sender, resolved.sender));
      const months = buildMonths(attempts);
      const kinds = buildKinds(attempts);
      const ignitedAttempts = attempts.filter((attempt) => attempt.ignited);
      const replySeconds = attempts
        .map((attempt) => attempt.reply_seconds)
        .filter((seconds): seconds is number => seconds != null);
      const meAttempts = attempts.filter((attempt) => attempt.sender === "Me");
      const themAttempts = attempts.filter((attempt) => attempt.sender === "Them");
      const strongestKind = [...kinds]
        .filter((kind) => kind.attempts >= 20)
        .sort((a, b) => b.ignition_rate - a.ignition_rate || b.ignitions - a.ignitions)[0] ?? kinds[0];

      return {
        overview: {
          generated_at: getDataGeneratedAt(),
          real_messages: rows.filter((row) => senderMatches(senderFor(row), resolved.sender)).length,
          attempts: attempts.length,
          ignitions: ignitedAttempts.length,
          ignition_rate: rate(ignitedAttempts.length, attempts.length),
          median_reply_seconds: median(replySeconds),
          me_ignition_rate: ignitionRate(meAttempts),
          them_ignition_rate: ignitionRate(themAttempts),
          strongest_kind: strongestKind?.label ?? "n/a",
          strongest_kind_rate: strongestKind?.ignition_rate ?? 0,
        },
        months,
        kinds,
        top_attempts: [...attempts]
          .filter((attempt) => attempt.ignited)
          .sort((a, b) => b.score - a.score || b.messages_4h - a.messages_4h)
          .slice(0, TOP_ATTEMPTS),
        quiet_misses: [...attempts]
          .filter((attempt) => !attempt.ignited && attempt.reply_seconds == null && attempt.kind !== "status")
          .sort((a, b) => b.gap_seconds - a.gap_seconds || b.score - a.score)
          .slice(0, 12),
      };
    });
  });

function buildAttempts(rows: MessageRow[]): IgnitionAttempt[] {
  const attempts: IgnitionAttempt[] = [];
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    const previous = rows[i - 1];
    const gap = row.ts - previous.ts;
    if (gap < SILENCE_GAP_SECONDS) continue;

    const sender = senderFor(row);
    const kind = classify(row);
    let replySeconds: number | null = null;
    let replyPreview: string | null = null;
    let replyYmd: string | null = null;
    let replySender: Sender | null = null;
    let messages4h = 1;
    let otherMessages4h = 0;
    let words4h = row.word_count;
    let messages24h = 1;
    let handoffs4h = 0;
    let lastSender = sender;

    for (let j = i + 1; j < rows.length; j += 1) {
      const next = rows[j];
      const delta = next.ts - row.ts;
      if (delta > RESPONSE_WINDOW_SECONDS) break;
      const nextSender = senderFor(next);
      messages24h += 1;
      if (replySeconds == null && nextSender !== sender) {
        replySeconds = delta;
        replyPreview = cleanPreview(next.text);
        replyYmd = next.ymd;
        replySender = nextSender;
      }
      if (delta <= IGNITION_WINDOW_SECONDS) {
        messages4h += 1;
        words4h += next.word_count;
        if (nextSender !== sender) otherMessages4h += 1;
        if (nextSender !== lastSender) handoffs4h += 1;
        lastSender = nextSender;
      }
    }

    const score = ignitionScore({
      replySeconds,
      messages4h,
      words4h,
      otherMessages4h,
      handoffs4h,
      messages24h,
    });
    const ignited = Boolean(
      replySeconds != null &&
        ((replySeconds <= FAST_REPLY_SECONDS && messages4h >= 8 && otherMessages4h >= 2) ||
          messages24h >= 20 ||
          (messages4h >= 16 && otherMessages4h >= 4)),
    );

    attempts.push({
      id: row.id,
      ts: row.ts,
      ymd: row.ymd,
      ym: row.ym,
      sender,
      kind: kind.key,
      label: kind.label,
      preview: cleanPreview(row.text),
      reply_preview: replyPreview,
      reply_ymd: replyYmd,
      reply_sender: replySender,
      gap_seconds: gap,
      reply_seconds: replySeconds,
      messages_4h: messages4h,
      other_messages_4h: otherMessages4h,
      words_4h: words4h,
      messages_24h: messages24h,
      score: round(score),
      ignited,
    });
  }
  return attempts;
}

function buildMonths(attempts: IgnitionAttempt[]): IgnitionMonth[] {
  const months = new Map<string, MonthAccumulator>();
  for (const attempt of attempts) {
    const month = monthSlot(months, attempt.ym);
    month.attempts += 1;
    if (attempt.ignited) month.ignitions += 1;
    if (attempt.sender === "Me") month.meAttempts += 1;
    else month.themAttempts += 1;
    month.maxScore = Math.max(month.maxScore, attempt.score);
  }
  return [...months.values()]
    .sort((a, b) => a.ym.localeCompare(b.ym))
    .map((month) => ({
      ym: month.ym,
      attempts: month.attempts,
      ignitions: month.ignitions,
      ignition_rate: rate(month.ignitions, month.attempts),
      me_attempts: month.meAttempts,
      them_attempts: month.themAttempts,
      max_score: month.maxScore,
    }));
}

function buildKinds(attempts: IgnitionAttempt[]): IgnitionKind[] {
  const kinds = new Map<string, KindAccumulator>();
  for (const definition of KIND_DEFINITIONS) {
    kinds.set(definition.key, {
      key: definition.key,
      label: definition.label,
      description: definition.description,
      attempts: [],
    });
  }
  kinds.set("ambient", {
    key: "ambient",
    label: "Ambient reopeners",
    description: "Messages that reopen the room without matching a stronger named move.",
    attempts: [],
  });

  for (const attempt of attempts) {
    kinds.get(attempt.kind)?.attempts.push(attempt);
  }

  return [...kinds.values()]
    .map((kind) => {
      const ignitions = kind.attempts.filter((attempt) => attempt.ignited);
      const replies = kind.attempts
        .map((attempt) => attempt.reply_seconds)
        .filter((seconds): seconds is number => seconds != null);
      const messages4h = kind.attempts.map((attempt) => attempt.messages_4h);
      return {
        key: kind.key,
        label: kind.label,
        description: kind.description,
        attempts: kind.attempts.length,
        ignitions: ignitions.length,
        ignition_rate: rate(ignitions.length, kind.attempts.length),
        me_attempts: kind.attempts.filter((attempt) => attempt.sender === "Me").length,
        them_attempts: kind.attempts.filter((attempt) => attempt.sender === "Them").length,
        median_reply_seconds: median(replies),
        median_messages_4h: median(messages4h) ?? 0,
        avg_score: round(average(kind.attempts.map((attempt) => attempt.score))),
        examples: [...kind.attempts]
          .sort((a, b) => Number(b.ignited) - Number(a.ignited) || b.score - a.score)
          .slice(0, 3),
      };
    })
    .filter((kind) => kind.attempts > 0)
    .sort((a, b) => b.ignition_rate - a.ignition_rate || b.ignitions - a.ignitions);
}

function classify(row: MessageRow) {
  const text = cleanText(row.text);
  return KIND_DEFINITIONS.find((definition) => definition.matches(row, text)) ?? {
    key: "ambient",
    label: "Ambient reopeners",
    description: "Messages that reopen the room without matching a stronger named move.",
    matches: () => true,
  };
}

function ignitionScore(input: {
  replySeconds: number | null;
  messages4h: number;
  words4h: number;
  otherMessages4h: number;
  handoffs4h: number;
  messages24h: number;
}) {
  const replyBoost =
    input.replySeconds == null ? 0 : Math.max(0, 1 - input.replySeconds / FAST_REPLY_SECONDS) * 2.6;
  const exchangeBoost = Math.log1p(input.otherMessages4h) * 1.4 + Math.log1p(input.handoffs4h) * 0.9;
  const volumeBoost = Math.log1p(input.messages4h) * 1.1 + Math.log1p(input.words4h) / 2.4;
  const longTailBoost = Math.log1p(input.messages24h) * 0.45;
  return replyBoost + exchangeBoost + volumeBoost + longTailBoost;
}

function monthSlot(months: Map<string, MonthAccumulator>, ym: string) {
  const existing = months.get(ym);
  if (existing) return existing;
  const created = {
    ym,
    attempts: 0,
    ignitions: 0,
    meAttempts: 0,
    themAttempts: 0,
    maxScore: 0,
  };
  months.set(ym, created);
  return created;
}

function senderFor(row: MessageRow): Sender {
  return row.is_from_me === 1 ? "Me" : "Them";
}

function senderMatches(sender: Sender, filter: MessageScope["sender"]) {
  return filter === "both" || (filter === "me" ? sender === "Me" : sender === "Them");
}

function ignitionRate(attempts: IgnitionAttempt[]) {
  return rate(attempts.filter((attempt) => attempt.ignited).length, attempts.length);
}

function cleanText(text: string | null) {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function cleanPreview(text: string | null) {
  const cleaned = cleanText(text).replace(/\uFFFC/g, "").trim();
  return cleaned ? truncate(cleaned, 240) : "No text body";
}

function truncate(text: string, maxChars: number) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1).trim()}...`;
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function average(values: number[]) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function rate(part: number, whole: number) {
  return whole ? part / whole : 0;
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}
