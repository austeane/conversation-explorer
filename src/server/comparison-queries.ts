import { createServerFn } from "@tanstack/react-start";
import { db, withDbCache } from "~/lib/server-db";

export type ComparisonPerson = {
  id: string;
  label: string;
  is_them: number;
  person_rank: number;
  chat_count: number;
  messages_total: number;
  me_messages: number;
  them_messages: number;
  me_text_messages: number;
  them_text_messages: number;
  first_ts: number | null;
  last_ts: number | null;
  me_words: number;
  me_chars: number;
  them_words: number;
  them_chars: number;
  me_questions: number;
  me_exclaims: number;
  me_emoji: number;
  me_attachments: number;
  me_tapbacks: number;
  me_links: number;
  me_replies: number;
  median_reply_me_sec: number | null;
  median_reply_them_sec: number | null;
  me_share: number;
  words_per_me_text: number;
  chars_per_me_text: number;
  question_rate: number;
  exclaim_rate: number;
  emoji_per_me_text: number;
  attachment_rate: number;
  tapback_rate: number;
  link_rate: number;
  reply_rate: number;
};

export type MetricComparison = {
  key: string;
  label: string;
  value: number;
  other_median: number;
  p25: number;
  p75: number;
  percentile: number;
  standing: number;
  z_score: number;
  rank_high: number;
  rank_low: number;
  cohort_count: number;
  direction_label: string;
  unit: "percent" | "number" | "seconds";
  lower_is_more: boolean;
};

export type ComparisonNeighborDifference = {
  key: string;
  label: string;
  unit: MetricComparison["unit"];
  them_value: number;
  neighbor_value: number;
  delta_z: number;
};

export type ComparisonNeighbor = {
  person: ComparisonPerson;
  similarity: number;
  distance: number;
  shared_traits: string[];
  differences: ComparisonNeighborDifference[];
};

export type ComparisonWord = {
  word: string;
  count_them: number;
  count_others: number;
  log_odds_z: number;
  combined_count: number;
  side: "them" | "others";
};

export type ComparisonOverview = {
  meta: Record<string, string>;
  them: ComparisonPerson;
  people: ComparisonPerson[];
  metrics: MetricComparison[];
  extremes: MetricComparison[];
  neighbors: ComparisonNeighbor[];
  words: {
    them: ComparisonWord[];
    others: ComparisonWord[];
  };
};

type MetricDef = {
  key: keyof ComparisonPerson;
  label: string;
  unit: MetricComparison["unit"];
  lowerIsMore?: boolean;
  higherLabel: string;
  lowerLabel: string;
  transform?: (value: number) => number;
};

const METRICS: MetricDef[] = [
  {
    key: "me_share",
    label: "Me share of messages",
    unit: "percent",
    higherLabel: "more Me-weighted",
    lowerLabel: "more listening-weighted",
  },
  {
    key: "words_per_me_text",
    label: "Words per Me text",
    unit: "number",
    higherLabel: "longer Me texts",
    lowerLabel: "shorter Me texts",
  },
  {
    key: "chars_per_me_text",
    label: "Characters per Me text",
    unit: "number",
    higherLabel: "denser messages",
    lowerLabel: "lighter messages",
  },
  {
    key: "question_rate",
    label: "Question rate",
    unit: "percent",
    higherLabel: "more question-led",
    lowerLabel: "less question-led",
  },
  {
    key: "exclaim_rate",
    label: "Exclamation rate",
    unit: "percent",
    higherLabel: "more emphatic",
    lowerLabel: "less emphatic",
  },
  {
    key: "emoji_per_me_text",
    label: "Emoji per Me text",
    unit: "number",
    higherLabel: "more emoji-rich",
    lowerLabel: "less emoji-rich",
  },
  {
    key: "attachment_rate",
    label: "Attachment rate",
    unit: "percent",
    higherLabel: "more object-heavy",
    lowerLabel: "less object-heavy",
  },
  {
    key: "tapback_rate",
    label: "Tapback rate",
    unit: "percent",
    higherLabel: "more reaction-heavy",
    lowerLabel: "less reaction-heavy",
  },
  {
    key: "link_rate",
    label: "Link rate",
    unit: "percent",
    higherLabel: "more link-heavy",
    lowerLabel: "less link-heavy",
  },
  {
    key: "reply_rate",
    label: "Reply-thread rate",
    unit: "percent",
    higherLabel: "more reply-threaded",
    lowerLabel: "less reply-threaded",
  },
  {
    key: "median_reply_me_sec",
    label: "Median Me reply time",
    unit: "seconds",
    lowerIsMore: true,
    higherLabel: "slower Me replies",
    lowerLabel: "faster Me replies",
    transform: Math.log1p,
  },
];

export const getComparisonOverview = createServerFn({ method: "GET" }).handler(
  async (): Promise<ComparisonOverview> => {
    return withDbCache("comparisons", () => {
      const metaRows = db().prepare(`SELECT k, v FROM cmp_meta`).all() as Array<{
        k: string;
        v: string;
      }>;
      const rawPeople = db()
        .prepare(`SELECT * FROM cmp_people ORDER BY is_them DESC, messages_total DESC`)
        .all() as Array<Omit<ComparisonPerson, "me_share" | "words_per_me_text" | "chars_per_me_text" | "question_rate" | "exclaim_rate" | "emoji_per_me_text" | "attachment_rate" | "tapback_rate" | "link_rate" | "reply_rate">>;

      const people = rawPeople.map(addRates);
      const them = people.find((p) => p.is_them === 1);
      if (!them) {
        throw new Error("Comparison tables are missing the Them profile. Run pnpm extract:comparisons.");
      }

      const wordsThem = db()
        .prepare(
          `
          SELECT * FROM cmp_distinctive_words
          WHERE side = 'them'
          ORDER BY log_odds_z DESC
          LIMIT 40
          `,
        )
        .all() as ComparisonWord[];
      const wordsOthers = db()
        .prepare(
          `
          SELECT * FROM cmp_distinctive_words
          WHERE side = 'others'
          ORDER BY log_odds_z ASC
          LIMIT 40
          `,
        )
        .all() as ComparisonWord[];

      const metrics = buildMetricComparisons(them, people);

      return {
        meta: Object.fromEntries(metaRows.map((r) => [r.k, r.v])),
        them,
        people,
        metrics,
        extremes: metrics.slice().sort((a, b) => Math.abs(b.z_score) - Math.abs(a.z_score)).slice(0, 6),
        neighbors: buildNeighbors(them, people),
        words: { them: wordsThem, others: wordsOthers },
      };
    });
  },
);

function addRates(
  p: Omit<ComparisonPerson, "me_share" | "words_per_me_text" | "chars_per_me_text" | "question_rate" | "exclaim_rate" | "emoji_per_me_text" | "attachment_rate" | "tapback_rate" | "link_rate" | "reply_rate">,
): ComparisonPerson {
  return {
    ...p,
    me_share: div(p.me_messages, p.messages_total),
    words_per_me_text: div(p.me_words, p.me_text_messages),
    chars_per_me_text: div(p.me_chars, p.me_text_messages),
    question_rate: div(p.me_questions, p.me_text_messages),
    exclaim_rate: div(p.me_exclaims, p.me_text_messages),
    emoji_per_me_text: div(p.me_emoji, p.me_text_messages),
    attachment_rate: div(p.me_attachments, p.me_messages),
    tapback_rate: div(p.me_tapbacks, p.me_messages),
    link_rate: div(p.me_links, p.me_text_messages),
    reply_rate: div(p.me_replies, p.me_messages),
  };
}

function buildMetricComparisons(them: ComparisonPerson, people: ComparisonPerson[]): MetricComparison[] {
  const others = people.filter((p) => p.is_them === 0);
  return METRICS.flatMap((def) => {
    const rawValue = them[def.key];
    if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) return [];
    const values = others
      .map((p) => p[def.key])
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
      .sort((a, b) => a - b);
    if (values.length === 0) return [];
    const allValues = people
      .map((p) => p[def.key])
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    const zScore = zScoreFor(rawValue, values, def.transform);
    const percentile = percentileRank(values, rawValue);
    return [
      {
        key: String(def.key),
        label: def.label,
        value: rawValue,
        other_median: quantile(values, 0.5),
        p25: quantile(values, 0.25),
        p75: quantile(values, 0.75),
        percentile,
        standing: def.lowerIsMore ? 100 - percentile : percentile,
        z_score: round(zScore),
        rank_high: rank(rawValue, allValues, "high"),
        rank_low: rank(rawValue, allValues, "low"),
        cohort_count: allValues.length,
        direction_label: percentile >= 50 ? def.higherLabel : def.lowerLabel,
        unit: def.unit,
        lower_is_more: def.lowerIsMore ?? false,
      },
    ];
  });
}

function buildNeighbors(them: ComparisonPerson, people: ComparisonPerson[]): ComparisonNeighbor[] {
  const others = people.filter((p) => p.is_them === 0);
  const stats = new Map(
    METRICS.map((def) => {
      const values = people
        .map((p) => p[def.key])
        .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
        .map((value) => (def.transform ? def.transform(value) : value))
        .sort((a, b) => a - b);
      return [String(def.key), { def, median: quantile(values, 0.5), scale: robustScale(values) }];
    }),
  );
  const themVector = profileVector(them, stats);

  return others
    .map((person) => {
      const personVector = profileVector(person, stats);
      const distance = vectorDistance(themVector, personVector);
      return {
        person,
        similarity: Math.max(0, Math.min(100, Math.round(Math.exp(-distance / 2.35) * 100))),
        distance: round(distance),
        shared_traits: sharedTraits(them, person, stats),
        differences: neighborDifferences(them, person, stats),
      };
    })
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 6);
}

function profileVector(person: ComparisonPerson, stats: Map<string, { def: MetricDef; median: number; scale: number }>): number[] {
  return [...stats.values()].map(({ def, median, scale }) => {
    const raw = person[def.key];
    if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
    const value = def.transform ? def.transform(raw) : raw;
    return (value - median) / scale;
  });
}

function sharedTraits(
  them: ComparisonPerson,
  person: ComparisonPerson,
  stats: Map<string, { def: MetricDef; median: number; scale: number }>,
): string[] {
  return [...stats.values()]
    .map(({ def, median, scale }) => {
      const themValue = transformedValue(them, def);
      const personValue = transformedValue(person, def);
      const themZ = (themValue - median) / scale;
      const personZ = (personValue - median) / scale;
      if (Math.sign(themZ) !== Math.sign(personZ) || Math.abs(themZ) < 0.35 || Math.abs(personZ) < 0.2) return null;
      return themZ >= 0 ? def.higherLabel : def.lowerLabel;
    })
    .filter((trait): trait is string => Boolean(trait))
    .slice(0, 4);
}

function neighborDifferences(
  them: ComparisonPerson,
  person: ComparisonPerson,
  stats: Map<string, { def: MetricDef; median: number; scale: number }>,
): ComparisonNeighborDifference[] {
  return [...stats.values()]
    .map(({ def, scale }) => {
      const themRaw = them[def.key];
      const personRaw = person[def.key];
      if (typeof themRaw !== "number" || typeof personRaw !== "number") return null;
      const deltaZ = (transformedValue(them, def) - transformedValue(person, def)) / scale;
      return {
        key: String(def.key),
        label: def.label,
        unit: def.unit,
        them_value: themRaw,
        neighbor_value: personRaw,
        delta_z: round(deltaZ),
      };
    })
    .filter((diff): diff is ComparisonNeighborDifference => Boolean(diff))
    .sort((a, b) => Math.abs(b.delta_z) - Math.abs(a.delta_z))
    .slice(0, 3);
}

function transformedValue(person: ComparisonPerson, def: MetricDef): number {
  const raw = person[def.key];
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  return def.transform ? def.transform(raw) : raw;
}

function percentileRank(sortedValues: number[], value: number): number {
  const n = sortedValues.length;
  const belowOrEqual = sortedValues.filter((v) => v <= value).length;
  return (belowOrEqual / n) * 100;
}

function quantile(sortedValues: number[], q: number): number {
  if (sortedValues.length === 0) return 0;
  const idx = Math.min(sortedValues.length - 1, Math.max(0, Math.round((sortedValues.length - 1) * q)));
  return sortedValues[idx];
}

function zScoreFor(value: number, cohortValues: number[], transform: ((value: number) => number) | undefined): number {
  const values = cohortValues.map((v) => (transform ? transform(v) : v)).sort((a, b) => a - b);
  const transformed = transform ? transform(value) : value;
  const center = quantile(values, 0.5);
  return (transformed - center) / robustScale(values);
}

function robustScale(sortedValues: number[]): number {
  if (sortedValues.length < 2) return 1;
  const iqr = quantile(sortedValues, 0.75) - quantile(sortedValues, 0.25);
  if (iqr > 0) return iqr / 1.349;
  const mean = sortedValues.reduce((total, value) => total + value, 0) / sortedValues.length;
  const variance = sortedValues.reduce((total, value) => total + (value - mean) ** 2, 0) / sortedValues.length;
  return Math.sqrt(variance) || 1;
}

function rank(value: number, values: number[], direction: "high" | "low"): number {
  if (direction === "high") return 1 + values.filter((v) => v > value).length;
  return 1 + values.filter((v) => v < value).length;
}

function div(n: number, d: number): number {
  return d > 0 ? n / d : 0;
}

function vectorDistance(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  const squared = left.reduce((total, value, index) => total + (value - right[index]) ** 2, 0);
  return Math.sqrt(squared / left.length);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
