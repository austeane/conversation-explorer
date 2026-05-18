import { createServerFn } from "@tanstack/react-start";
import { realMessageWhere } from "~/lib/conversation/filters";
import { addMessageScopeFilters, messageScopeInput, messageScopeWhere, type MessageScope } from "~/lib/conversation/scope";
import { bucket } from "~/lib/conversation/time";
import { db, withDbCache } from "~/lib/server-db";
import { resolveMessageScope } from "~/server/scope";

const REAL_MESSAGE_WHERE = realMessageWhere("browsable_message", "m");
const ROLLING_DAYS = 30;
const TOP_DAYS = 24;
const TOP_QUIET_DAYS = 8;
const OUTLIER_THRESHOLD = 5;
const MIN_RANKED_MESSAGES = 8;
const MIN_RANKED_WORDS = 500;
const RATE_PRIOR_MESSAGES = 30;

export type Sender = "Me" | "Them";

export type OutlierOverview = {
  generated_at: string;
  active_days: number;
  ranked_days: number;
  messages: number;
  outlier_days: number;
  threshold: number;
  min_ranked_messages: number;
  top_day: string;
  top_score: number;
  strongest_signal: string;
  quiet_days: number;
};

export type OutlierFeature = {
  key: string;
  label: string;
  raw: number;
  z: number;
  contribution: number;
};

export type OutlierExample = {
  id: number;
  ts: number;
  sender: Sender;
  text: string;
  kinds: string[];
};

export type OutlierCategory = {
  category: string;
  n: number;
  share: number;
};

export type OutlierDay = {
  ymd: string;
  ym: string;
  start_ts: number;
  end_ts: number;
  messages: number;
  words: number;
  attachments: number;
  me_share: number;
  score: number;
  features: OutlierFeature[];
  categories: OutlierCategory[];
  examples: OutlierExample[];
};

export type QuietDay = {
  ymd: string;
  ym: string;
  start_ts: number;
  end_ts: number;
  messages: number;
  words: number;
  me_share: number;
  quiet_score: number;
  expected_messages: number;
  categories: OutlierCategory[];
  examples: OutlierExample[];
};

export type OutlierMonth = {
  ym: string;
  days: number;
  outlier_days: number;
  max_score: number;
  top_day: string;
};

export type FeatureLeader = {
  feature_key: string;
  feature: string;
  day: OutlierDay;
};

export type OutlierResult = {
  overview: OutlierOverview;
  months: OutlierMonth[];
  days: OutlierDay[];
  quiet_days: QuietDay[];
  feature_leaders: FeatureLeader[];
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

type SegmentRow = {
  ymd: string;
  category: string | null;
  n_msgs: number;
  umap_x: number | null;
  umap_y: number | null;
};
type RawSegmentRow = Omit<SegmentRow, "ymd"> & { start_ts: number };

type LexiconKind = "warmth" | "strain" | "repair" | "gratitude" | "care" | "humor";

type DayMessage = {
  id: number;
  ts: number;
  sender: Sender;
  text: string;
  kinds: LexiconKind[];
};

type DayAccumulator = {
  ymd: string;
  ym: string;
  startTs: number;
  endTs: number;
  messages: number;
  words: number;
  me: number;
  them: number;
  attachments: number;
  warmth: number;
  strain: number;
  repair: number;
  gratitude: number;
  care: number;
  humor: number;
  categories: Map<string, number>;
  segments: number;
  sumX: number;
  sumY: number;
  umapCount: number;
  semanticNovelty: number;
  dayMessages: DayMessage[];
};

type FeatureSpec = {
  key: string;
  label: string;
  weight: number;
  value: (day: DayAccumulator, context: FeatureContext) => number;
};

type FeatureContext = {
  affectRate: number;
  strainRate: number;
  repairRate: number;
  meShare: number;
};

type FeatureStat = {
  median: number;
  scale: number;
};

const LEXICONS: Record<LexiconKind, RegExp> = {
  warmth: /\b(love|miss|proud|sweet|cute|beautiful|handsome|excited|cuddle|snuggle|kiss|sweetheart|darling|adorable|lovely)\b/i,
  strain: /\b(sad|anxious|anxiety|worried|worry|scared|afraid|hurt|cry|crying|upset|stress|stressed|hard|tired|exhausted|lonely|overwhelmed|frustrated)\b/i,
  repair: /\b(sorry|apologize|apologise|forgive|my bad|misunderstood|didn't mean|didnt mean|should have|i understand|that makes sense)\b/i,
  gratitude: /\b(thank you|thanks|appreciate|grateful|thankful|means a lot|bless)\b/i,
  care: /\b(hope you|are you okay|you okay|you ok|feel better|sleep well|rest|eat|safe|take care|checking in|how are you|how was your day)\b/i,
  humor: /\b(lol|lmao|haha|hehe|funny|silly|wild|ridiculous|joke|hilarious)\b/i,
};

const FEATURES: FeatureSpec[] = [
  { key: "volume", label: "volume surge", weight: 1.1, value: (d) => Math.log1p(d.messages) },
  { key: "words", label: "word flood", weight: 0.9, value: (d) => Math.log1p(d.words) },
  { key: "tempo", label: "tempo compression", weight: 1, value: (d) => d.messages / Math.max(1, (d.endTs - d.startTs) / 3600 + 1) },
  {
    key: "affect",
    label: "affect density",
    weight: 1,
    value: (d, c) => smoothedRate(d.warmth + d.strain + d.repair + d.gratitude + d.care + d.humor, d.messages, c.affectRate),
  },
  { key: "strain", label: "strain signal", weight: 1.15, value: (d, c) => smoothedRate(d.strain, d.messages, c.strainRate) },
  { key: "repair", label: "repair signal", weight: 0.95, value: (d, c) => smoothedRate(d.repair, d.messages, c.repairRate) },
  { key: "attachments", label: "attachment pulse", weight: 0.85, value: (d) => Math.log1p(d.attachments) },
  { key: "semantic", label: "semantic departure", weight: 1.2, value: (d) => d.semanticNovelty * supportConfidence(d.messages) },
  { key: "entropy", label: "topic spread", weight: 0.75, value: (d) => categoryEntropy(d.categories) * supportConfidence(d.messages) },
  {
    key: "sender",
    label: "sender skew",
    weight: 0.7,
    value: (d, c) => Math.abs(smoothedRate(d.me, d.messages, c.meShare) - c.meShare) * 2,
  },
];

export const getOutliers = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => messageScopeInput.parse(d ?? {}))
  .handler(async ({ data }): Promise<OutlierResult> => {
    const resolved = resolveMessageScope(data);
    return withDbCache(`outliers:${JSON.stringify(resolved)}`, () => {
      const generated = db().prepare("SELECT v FROM meta WHERE k = 'generated_at'").get() as { v: string } | undefined;
      const messageScope = messageScopeWhere(resolved, "m", [REAL_MESSAGE_WHERE]);
      const messages = db()
        .prepare(
          `
          SELECT m.id, m.ts, m.ymd, m.ym, m.is_from_me, m.word_count, m.has_attachment, m.text
          FROM messages m
          ${messageScope.sql}
          ORDER BY m.ts ASC, m.id ASC
        `,
        )
        .all(...messageScope.args) as MessageRow[];

      const segmentScope = scopedSegmentWhere(resolved);
      const rawSegments = db()
        .prepare(
          `
          SELECT s.start_ts,
                 COALESCE(c.category, 'unclassified') AS category,
                 s.n_msgs,
                 s.umap_x,
                 s.umap_y
          FROM seg_segments s
          LEFT JOIN seg_segment_categories c ON c.segment_id = s.id
          ${segmentScope.sql}
          ORDER BY s.start_ts ASC, s.id ASC
        `,
        )
        .all(...segmentScope.args) as RawSegmentRow[];
      const segments: SegmentRow[] = rawSegments.map(({ start_ts, ...row }) => ({
        ...row,
        ymd: bucket(start_ts, "ymd"),
      }));

      const days = buildDays(messages, segments);
      computeSemanticNovelty(days);
      const scoredDays = scoreDays(days);
      const rankableDays = scoredDays.filter(isRankableDay);
      const rankedDays = [...rankableDays].sort((a, b) => b.score - a.score);
      const topDays = rankedDays.slice(0, TOP_DAYS);
      const quietDays = buildQuietDays(days);
      const featureLeaders = buildFeatureLeaders(rankableDays);
      const months = buildMonths(rankableDays);
      const topDay = topDays[0];

      return {
        overview: {
          generated_at: generated?.v ?? "unknown",
          active_days: scoredDays.length,
          ranked_days: rankableDays.length,
          messages: messages.length,
          outlier_days: rankableDays.filter((day) => day.score >= OUTLIER_THRESHOLD).length,
          threshold: OUTLIER_THRESHOLD,
          min_ranked_messages: MIN_RANKED_MESSAGES,
          top_day: topDay?.ymd ?? "n/a",
          top_score: topDay?.score ?? 0,
          strongest_signal: topDay?.features[0]?.label ?? "n/a",
          quiet_days: quietDays.length,
        },
        months,
        days: topDays,
        quiet_days: quietDays,
        feature_leaders: featureLeaders,
      };
    });
  });

function scopedSegmentWhere(scope: MessageScope) {
  if (!hasActiveScope(scope)) return { sql: "", args: [] as Array<string | number> };
  const where = [
    "sms_scope.segment_id = s.id",
    "(m_scope.associated_message_type IS NULL OR m_scope.associated_message_type < 2000)",
  ];
  const args: Array<string | number> = [];
  addMessageScopeFilters(where, args, scope, "m_scope");
  return {
    sql: `
      WHERE EXISTS (
        SELECT 1
        FROM seg_msg_segment sms_scope
        JOIN messages m_scope ON m_scope.id = sms_scope.msg_id
        WHERE ${where.join(" AND ")}
      )
    `,
    args,
  };
}

function hasActiveScope(scope: MessageScope) {
  return Boolean(scope.from || scope.to || (scope.sender && scope.sender !== "both"));
}

function buildDays(messages: MessageRow[], segments: SegmentRow[]) {
  const days = new Map<string, DayAccumulator>();
  for (const row of messages) {
    const day = daySlot(days, row.ymd, row.ym, row.ts);
    day.startTs = Math.min(day.startTs, row.ts);
    day.endTs = Math.max(day.endTs, row.ts);
    day.messages += 1;
    day.words += row.word_count;
    day.attachments += row.has_attachment;
    if (row.is_from_me === 1) day.me += 1;
    else day.them += 1;
    const text = cleanText(row.text);
    const kinds = classify(text);
    for (const kind of kinds) day[kind] += 1;
    if (text && isUsefulText(text)) {
      day.dayMessages.push({
        id: row.id,
        ts: row.ts,
        sender: row.is_from_me === 1 ? "Me" : "Them",
        text,
        kinds,
      });
    }
  }

  for (const row of segments) {
    const day = days.get(row.ymd);
    if (!day) continue;
    const category = row.category ?? "unclassified";
    day.categories.set(category, (day.categories.get(category) ?? 0) + row.n_msgs);
    day.segments += 1;
    if (row.umap_x != null && row.umap_y != null) {
      day.sumX += row.umap_x;
      day.sumY += row.umap_y;
      day.umapCount += 1;
    }
  }

  return [...days.values()].sort((a, b) => a.ymd.localeCompare(b.ymd));
}

function computeSemanticNovelty(days: DayAccumulator[]) {
  const context: Array<{ x: number; y: number }> = [];
  for (const day of days) {
    if (day.umapCount === 0) {
      day.semanticNovelty = 0;
      continue;
    }
    const x = day.sumX / day.umapCount;
    const y = day.sumY / day.umapCount;
    if (context.length === 0) {
      day.semanticNovelty = 0;
    } else {
      const usable = context.slice(-ROLLING_DAYS);
      const meanX = usable.reduce((sum, item) => sum + item.x, 0) / usable.length;
      const meanY = usable.reduce((sum, item) => sum + item.y, 0) / usable.length;
      day.semanticNovelty = distance(x, y, meanX, meanY);
    }
    context.push({ x, y });
  }
}

function scoreDays(days: DayAccumulator[]): OutlierDay[] {
  const context = buildFeatureContext(days);
  const stats = new Map<string, FeatureStat>();
  for (const feature of FEATURES) {
    const values = days.map((day) => feature.value(day, context));
    stats.set(feature.key, robustStats(values));
  }

  return days.map((day) => {
    const features = FEATURES.map((feature) => {
      const raw = feature.value(day, context);
      const stat = stats.get(feature.key) ?? { median: 0, scale: 1 };
      const z = Math.max(0, (raw - stat.median) / stat.scale);
      return {
        key: feature.key,
        label: feature.label,
        raw: round(raw),
        z: round(z),
        contribution: round(z * feature.weight),
      };
    }).sort((a, b) => b.contribution - a.contribution);
    const score = Math.sqrt(features.reduce((sum, feature) => sum + feature.contribution ** 2, 0));

    return {
      ymd: day.ymd,
      ym: day.ym,
      start_ts: day.startTs,
      end_ts: day.endTs,
      messages: day.messages,
      words: day.words,
      attachments: day.attachments,
      me_share: round(rate(day.me, day.messages)),
      score: round(score),
      features: features.filter((feature) => feature.z >= 0.5).slice(0, 5),
      categories: topCategories(day),
      examples: examplesForDay(day),
    };
  });
}

function buildFeatureContext(days: DayAccumulator[]): FeatureContext {
  const totals = days.reduce(
    (acc, day) => {
      acc.messages += day.messages;
      acc.affect += day.warmth + day.strain + day.repair + day.gratitude + day.care + day.humor;
      acc.strain += day.strain;
      acc.repair += day.repair;
      acc.me += day.me;
      return acc;
    },
    { messages: 0, affect: 0, strain: 0, repair: 0, me: 0 },
  );
  return {
    affectRate: rate(totals.affect, totals.messages),
    strainRate: rate(totals.strain, totals.messages),
    repairRate: rate(totals.repair, totals.messages),
    meShare: rate(totals.me, totals.messages),
  };
}

function buildFeatureLeaders(days: OutlierDay[]): FeatureLeader[] {
  return FEATURES.map((feature) => {
    const day = [...days].sort((a, b) => featureContribution(b, feature.key) - featureContribution(a, feature.key))[0];
    return {
      feature_key: feature.key,
      feature: feature.label,
      day,
      contribution: day ? featureContribution(day, feature.key) : 0,
    };
  })
    .filter((leader) => leader.day && leader.contribution > 0)
    .map(({ feature_key, feature, day }) => ({ feature_key, feature, day }));
}

function buildQuietDays(days: DayAccumulator[]): QuietDay[] {
  if (!days.length) return [];
  const messageStats = lowerTailStats(days.map((day) => day.messages));
  const wordStats = lowerTailStats(days.map((day) => day.words));
  const quiet = days
    .map((day) => {
      const messageDeficit = Math.max(0, (messageStats.median - day.messages) / messageStats.scale);
      const wordDeficit = Math.max(0, (wordStats.median - day.words) / wordStats.scale);
      const quietScore = round(messageDeficit * 0.8 + wordDeficit * 0.2);
      return { day, quietScore };
    })
    .filter(({ day, quietScore }) => quietScore >= 1 && day.messages <= messageStats.lowerQuartile && day.words < wordStats.median && day.dayMessages.length > 0)
    .sort((a, b) => b.quietScore - a.quietScore || b.day.dayMessages.length - a.day.dayMessages.length || a.day.ymd.localeCompare(b.day.ymd))
    .slice(0, TOP_QUIET_DAYS);

  return quiet.map(({ day, quietScore }) => ({
    ymd: day.ymd,
    ym: day.ym,
    start_ts: day.startTs,
    end_ts: day.endTs,
    messages: day.messages,
    words: day.words,
    me_share: round(rate(day.me, day.messages)),
    quiet_score: quietScore,
    expected_messages: round(messageStats.median),
    categories: topCategories(day),
    examples: examplesForDay(day),
  }));
}

function lowerTailStats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const medianValue = median(sorted) ?? 0;
  const lowerQuartile = quantileSorted(sorted, 0.25);
  return {
    median: medianValue,
    lowerQuartile,
    scale: Math.max(1, medianValue - lowerQuartile),
  };
}

function buildMonths(days: OutlierDay[]): OutlierMonth[] {
  const months = new Map<string, OutlierMonth>();
  for (const day of days) {
    const existing = months.get(day.ym) ?? {
      ym: day.ym,
      days: 0,
      outlier_days: 0,
      max_score: 0,
      top_day: day.ymd,
    };
    existing.days += 1;
    if (day.score >= OUTLIER_THRESHOLD) existing.outlier_days += 1;
    if (day.score > existing.max_score) {
      existing.max_score = day.score;
      existing.top_day = day.ymd;
    }
    months.set(day.ym, existing);
  }
  return [...months.values()].sort((a, b) => a.ym.localeCompare(b.ym));
}

function isRankableDay(day: OutlierDay) {
  return day.messages >= MIN_RANKED_MESSAGES || day.words >= MIN_RANKED_WORDS;
}

function featureContribution(day: OutlierDay, key: string) {
  return day.features.find((feature) => feature.key === key)?.contribution ?? 0;
}

function daySlot(days: Map<string, DayAccumulator>, ymd: string, ym: string, ts: number) {
  const existing = days.get(ymd);
  if (existing) return existing;
  const created: DayAccumulator = {
    ymd,
    ym,
    startTs: ts,
    endTs: ts,
    messages: 0,
    words: 0,
    me: 0,
    them: 0,
    attachments: 0,
    warmth: 0,
    strain: 0,
    repair: 0,
    gratitude: 0,
    care: 0,
    humor: 0,
    categories: new Map<string, number>(),
    segments: 0,
    sumX: 0,
    sumY: 0,
    umapCount: 0,
    semanticNovelty: 0,
    dayMessages: [],
  };
  days.set(ymd, created);
  return created;
}

function topCategories(day: DayAccumulator): OutlierCategory[] {
  const total = [...day.categories.values()].reduce((sum, value) => sum + value, 0);
  return [...day.categories.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([category, n]) => ({
      category,
      n,
      share: round(rate(n, total)),
    }));
}

function examplesForDay(day: DayAccumulator): OutlierExample[] {
  const affective = day.dayMessages
    .filter((message) => message.kinds.length > 0)
    .sort((a, b) => b.kinds.length - a.kinds.length || b.text.length - a.text.length)
    .slice(0, 3);
  const fallback = day.dayMessages
    .filter((message) => !affective.some((item) => item.id === message.id))
    .slice(0, 3 - affective.length);
  return [...affective, ...fallback]
    .sort((a, b) => a.ts - b.ts)
    .map((message) => ({
      id: message.id,
      ts: message.ts,
      sender: message.sender,
      text: truncate(message.text, 220),
      kinds: message.kinds,
    }));
}

function robustStats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const med = median(values) ?? 0;
  const deviations = values.map((value) => Math.abs(value - med));
  const mad = median(deviations) || 0.000001;
  const iqr = quantileSorted(sorted, 0.75) - quantileSorted(sorted, 0.25);
  const p90Spread = Math.abs(quantileSorted(sorted, 0.9) - med);
  const p95Spread = Math.abs(quantileSorted(sorted, 0.95) - med);
  const scale = Math.max(1.4826 * mad, iqr / 1.349, p90Spread / 1.2816, p95Spread / 1.6449, 0.000001);
  return { median: med, scale };
}

function categoryEntropy(categories: Map<string, number>) {
  const total = [...categories.values()].reduce((sum, value) => sum + value, 0);
  if (!total || categories.size <= 1) return 0;
  let entropy = 0;
  for (const n of categories.values()) {
    const p = n / total;
    entropy -= p * Math.log(p);
  }
  return entropy / Math.log(categories.size);
}

function classify(text: string): LexiconKind[] {
  return (Object.keys(LEXICONS) as LexiconKind[]).filter((kind) => LEXICONS[kind].test(text));
}

function cleanText(text: string | null) {
  return (text ?? "")
    .replace(/\s+/g, " ")
    .replace(/\uFFFC/g, "")
    .trim();
}

function isUsefulText(text: string) {
  return text.length > 1 && !/^https?:\/\/\S+$/i.test(text);
}

function truncate(text: string, maxChars: number) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1).trim()}...`;
}

function rate(part: number, whole: number) {
  return whole ? part / whole : 0;
}

function smoothedRate(part: number, whole: number, baseline: number) {
  return (part + baseline * RATE_PRIOR_MESSAGES) / (whole + RATE_PRIOR_MESSAGES);
}

function supportConfidence(messages: number) {
  return messages / (messages + RATE_PRIOR_MESSAGES);
}

function distance(ax: number, ay: number, bx: number, by: number) {
  return Math.hypot(ax - bx, ay - by);
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function quantileSorted(sorted: number[], q: number) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] == null ? sorted[base] : sorted[base] + rest * (sorted[base + 1] - sorted[base]);
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}
