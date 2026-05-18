import { createServerFn } from "@tanstack/react-start";
import { realMessageWhere } from "~/lib/conversation/filters";
import { bucket } from "~/lib/conversation/time";
import { db, withDbCache } from "~/lib/server-db";

const REAL_MESSAGE_WHERE = realMessageWhere("text_turn");
const MIN_WEEK_MESSAGES = 18;
const MIN_RECURRENCE_GAP_WEEKS = 8;
const DISTANT_PAIR_GAP_WEEKS = 26;
const TARGET_RECURRENCE_RATE = 0.075;
const MAX_MATRIX_POINTS = 2600;
const MAX_ECHO_PAIRS = 12;
const MAX_LINES = 8;
const MAX_FRONTIERS = 10;

const FEATURE_KEYS = [
  "intensity",
  "reciprocity",
  "me_share",
  "tempo",
  "wordiness",
  "question",
  "attachment",
  "late",
  "warmth",
  "strain",
  "repair",
  "play",
  "planning",
  "care",
  "small_talk",
  "emotional_support",
  "romantic_intimacy",
  "sexual_intimacy",
  "conflict",
  "logistics",
  "travel",
  "photo",
] as const;

export type RecurrenceFeatureKey = (typeof FEATURE_KEYS)[number];

export type RecurrenceOverview = {
  generated_at: string;
  active_weeks: number;
  recurrence_rate: number;
  determinism: number;
  laminarity: number;
  strongest_echo: string;
  longest_return: string;
  current_return: string;
};

export type RecurrencePoint = {
  left_index: number;
  right_index: number;
  similarity: number;
  gap_weeks: number;
};

export type RecurrenceWeek = {
  index: number;
  key: string;
  start_ts: number;
  messages: number;
  recurrence_count: number;
  novelty: number;
  label: string;
  x: number;
  height: number;
};

export type RecurrenceSnippet = {
  ts: number;
  sender: "Me" | "Them";
  text: string;
};

export type RecurrenceEcho = {
  key: string;
  left_key: string;
  right_key: string;
  left_ts: number;
  right_ts: number;
  gap_weeks: number;
  similarity: number;
  label: string;
  shared_features: string[];
  left_snippets: RecurrenceSnippet[];
  right_snippets: RecurrenceSnippet[];
};

export type RecurrenceLine = {
  key: string;
  left_start_ts: number;
  right_start_ts: number;
  length_weeks: number;
  gap_weeks: number;
  similarity: number;
  label: string;
  shared_features: string[];
};

export type RecurrenceFrontier = {
  key: string;
  start_ts: number;
  messages: number;
  novelty: number;
  label: string;
  nearest_return: string;
  snippets: RecurrenceSnippet[];
};

export type RecurrenceResult = {
  overview: RecurrenceOverview;
  weeks: RecurrenceWeek[];
  points: RecurrencePoint[];
  echoes: RecurrenceEcho[];
  lines: RecurrenceLine[];
  frontiers: RecurrenceFrontier[];
};

type MessageRow = {
  ts: number;
  ymd: string;
  is_from_me: number;
  text: string | null;
  word_count: number;
  has_attachment: number;
};

type SegmentCategoryRow = {
  ymd: string;
  n_msgs: number;
  category: string;
  confidence: number;
};

type CandidateSnippet = RecurrenceSnippet & {
  score: number;
};

type WeekBuilder = {
  key: string;
  startTs: number;
  messages: number;
  me: number;
  them: number;
  words: number;
  prevTs: number | null;
  gaps: number[];
  hits: Record<RateFeatureKey, number>;
  categories: Map<RecurrenceFeatureKey, number>;
  snippets: CandidateSnippet[];
};

type WeekVector = {
  index: number;
  key: string;
  startTs: number;
  messages: number;
  raw: Record<RecurrenceFeatureKey, number>;
  scaled: Record<RecurrenceFeatureKey, number>;
  vector: number[];
  recurrenceCount: number;
  novelty: number;
  nearestPrevious: number | null;
  snippets: RecurrenceSnippet[];
};

type PairCandidate = {
  left: number;
  right: number;
  distance: number;
  similarity: number;
};

type RqaStats = {
  recurrenceRate: number;
  determinism: number;
  laminarity: number;
};

type RateFeatureKey =
  | "question"
  | "attachment"
  | "late"
  | "warmth"
  | "strain"
  | "repair"
  | "play"
  | "planning"
  | "care";

const FEATURE_LABELS: Record<RecurrenceFeatureKey, string> = {
  intensity: "Intensity",
  reciprocity: "Reciprocity",
  me_share: "Me share",
  tempo: "Tempo",
  wordiness: "Wordiness",
  question: "Questions",
  attachment: "Objects",
  late: "Late-night",
  warmth: "Warmth",
  strain: "Strain",
  repair: "Repair",
  play: "Play",
  planning: "Planning",
  care: "Care",
  small_talk: "Small talk",
  emotional_support: "Emotional support",
  romantic_intimacy: "Romantic intimacy",
  sexual_intimacy: "Sexual intimacy",
  conflict: "Conflict",
  logistics: "Logistics",
  travel: "Travel",
  photo: "Photo sharing",
};

const CATEGORY_TO_FEATURE: Record<string, RecurrenceFeatureKey> = {
  small_talk: "small_talk",
  emotional_support: "emotional_support",
  romantic_intimacy: "romantic_intimacy",
  sexual_intimacy: "sexual_intimacy",
  conflict: "conflict",
  logistics: "logistics",
  travel: "travel",
  planning: "planning",
  humor: "play",
  games: "play",
  daily_check_in: "care",
  food: "care",
  health: "care",
  tech: "logistics",
  household: "logistics",
  finance: "logistics",
  photo_sharing: "photo",
  memes_links: "photo",
};

const LEXICONS: Record<Exclude<RateFeatureKey, "question" | "attachment" | "late">, { words: Set<string>; phrases: string[] }> = {
  warmth: lexicon(
    ["adore", "angel", "beautiful", "babe", "bb", "cute", "glad", "gorgeous", "heart", "hug", "kiss", "love", "miss", "pretty", "proud", "sweet"],
    ["love you", "miss you", "my love", "so proud", "thinking of you"],
  ),
  strain: lexicon(
    ["afraid", "anxious", "bad", "cry", "difficult", "fight", "hard", "hurt", "lonely", "mad", "overwhelmed", "panic", "sad", "scared", "stress", "upset", "worried"],
    ["feel bad", "really hard", "not okay", "i am sorry"],
  ),
  repair: lexicon(
    ["apologize", "apology", "forgive", "grateful", "okay", "repair", "safe", "sorry", "thank", "thanks", "understand"],
    ["i understand", "thank you", "thats okay", "that's okay", "i am sorry", "im sorry", "i'm sorry"],
  ),
  play: lexicon(
    ["haha", "hahaha", "hehe", "joke", "lmao", "lol", "meme", "omg", "silly", "wild", "wow", "wtf"],
    ["ha ha", "oh my god", "very funny"],
  ),
  planning: lexicon(
    ["appointment", "calendar", "call", "class", "coffee", "dinner", "drive", "later", "meet", "meeting", "plan", "ready", "schedule", "soon", "time", "today", "tomorrow", "work"],
    ["what time", "see you", "come over", "pick you up", "on my way"],
  ),
  care: lexicon(
    ["eat", "home", "nap", "okay", "safe", "sick", "sleep", "tired", "water"],
    ["are you okay", "you okay", "you good", "feel better", "take care"],
  ),
};

export const getRecurrence = createServerFn({ method: "GET" }).handler(
  async (): Promise<RecurrenceResult> => {
    return withDbCache("recurrence", () => {
      const generated = db().prepare("SELECT v FROM meta WHERE k = 'generated_at'").get() as { v: string } | undefined;
      const rows = db()
        .prepare(
          `
          SELECT ts, ymd, is_from_me, text, word_count, has_attachment
          FROM messages
          WHERE ${REAL_MESSAGE_WHERE}
          ORDER BY ts ASC, id ASC
        `,
        )
        .all() as MessageRow[];

      const rawSegmentRows = db()
        .prepare(
          `
          SELECT s.start_ts, s.n_msgs, c.category, c.confidence
          FROM seg_segments s
          JOIN seg_segment_categories c ON c.segment_id = s.id
        `,
        )
        .all() as Array<Omit<SegmentCategoryRow, "ymd"> & { start_ts: number }>;
      const segmentRows: SegmentCategoryRow[] = rawSegmentRows.map(({ start_ts, ...row }) => ({
        ...row,
        ymd: bucket(start_ts, "ymd"),
      }));

      const weeks = buildWeekVectors(rows, segmentRows);
      const pairs = buildPairCandidates(weeks);
      const threshold = distanceThreshold(pairs);
      const recurrent = pairs.filter((pair) => pair.distance <= threshold);
      assignRecurrenceStats(weeks, pairs, recurrent);

      const rqa = computeRqaStats(weeks.length, pairs.length, recurrent);
      const points = samplePoints(recurrent);
      const echoes = selectEchoes(weeks, recurrent);
      const lines = buildDiagonalLines(weeks, recurrent);
      const frontiers = buildFrontiers(weeks);
      const recentWeek = weeks[weeks.length - 1];
      const recentMatch = recentWeek?.nearestPrevious == null ? null : weeks[recentWeek.nearestPrevious];

      return {
        overview: {
          generated_at: generated?.v ?? "unknown",
          active_weeks: weeks.length,
          recurrence_rate: round(rqa.recurrenceRate),
          determinism: round(rqa.determinism),
          laminarity: round(rqa.laminarity),
          strongest_echo: echoes[0] ? `${echoes[0].gap_weeks}w apart` : "n/a",
          longest_return: lines[0] ? `${lines[0].length_weeks}w corridor` : "n/a",
          current_return: recentMatch ? `${recentMatch.key} (${sharedFeatureLabel(recentWeek, recentMatch)})` : "n/a",
        },
        weeks: serializeWeeks(weeks),
        points,
        echoes,
        lines,
        frontiers,
      };
    });
  },
);

function buildWeekVectors(rows: MessageRow[], segmentRows: SegmentCategoryRow[]) {
  const builders = new Map<string, WeekBuilder>();

  for (const row of rows) {
    const key = weekKey(row.ymd);
    let builder = builders.get(key);
    if (!builder) {
      builder = createBuilder(key);
      builders.set(key, builder);
    }

    builder.messages++;
    if (row.is_from_me === 1) builder.me++;
    else builder.them++;
    builder.words += row.word_count || wordCount(row.text ?? "");

    if (builder.prevTs !== null) {
      const gap = row.ts - builder.prevTs;
      if (gap > 0) builder.gaps.push(gap);
    }
    builder.prevTs = row.ts;

    const text = row.text ?? "";
    const lower = text.toLowerCase();
    const tokens = tokenize(text);
    if (text.includes("?")) builder.hits.question++;
    if (row.has_attachment) builder.hits.attachment++;
    if (isLate(row.ts)) builder.hits.late++;
    for (const feature of ["warmth", "strain", "repair", "play", "planning", "care"] as const) {
      builder.hits[feature] += countLexiconHits(lower, tokens, LEXICONS[feature]);
    }
    maybeAddSnippet(builder, row, tokens.length);
  }

  for (const row of segmentRows) {
    const feature = CATEGORY_TO_FEATURE[row.category];
    if (!feature) continue;
    const builder = builders.get(weekKey(row.ymd));
    if (!builder) continue;
    const weight = row.n_msgs * Math.max(row.confidence, 0.35);
    builder.categories.set(feature, (builder.categories.get(feature) ?? 0) + weight);
  }

  const active = [...builders.values()]
    .filter((week) => week.messages >= MIN_WEEK_MESSAGES)
    .sort((a, b) => a.startTs - b.startTs);
  const messageCap = quantile(active.map((week) => week.messages), 0.95) || 1;
  const wordCap = quantile(active.map((week) => week.words / Math.max(week.messages, 1)), 0.9) || 1;
  const rateCaps = computeRateCaps(active);

  const weeks = active.map((week, index) => {
    const raw = weekRawFeatures(week, messageCap, wordCap, rateCaps);
    return {
      index,
      key: week.key,
      startTs: week.startTs,
      messages: week.messages,
      raw,
      scaled: emptyFeatureRecord(),
      vector: [],
      recurrenceCount: 0,
      novelty: 1,
      nearestPrevious: null,
      snippets: week.snippets
        .sort((a, b) => b.score - a.score)
        .slice(0, 2)
        .sort((a, b) => a.ts - b.ts)
        .map(({ score: _score, ...snippet }) => snippet),
    } satisfies WeekVector;
  });

  standardizeWeeks(weeks);
  return weeks;
}

function weekRawFeatures(
  week: WeekBuilder,
  messageCap: number,
  wordCap: number,
  rateCaps: Record<RateFeatureKey, number>,
): Record<RecurrenceFeatureKey, number> {
  const messages = Math.max(week.messages, 1);
  const medianGap = median(week.gaps) ?? 7 * 86400;
  const tempo = 1 - clamp(Math.log1p(medianGap) / Math.log1p(72 * 3600), 0, 1);
  const categoryTotal = sum([...week.categories.values()]);
  const raw = emptyFeatureRecord();
  raw.intensity = clamp(Math.log1p(week.messages) / Math.log1p(messageCap), 0, 1);
  raw.reciprocity = clamp(1 - Math.abs(week.me - week.them) / messages, 0, 1);
  raw.me_share = week.me / messages;
  raw.tempo = tempo;
  raw.wordiness = clamp((week.words / messages) / wordCap, 0, 1);
  for (const feature of Object.keys(week.hits) as RateFeatureKey[]) {
    raw[feature] = normalizedRate(week.hits[feature], messages, rateCaps[feature]);
  }
  for (const [feature, weight] of week.categories.entries()) {
    raw[feature] = Math.max(raw[feature], categoryTotal ? weight / categoryTotal : 0);
  }
  return raw;
}

function computeRateCaps(weeks: WeekBuilder[]) {
  const caps = {} as Record<RateFeatureKey, number>;
  for (const feature of ["question", "attachment", "late", "warmth", "strain", "repair", "play", "planning", "care"] as RateFeatureKey[]) {
    caps[feature] = Math.max(quantile(weeks.map((week) => week.hits[feature] / Math.max(week.messages, 1)), 0.9), 0.025);
  }
  return caps;
}

function standardizeWeeks(weeks: WeekVector[]) {
  for (const key of FEATURE_KEYS) {
    const values = weeks.map((week) => week.raw[key]);
    const mean = average(values);
    const sd = stddev(values) || 1;
    for (const week of weeks) {
      week.scaled[key] = (week.raw[key] - mean) / sd;
    }
  }
  for (const week of weeks) {
    week.vector = FEATURE_KEYS.map((key) => week.scaled[key]);
  }
}

function buildPairCandidates(weeks: WeekVector[]) {
  const pairs: PairCandidate[] = [];
  const scale = Math.sqrt(FEATURE_KEYS.length);
  for (let left = 0; left < weeks.length; left += 1) {
    for (let right = left + MIN_RECURRENCE_GAP_WEEKS; right < weeks.length; right += 1) {
      const distance = euclidean(weeks[left].vector, weeks[right].vector);
      pairs.push({
        left,
        right,
        distance,
        similarity: 1 / (1 + distance / scale),
      });
    }
  }
  return pairs;
}

function distanceThreshold(pairs: PairCandidate[]) {
  if (!pairs.length) return 0;
  const sorted = pairs.map((pair) => pair.distance).sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * TARGET_RECURRENCE_RATE)))];
}

function assignRecurrenceStats(weeks: WeekVector[], pairs: PairCandidate[], recurrent: PairCandidate[]) {
  for (const pair of recurrent) {
    weeks[pair.left].recurrenceCount++;
    weeks[pair.right].recurrenceCount++;
  }

  for (const week of weeks) {
    const previous = pairs
      .filter((pair) => pair.right === week.index && week.index - pair.left >= MIN_RECURRENCE_GAP_WEEKS)
      .sort((a, b) => a.distance - b.distance)[0];
    if (previous) {
      week.nearestPrevious = previous.left;
      week.novelty = round(1 - previous.similarity);
    }
  }
}

function computeRqaStats(weekCount: number, pairCount: number, recurrent: PairCandidate[]): RqaStats {
  if (!pairCount || !recurrent.length) {
    return { recurrenceRate: 0, determinism: 0, laminarity: 0 };
  }

  const pairMap = recurrenceMap(recurrent);
  let deterministicPoints = 0;
  let laminarPoints = 0;

  for (const pair of recurrent) {
    if (pairMap.has(pairKey(pair.left - 1, pair.right - 1)) || pairMap.has(pairKey(pair.left + 1, pair.right + 1))) {
      deterministicPoints++;
    }
    if (pairMap.has(pairKey(pair.left, pair.right - 1)) || pairMap.has(pairKey(pair.left, pair.right + 1))) {
      laminarPoints++;
    }
  }

  return {
    recurrenceRate: recurrent.length / pairCount,
    determinism: deterministicPoints / recurrent.length,
    laminarity: laminarPoints / recurrent.length,
  };
}

function samplePoints(recurrent: PairCandidate[]): RecurrencePoint[] {
  const sorted = recurrent.slice().sort((a, b) => b.similarity - a.similarity);
  const sampled = sorted.length <= MAX_MATRIX_POINTS
    ? sorted
    : sorted.filter((_, index) => index % Math.ceil(sorted.length / MAX_MATRIX_POINTS) === 0).slice(0, MAX_MATRIX_POINTS);
  return sampled.map((pair) => ({
    left_index: pair.left,
    right_index: pair.right,
    similarity: round(pair.similarity),
    gap_weeks: pair.right - pair.left,
  }));
}

function selectEchoes(weeks: WeekVector[], recurrent: PairCandidate[]) {
  const selected: RecurrenceEcho[] = [];
  const used = new Set<number>();
  const candidates = recurrent
    .filter((pair) => pair.right - pair.left >= DISTANT_PAIR_GAP_WEEKS)
    .sort((a, b) => b.similarity * Math.log1p(b.right - b.left) - a.similarity * Math.log1p(a.right - a.left));

  for (const pair of candidates) {
    if ([...used].some((index) => Math.abs(index - pair.left) <= 2 || Math.abs(index - pair.right) <= 2)) continue;
    const left = weeks[pair.left];
    const right = weeks[pair.right];
    selected.push({
      key: `${left.key}-${right.key}`,
      left_key: left.key,
      right_key: right.key,
      left_ts: left.startTs,
      right_ts: right.startTs,
      gap_weeks: pair.right - pair.left,
      similarity: round(pair.similarity),
      label: echoLabel(left, right),
      shared_features: sharedFeatures(left, right, 4),
      left_snippets: left.snippets,
      right_snippets: right.snippets,
    });
    used.add(pair.left);
    used.add(pair.right);
    if (selected.length >= MAX_ECHO_PAIRS) break;
  }
  return selected;
}

function buildDiagonalLines(weeks: WeekVector[], recurrent: PairCandidate[]): RecurrenceLine[] {
  const pairMap = recurrenceMap(recurrent);
  const byKey = new Map(recurrent.map((pair) => [pairKey(pair.left, pair.right), pair]));
  const lines: RecurrenceLine[] = [];

  for (const pair of recurrent) {
    if (pairMap.has(pairKey(pair.left - 1, pair.right - 1))) continue;
    let length = 0;
    let similarityTotal = 0;
    while (pairMap.has(pairKey(pair.left + length, pair.right + length))) {
      similarityTotal += byKey.get(pairKey(pair.left + length, pair.right + length))?.similarity ?? 0;
      length++;
    }
    if (length < 3) continue;
    const left = weeks[pair.left];
    const right = weeks[pair.right];
    lines.push({
      key: `${left.key}-${right.key}-${length}`,
      left_start_ts: left.startTs,
      right_start_ts: right.startTs,
      length_weeks: length,
      gap_weeks: pair.right - pair.left,
      similarity: round(similarityTotal / length),
      label: echoLabel(left, right),
      shared_features: sharedFeatures(left, right, 3),
    });
  }

  return lines
    .sort((a, b) => b.length_weeks * b.similarity * Math.log1p(b.gap_weeks) - a.length_weeks * a.similarity * Math.log1p(a.gap_weeks))
    .slice(0, MAX_LINES);
}

function buildFrontiers(weeks: WeekVector[]): RecurrenceFrontier[] {
  return weeks
    .filter((week) => week.index >= MIN_RECURRENCE_GAP_WEEKS)
    .slice()
    .sort((a, b) => b.novelty - a.novelty || b.messages - a.messages)
    .slice(0, MAX_FRONTIERS)
    .map((week) => ({
      key: week.key,
      start_ts: week.startTs,
      messages: week.messages,
      novelty: round(week.novelty),
      label: dominantFeatureLabel(week),
      nearest_return: week.nearestPrevious == null ? "none" : weeks[week.nearestPrevious].key,
      snippets: week.snippets,
    }));
}

function serializeWeeks(weeks: WeekVector[]): RecurrenceWeek[] {
  const maxRecurrences = Math.max(...weeks.map((week) => week.recurrenceCount), 1);
  const denom = Math.max(weeks.length - 1, 1);
  return weeks.map((week) => ({
    index: week.index,
    key: week.key,
    start_ts: week.startTs,
    messages: week.messages,
    recurrence_count: week.recurrenceCount,
    novelty: round(week.novelty),
    label: dominantFeatureLabel(week),
    x: round(week.index / denom),
    height: round(week.recurrenceCount / maxRecurrences),
  }));
}

function createBuilder(key: string): WeekBuilder {
  return {
    key,
    startTs: tsForYmd(key),
    messages: 0,
    me: 0,
    them: 0,
    words: 0,
    prevTs: null,
    gaps: [],
    hits: {
      question: 0,
      attachment: 0,
      late: 0,
      warmth: 0,
      strain: 0,
      repair: 0,
      play: 0,
      planning: 0,
      care: 0,
    },
    categories: new Map(),
    snippets: [],
  };
}

function maybeAddSnippet(builder: WeekBuilder, row: MessageRow, tokenCount: number) {
  const text = preview(row.text);
  if (!text || tokenCount < 6) return;
  const score = Math.min(tokenCount, 42) + (row.has_attachment ? 4 : 0);
  builder.snippets.push({
    ts: row.ts,
    sender: row.is_from_me === 1 ? "Me" : "Them",
    text,
    score,
  });
  if (builder.snippets.length > 8) {
    builder.snippets.sort((a, b) => b.score - a.score);
    builder.snippets.length = 8;
  }
}

function sharedFeatures(left: WeekVector, right: WeekVector, limit: number) {
  return FEATURE_KEYS.map((key) => ({
    key,
    score: Math.min(left.scaled[key], right.scaled[key]) + (left.raw[key] + right.raw[key]) * 0.15,
  }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((feature) => FEATURE_LABELS[feature.key]);
}

function sharedFeatureLabel(left: WeekVector, right: WeekVector) {
  return sharedFeatures(left, right, 1)[0] ?? "state return";
}

function echoLabel(left: WeekVector, right: WeekVector) {
  const features = sharedFeatures(left, right, 2).map((feature) => feature.toLowerCase());
  return features.length ? `${features.join(" + ")} return` : "state return";
}

function dominantFeatureLabel(week: WeekVector) {
  const key = FEATURE_KEYS.slice().sort((a, b) => week.scaled[b] - week.scaled[a])[0];
  return FEATURE_LABELS[key] ?? "State";
}

function recurrenceMap(pairs: PairCandidate[]) {
  return new Set(pairs.map((pair) => pairKey(pair.left, pair.right)));
}

function pairKey(left: number, right: number) {
  return `${left}:${right}`;
}

function countLexiconHits(lower: string, tokens: string[], lex: { words: Set<string>; phrases: string[] }) {
  let count = 0;
  for (const token of tokens) {
    if (lex.words.has(token)) count++;
  }
  for (const phrase of lex.phrases) {
    if (lower.includes(phrase)) count += 2;
  }
  return count;
}

function tokenize(text: string) {
  return text
    .toLowerCase()
    .replace(/[']/g, "")
    .match(/[a-z0-9]{2,}/g) ?? [];
}

function lexicon(words: string[], phrases: string[]) {
  return { words: new Set(words), phrases };
}

function emptyFeatureRecord() {
  return Object.fromEntries(FEATURE_KEYS.map((key) => [key, 0])) as Record<RecurrenceFeatureKey, number>;
}

function isLate(ts: number) {
  const hour = new Date(ts * 1000).getUTCHours();
  return hour >= 6 && hour <= 11;
}

function normalizedRate(count: number, messages: number, cap: number) {
  return clamp(count / Math.max(messages, 1) / Math.max(cap, 0.001), 0, 1);
}

function euclidean(left: number[], right: number[]) {
  let total = 0;
  for (let index = 0; index < left.length; index += 1) {
    total += (left[index] - right[index]) ** 2;
  }
  return Math.sqrt(total);
}

function weekKey(ymd: string) {
  const [year, month, day] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  const dayOfWeek = date.getUTCDay();
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return date.toISOString().slice(0, 10);
}

function tsForYmd(ymd: string) {
  const [year, month, day] = ymd.split("-").map(Number);
  return Date.UTC(year, month - 1, day, 12) / 1000;
}

function wordCount(text: string) {
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

function preview(text: string | null) {
  const cleaned = (text ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  return cleaned.length > 155 ? `${cleaned.slice(0, 152)}...` : cleaned;
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function quantile(values: number[], q: number) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function average(values: number[]) {
  return values.length ? sum(values) / values.length : 0;
}

function stddev(values: number[]) {
  if (!values.length) return 0;
  const mean = average(values);
  return Math.sqrt(average(values.map((value) => (value - mean) ** 2)));
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}
