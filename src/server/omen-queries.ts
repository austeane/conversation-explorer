import { createServerFn } from "@tanstack/react-start";
import { realMessageWhere } from "~/lib/conversation/filters";
import { messageScopeInput, messageScopeWhere } from "~/lib/conversation/scope";
import { bucket } from "~/lib/conversation/time";
import { db, getDataGeneratedAt, withDbCache } from "~/lib/server-db";
import { resolveMessageScope } from "~/server/scope";

const REAL_MESSAGE_WHERE = realMessageWhere("browsable_message", "m");
const LOOKBACK_DAYS = 7;
const LOOKAHEAD_DAYS = 7;
const PRE_WINDOW_DAYS = 3;
const EVENT_SPACING_DAYS = 5;
const MAX_EVENTS_PER_KIND = 18;
const MAX_TOP_EVENTS = 24;
const MAX_NEUTRAL_WINDOWS = 260;

export type Sender = "Me" | "Them";
export type OmenKind = "surge" | "lull" | "storm" | "repair";

export type OmenOverview = {
  generated_at: string;
  days_analyzed: number;
  real_messages: number;
  inflection_windows: number;
  surge_events: number;
  lull_events: number;
  storm_events: number;
  repair_events: number;
  strongest_signal: string;
  strongest_signal_kind: OmenKind | null;
};

export type OmenMonth = {
  ym: string;
  surge: number;
  lull: number;
  storm: number;
  repair: number;
  max_score: number;
};

export type OmenExample = {
  ts: number;
  ymd: string;
  sender: Sender;
  text: string;
};

export type OmenEvent = {
  id: string;
  kind: OmenKind;
  label: string;
  ymd: string;
  ym: string;
  score: number;
  past_messages: number;
  future_messages: number;
  delta_messages: number;
  past_rate: number;
  future_rate: number;
  rate_label: string;
  before_examples: OmenExample[];
  after_examples: OmenExample[];
};

export type OmenSignal = {
  kind: OmenKind;
  label: string;
  phrase: string;
  lift: number;
  score: number;
  event_windows: number;
  neutral_windows: number;
  event_total: number;
  neutral_total: number;
  examples: Array<OmenExample & { event_ymd: string }>;
};

export type OmenSignalGroup = {
  kind: OmenKind;
  label: string;
  description: string;
  signals: OmenSignal[];
};

export type OmenResult = {
  overview: OmenOverview;
  months: OmenMonth[];
  signal_groups: OmenSignalGroup[];
  top_events: OmenEvent[];
};

type MessageRow = {
  id: number;
  ts: number;
  ymd: string;
  ym: string;
  is_from_me: number;
  word_count: number;
  text: string | null;
};

type DayBucket = {
  index: number;
  ymd: string;
  ym: string;
  messages: number;
  words: number;
  me: number;
  them: number;
  warmth: number;
  strain: number;
  repair: number;
  care: number;
  gratitude: number;
  humor: number;
  rows: MessageRow[];
};

type WindowMetrics = {
  messages: number;
  words: number;
  warmth: number;
  strain: number;
  repair: number;
  care: number;
  gratitude: number;
  humor: number;
};

type PrefixMetric = keyof WindowMetrics;
type PrefixSums = Record<PrefixMetric, number[]>;
type CandidateEvent = OmenEvent & { index: number };

type SignalStats = {
  eventWindows: number;
  neutralWindows: number;
  examples: Array<OmenExample & { event_ymd: string }>;
};

const KIND_META: Record<OmenKind, { label: string; description: string; rateLabel: string }> = {
  surge: {
    label: "Surge ahead",
    description: "Language in the 72 hours before a week where message volume accelerates sharply.",
    rateLabel: "message acceleration",
  },
  lull: {
    label: "Quiet ahead",
    description: "Signals before a high-volume week gives way to a substantially quieter one.",
    rateLabel: "message contraction",
  },
  storm: {
    label: "Storm ahead",
    description: "Terms that appear before strain language rises in the following week.",
    rateLabel: "strain per 100",
  },
  repair: {
    label: "Repair ahead",
    description: "Language before the next week carries more repair, care, gratitude, and warmth.",
    rateLabel: "repair per 100",
  },
};

const LEXICONS = {
  warmth: /\b(love|miss|proud|sweet|cute|beautiful|handsome|excited|cuddle|snuggle|kiss|sweetheart|darling|adorable|lovely|heart)\b/i,
  strain: /\b(sad|anxious|anxiety|worried|worry|scared|afraid|hurt|cry|crying|upset|stress|stressed|hard|tired|exhausted|lonely|overwhelmed|frustrated|rough|bad day)\b/i,
  repair: /\b(sorry|apologize|apologise|forgive|my bad|misunderstood|didn'?t mean|didnt mean|should have|i understand|that makes sense|talk about)\b/i,
  care: /\b(hope you|are you okay|you okay|you ok|feel better|sleep well|rest|eat|safe|take care|checking in|how are you|how was your day|how's your day)\b/i,
  gratitude: /\b(thank you|thanks|appreciate|grateful|thankful|means a lot)\b/i,
  humor: /\b(lol|lmao|haha|hehe|funny|silly|wild|ridiculous|joke|hilarious)\b/i,
};

const STOPWORDS = new Set([
  "also",
  "always",
  "about",
  "actually",
  "after",
  "again",
  "almost",
  "and",
  "another",
  "around",
  "bc",
  "because",
  "before",
  "been",
  "being",
  "best",
  "better",
  "both",
  "but",
  "can",
  "could",
  "didnt",
  "didn",
  "does",
  "doing",
  "done",
  "dont",
  "down",
  "even",
  "ever",
  "every",
  "from",
  "for",
  "in",
  "going",
  "gonna",
  "had",
  "have",
  "having",
  "here",
  "hers",
  "him",
  "his",
  "how",
  "im",
  "into",
  "its",
  "it",
  "into",
  "just",
  "know",
  "like",
  "little",
  "might",
  "maybe",
  "mean",
  "me",
  "most",
  "more",
  "much",
  "need",
  "never",
  "not",
  "only",
  "off",
  "of",
  "on",
  "or",
  "onto",
  "over",
  "really",
  "right",
  "said",
  "should",
  "some",
  "still",
  "sure",
  "take",
  "that",
  "than",
  "the",
  "thats",
  "their",
  "them",
  "then",
  "there",
  "they",
  "thing",
  "think",
  "this",
  "through",
  "time",
  "today",
  "tomorrow",
  "too",
  "to",
  "up",
  "very",
  "was",
  "want",
  "wanna",
  "we",
  "week",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "will",
  "with",
  "would",
  "you",
  "yeah",
  "yep",
  "your",
  "youre",
]);

const GENERIC_SINGLE_WORDS = new Set([
  "already",
  "back",
  "cool",
  "done",
  "different",
  "earlier",
  "fair",
  "later",
  "meeting",
  "minute",
  "minutes",
  "mins",
  "okay",
  "positive",
  "pretty",
  "suggest",
  "tested",
  "thing",
  "things",
  "work",
  "working",
]);

const ALLOWED_STOPWORD_END_STARTS = new Set([
  "appreciate",
  "love",
  "miss",
  "thank",
  "thanks",
]);

const BLOCKED_FEATURES = new Set([
  "and the",
  "are you",
  "but i",
  "do you",
  "for the",
  "going to",
  "have to",
  "i am",
  "i can",
  "i dont",
  "i feel",
  "i have",
  "i just",
  "i know",
  "i mean",
  "i need",
  "i think",
  "i want",
  "in the",
  "it is",
  "of the",
  "on the",
  "so i",
  "that i",
  "the same",
  "to be",
  "want to",
  "we can",
  "we should",
  "you are",
]);

export const getOmens = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => messageScopeInput.parse(d ?? {}))
  .handler(async ({ data }): Promise<OmenResult> => {
    const resolved = resolveMessageScope(data);
    return withDbCache(`omens:${JSON.stringify(resolved)}`, () => {
      const scope = messageScopeWhere(resolved, "m", [REAL_MESSAGE_WHERE]);
      const rows = db()
        .prepare(
          `
          SELECT m.id, m.ts, m.ymd, m.ym, m.is_from_me, m.word_count, m.text
          FROM messages m
          ${scope.sql}
          ORDER BY m.ts ASC, m.id ASC
        `,
        )
        .all(...scope.args) as MessageRow[];

      const days = buildDays(rows);
      const prefix = buildPrefix(days);
      const events = buildEvents(days, prefix);
      const months = buildMonths(events);
      const signalGroups = buildSignalGroups(days, events);
      const strongestSignal = signalGroups
        .flatMap((group) => group.signals)
        .sort((a, b) => b.score - a.score)[0];

      return {
        overview: {
          generated_at: getDataGeneratedAt(),
          days_analyzed: days.filter((day) => day.messages > 0).length,
          real_messages: rows.length,
          inflection_windows: events.length,
          surge_events: events.filter((event) => event.kind === "surge").length,
          lull_events: events.filter((event) => event.kind === "lull").length,
          storm_events: events.filter((event) => event.kind === "storm").length,
          repair_events: events.filter((event) => event.kind === "repair").length,
          strongest_signal: strongestSignal?.phrase ?? "n/a",
          strongest_signal_kind: strongestSignal?.kind ?? null,
        },
        months,
        signal_groups: signalGroups,
        top_events: [...events].sort((a, b) => b.score - a.score).slice(0, MAX_TOP_EVENTS).map(stripIndex),
      };
    });
  });

function buildDays(rows: MessageRow[]): DayBucket[] {
  if (rows.length === 0) return [];
  const byDay = new Map<number, DayBucket>();
  const minDay = epochDay(rows[0].ymd);
  const maxDay = epochDay(rows[rows.length - 1].ymd);

  for (let day = minDay; day <= maxDay; day += 1) {
    const ymd = ymdFromEpochDay(day);
    byDay.set(day, emptyDay(day - minDay, ymd));
  }

  for (const row of rows) {
    const day = byDay.get(epochDay(row.ymd));
    if (!day) continue;
    const text = row.text ?? "";
    day.messages += 1;
    day.words += row.word_count;
    day.me += row.is_from_me === 1 ? 1 : 0;
    day.them += row.is_from_me === 1 ? 0 : 1;
    day.warmth += LEXICONS.warmth.test(text) ? 1 : 0;
    day.strain += LEXICONS.strain.test(text) ? 1 : 0;
    day.repair += LEXICONS.repair.test(text) ? 1 : 0;
    day.care += LEXICONS.care.test(text) ? 1 : 0;
    day.gratitude += LEXICONS.gratitude.test(text) ? 1 : 0;
    day.humor += LEXICONS.humor.test(text) ? 1 : 0;
    day.rows.push(row);
  }

  return [...byDay.values()].sort((a, b) => a.index - b.index);
}

function emptyDay(index: number, ymd: string): DayBucket {
  return {
    index,
    ymd,
    ym: ymd.slice(0, 7),
    messages: 0,
    words: 0,
    me: 0,
    them: 0,
    warmth: 0,
    strain: 0,
    repair: 0,
    care: 0,
    gratitude: 0,
    humor: 0,
    rows: [],
  };
}

function buildPrefix(days: DayBucket[]): PrefixSums {
  const metrics: PrefixMetric[] = ["messages", "words", "warmth", "strain", "repair", "care", "gratitude", "humor"];
  const prefix = Object.fromEntries(metrics.map((metric) => [metric, [0]])) as PrefixSums;
  for (const day of days) {
    for (const metric of metrics) {
      prefix[metric].push(prefix[metric][prefix[metric].length - 1] + day[metric]);
    }
  }
  return prefix;
}

function buildEvents(days: DayBucket[], prefix: PrefixSums): CandidateEvent[] {
  const candidates: CandidateEvent[] = [];
  for (let i = LOOKBACK_DAYS; i < days.length - LOOKAHEAD_DAYS - 1; i += 1) {
    const past = windowMetrics(prefix, i - LOOKBACK_DAYS, i);
    const future = windowMetrics(prefix, i + 1, i + 1 + LOOKAHEAD_DAYS);
    if (past.messages + future.messages < 80) continue;

    const surgeRatio = (future.messages + 20) / (past.messages + 20);
    const surgeDelta = future.messages - past.messages;
    if (past.messages >= 30 && future.messages >= 120 && surgeRatio >= 1.65 && surgeDelta >= 75) {
      candidates.push(makeEvent(days, i, "surge", past, future, round(Math.log2(surgeRatio) * 3 + Math.min(surgeDelta / 180, 2.5))));
    }

    const lullRatio = (past.messages + 20) / (future.messages + 20);
    const lullDelta = past.messages - future.messages;
    if (past.messages >= 120 && future.messages <= past.messages * 0.48 && lullRatio >= 1.75 && lullDelta >= 75) {
      candidates.push(makeEvent(days, i, "lull", past, future, round(Math.log2(lullRatio) * 3 + Math.min(lullDelta / 180, 2.5))));
    }

    const pastStrainRate = per100(past.strain, past.messages);
    const futureStrainRate = per100(future.strain, future.messages);
    if (future.messages >= 80 && future.strain >= 8 && futureStrainRate >= Math.max(4.2, pastStrainRate + 1.4)) {
      candidates.push(makeEvent(days, i, "storm", past, future, round((futureStrainRate - pastStrainRate) * 0.8 + Math.min(future.strain / 8, 2.5))));
    }

    const pastRepairRate = repairRate(past);
    const futureRepairRate = repairRate(future);
    if (past.strain >= 4 && future.messages >= 70 && future.repair + future.care + future.gratitude >= 8 && futureRepairRate >= pastRepairRate + 1.2) {
      candidates.push(makeEvent(days, i, "repair", past, future, round((futureRepairRate - pastRepairRate) * 0.75 + Math.min((future.repair + future.care + future.gratitude) / 8, 2.5))));
    }
  }

  return (Object.keys(KIND_META) as OmenKind[])
    .flatMap((kind) => selectSpaced(candidates.filter((candidate) => candidate.kind === kind)))
    .sort((a, b) => a.ymd.localeCompare(b.ymd) || b.score - a.score);
}

function makeEvent(days: DayBucket[], index: number, kind: OmenKind, past: WindowMetrics, future: WindowMetrics, score: number): CandidateEvent {
  const day = days[index];
  const ratePair = eventRates(kind, past, future);
  return {
    id: `${kind}-${day.ymd}`,
    index,
    kind,
    label: KIND_META[kind].label,
    ymd: day.ymd,
    ym: day.ym,
    score,
    past_messages: past.messages,
    future_messages: future.messages,
    delta_messages: future.messages - past.messages,
    past_rate: ratePair.past,
    future_rate: ratePair.future,
    rate_label: KIND_META[kind].rateLabel,
    before_examples: examplesForRows(rowsForWindow(days, index - PRE_WINDOW_DAYS + 1, index + 1), 3, "latest"),
    after_examples: examplesForRows(rowsForWindow(days, index + 1, index + 4), 3, "earliest"),
  };
}

function eventRates(kind: OmenKind, past: WindowMetrics, future: WindowMetrics) {
  if (kind === "storm") return { past: round(per100(past.strain, past.messages)), future: round(per100(future.strain, future.messages)) };
  if (kind === "repair") return { past: round(repairRate(past)), future: round(repairRate(future)) };
  return {
    past: round(past.messages / LOOKBACK_DAYS),
    future: round(future.messages / LOOKAHEAD_DAYS),
  };
}

function selectSpaced(candidates: CandidateEvent[]) {
  const selected: CandidateEvent[] = [];
  for (const candidate of [...candidates].sort((a, b) => b.score - a.score || Math.abs(b.delta_messages) - Math.abs(a.delta_messages))) {
    if (selected.length >= MAX_EVENTS_PER_KIND) break;
    if (selected.some((event) => Math.abs(event.index - candidate.index) < EVENT_SPACING_DAYS)) continue;
    selected.push(candidate);
  }
  return selected;
}

function buildMonths(events: CandidateEvent[]): OmenMonth[] {
  const months = new Map<string, OmenMonth>();
  for (const event of events) {
    const month = months.get(event.ym) ?? { ym: event.ym, surge: 0, lull: 0, storm: 0, repair: 0, max_score: 0 };
    month[event.kind] += 1;
    month.max_score = Math.max(month.max_score, event.score);
    months.set(event.ym, month);
  }
  return [...months.values()].sort((a, b) => a.ym.localeCompare(b.ym));
}

function buildSignalGroups(days: DayBucket[], events: CandidateEvent[]): OmenSignalGroup[] {
  const neutral = neutralFeatureCounts(days, events);
  return (Object.keys(KIND_META) as OmenKind[]).map((kind) => {
    const kindEvents = events.filter((event) => event.kind === kind);
    const eventStats = eventFeatureCounts(days, kindEvents);
    const minSupport = Math.max(2, Math.ceil(kindEvents.length * 0.12));
    const signals = [...eventStats.entries()]
      .filter(([, stats]) => stats.eventWindows >= minSupport)
      .map(([phrase, stats]) => signalFromStats(kind, phrase, stats, neutral.counts.get(phrase) ?? 0, kindEvents.length, neutral.total))
      .filter((signal) => signal.lift > 0.7 && signal.event_windows > signal.neutral_windows * 0.015)
      .sort((a, b) => b.score - a.score || b.event_windows - a.event_windows)
      .slice(0, 8);
    return {
      kind,
      label: KIND_META[kind].label,
      description: KIND_META[kind].description,
      signals,
    };
  });
}

function eventFeatureCounts(days: DayBucket[], events: CandidateEvent[]) {
  const stats = new Map<string, SignalStats>();
  for (const event of events) {
    const rows = rowsForWindow(days, event.index - PRE_WINDOW_DAYS + 1, event.index + 1);
    const features = featuresForRows(rows);
    for (const phrase of features) {
      const existing = stats.get(phrase) ?? { eventWindows: 0, neutralWindows: 0, examples: [] };
      existing.eventWindows += 1;
      if (existing.examples.length < 2) {
        const example = exampleForFeature(rows, phrase);
        if (example) existing.examples.push({ ...example, event_ymd: event.ymd });
      }
      stats.set(phrase, existing);
    }
  }
  return stats;
}

function neutralFeatureCounts(days: DayBucket[], events: CandidateEvent[]) {
  const eventIndices = new Set<number>();
  for (const event of events) {
    for (let i = event.index - LOOKBACK_DAYS; i <= event.index + LOOKAHEAD_DAYS; i += 1) {
      eventIndices.add(i);
    }
  }

  const eligible = days
    .filter((day) => day.messages >= 8 && !eventIndices.has(day.index))
    .map((day) => day.index);
  const stride = Math.max(1, Math.ceil(eligible.length / MAX_NEUTRAL_WINDOWS));
  const selected = eligible.filter((_index, offset) => offset % stride === 0).slice(0, MAX_NEUTRAL_WINDOWS);
  const counts = new Map<string, number>();

  for (const index of selected) {
    const features = featuresForRows(rowsForWindow(days, index - PRE_WINDOW_DAYS + 1, index + 1));
    for (const phrase of features) {
      counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
    }
  }

  return { counts, total: selected.length };
}

function signalFromStats(
  kind: OmenKind,
  phrase: string,
  stats: SignalStats,
  neutralWindows: number,
  eventTotal: number,
  neutralTotal: number,
): OmenSignal {
  const eventOdds = (stats.eventWindows + 0.5) / (eventTotal - stats.eventWindows + 0.5);
  const neutralOdds = (neutralWindows + 0.5) / (neutralTotal - neutralWindows + 0.5);
  const lift = Math.log2(eventOdds / neutralOdds);
  return {
    kind,
    label: KIND_META[kind].label,
    phrase,
    lift: round(lift),
    score: round(lift * Math.sqrt(stats.eventWindows)),
    event_windows: stats.eventWindows,
    neutral_windows: neutralWindows,
    event_total: eventTotal,
    neutral_total: neutralTotal,
    examples: stats.examples,
  };
}

function rowsForWindow(days: DayBucket[], start: number, end: number) {
  const rows: MessageRow[] = [];
  const from = Math.max(0, start);
  const to = Math.min(days.length, end);
  for (let i = from; i < to; i += 1) {
    rows.push(...days[i].rows);
  }
  return rows;
}

function examplesForRows(rows: MessageRow[], max: number, direction: "earliest" | "latest") {
  const source = direction === "latest" ? [...rows].reverse() : rows;
  const examples: OmenExample[] = [];
  const seen = new Set<Sender>();
  for (const row of source) {
    const text = cleanPreview(row.text);
    if (!text) continue;
    const sender = senderName(row);
    if (seen.has(sender) && examples.length < 2) continue;
    examples.push({ ts: row.ts, ymd: bucket(row.ts, "ymd"), sender, text });
    seen.add(sender);
    if (examples.length >= max) break;
  }
  return direction === "latest" ? examples.reverse() : examples;
}

function featuresForRows(rows: MessageRow[]) {
  const features = new Set<string>();
  for (const row of rows) {
    const tokens = tokenize(row.text ?? "");
    for (const feature of featuresForTokens(tokens)) {
      features.add(feature);
    }
  }
  return features;
}

function featuresForTokens(tokens: string[]) {
  const features: string[] = [];
  for (let n = 1; n <= 3; n += 1) {
    for (let i = 0; i <= tokens.length - n; i += 1) {
      const phraseTokens = tokens.slice(i, i + n);
      const phrase = phraseTokens.join(" ");
      if (!isGoodFeature(phraseTokens, phrase, n)) continue;
      features.push(phrase);
    }
  }
  return features;
}

function exampleForFeature(rows: MessageRow[], phrase: string) {
  const words = phrase.split(" ");
  for (const row of rows) {
    const text = cleanPreview(row.text);
    if (!text) continue;
    const tokens = tokenize(text);
    if (containsPhrase(tokens, words)) return { ts: row.ts, ymd: bucket(row.ts, "ymd"), sender: senderName(row), text };
  }
  return null;
}

function containsPhrase(tokens: string[], phrase: string[]) {
  for (let i = 0; i <= tokens.length - phrase.length; i += 1) {
    if (phrase.every((token, offset) => tokens[i + offset] === token)) return true;
  }
  return false;
}

function tokenize(text: string) {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/&amp;/g, " and ")
    .match(/[a-z][a-z']{1,}|[0-9]{2,}/g)
    ?.map((token) => token.replace(/'/g, ""))
    .filter((token) => token.length > 1) ?? [];
}

function isGoodFeature(tokens: string[], phrase: string, size: number) {
  if (BLOCKED_FEATURES.has(phrase)) return false;
  if (tokens.some((token) => token.length > 18)) return false;
  const strongTokens = tokens.filter((token) => !STOPWORDS.has(token) && token.length >= 4);
  if (size === 1) return strongTokens.length === 1 && !/^\d+$/.test(tokens[0]) && !GENERIC_SINGLE_WORDS.has(tokens[0]);
  if (strongTokens.length === 0) return false;
  if (tokens.every((token) => STOPWORDS.has(token))) return false;
  if (GENERIC_SINGLE_WORDS.has(tokens[0]) || GENERIC_SINGLE_WORDS.has(tokens[tokens.length - 1])) return false;
  if (STOPWORDS.has(tokens[0])) return false;
  if (STOPWORDS.has(tokens[tokens.length - 1]) && !ALLOWED_STOPWORD_END_STARTS.has(tokens[0])) return false;
  return true;
}

function windowMetrics(prefix: PrefixSums, start: number, end: number): WindowMetrics {
  const from = Math.max(0, start);
  const to = Math.min(prefix.messages.length - 1, end);
  return {
    messages: range(prefix.messages, from, to),
    words: range(prefix.words, from, to),
    warmth: range(prefix.warmth, from, to),
    strain: range(prefix.strain, from, to),
    repair: range(prefix.repair, from, to),
    care: range(prefix.care, from, to),
    gratitude: range(prefix.gratitude, from, to),
    humor: range(prefix.humor, from, to),
  };
}

function range(prefix: number[], start: number, end: number) {
  return prefix[end] - prefix[start];
}

function repairRate(metrics: WindowMetrics) {
  return per100(metrics.repair + metrics.care + metrics.gratitude + metrics.warmth * 0.35, metrics.messages);
}

function per100(count: number, total: number) {
  return total ? (count / total) * 100 : 0;
}

function senderName(row: MessageRow): Sender {
  return row.is_from_me === 1 ? "Me" : "Them";
}

function cleanPreview(text: string | null) {
  return (text ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
}

function stripIndex(event: CandidateEvent): OmenEvent {
  const { index: _index, ...rest } = event;
  return rest;
}

function epochDay(ymd: string) {
  const [year, month, day] = ymd.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

function ymdFromEpochDay(day: number) {
  return new Date(day * 86400000).toISOString().slice(0, 10);
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}
