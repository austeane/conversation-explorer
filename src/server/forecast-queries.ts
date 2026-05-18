import { createServerFn } from "@tanstack/react-start";
import { realMessageWhere } from "~/lib/conversation/filters";
import { messageScopeInput, messageScopeWhere } from "~/lib/conversation/scope";
import { bucket } from "~/lib/conversation/time";
import { bootstrapAUC, type BootstrapCi } from "~/lib/stats/bootstrap";
import { db, getDataGeneratedAt, withDbCache } from "~/lib/server-db";
import { resolveMessageScope } from "~/server/scope";

const REAL_MESSAGE_WHERE = realMessageWhere("browsable_message", "m");
const PAST_DAYS = 3;
const FUTURE_DAYS = 2;
const HOLDOUT_SHARE = 0.28;
const TRAINING_STEPS = 720;
const LEARNING_RATE = 0.08;
const L2 = 0.012;

export type Sender = "Me" | "Them";
export type ForecastKey = "warm" | "strain" | "repair" | "quiet" | "surge";

export type ForecastOverview = {
  generated_at: string;
  real_messages: number;
  active_days: number;
  training_windows: number;
  holdout_windows: number;
  current_ymd: string;
  best_forecast: string;
  best_auc: number;
  strongest_driver: string;
  current_top: string;
};

export type ForecastDriver = {
  feature: string;
  label: string;
  direction: "raises" | "lowers";
  weight: number;
  odds_multiplier: number;
};

export type ForecastExampleMessage = {
  ts: number;
  ymd: string;
  sender: Sender;
  text: string;
};

export type ForecastExample = {
  ymd: string;
  probability: number;
  actual: boolean;
  future_summary: string;
  prior_messages: number;
  future_messages: number;
  prior_examples: ForecastExampleMessage[];
  future_examples: ForecastExampleMessage[];
};

export type ForecastTarget = {
  key: ForecastKey;
  label: string;
  description: string;
  positive_label: string;
  windows: number;
  positives: number;
  baseline_rate: number;
  holdout_auc: number;
  holdout_auc_ci: BootstrapCi;
  baseline_auc: number;
  auc_delta: number;
  lift_top_quintile: number;
  current_probability: number;
  current_rank: number;
  calibration: ForecastCalibrationBin[];
  drivers: ForecastDriver[];
  examples: ForecastExample[];
};

export type ForecastCalibrationBin = {
  bin: number;
  range: string;
  predicted: number;
  observed: number;
  windows: number;
  positives: number;
};

export type ForecastThreshold = {
  label: string;
  value: string;
};

export type ForecastMonth = {
  ym: string;
  windows: number;
  warm: number;
  strain: number;
  repair: number;
  quiet: number;
  surge: number;
};

export type ForecastResult = {
  overview: ForecastOverview;
  targets: ForecastTarget[];
  months: ForecastMonth[];
  thresholds: ForecastThreshold[];
};

type MessageRow = {
  id: number;
  ts: number;
  date_iso: string;
  ymd: string;
  ym: string;
  is_from_me: number;
  word_count: number;
  has_attachment: number;
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
  questions: number;
  planning: number;
  affection: number;
  attachments: number;
  late_night: number;
  rows: MessageRow[];
};

type MetricKey =
  | "messages"
  | "words"
  | "me"
  | "them"
  | "warmth"
  | "strain"
  | "repair"
  | "care"
  | "gratitude"
  | "humor"
  | "questions"
  | "planning"
  | "affection"
  | "attachments"
  | "late_night";

type WindowMetrics = Pick<DayBucket, MetricKey>;
type PrefixSums = Record<MetricKey, number[]>;

type FeatureDefinition = {
  key: string;
  label: string;
  value: (past: WindowMetrics, previous: WindowMetrics) => number;
};

type ForecastFrame = {
  ymd: string;
  ym: string;
  index: number;
  past_start: number;
  past_end: number;
  future_start: number;
  future_end: number;
  past: WindowMetrics;
  future: WindowMetrics;
  features: number[];
  labels: Record<ForecastKey, boolean>;
};

type TargetDefinition = {
  key: ForecastKey;
  label: string;
  description: string;
  positiveLabel: string;
  isPositive: (frame: ForecastFrame, thresholds: OutcomeThresholds) => boolean;
  futureSummary: (frame: ForecastFrame) => string;
};

type OutcomeThresholds = {
  warm_rate: number;
  strain_rate: number;
  repair_rate: number;
  quiet_messages: number;
  busy_messages: number;
  surge_ratio: number;
  median_messages: number;
};

type Standardizer = {
  mean: number[];
  std: number[];
};

type TrainedModel = {
  target: TargetDefinition;
  weights: number[];
  bias: number;
  standardizer: Standardizer;
  predictions: number[];
  currentProbability: number;
  auc: number;
  aucCi: BootstrapCi;
  baselineAuc: number;
  aucDelta: number;
  calibration: ForecastCalibrationBin[];
  lift: number;
  baseline: number;
  positives: number;
  examples: ForecastExample[];
};

const LEXICONS = {
  warmth: /\b(love|miss|proud|sweet|cute|beautiful|handsome|excited|cuddle|snuggle|kiss|sweetheart|darling|adorable|lovely|heart)\b/i,
  strain: /\b(sad|anxious|anxiety|worried|worry|scared|afraid|hurt|cry|crying|upset|stress|stressed|hard|tired|exhausted|lonely|overwhelmed|frustrated|rough|bad day)\b/i,
  repair: /\b(sorry|apologize|apologise|forgive|my bad|misunderstood|didn'?t mean|didnt mean|should have|i understand|that makes sense|talk about)\b/i,
  care: /\b(hope you|are you okay|you okay|you ok|feel better|sleep well|rest|eat|safe|take care|checking in|how are you|how was your day|how's your day)\b/i,
  gratitude: /\b(thank you|thanks|appreciate|grateful|thankful|means a lot)\b/i,
  humor: /\b(lol|lmao|haha|hehe|funny|silly|wild|ridiculous|joke|hilarious)\b/i,
  planning: /\b(when|where|tonight|tomorrow|today|time|meet|come over|coming over|dinner|lunch|plans?|schedule|ride|pickup|pick up|drop off|book|reservation)\b/i,
  affection: /\b(love you|i love|miss you|proud of you|sweetheart|darling|cute|beautiful|handsome|kiss|cuddle|snuggle)\b/i,
};

const FEATURE_DEFINITIONS: FeatureDefinition[] = [
  {
    key: "volume",
    label: "message volume",
    value: (past) => Math.log1p(past.messages),
  },
  {
    key: "momentum",
    label: "volume momentum",
    value: (past, previous) => (past.messages - previous.messages) / Math.max(12, previous.messages),
  },
  {
    key: "reciprocity",
    label: "turn balance",
    value: (past) => (past.messages === 0 ? 0 : 1 - Math.abs(past.me - past.them) / past.messages),
  },
  {
    key: "me_share",
    label: "Me share",
    value: (past) => rate(past.me, past.messages),
  },
  {
    key: "mean_words",
    label: "message length",
    value: (past) => (past.messages === 0 ? 0 : past.words / past.messages),
  },
  {
    key: "warmth_rate",
    label: "warmth words",
    value: (past) => per100(past.warmth + past.gratitude + past.affection, past.messages),
  },
  {
    key: "strain_rate",
    label: "strain words",
    value: (past) => per100(past.strain, past.messages),
  },
  {
    key: "repair_rate",
    label: "repair language",
    value: (past) => per100(past.repair, past.messages),
  },
  {
    key: "care_rate",
    label: "care checks",
    value: (past) => per100(past.care, past.messages),
  },
  {
    key: "humor_rate",
    label: "play language",
    value: (past) => per100(past.humor, past.messages),
  },
  {
    key: "question_rate",
    label: "question load",
    value: (past) => per100(past.questions, past.messages),
  },
  {
    key: "planning_rate",
    label: "planning load",
    value: (past) => per100(past.planning, past.messages),
  },
  {
    key: "attachment_rate",
    label: "object drops",
    value: (past) => per100(past.attachments, past.messages),
  },
  {
    key: "late_night_rate",
    label: "late-night share",
    value: (past) => per100(past.late_night, past.messages),
  },
];

const TARGET_DEFINITIONS: TargetDefinition[] = [
  {
    key: "warm",
    label: "Warm landing",
    description: "The next 48 hours carry unusually high affection, gratitude, or care with enough volume to count.",
    positiveLabel: "warm next 48h",
    isPositive: (frame, thresholds) =>
      frame.future.messages >= Math.max(14, thresholds.median_messages * 0.35) &&
      warmRate(frame.future) >= thresholds.warm_rate,
    futureSummary: (frame) => `${per100(frame.future.warmth + frame.future.care + frame.future.gratitude + frame.future.affection, frame.future.messages).toFixed(1)} warm signals / 100`,
  },
  {
    key: "strain",
    label: "Strain pocket",
    description: "The next 48 hours contain unusually high anxiety, hurt, stress, sadness, or conflict language.",
    positiveLabel: "strain next 48h",
    isPositive: (frame, thresholds) =>
      frame.future.messages >= 10 &&
      frame.future.strain >= 2 &&
      per100(frame.future.strain, frame.future.messages) >= thresholds.strain_rate,
    futureSummary: (frame) => `${per100(frame.future.strain, frame.future.messages).toFixed(1)} strain signals / 100`,
  },
  {
    key: "repair",
    label: "Repair turn",
    description: "The next 48 hours become unusually repair-heavy, with apologies, care, clarification, or gratitude.",
    positiveLabel: "repair next 48h",
    isPositive: (frame, thresholds) =>
      frame.future.messages >= 10 &&
      frame.future.repair + frame.future.care + frame.future.gratitude >= 2 &&
      repairRate(frame.future) >= thresholds.repair_rate,
    futureSummary: (frame) => `${repairRate(frame.future).toFixed(1)} repair/care signals / 100`,
  },
  {
    key: "quiet",
    label: "Quiet drop",
    description: "A recently active window is followed by one of the conversation's quietest 48-hour stretches.",
    positiveLabel: "quiet next 48h",
    isPositive: (frame, thresholds) =>
      frame.past.messages >= thresholds.median_messages * 0.7 &&
      frame.future.messages <= thresholds.quiet_messages,
    futureSummary: (frame) => `${frame.future.messages} messages next 48h`,
  },
  {
    key: "surge",
    label: "Surge",
    description: "The next 48 hours become unusually busy relative to both the baseline and the immediate past.",
    positiveLabel: "surge next 48h",
    isPositive: (frame, thresholds) =>
      frame.future.messages >= thresholds.busy_messages &&
      (frame.future.messages + 10) / (frame.past.messages + 10) >= thresholds.surge_ratio,
    futureSummary: (frame) => `${frame.future.messages} messages next 48h`,
  },
];

export const getForecasts = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => messageScopeInput.parse(d ?? {}))
  .handler(async ({ data }): Promise<ForecastResult> => {
    const resolved = resolveMessageScope(data);
    return withDbCache(`forecasts:${JSON.stringify(resolved)}`, () => {
      const scope = messageScopeWhere(resolved, "m", [REAL_MESSAGE_WHERE]);
      const rows = db()
        .prepare(
          `
          SELECT m.id, m.ts, m.date_iso, m.ymd, m.ym, m.is_from_me, m.word_count, m.has_attachment, m.text
          FROM messages m
          ${scope.sql}
          ORDER BY m.ts ASC, m.id ASC
        `,
        )
        .all(...scope.args) as MessageRow[];

      const days = buildDays(rows);
      const prefix = buildPrefix(days);
      const frames = buildFrames(days, prefix);
      const splitIndex = Math.max(40, Math.floor(frames.length * (1 - HOLDOUT_SHARE)));
      const thresholds = buildOutcomeThresholds(frames.slice(0, splitIndex));
      for (const frame of frames) {
        frame.labels = labelsForFrame(frame, thresholds);
      }

      const trainFrames = frames.slice(0, splitIndex);
      const holdoutFrames = frames.slice(splitIndex);
      const currentFrame = buildCurrentFrame(days, prefix);
      const models = TARGET_DEFINITIONS.map((target) =>
        trainModel(target, frames, trainFrames, holdoutFrames, currentFrame, days),
      );

      const rankedCurrent = [...models].sort((a, b) => b.currentProbability - a.currentProbability);
      const rankedModels = [...models].sort((a, b) => b.auc - a.auc || b.lift - a.lift);
      const strongest = strongestDriver(models);

      return {
        overview: {
          generated_at: getDataGeneratedAt(),
          real_messages: rows.length,
          active_days: days.filter((day) => day.messages > 0).length,
          training_windows: trainFrames.length,
          holdout_windows: holdoutFrames.length,
          current_ymd: currentFrame.ymd,
          best_forecast: rankedModels[0]?.target.label ?? "n/a",
          best_auc: rankedModels[0]?.auc ?? 0,
          strongest_driver: strongest,
          current_top: rankedCurrent[0] ? `${rankedCurrent[0].target.label} (${formatProbability(rankedCurrent[0].currentProbability)})` : "n/a",
        },
        targets: models.map((model, index) => modelToTarget(model, index, rankedCurrent)),
        months: buildMonths(frames, models),
        thresholds: thresholdRows(thresholds),
      };
    });
  });

function buildDays(rows: MessageRow[]): DayBucket[] {
  if (rows.length === 0) return [];
  const byDay = new Map<number, DayBucket>();
  const minDay = epochDay(bucket(rows[0].ts, "ymd"));
  const maxDay = epochDay(bucket(rows[rows.length - 1].ts, "ymd"));

  for (let day = minDay; day <= maxDay; day += 1) {
    const ymd = ymdFromEpochDay(day);
    byDay.set(day, emptyDay(day - minDay, ymd));
  }

  for (const row of rows) {
    const day = byDay.get(epochDay(bucket(row.ts, "ymd")));
    if (!day) continue;
    const text = stripUrls(row.text ?? "");
    const hour = bucket(row.ts, "hour");
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
    day.questions += text.includes("?") || /^(what|when|where|who|why|how|do you|did you|are you|can you|would you|could you)\b/i.test(text) ? 1 : 0;
    day.planning += LEXICONS.planning.test(text) ? 1 : 0;
    day.affection += LEXICONS.affection.test(text) ? 1 : 0;
    day.attachments += row.has_attachment === 1 || row.text?.includes("http") ? 1 : 0;
    day.late_night += hour >= 23 || hour < 6 ? 1 : 0;
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
    questions: 0,
    planning: 0,
    affection: 0,
    attachments: 0,
    late_night: 0,
    rows: [],
  };
}

function buildPrefix(days: DayBucket[]): PrefixSums {
  const metrics: MetricKey[] = [
    "messages",
    "words",
    "me",
    "them",
    "warmth",
    "strain",
    "repair",
    "care",
    "gratitude",
    "humor",
    "questions",
    "planning",
    "affection",
    "attachments",
    "late_night",
  ];
  const prefix = Object.fromEntries(metrics.map((metric) => [metric, [0]])) as PrefixSums;
  for (const day of days) {
    for (const metric of metrics) {
      prefix[metric].push(prefix[metric][prefix[metric].length - 1] + day[metric]);
    }
  }
  return prefix;
}

function buildFrames(days: DayBucket[], prefix: PrefixSums): ForecastFrame[] {
  const frames: ForecastFrame[] = [];
  for (let index = PAST_DAYS * 2 - 1; index < days.length - FUTURE_DAYS; index += 1) {
    const pastStart = index - PAST_DAYS + 1;
    const pastEnd = index + 1;
    const previousStart = index - PAST_DAYS * 2 + 1;
    const previousEnd = index - PAST_DAYS + 1;
    const futureStart = index + 1;
    const futureEnd = index + 1 + FUTURE_DAYS;
    const past = windowMetrics(prefix, pastStart, pastEnd);
    const previous = windowMetrics(prefix, previousStart, previousEnd);
    const future = windowMetrics(prefix, futureStart, futureEnd);
    if (past.messages < 8) continue;
    frames.push({
      ymd: days[index].ymd,
      ym: days[index].ym,
      index,
      past_start: pastStart,
      past_end: pastEnd,
      future_start: futureStart,
      future_end: futureEnd,
      past,
      future,
      features: FEATURE_DEFINITIONS.map((feature) => feature.value(past, previous)),
      labels: emptyLabels(),
    });
  }
  return frames;
}

function buildCurrentFrame(days: DayBucket[], prefix: PrefixSums): ForecastFrame {
  const index = days.length - 1;
  const pastStart = Math.max(0, index - PAST_DAYS + 1);
  const past = windowMetrics(prefix, pastStart, index + 1);
  const previous = windowMetrics(prefix, Math.max(0, pastStart - PAST_DAYS), pastStart);
  return {
    ymd: days[index]?.ymd ?? "n/a",
    ym: days[index]?.ym ?? "n/a",
    index,
    past_start: pastStart,
    past_end: index + 1,
    future_start: index + 1,
    future_end: index + 1 + FUTURE_DAYS,
    past,
    future: zeroMetrics(),
    features: FEATURE_DEFINITIONS.map((feature) => feature.value(past, previous)),
    labels: emptyLabels(),
  };
}

function buildOutcomeThresholds(frames: ForecastFrame[]): OutcomeThresholds {
  const futureMessages = frames.map((frame) => frame.future.messages);
  return {
    warm_rate: quantile(frames.map((frame) => warmRate(frame.future)), 0.74),
    strain_rate: quantile(frames.map((frame) => per100(frame.future.strain, frame.future.messages)), 0.82),
    repair_rate: quantile(frames.map((frame) => repairRate(frame.future)), 0.8),
    quiet_messages: quantile(futureMessages, 0.24),
    busy_messages: quantile(futureMessages, 0.78),
    surge_ratio: quantile(frames.map((frame) => (frame.future.messages + 10) / (frame.past.messages + 10)), 0.78),
    median_messages: quantile(futureMessages, 0.5),
  };
}

function labelsForFrame(frame: ForecastFrame, thresholds: OutcomeThresholds): Record<ForecastKey, boolean> {
  return Object.fromEntries(
    TARGET_DEFINITIONS.map((target) => [target.key, target.isPositive(frame, thresholds)]),
  ) as Record<ForecastKey, boolean>;
}

function trainModel(
  target: TargetDefinition,
  frames: ForecastFrame[],
  trainFrames: ForecastFrame[],
  holdoutFrames: ForecastFrame[],
  currentFrame: ForecastFrame,
  days: DayBucket[],
): TrainedModel {
  const labels = trainFrames.map((frame) => (frame.labels[target.key] ? 1 : 0));
  const standardizer = buildStandardizer(trainFrames.map((frame) => frame.features));
  const trainX = trainFrames.map((frame) => standardize(frame.features, standardizer));
  const holdoutX = holdoutFrames.map((frame) => standardize(frame.features, standardizer));
  const fullX = frames.map((frame) => standardize(frame.features, standardizer));
  const model = fitLogistic(trainX, labels);
  const holdoutPredictions = holdoutX.map((features) => sigmoid(dot(features, model.weights) + model.bias));
  const holdoutLabels = holdoutFrames.map((frame) => (frame.labels[target.key] ? 1 : 0));
  const aucResult = bootstrapAUC(holdoutPredictions, holdoutLabels, 500, 14);
  const baselinePredictions = baselineScores(target, holdoutFrames);
  const baselineAuc = auc(baselinePredictions, holdoutLabels);
  const predictions = fullX.map((features) => sigmoid(dot(features, model.weights) + model.bias));
  const currentProbability = sigmoid(dot(standardize(currentFrame.features, standardizer), model.weights) + model.bias);
  return {
    target,
    weights: model.weights,
    bias: model.bias,
    standardizer,
    predictions,
    currentProbability,
    auc: aucResult.auc,
    aucCi: aucResult.ci,
    baselineAuc,
    aucDelta: aucResult.auc - baselineAuc,
    calibration: calibrationBins(holdoutPredictions, holdoutLabels),
    lift: topQuintileLift(holdoutPredictions, holdoutLabels),
    baseline: mean(holdoutLabels),
    positives: holdoutLabels.reduce((sum, label) => sum + label, 0 as number),
    examples: forecastExamples(target, holdoutFrames, holdoutPredictions, days),
  };
}

function fitLogistic(features: number[][], labels: number[]) {
  const width = features[0]?.length ?? 0;
  const weights = new Array<number>(width).fill(0);
  const baseRate = Math.min(0.94, Math.max(0.06, mean(labels)));
  let bias = Math.log(baseRate / (1 - baseRate));

  for (let step = 0; step < TRAINING_STEPS; step += 1) {
    const grad = new Array<number>(width).fill(0);
    let biasGrad = 0;
    for (let i = 0; i < features.length; i += 1) {
      const prediction = sigmoid(dot(features[i], weights) + bias);
      const error = prediction - labels[i];
      biasGrad += error;
      for (let j = 0; j < width; j += 1) {
        grad[j] += error * features[i][j] + L2 * weights[j];
      }
    }
    const scale = LEARNING_RATE / Math.max(1, features.length);
    bias -= scale * biasGrad;
    for (let j = 0; j < width; j += 1) {
      weights[j] -= scale * grad[j];
    }
  }

  return { weights, bias };
}

function modelToTarget(model: TrainedModel, index: number, rankedCurrent: TrainedModel[]): ForecastTarget {
  const currentRank = rankedCurrent.findIndex((candidate) => candidate.target.key === model.target.key) + 1;
  return {
    key: model.target.key,
    label: model.target.label,
    description: model.target.description,
    positive_label: model.target.positiveLabel,
    windows: model.predictions.length,
    positives: model.positives,
    baseline_rate: model.baseline,
    holdout_auc: model.auc,
    holdout_auc_ci: model.aucCi,
    baseline_auc: model.baselineAuc,
    auc_delta: model.aucDelta,
    lift_top_quintile: model.lift,
    current_probability: model.currentProbability,
    current_rank: currentRank || index + 1,
    calibration: model.calibration,
    drivers: modelDrivers(model),
    examples: model.examples,
  };
}

function modelDrivers(model: TrainedModel): ForecastDriver[] {
  return model.weights
    .map((weight, index) => ({
      feature: FEATURE_DEFINITIONS[index].key,
      label: FEATURE_DEFINITIONS[index].label,
      direction: weight >= 0 ? ("raises" as const) : ("lowers" as const),
      weight,
      odds_multiplier: Math.exp(weight),
    }))
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
    .slice(0, 6);
}

function thresholdRows(thresholds: OutcomeThresholds): ForecastThreshold[] {
  return [
    { label: "warm", value: `${thresholds.warm_rate.toFixed(1)} / 100` },
    { label: "strain", value: `${thresholds.strain_rate.toFixed(1)} / 100` },
    { label: "repair", value: `${thresholds.repair_rate.toFixed(1)} / 100` },
    { label: "quiet", value: `${Math.round(thresholds.quiet_messages)} msgs` },
    { label: "busy", value: `${Math.round(thresholds.busy_messages)} msgs` },
    { label: "surge", value: `${thresholds.surge_ratio.toFixed(1)}x` },
  ];
}

function forecastExamples(
  target: TargetDefinition,
  holdoutFrames: ForecastFrame[],
  predictions: number[],
  days: DayBucket[],
): ForecastExample[] {
  const scored = holdoutFrames
    .map((frame, index) => ({ frame, probability: predictions[index], actual: frame.labels[target.key] }))
    .sort((a, b) => b.probability - a.probability);
  const positive = scored.filter((item) => item.actual).slice(0, 4);
  const fallbacks = scored.filter((item) => !positive.includes(item)).slice(0, 4 - positive.length);

  return [...positive, ...fallbacks].map(({ frame, probability, actual }) => ({
    ymd: frame.ymd,
    probability,
    actual,
    future_summary: target.futureSummary(frame),
    prior_messages: frame.past.messages,
    future_messages: frame.future.messages,
    prior_examples: examplesForRows(rowsForWindow(frame, "past", days), 3, "latest"),
    future_examples: examplesForRows(rowsForWindow(frame, "future", days), 3, "earliest"),
  }));
}

function buildMonths(frames: ForecastFrame[], models: TrainedModel[]): ForecastMonth[] {
  const months = new Map<string, ForecastMonth>();
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const month = months.get(frame.ym) ?? {
      ym: frame.ym,
      windows: 0,
      warm: 0,
      strain: 0,
      repair: 0,
      quiet: 0,
      surge: 0,
    };
    month.windows += 1;
    for (const model of models) {
      month[model.target.key] += model.predictions[index] ?? 0;
    }
    months.set(frame.ym, month);
  }

  return [...months.values()].map((month) => ({
    ym: month.ym,
    windows: month.windows,
    warm: rate(month.warm, month.windows),
    strain: rate(month.strain, month.windows),
    repair: rate(month.repair, month.windows),
    quiet: rate(month.quiet, month.windows),
    surge: rate(month.surge, month.windows),
  }));
}

function strongestDriver(models: TrainedModel[]) {
  const allDrivers = models.flatMap((model) =>
    modelDrivers(model).map((driver) => ({ model, driver })),
  );
  const strongest = allDrivers.sort((a, b) => Math.abs(b.driver.weight) - Math.abs(a.driver.weight))[0];
  if (!strongest) return "n/a";
  return `${strongest.driver.label} ${strongest.driver.direction} ${strongest.model.target.label}`;
}

function windowMetrics(prefix: PrefixSums, start: number, end: number): WindowMetrics {
  const boundedStart = Math.max(0, start);
  const boundedEnd = Math.max(boundedStart, Math.min(prefix.messages.length - 1, end));
  return {
    messages: metric(prefix, "messages", boundedStart, boundedEnd),
    words: metric(prefix, "words", boundedStart, boundedEnd),
    me: metric(prefix, "me", boundedStart, boundedEnd),
    them: metric(prefix, "them", boundedStart, boundedEnd),
    warmth: metric(prefix, "warmth", boundedStart, boundedEnd),
    strain: metric(prefix, "strain", boundedStart, boundedEnd),
    repair: metric(prefix, "repair", boundedStart, boundedEnd),
    care: metric(prefix, "care", boundedStart, boundedEnd),
    gratitude: metric(prefix, "gratitude", boundedStart, boundedEnd),
    humor: metric(prefix, "humor", boundedStart, boundedEnd),
    questions: metric(prefix, "questions", boundedStart, boundedEnd),
    planning: metric(prefix, "planning", boundedStart, boundedEnd),
    affection: metric(prefix, "affection", boundedStart, boundedEnd),
    attachments: metric(prefix, "attachments", boundedStart, boundedEnd),
    late_night: metric(prefix, "late_night", boundedStart, boundedEnd),
  };
}

function metric(prefix: PrefixSums, key: MetricKey, start: number, end: number) {
  return prefix[key][end] - prefix[key][start];
}

function zeroMetrics(): WindowMetrics {
  return {
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
    questions: 0,
    planning: 0,
    affection: 0,
    attachments: 0,
    late_night: 0,
  };
}

function emptyLabels(): Record<ForecastKey, boolean> {
  return {
    warm: false,
    strain: false,
    repair: false,
    quiet: false,
    surge: false,
  };
}

function buildStandardizer(features: number[][]): Standardizer {
  const width = features[0]?.length ?? 0;
  const meanValues = new Array<number>(width).fill(0);
  const std = new Array<number>(width).fill(1);
  for (const row of features) {
    for (let i = 0; i < width; i += 1) meanValues[i] += row[i];
  }
  for (let i = 0; i < width; i += 1) meanValues[i] /= Math.max(1, features.length);
  for (const row of features) {
    for (let i = 0; i < width; i += 1) std[i] += (row[i] - meanValues[i]) ** 2;
  }
  for (let i = 0; i < width; i += 1) std[i] = Math.max(0.001, Math.sqrt(std[i] / Math.max(1, features.length)));
  return { mean: meanValues, std };
}

function standardize(features: number[], standardizer: Standardizer) {
  return features.map((value, index) => (value - standardizer.mean[index]) / standardizer.std[index]);
}

function auc(predictions: number[], labels: number[]) {
  const positives = labels.filter(Boolean).length;
  const negatives = labels.length - positives;
  if (positives === 0 || negatives === 0) return 0.5;
  const paired = predictions
    .map((prediction, index) => ({ prediction, label: labels[index] }))
    .sort((a, b) => a.prediction - b.prediction);
  let rankSum = 0;
  for (let i = 0; i < paired.length; i += 1) {
    if (paired[i].label === 1) rankSum += i + 1;
  }
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

function topQuintileLift(predictions: number[], labels: number[]) {
  const baseline = mean(labels);
  if (baseline === 0) return 1;
  const scored = predictions
    .map((prediction, index) => ({ prediction, label: labels[index] }))
    .sort((a, b) => b.prediction - a.prediction);
  const topCount = Math.max(8, Math.ceil(scored.length * 0.2));
  return mean(scored.slice(0, topCount).map((item) => item.label)) / baseline;
}

function baselineScores(target: TargetDefinition, frames: ForecastFrame[]) {
  return frames.map((frame) => {
    const volumeScore = frame.past.messages;
    return target.key === "quiet" ? -volumeScore : volumeScore;
  });
}

function calibrationBins(predictions: number[], labels: number[], binCount = 10): ForecastCalibrationBin[] {
  const bins = Array.from({ length: binCount }, (_, index) => ({
    bin: index,
    predictedSum: 0,
    positives: 0,
    windows: 0,
  }));

  for (let index = 0; index < predictions.length; index += 1) {
    const bin = Math.min(binCount - 1, Math.max(0, Math.floor(predictions[index] * binCount)));
    bins[bin].predictedSum += predictions[index];
    bins[bin].positives += labels[index] ? 1 : 0;
    bins[bin].windows += 1;
  }

  return bins
    .filter((bin) => bin.windows > 0)
    .map((bin) => ({
      bin: bin.bin,
      range: `${Math.round((bin.bin / binCount) * 100)}-${Math.round(((bin.bin + 1) / binCount) * 100)}%`,
      predicted: bin.predictedSum / bin.windows,
      observed: bin.positives / bin.windows,
      windows: bin.windows,
      positives: bin.positives,
    }));
}

function rowsForWindow(frame: ForecastFrame, which: "past" | "future", days: DayBucket[]): MessageRow[] {
  const start = which === "past" ? frame.past_start : frame.future_start;
  const end = which === "past" ? frame.past_end : frame.future_end;
  return days.slice(start, end).flatMap((day) => day.rows);
}

function examplesForRows(rows: MessageRow[], limit: number, mode: "earliest" | "latest"): ForecastExampleMessage[] {
  const ordered = mode === "latest" ? [...rows].reverse() : rows;
  return ordered
    .filter((row) => stripUrls(row.text ?? "").trim().length > 0)
    .slice(0, limit)
    .map((row) => ({
      ts: row.ts,
      ymd: bucket(row.ts, "ymd"),
      sender: row.is_from_me === 1 ? "Me" : "Them",
      text: preview(stripUrls(row.text ?? ""), 170),
    }));
}

function warmRate(metrics: WindowMetrics) {
  return per100(metrics.warmth + metrics.care + metrics.gratitude + metrics.affection, metrics.messages);
}

function repairRate(metrics: WindowMetrics) {
  return per100(metrics.repair + metrics.care + metrics.gratitude, metrics.messages);
}

function per100(part: number, whole: number) {
  return whole === 0 ? 0 : (part / whole) * 100;
}

function rate(part: number, whole: number) {
  return whole === 0 ? 0 : part / whole;
}

function mean(values: number[]) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sigmoid(value: number) {
  if (value < -35) return 0;
  if (value > 35) return 1;
  return 1 / (1 + Math.exp(-value));
}

function dot(a: number[], b: number[]) {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

function quantile(values: number[], q: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)));
  return sorted[index];
}

function stripUrls(text: string) {
  return text.replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim();
}

function preview(text: string, maxLength: number) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 1).trimEnd()}…`;
}

function epochDay(ymd: string) {
  return Math.floor(Date.parse(`${ymd}T00:00:00Z`) / 86400000);
}

function ymdFromEpochDay(day: number) {
  return new Date(day * 86400000).toISOString().slice(0, 10);
}

function formatProbability(value: number) {
  return `${Math.round(value * 100)}%`;
}
