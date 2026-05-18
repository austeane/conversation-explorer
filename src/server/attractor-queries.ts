import { createServerFn } from "@tanstack/react-start";
import { realMessageWhere } from "~/lib/conversation/filters";
import { messageScopeInput, messageScopeWhere } from "~/lib/conversation/scope";
import { bucket } from "~/lib/conversation/time";
import { db, withDbCache } from "~/lib/server-db";
import { resolveMessageScope } from "~/server/scope";

const REAL_MESSAGE_WHERE = realMessageWhere("browsable_message", "m");
const MIN_WEEK_MESSAGES = 12;
const CLUSTER_COUNT = 6;
const MAX_TRANSITIONS = 12;
const MAX_ESCAPES = 12;
const MAX_PATH_WEEKS = 220;

const FEATURE_KEYS = [
  "intensity",
  "reciprocity",
  "tempo",
  "warmth",
  "strain",
  "repair",
  "play",
  "practical",
  "object",
] as const;

export type AttractorFeatureKey = (typeof FEATURE_KEYS)[number];

export type AttractorOverview = {
  generated_at: string;
  active_weeks: number;
  attractors: number;
  stability_rate: number;
  dominant_attractor: string;
  largest_escape: string;
};

export type AttractorWeek = {
  key: string;
  start_ts: number;
  end_ts: number;
  cluster_id: number;
  label: string;
  messages: number;
  me_share: number;
  x: number;
  y: number;
  radius: number;
  features: Record<AttractorFeatureKey, number>;
};

export type AttractorFeature = {
  key: AttractorFeatureKey;
  label: string;
  value: number;
};

export type RepresentativeWeek = {
  key: string;
  start_ts: number;
  end_ts: number;
  messages: number;
  me_share: number;
};

export type Attractor = {
  id: number;
  label: string;
  weeks: number;
  share: number;
  messages: number;
  avg_messages: number;
  avg_me_share: number;
  features: AttractorFeature[];
  signature_words: string[];
  representative_weeks: RepresentativeWeek[];
};

export type AttractorTransition = {
  key: string;
  from_id: number;
  to_id: number;
  from_label: string;
  to_label: string;
  count: number;
  rate: number;
  lift: number;
};

export type AttractorEscape = {
  key: string;
  week: string;
  start_ts: number;
  from_label: string;
  to_label: string;
  distance: number;
  messages: number;
  feature_changes: {
    key: AttractorFeatureKey;
    label: string;
    delta: number;
  }[];
};

export type AttractorResult = {
  overview: AttractorOverview;
  weeks: AttractorWeek[];
  path_weeks: AttractorWeek[];
  attractors: Attractor[];
  transitions: AttractorTransition[];
  escapes: AttractorEscape[];
};

type MessageRow = {
  id: number;
  ts: number;
  is_from_me: number;
  has_attachment: number;
  text: string | null;
};

type WeekBuilder = {
  key: string;
  startTs: number;
  endTs: number;
  firstTs: number;
  lastTs: number;
  messages: number;
  me: number;
  them: number;
  words: number;
  prevTs: number | null;
  gaps: number[];
  hits: Record<RateFeatureKey, number>;
  tokens: Map<string, number>;
};

type WeekVector = {
  key: string;
  startTs: number;
  endTs: number;
  messages: number;
  meShare: number;
  features: Record<AttractorFeatureKey, number>;
  scaled: number[];
  cluster: number;
  x: number;
  y: number;
  radius: number;
  tokenCounts: Map<string, number>;
  tokenTotal: number;
};

type ClusterSummary = {
  originalId: number;
  id: number;
  label: string;
  weeks: WeekVector[];
  centroid: number[];
  features: Record<AttractorFeatureKey, number>;
  messages: number;
  tokenCounts: Map<string, number>;
  tokenTotal: number;
};

type RateFeatureKey = "warmth" | "strain" | "repair" | "play" | "practical" | "object";
type RateCaps = Record<RateFeatureKey, number>;

const FEATURE_LABELS: Record<AttractorFeatureKey, string> = {
  intensity: "Intensity",
  reciprocity: "Reciprocity",
  tempo: "Tempo",
  warmth: "Warmth",
  strain: "Strain",
  repair: "Repair",
  play: "Play",
  practical: "Practical",
  object: "Object",
};

const RATE_FEATURES: RateFeatureKey[] = ["warmth", "strain", "repair", "play", "practical", "object"];

const LEXICONS: Record<RateFeatureKey, { words: Set<string>; phrases: string[] }> = {
  warmth: lexicon(
    [
      "adore",
      "angel",
      "beautiful",
      "babe",
      "bb",
      "cute",
      "gorgeous",
      "heart",
      "hug",
      "kiss",
      "love",
      "lovely",
      "miss",
      "pretty",
      "sweet",
      "tender",
      "warm",
      "xoxo",
    ],
    ["love you", "miss you", "my love", "so proud", "thinking of you"],
  ),
  strain: lexicon(
    [
      "afraid",
      "anxious",
      "bad",
      "cry",
      "crying",
      "difficult",
      "fight",
      "hard",
      "hurt",
      "lonely",
      "mad",
      "overwhelmed",
      "pain",
      "panic",
      "sad",
      "scared",
      "stress",
      "stressed",
      "upset",
      "worried",
      "worry",
    ],
    ["feel bad", "feeling bad", "really hard", "so hard", "not okay", "i am sorry"],
  ),
  repair: lexicon(
    [
      "apologize",
      "apology",
      "forgive",
      "grateful",
      "okay",
      "repair",
      "safe",
      "sorry",
      "thank",
      "thanks",
      "understand",
    ],
    ["i mean", "i understand", "thank you", "thats okay", "that's okay", "i am sorry", "im sorry", "i'm sorry"],
  ),
  play: lexicon(
    [
      "haha",
      "hahaha",
      "hehe",
      "joke",
      "lmao",
      "lol",
      "meme",
      "omg",
      "silly",
      "wild",
      "wow",
      "wtf",
    ],
    ["ha ha", "oh my god", "very funny"],
  ),
  practical: lexicon(
    [
      "airport",
      "appointment",
      "bus",
      "call",
      "class",
      "coffee",
      "dinner",
      "drive",
      "home",
      "later",
      "meet",
      "meeting",
      "morning",
      "night",
      "park",
      "pickup",
      "plan",
      "ready",
      "schedule",
      "soon",
      "time",
      "today",
      "tomorrow",
      "train",
      "work",
    ],
    ["on my way", "what time", "see you", "come over", "pick you up"],
  ),
  object: lexicon(
    [
      "book",
      "cat",
      "dragon",
      "film",
      "game",
      "image",
      "link",
      "movie",
      "music",
      "photo",
      "pic",
      "picture",
      "screen",
      "screenshot",
      "song",
      "snap",
      "video",
      "youtube",
    ],
    ["sent you", "look at", "watch this"],
  ),
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
  "getting",
  "going",
  "have",
  "having",
  "here",
  "how",
  "mean",
  "just",
  "know",
  "like",
  "more",
  "not",
  "okay",
  "really",
  "said",
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
  "week",
  "you",
  "your",
]);

export const getAttractors = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => messageScopeInput.parse(d ?? {}))
  .handler(async ({ data }): Promise<AttractorResult> => {
    const resolved = resolveMessageScope(data);
    return withDbCache(`attractors:${JSON.stringify(resolved)}`, () => {
      const generated = db().prepare("SELECT v FROM meta WHERE k = 'generated_at'").get() as { v: string } | undefined;
      const scope = messageScopeWhere(resolved, "m", [REAL_MESSAGE_WHERE]);
      const rows = db()
        .prepare(
          `
          SELECT m.id, m.ts, m.is_from_me, m.has_attachment, m.text
          FROM messages m
          ${scope.sql}
          ORDER BY m.ts ASC, m.id ASC
        `,
        )
        .all(...scope.args) as MessageRow[];

      const weekVectors = buildWeekVectors(rows);
      const clusters = summarizeClusters(weekVectors);
      const weekRows = serializeWeeks(weekVectors, clusters);
      const pathWeeks = downsampleWeeks(weekRows);
      const attractors = clusters.map(toAttractor);
      const transitions = buildTransitions(weekVectors, clusters);
      const escapes = buildEscapes(weekVectors, clusters);
      const stableTransitions = weekVectors
        .slice(1)
        .filter((week, index) => week.cluster === weekVectors[index].cluster).length;

      return {
        overview: {
          generated_at: generated?.v ?? "unknown",
          active_weeks: weekVectors.length,
          attractors: clusters.length,
          stability_rate: rate(stableTransitions, Math.max(weekVectors.length - 1, 0)),
          dominant_attractor: attractors[0]?.label ?? "n/a",
          largest_escape: escapes[0] ? `${escapes[0].from_label} -> ${escapes[0].to_label}` : "n/a",
        },
        weeks: weekRows,
        path_weeks: pathWeeks,
        attractors,
        transitions,
        escapes,
      };
    });
  });

function buildWeekVectors(rows: MessageRow[]): WeekVector[] {
  const builders = new Map<string, WeekBuilder>();

  for (const row of rows) {
    const key = weekKey(bucket(row.ts, "ymd"));
    const startTs = tsForYmd(key);
    let builder = builders.get(key);
    if (!builder) {
      builder = {
        key,
        startTs,
        endTs: startTs + 7 * 86400 - 1,
        firstTs: row.ts,
        lastTs: row.ts,
        messages: 0,
        me: 0,
        them: 0,
        words: 0,
        prevTs: null,
        gaps: [],
        hits: { warmth: 0, strain: 0, repair: 0, play: 0, practical: 0, object: 0 },
        tokens: new Map(),
      };
      builders.set(key, builder);
    }

    builder.messages++;
    builder.firstTs = Math.min(builder.firstTs, row.ts);
    builder.lastTs = Math.max(builder.lastTs, row.ts);
    if (row.is_from_me) builder.me++;
    else builder.them++;

    if (builder.prevTs !== null) {
      const gap = row.ts - builder.prevTs;
      if (gap > 0) builder.gaps.push(gap);
    }
    builder.prevTs = row.ts;

    const text = row.text ?? "";
    const tokens = tokenize(text);
    builder.words += tokens.length;
    for (const token of tokens) {
      if (isSignatureToken(token)) {
        builder.tokens.set(token, (builder.tokens.get(token) ?? 0) + 1);
      }
    }

    const lower = text.toLowerCase();
    for (const feature of RATE_FEATURES) {
      builder.hits[feature] += countLexiconHits(lower, tokens, LEXICONS[feature]);
    }
    if (row.has_attachment) builder.hits.object += 2;
  }

  const activeWeeks = [...builders.values()]
    .filter((week) => week.messages >= MIN_WEEK_MESSAGES)
    .sort((a, b) => a.startTs - b.startTs);
  const messageCounts = activeWeeks.map((week) => week.messages);
  const p95Messages = quantile(messageCounts, 0.95) || Math.max(...messageCounts, 1);
  const rateCaps = Object.fromEntries(
    RATE_FEATURES.map((feature) => [
      feature,
      Math.max(quantile(activeWeeks.map((week) => week.hits[feature] / Math.max(week.messages, 1)), 0.9), 0.03),
    ]),
  ) as RateCaps;

  const weeks = activeWeeks.map((week) => {
    const features = computeFeatures(week, p95Messages, rateCaps);
    return {
      key: week.key,
      startTs: week.startTs,
      endTs: week.endTs,
      messages: week.messages,
      meShare: week.messages ? week.me / week.messages : 0,
      features,
      scaled: [],
      cluster: 0,
      x: 0,
      y: 0,
      radius: 3,
      tokenCounts: week.tokens,
      tokenTotal: sumMap(week.tokens),
    };
  });

  scaleFeatures(weeks);
  assignClusters(weeks);
  assignMapCoordinates(weeks);

  return weeks;
}

function computeFeatures(week: WeekBuilder, p95Messages: number, rateCaps: RateCaps): Record<AttractorFeatureKey, number> {
  const messages = Math.max(week.messages, 1);
  const medianGap = median(week.gaps) ?? 7 * 86400;
  const tempo = 1 - clamp(Math.log1p(medianGap) / Math.log1p(72 * 3600), 0, 1);
  return {
    intensity: clamp(Math.log1p(week.messages) / Math.log1p(Math.max(p95Messages, 1)), 0, 1),
    reciprocity: clamp(1 - Math.abs(week.me - week.them) / messages, 0, 1),
    tempo: clamp(tempo, 0, 1),
    warmth: normalizedRate(week.hits.warmth, messages, rateCaps.warmth),
    strain: normalizedRate(week.hits.strain, messages, rateCaps.strain),
    repair: normalizedRate(week.hits.repair, messages, rateCaps.repair),
    play: normalizedRate(week.hits.play, messages, rateCaps.play),
    practical: normalizedRate(week.hits.practical, messages, rateCaps.practical),
    object: normalizedRate(week.hits.object, messages, rateCaps.object),
  };
}

function normalizedRate(hits: number, messages: number, cap: number) {
  return clamp(hits / Math.max(messages, 1) / cap, 0, 1);
}

function scaleFeatures(weeks: WeekVector[]) {
  const means = FEATURE_KEYS.map((key) => avg(weeks.map((week) => week.features[key])));
  const deviations = FEATURE_KEYS.map((key, index) => {
    const variance = avg(weeks.map((week) => (week.features[key] - means[index]) ** 2));
    return Math.sqrt(variance) || 1;
  });

  for (const week of weeks) {
    week.scaled = FEATURE_KEYS.map((key, index) => (week.features[key] - means[index]) / deviations[index]);
  }
}

function assignClusters(weeks: WeekVector[]) {
  const k = Math.min(CLUSTER_COUNT, weeks.length);
  if (!k) return;

  let centroids = seedCentroids(weeks, k);
  for (let iteration = 0; iteration < 36; iteration++) {
    let changed = false;
    for (const week of weeks) {
      const next = nearestCentroid(week.scaled, centroids);
      if (next !== week.cluster) {
        week.cluster = next;
        changed = true;
      }
    }

    centroids = centroids.map((centroid, index) => {
      const assigned = weeks.filter((week) => week.cluster === index);
      if (!assigned.length) return centroid;
      return averageVector(assigned.map((week) => week.scaled));
    });

    if (!changed) break;
  }
}

function summarizeClusters(weeks: WeekVector[]): ClusterSummary[] {
  const originals = new Map<number, WeekVector[]>();
  for (const week of weeks) {
    const bucket = originals.get(week.cluster) ?? [];
    bucket.push(week);
    originals.set(week.cluster, bucket);
  }

  const summaries = [...originals.entries()]
    .map(([originalId, clusterWeeks]) => {
      const features = Object.fromEntries(
        FEATURE_KEYS.map((key) => [key, avg(clusterWeeks.map((week) => week.features[key]))]),
      ) as Record<AttractorFeatureKey, number>;
      const tokenCounts = new Map<string, number>();
      for (const week of clusterWeeks) {
        for (const [token, count] of week.tokenCounts) {
          tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + count);
        }
      }
      return {
        originalId,
        id: originalId,
        label: "",
        weeks: clusterWeeks,
        centroid: averageVector(clusterWeeks.map((week) => week.scaled)),
        features,
        messages: sum(clusterWeeks.map((week) => week.messages)),
        tokenCounts,
        tokenTotal: sumMap(tokenCounts),
      };
    })
    .sort((a, b) => b.weeks.length - a.weeks.length || b.messages - a.messages);

  const usedLabels = new Map<string, number>();
  summaries.forEach((summary, index) => {
    summary.id = index;
    summary.label = uniqueLabel(labelCandidates(summary.features), usedLabels);
    for (const week of summary.weeks) {
      week.cluster = index;
    }
  });

  currentClusters = summaries;
  return summaries;
}

function serializeWeeks(weeks: WeekVector[], clusters: ClusterSummary[]): AttractorWeek[] {
  const labels = new Map(clusters.map((cluster) => [cluster.id, cluster.label]));
  return weeks.map((week) => ({
    key: week.key,
    start_ts: week.startTs,
    end_ts: week.endTs,
    cluster_id: week.cluster,
    label: labels.get(week.cluster) ?? "Unknown",
    messages: week.messages,
    me_share: round(week.meShare),
    x: round(week.x),
    y: round(week.y),
    radius: round(week.radius),
    features: Object.fromEntries(FEATURE_KEYS.map((key) => [key, round(week.features[key])])) as Record<
      AttractorFeatureKey,
      number
    >,
  }));
}

function toAttractor(cluster: ClusterSummary): Attractor {
  const signatureWords = signatureForCluster(cluster);
  const representativeWeeks = cluster.weeks
    .map((week) => ({ week, distance: euclidean(week.scaled, cluster.centroid) }))
    .sort((a, b) => a.distance - b.distance || b.week.messages - a.week.messages)
    .slice(0, 3)
    .map(({ week }) => ({
      key: week.key,
      start_ts: week.startTs,
      end_ts: week.endTs,
      messages: week.messages,
      me_share: round(week.meShare),
    }));

  return {
    id: cluster.id,
    label: cluster.label,
    weeks: cluster.weeks.length,
    share: round(cluster.weeks.length / Math.max(totalWeeks(cluster), 1)),
    messages: cluster.messages,
    avg_messages: Math.round(cluster.messages / Math.max(cluster.weeks.length, 1)),
    avg_me_share: round(avg(cluster.weeks.map((week) => week.meShare))),
    features: topFeatures(cluster.features),
    signature_words: signatureWords,
    representative_weeks: representativeWeeks,
  };
}

function buildTransitions(weeks: WeekVector[], clusters: ClusterSummary[]): AttractorTransition[] {
  const clusterWeekCounts = new Map(clusters.map((cluster) => [cluster.id, cluster.weeks.length]));
  const transitionCounts = new Map<string, { from: number; to: number; count: number }>();
  const sourceTotals = new Map<number, number>();

  for (let index = 1; index < weeks.length; index++) {
    const from = weeks[index - 1].cluster;
    const to = weeks[index].cluster;
    const key = `${from}->${to}`;
    const current = transitionCounts.get(key) ?? { from, to, count: 0 };
    current.count++;
    transitionCounts.set(key, current);
    sourceTotals.set(from, (sourceTotals.get(from) ?? 0) + 1);
  }

  const labels = new Map(clusters.map((cluster) => [cluster.id, cluster.label]));
  return [...transitionCounts.values()]
    .map((transition) => {
      const rateValue = rate(transition.count, sourceTotals.get(transition.from) ?? 0);
      const expected = rate(clusterWeekCounts.get(transition.to) ?? 0, weeks.length);
      return {
        key: `${transition.from}-${transition.to}`,
        from_id: transition.from,
        to_id: transition.to,
        from_label: labels.get(transition.from) ?? "Unknown",
        to_label: labels.get(transition.to) ?? "Unknown",
        count: transition.count,
        rate: round(rateValue),
        lift: round(expected ? rateValue / expected : 0),
      };
    })
    .filter((transition) => transition.count >= 2)
    .sort((a, b) => b.lift * Math.log1p(b.count) - a.lift * Math.log1p(a.count))
    .slice(0, MAX_TRANSITIONS);
}

function buildEscapes(weeks: WeekVector[], clusters: ClusterSummary[]): AttractorEscape[] {
  const labels = new Map(clusters.map((cluster) => [cluster.id, cluster.label]));
  return weeks
    .slice(1)
    .map((week, index) => {
      const previous = weeks[index];
      const featureChanges = FEATURE_KEYS.map((key) => ({
        key,
        label: FEATURE_LABELS[key],
        delta: round(week.features[key] - previous.features[key]),
      }))
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
        .slice(0, 3);
      return {
        key: `${previous.key}-${week.key}`,
        week: week.key,
        start_ts: week.startTs,
        from_label: labels.get(previous.cluster) ?? "Unknown",
        to_label: labels.get(week.cluster) ?? "Unknown",
        distance: round(euclidean(previous.scaled, week.scaled)),
        messages: week.messages,
        feature_changes: featureChanges,
        clusterChanged: previous.cluster !== week.cluster,
      };
    })
    .filter((escape) => escape.clusterChanged || escape.distance >= 2.8)
    .sort((a, b) => b.distance - a.distance)
    .slice(0, MAX_ESCAPES)
    .map(({ clusterChanged, ...escape }) => escape);
}

function signatureForCluster(cluster: ClusterSummary) {
  const allClusters = currentClusters ?? [];
  if (!allClusters.length) return [];
  const totalTokens = sum(allClusters.map((item) => item.tokenTotal));
  const otherTotal = Math.max(totalTokens - cluster.tokenTotal, 1);
  const allCounts = new Map<string, number>();
  for (const item of allClusters) {
    for (const [token, count] of item.tokenCounts) {
      allCounts.set(token, (allCounts.get(token) ?? 0) + count);
    }
  }

  return [...cluster.tokenCounts.entries()]
    .map(([token, inCount]) => {
      const totalCount = allCounts.get(token) ?? inCount;
      const outCount = totalCount - inCount;
      const score = Math.log((inCount + 0.5) / (cluster.tokenTotal + 20)) - Math.log((outCount + 0.5) / (otherTotal + 20));
      return { token, inCount, score };
    })
    .filter((item) => item.inCount >= 3)
    .sort((a, b) => b.score - a.score || b.inCount - a.inCount)
    .slice(0, 6)
    .map((item) => item.token);
}

let currentClusters: ClusterSummary[] | null = null;

function topFeatures(features: Record<AttractorFeatureKey, number>): AttractorFeature[] {
  return FEATURE_KEYS.map((key) => ({
    key,
    label: FEATURE_LABELS[key],
    value: round(features[key]),
  }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);
}

function labelCandidates(features: Record<AttractorFeatureKey, number>) {
  const candidates: string[] = [];
  const topRates = RATE_FEATURES.slice().sort((a, b) => features[b] - features[a]);
  const primary = topRates[0];
  const objectPlay = features.object + features.play;

  if (primary === "strain" && features.repair >= 0.45) candidates.push("Storm and repair");
  if (primary === "warmth" && features.play >= 0.5) candidates.push("Playful warmth");
  if (primary === "warmth" && features.practical >= 0.5) candidates.push("Warm logistics");
  if (primary === "object" && features.play >= 0.5) candidates.push("Shared-object play");
  if (primary === "object" && features.practical >= 0.5) candidates.push("Practical objects");
  if (primary === "practical") candidates.push("Logistics engine");
  if (primary === "repair") candidates.push("Care landing");
  if (primary === "play") candidates.push(features.warmth >= 0.5 ? "Playful warmth" : "Play channel");
  if (primary === "warmth") candidates.push("Warm current");
  if (features.reciprocity >= 0.72 && features.intensity >= 0.55) candidates.push("Live braid");
  if (features.tempo >= 0.7) candidates.push("Fast exchange");
  if (features.object >= 0.55) candidates.push("Shared-object orbit");
  if (objectPlay >= 0.75) candidates.push("Object-play loop");
  if (features.intensity <= 0.28) candidates.push("Quiet maintenance");
  candidates.push("Steady orbit");
  return candidates;
}

function uniqueLabel(candidates: string[], usedLabels: Map<string, number>) {
  for (const label of candidates) {
    if (!usedLabels.has(label)) {
      usedLabels.set(label, 1);
      return label;
    }
  }
  const fallback = candidates[0] ?? "Steady orbit";
  const seen = usedLabels.get(fallback) ?? 0;
  usedLabels.set(fallback, seen + 1);
  return `${fallback} ${seen + 1}`;
}

function assignMapCoordinates(weeks: WeekVector[]) {
  const xValues = weeks.map((week) => week.features.warmth + week.features.repair * 0.7 + week.features.play * 0.35 - week.features.strain);
  const yValues = weeks.map((week) => week.features.intensity * 0.72 + week.features.tempo * 0.28);
  const maxMessages = Math.max(...weeks.map((week) => week.messages), 1);

  for (let index = 0; index < weeks.length; index++) {
    weeks[index].x = scaleToRange(xValues[index], xValues, 7, 93);
    weeks[index].y = 68 - scaleToRange(yValues[index], yValues, 8, 60);
    weeks[index].radius = 1.8 + Math.sqrt(weeks[index].messages / maxMessages) * 3.8;
  }
}

function downsampleWeeks(weeks: AttractorWeek[]) {
  if (weeks.length <= MAX_PATH_WEEKS) return weeks;
  const step = weeks.length / MAX_PATH_WEEKS;
  const selected: AttractorWeek[] = [];
  for (let index = 0; index < MAX_PATH_WEEKS; index++) {
    selected.push(weeks[Math.floor(index * step)]);
  }
  const last = weeks[weeks.length - 1];
  if (selected[selected.length - 1]?.key !== last.key) selected.push(last);
  return selected;
}

function seedCentroids(weeks: WeekVector[], k: number) {
  const first = weeks.reduce((best, week, index) => {
    const score = week.features.intensity + week.features.tempo + week.features.warmth - week.features.strain * 0.5;
    return score > best.score ? { index, score } : best;
  }, { index: 0, score: -Infinity }).index;
  const seedIndexes = [first];

  while (seedIndexes.length < k) {
    let nextIndex = 0;
    let nextDistance = -Infinity;
    for (let index = 0; index < weeks.length; index++) {
      if (seedIndexes.includes(index)) continue;
      const distance = Math.min(...seedIndexes.map((seed) => euclidean(weeks[index].scaled, weeks[seed].scaled)));
      if (distance > nextDistance) {
        nextDistance = distance;
        nextIndex = index;
      }
    }
    seedIndexes.push(nextIndex);
  }

  return seedIndexes.map((index) => weeks[index].scaled.slice());
}

function nearestCentroid(vector: number[], centroids: number[][]) {
  let best = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < centroids.length; index++) {
    const distance = euclidean(vector, centroids[index]);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return best;
}

function averageVector(vectors: number[][]) {
  if (!vectors.length) return [];
  return vectors[0].map((_, index) => avg(vectors.map((vector) => vector[index])));
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

function isSignatureToken(token: string) {
  return token.length >= 4 && token.length <= 18 && !STOPWORDS.has(token) && !/[0-9]/.test(token);
}

function lexicon(words: string[], phrases: string[]) {
  return { words: new Set(words), phrases };
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

function totalWeeks(cluster: ClusterSummary) {
  return currentClusters ? sum(currentClusters.map((item) => item.weeks.length)) : cluster.weeks.length;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function sumMap(map: Map<string, number>) {
  let total = 0;
  for (const value of map.values()) total += value;
  return total;
}

function avg(values: number[]) {
  if (!values.length) return 0;
  return sum(values) / values.length;
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
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)))];
}

function euclidean(left: number[], right: number[]) {
  return Math.sqrt(sum(left.map((value, index) => (value - right[index]) ** 2)));
}

function scaleToRange(value: number, values: number[], min: number, max: number) {
  const low = Math.min(...values);
  const high = Math.max(...values);
  if (Math.abs(high - low) < 1e-9) return (min + max) / 2;
  return min + ((value - low) / (high - low)) * (max - min);
}

function rate(part: number, whole: number) {
  return whole ? part / whole : 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}
