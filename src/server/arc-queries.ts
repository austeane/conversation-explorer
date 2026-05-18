import { createServerFn } from "@tanstack/react-start";
import { realMessageWhere } from "~/lib/conversation/filters";
import { messageScopeInput, messageScopeWhere } from "~/lib/conversation/scope";
import { bucket } from "~/lib/conversation/time";
import { db, withDbCache } from "~/lib/server-db";
import { resolveMessageScope } from "~/server/scope";

const REAL_MESSAGE_WHERE = realMessageWhere("browsable_message", "m");
const ARC_DAYS = 5;
const STEP_DAYS = 2;
const CLUSTERS = 7;
const ITERATIONS = 34;
const MIN_WINDOW_MESSAGES = 32;

export type Sender = "Me" | "Them";

export type ArcOverview = {
  generated_at: string;
  active_days: number;
  windows: number;
  arcs: number;
  current_arc: string;
  dominant_arc: string;
  strongest_transition: string;
  rare_arc: string;
};

export type ArcDayShape = {
  day: number;
  intensity: number;
  warmth: number;
  strain: number;
  repair: number;
  reciprocity: number;
};

export type ArcExampleMessage = {
  ts: number;
  sender: Sender;
  text: string;
};

export type ArcWindowExample = {
  id: string;
  start_ymd: string;
  end_ymd: string;
  label: string;
  score: number;
  messages: number;
  warmth: number;
  strain: number;
  repair: number;
  shape: ArcDayShape[];
  examples: ArcExampleMessage[];
};

export type ArcCluster = {
  id: string;
  label: string;
  description: string;
  windows: number;
  share: number;
  median_messages: number;
  median_balance: number;
  median_warmth: number;
  median_strain: number;
  median_repair: number;
  shape: ArcDayShape[];
  signals: string[];
  examples: ArcWindowExample[];
};

export type ArcTransition = {
  from: string;
  to: string;
  count: number;
  lift: number;
  example_start: string;
};

export type ArcMonth = {
  ym: string;
  windows: number;
  arcs: Array<{
    label: string;
    count: number;
    share: number;
  }>;
};

export type ArcResult = {
  overview: ArcOverview;
  clusters: ArcCluster[];
  transitions: ArcTransition[];
  months: ArcMonth[];
  examples: ArcWindowExample[];
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
  attachments: number;
  late_night: number;
  rows: MessageRow[];
};

type DayMetrics = {
  intensity: number;
  warmth: number;
  strain: number;
  repair: number;
  reciprocity: number;
  planning: number;
  play: number;
  late: number;
};

type ArcWindow = {
  id: string;
  start: number;
  end: number;
  start_ymd: string;
  end_ymd: string;
  ym: string;
  messages: number;
  warmth: number;
  strain: number;
  repair: number;
  balance: number;
  metrics: DayMetrics[];
  vector: number[];
  cluster: number;
  distance: number;
};

type Standardizer = {
  mean: number[];
  std: number[];
};

type ClusterStats = {
  index: number;
  windows: ArcWindow[];
  centroid: number[];
  shape: ArcDayShape[];
  label: string;
  description: string;
};

const LEXICONS = {
  warmth: /\b(love|miss|proud|sweet|cute|beautiful|handsome|excited|cuddle|snuggle|kiss|sweetheart|darling|adorable|lovely|heart)\b/i,
  strain: /\b(sad|anxious|anxiety|worried|worry|scared|afraid|hurt|cry|crying|upset|stress|stressed|hard|tired|exhausted|lonely|overwhelmed|frustrated|rough|bad day)\b/i,
  repair: /\b(sorry|apologize|apologise|forgive|my bad|misunderstood|didn'?t mean|didnt mean|should have|i understand|that makes sense|talk about)\b/i,
  care: /\b(hope you|are you okay|you okay|you ok|feel better|sleep well|rest|eat|safe|take care|checking in|how are you|how was your day|how's your day)\b/i,
  gratitude: /\b(thank you|thanks|appreciate|grateful|thankful|means a lot)\b/i,
  humor: /\b(lol|lmao|haha|hehe|funny|silly|wild|ridiculous|joke|hilarious)\b/i,
  planning: /\b(when|where|tonight|tomorrow|today|time|meet|come over|coming over|dinner|lunch|plans?|schedule|ride|pickup|pick up|drop off|book|reservation)\b/i,
};

export const getArcs = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => messageScopeInput.parse(d ?? {}))
  .handler(async ({ data }): Promise<ArcResult> => {
    const resolved = resolveMessageScope(data);
    return withDbCache(`arcs:${JSON.stringify(resolved)}`, () => {
      const generated = db().prepare("SELECT v FROM meta WHERE k = 'generated_at'").get() as { v: string } | undefined;
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
      const rawWindows = buildWindows(days);
      const standardizer = buildStandardizer(rawWindows.map((window) => window.vector));
      const windows = rawWindows.map((window) => ({
        ...window,
        vector: standardize(window.vector, standardizer),
      }));
      const centroids = kmeans(windows.map((window) => window.vector), CLUSTERS);
      assignClusters(windows, centroids);
      const clusterStats = labelClusters(buildClusterStats(windows, centroids));
      const transitions = buildTransitions(windows, clusterStats);
      const months = buildMonths(windows, clusterStats);
      const current = nearestCluster(buildCurrentWindow(days), standardizer, centroids, clusterStats);
      const dominant = [...clusterStats].sort((a, b) => b.windows.length - a.windows.length)[0];
      const rare = [...clusterStats].filter((cluster) => cluster.windows.length > 0).sort((a, b) => a.windows.length - b.windows.length)[0];
      const strongestTransition = transitions[0];

      return {
        overview: {
          generated_at: generated?.v ?? "unknown",
          active_days: days.filter((day) => day.messages > 0).length,
          windows: windows.length,
          arcs: clusterStats.length,
          current_arc: current?.label ?? "n/a",
          dominant_arc: dominant?.label ?? "n/a",
          strongest_transition: strongestTransition ? `${strongestTransition.from} -> ${strongestTransition.to}` : "n/a",
          rare_arc: rare?.label ?? "n/a",
        },
        clusters: clusterStats.map((cluster) => clusterToResult(cluster, windows.length, days)),
        transitions,
        months,
        examples: clusterStats
          .flatMap((cluster) => examplesForCluster(cluster, days, 2))
          .sort((a, b) => b.score - a.score)
          .slice(0, 18),
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
    attachments: 0,
    late_night: 0,
    rows: [],
  };
}

function buildWindows(days: DayBucket[]): ArcWindow[] {
  const windows: ArcWindow[] = [];
  for (let start = 0; start <= days.length - ARC_DAYS; start += STEP_DAYS) {
    const slice = days.slice(start, start + ARC_DAYS);
    const messages = sum(slice.map((day) => day.messages));
    if (messages < MIN_WINDOW_MESSAGES) continue;
    const metrics = slice.map(dayMetrics);
    const warmth = sum(slice.map((day) => day.warmth + day.care + day.gratitude));
    const strain = sum(slice.map((day) => day.strain));
    const repair = sum(slice.map((day) => day.repair + day.care + day.gratitude));
    const me = sum(slice.map((day) => day.me));
    const them = sum(slice.map((day) => day.them));
    windows.push({
      id: `${slice[0].ymd}-${slice[slice.length - 1].ymd}`,
      start,
      end: start + ARC_DAYS,
      start_ymd: slice[0].ymd,
      end_ymd: slice[slice.length - 1].ymd,
      ym: slice[Math.floor(slice.length / 2)].ym,
      messages,
      warmth,
      strain,
      repair,
      balance: messages === 0 ? 0 : 1 - Math.abs(me - them) / messages,
      metrics,
      vector: flattenMetrics(metrics),
      cluster: -1,
      distance: 0,
    });
  }
  return windows;
}

function dayMetrics(day: DayBucket): DayMetrics {
  return {
    intensity: Math.log1p(day.messages),
    warmth: per100(day.warmth + day.care + day.gratitude, day.messages),
    strain: per100(day.strain, day.messages),
    repair: per100(day.repair + day.care + day.gratitude, day.messages),
    reciprocity: day.messages === 0 ? 0 : 1 - Math.abs(day.me - day.them) / day.messages,
    planning: per100(day.planning + day.questions, day.messages),
    play: per100(day.humor, day.messages),
    late: per100(day.late_night, day.messages),
  };
}

function flattenMetrics(metrics: DayMetrics[]) {
  return metrics.flatMap((day) => [
    day.intensity,
    day.warmth,
    day.strain,
    day.repair,
    day.reciprocity,
    day.planning,
    day.play,
    day.late,
  ]);
}

function buildStandardizer(vectors: number[][]): Standardizer {
  const width = vectors[0]?.length ?? 0;
  const meanValues = new Array<number>(width).fill(0);
  const std = new Array<number>(width).fill(0);
  for (const vector of vectors) {
    for (let i = 0; i < width; i += 1) meanValues[i] += vector[i];
  }
  for (let i = 0; i < width; i += 1) meanValues[i] /= Math.max(1, vectors.length);
  for (const vector of vectors) {
    for (let i = 0; i < width; i += 1) std[i] += (vector[i] - meanValues[i]) ** 2;
  }
  for (let i = 0; i < width; i += 1) std[i] = Math.max(0.001, Math.sqrt(std[i] / Math.max(1, vectors.length)));
  return { mean: meanValues, std };
}

function standardize(vector: number[], standardizer: Standardizer) {
  return vector.map((value, index) => (value - standardizer.mean[index]) / standardizer.std[index]);
}

function kmeans(vectors: number[][], k: number) {
  if (vectors.length === 0) return [];
  const centroids = seedCentroids(vectors, Math.min(k, vectors.length));
  let assignments = new Array<number>(vectors.length).fill(-1);

  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    let changed = false;
    for (let i = 0; i < vectors.length; i += 1) {
      const next = nearestCentroid(vectors[i], centroids).index;
      if (assignments[i] !== next) {
        changed = true;
        assignments[i] = next;
      }
    }
    if (!changed && iteration > 3) break;

    const sums = centroids.map((centroid) => new Array<number>(centroid.length).fill(0));
    const counts = centroids.map(() => 0);
    for (let i = 0; i < vectors.length; i += 1) {
      const assignment = assignments[i];
      counts[assignment] += 1;
      for (let j = 0; j < vectors[i].length; j += 1) sums[assignment][j] += vectors[i][j];
    }
    for (let c = 0; c < centroids.length; c += 1) {
      if (counts[c] === 0) continue;
      for (let j = 0; j < centroids[c].length; j += 1) centroids[c][j] = sums[c][j] / counts[c];
    }
  }

  return centroids;
}

function seedCentroids(vectors: number[][], k: number) {
  const centroids = [vectors[Math.floor(vectors.length / 2)].slice()];
  let seed = 94337;
  while (centroids.length < k) {
    const distances = vectors.map((vector) => nearestCentroid(vector, centroids).distance);
    const total = sum(distances);
    seed = (seed * 48271) % 2147483647;
    const threshold = (seed / 2147483647) * total;
    let cursor = 0;
    let chosen = vectors.length - 1;
    for (let i = 0; i < distances.length; i += 1) {
      cursor += distances[i];
      if (cursor >= threshold) {
        chosen = i;
        break;
      }
    }
    centroids.push(vectors[chosen].slice());
  }
  return centroids;
}

function assignClusters(windows: ArcWindow[], centroids: number[][]) {
  for (const window of windows) {
    const nearest = nearestCentroid(window.vector, centroids);
    window.cluster = nearest.index;
    window.distance = nearest.distance;
  }
}

function buildClusterStats(windows: ArcWindow[], centroids: number[][]): ClusterStats[] {
  return centroids
    .map((centroid, index) => {
      const clusterWindows = windows.filter((window) => window.cluster === index);
      return {
        index,
        windows: clusterWindows,
        centroid,
        shape: shapeForWindows(clusterWindows),
        label: `Arc ${index + 1}`,
        description: "",
      };
    })
    .filter((cluster) => cluster.windows.length > 0);
}

function labelClusters(clusters: ClusterStats[]) {
  const used = new Set<string>();
  return clusters.map((cluster) => {
    const metrics = clusterMetrics(cluster);
    const candidates = labelCandidates(metrics);
    const label = candidates.find((candidate) => !used.has(candidate.label)) ?? candidates[candidates.length - 1];
    used.add(label.label);
    return {
      ...cluster,
      label: label.label,
      description: label.description,
    };
  });
}

function labelCandidates(metrics: ReturnType<typeof clusterMetrics>) {
  const candidates: Array<{ label: string; description: string; score: number }> = [
    {
      label: "Storm to repair",
      description: "Strain crests and is followed by apology, care, clarification, or gratitude.",
      score: metrics.strainPeak >= 6 || metrics.strainMean >= 3.1
        ? metrics.strainPeak * 1.3 + metrics.repairEnd + Math.max(0, metrics.repairTrend) - metrics.warmStart * 0.3
        : -50,
    },
    {
      label: "Warm bloom",
      description: "Affection and care stay high across the window, usually with enough volume to feel alive.",
      score: metrics.warmMean >= 17
        ? metrics.warmMean * 1.3 + metrics.intensityMean * 0.35 + metrics.balanceMean * 2
        : -40,
    },
    {
      label: "Logistics sprint",
      description: "Planning, questions, and practical coordination carry the shape.",
      score: metrics.planningMean >= 17
        ? metrics.planningMean * 1.2 + metrics.intensityMean * 0.35
        : -30,
    },
    {
      label: "High-volume groove",
      description: "Dense, balanced exchange stays active across most of the five-day run.",
      score: metrics.intensityMean * 2.4 + metrics.balanceMean * 3 + metrics.warmMean * 0.2,
    },
    {
      label: "Acceleration ramp",
      description: "The window starts smaller and builds into denser exchange.",
      score: metrics.intensityTrend * 2.3 + metrics.intensityEnd,
    },
    {
      label: "Quiet landing",
      description: "The shape falls out of a busier opening into quieter follow-through.",
      score: -metrics.intensityTrend * 2.2 + metrics.intensityStart - metrics.strainMean * 0.2,
    },
    {
      label: "All-day exchange",
      description: "Long, active runs where the thread stays light enough to keep moving.",
      score: metrics.playMean >= 6
        ? metrics.playMean * 1.8 + metrics.warmMean * 0.25
        : -20,
    },
    {
      label: "Mutual rhythm",
      description: "Neither person dominates and the arc stays conversationally balanced.",
      score: metrics.balanceMean * 4 + metrics.intensityMean * 0.35,
    },
  ];
  return candidates.sort((a, b) => b.score - a.score);
}

function clusterMetrics(cluster: ClusterStats) {
  const first = cluster.windows.map((window) => window.metrics[0]).filter(Boolean);
  const last = cluster.windows.map((window) => window.metrics[ARC_DAYS - 1]).filter(Boolean);
  const all = cluster.windows.flatMap((window) => window.metrics);
  return {
    intensityMean: mean(all.map((day) => day.intensity)),
    intensityStart: mean(first.map((day) => day.intensity)),
    intensityEnd: mean(last.map((day) => day.intensity)),
    intensityTrend: mean(last.map((day) => day.intensity)) - mean(first.map((day) => day.intensity)),
    windowMessagesMean: mean(cluster.windows.map((window) => window.messages)),
    warmMean: mean(all.map((day) => day.warmth)),
    warmStart: mean(first.map((day) => day.warmth)),
    strainMean: mean(all.map((day) => day.strain)),
    strainPeak: Math.max(...all.map((day) => day.strain), 0),
    repairMean: mean(all.map((day) => day.repair)),
    repairEnd: mean(last.map((day) => day.repair)),
    repairTrend: mean(last.map((day) => day.repair)) - mean(first.map((day) => day.repair)),
    planningMean: mean(all.map((day) => day.planning)),
    playMean: mean(all.map((day) => day.play)),
    lateMean: mean(all.map((day) => day.late)),
    balanceMean: mean(cluster.windows.map((window) => window.balance)),
  };
}

function shapeForWindows(windows: ArcWindow[]): ArcDayShape[] {
  return Array.from({ length: ARC_DAYS }, (_, dayIndex) => {
    const metrics = windows.map((window) => window.metrics[dayIndex]).filter(Boolean);
    return {
      day: dayIndex + 1,
      intensity: clamp01(mean(metrics.map((metric) => metric.intensity)) / 5.5),
      warmth: clamp01(mean(metrics.map((metric) => metric.warmth)) / 45),
      strain: clamp01(mean(metrics.map((metric) => metric.strain)) / 24),
      repair: clamp01(mean(metrics.map((metric) => metric.repair)) / 32),
      reciprocity: clamp01(mean(metrics.map((metric) => metric.reciprocity))),
    };
  });
}

function clusterToResult(cluster: ClusterStats, totalWindows: number, days: DayBucket[]): ArcCluster {
  const sorted = [...cluster.windows].sort((a, b) => a.distance - b.distance);
  return {
    id: `arc-${cluster.index}`,
    label: cluster.label,
    description: cluster.description,
    windows: cluster.windows.length,
    share: cluster.windows.length / Math.max(1, totalWindows),
    median_messages: median(cluster.windows.map((window) => window.messages)),
    median_balance: median(cluster.windows.map((window) => window.balance)),
    median_warmth: median(cluster.windows.map((window) => per100(window.warmth, window.messages))),
    median_strain: median(cluster.windows.map((window) => per100(window.strain, window.messages))),
    median_repair: median(cluster.windows.map((window) => per100(window.repair, window.messages))),
    shape: cluster.shape,
    signals: signalsForCluster(cluster),
    examples: sorted.slice(0, 2).map((window) => windowToExample(window, cluster.label, days)),
  };
}

function signalsForCluster(cluster: ClusterStats) {
  const metrics = clusterMetrics(cluster);
  const signals: string[] = [];

  if (metrics.windowMessagesMean >= 420) signals.push("dense exchange");
  else if (metrics.windowMessagesMean <= 140) signals.push("quiet run");
  else signals.push("moderate volume");

  if (metrics.intensityTrend >= 0.35) signals.push("volume rises");
  else if (metrics.intensityTrend <= -0.35) signals.push("volume eases");
  else signals.push("steady shape");

  if (metrics.balanceMean >= 0.95) signals.push("high reciprocity");
  else if (metrics.balanceMean >= 0.88) signals.push("mostly mutual");
  else signals.push("uneven turns");

  if (metrics.warmMean >= 18) signals.push("high warmth");
  else if (metrics.warmMean >= 14) signals.push("warm undertone");
  else signals.push("cooler texture");

  if (metrics.strainMean >= 3.1) signals.push("strain crest");
  else if (metrics.strainMean >= 2) signals.push("some strain");
  else signals.push("low strain");

  if (metrics.repairEnd >= 8 || metrics.repairTrend >= 1.5 || metrics.repairMean >= 7) signals.push("repair/care active");
  if (metrics.planningMean >= 17) signals.push("coordination-heavy");
  if (metrics.playMean >= 5.5) signals.push("more joking");
  if (metrics.lateMean >= 16) signals.push("late-night texture");

  return signals.slice(0, 8);
}

function buildTransitions(windows: ArcWindow[], clusters: ClusterStats[]): ArcTransition[] {
  const byIndex = new Map(clusters.map((cluster) => [cluster.index, cluster.label]));
  const sorted = [...windows].sort((a, b) => a.start - b.start);
  const totals = new Map<number, number>();
  const counts = new Map<string, { count: number; example: string; from: number; to: number }>();

  for (const window of sorted) {
    totals.set(window.cluster, (totals.get(window.cluster) ?? 0) + 1);
  }

  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (current.start - previous.start > STEP_DAYS * 2) continue;
    const key = `${previous.cluster}->${current.cluster}`;
    const existing = counts.get(key);
    counts.set(key, {
      count: (existing?.count ?? 0) + 1,
      example: existing?.example ?? current.start_ymd,
      from: previous.cluster,
      to: current.cluster,
    });
  }

  const totalTransitions = sum([...counts.values()].map((entry) => entry.count));
  return [...counts.values()]
    .filter((entry) => entry.from !== entry.to && entry.count >= 4)
    .map((entry) => {
      const expected = ((totals.get(entry.from) ?? 0) / Math.max(1, windows.length)) *
        ((totals.get(entry.to) ?? 0) / Math.max(1, windows.length));
      const observed = entry.count / Math.max(1, totalTransitions);
      return {
        from: byIndex.get(entry.from) ?? `Arc ${entry.from + 1}`,
        to: byIndex.get(entry.to) ?? `Arc ${entry.to + 1}`,
        count: entry.count,
        lift: expected === 0 ? 1 : observed / expected,
        example_start: entry.example,
      };
    })
    .sort((a, b) => b.lift - a.lift || b.count - a.count)
    .slice(0, 12);
}

function buildMonths(windows: ArcWindow[], clusters: ClusterStats[]): ArcMonth[] {
  const byIndex = new Map(clusters.map((cluster) => [cluster.index, cluster.label]));
  const months = new Map<string, Map<string, number>>();
  for (const window of windows) {
    const label = byIndex.get(window.cluster) ?? `Arc ${window.cluster + 1}`;
    const month = months.get(window.ym) ?? new Map<string, number>();
    month.set(label, (month.get(label) ?? 0) + 1);
    months.set(window.ym, month);
  }
  return [...months.entries()].map(([ym, counts]) => {
    const windowsForMonth = sum([...counts.values()]);
    return {
      ym,
      windows: windowsForMonth,
      arcs: [...counts.entries()]
        .map(([label, count]) => ({ label, count, share: count / Math.max(1, windowsForMonth) }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 3),
    };
  });
}

function examplesForCluster(cluster: ClusterStats, days: DayBucket[], count: number) {
  return [...cluster.windows]
    .sort((a, b) => a.distance - b.distance)
    .slice(0, count)
    .map((window) => windowToExample(window, cluster.label, days));
}

function windowToExample(window: ArcWindow, label: string, days: DayBucket[]): ArcWindowExample {
  return {
    id: window.id,
    start_ymd: window.start_ymd,
    end_ymd: window.end_ymd,
    label,
    score: round(Math.exp(-window.distance / Math.max(1, window.vector.length))),
    messages: window.messages,
    warmth: per100(window.warmth, window.messages),
    strain: per100(window.strain, window.messages),
    repair: per100(window.repair, window.messages),
    shape: window.metrics.map((metric, index) => ({
      day: index + 1,
      intensity: clamp01(metric.intensity / 6),
      warmth: clamp01(metric.warmth / 45),
      strain: clamp01(metric.strain / 28),
      repair: clamp01(metric.repair / 36),
      reciprocity: clamp01(metric.reciprocity),
    })),
    examples: examplesForRows(days.slice(window.start, window.end).flatMap((day) => day.rows), 4),
  };
}

function nearestCluster(window: ArcWindow | null, standardizer: Standardizer, centroids: number[][], clusters: ClusterStats[]) {
  if (!window) return null;
  const nearest = nearestCentroid(standardize(window.vector, standardizer), centroids);
  return clusters.find((cluster) => cluster.index === nearest.index) ?? null;
}

function buildCurrentWindow(days: DayBucket[]) {
  if (days.length < ARC_DAYS) return null;
  const start = Math.max(0, days.length - ARC_DAYS);
  return buildWindows(days.slice(start)).at(-1) ?? null;
}

function nearestCentroid(vector: number[], centroids: number[][]) {
  let index = 0;
  let distance = Infinity;
  for (let i = 0; i < centroids.length; i += 1) {
    const next = squaredDistance(vector, centroids[i]);
    if (next < distance) {
      index = i;
      distance = next;
    }
  }
  return { index, distance };
}

function squaredDistance(a: number[], b: number[]) {
  let sumSquares = 0;
  for (let i = 0; i < a.length; i += 1) {
    const delta = a[i] - b[i];
    sumSquares += delta * delta;
  }
  return sumSquares;
}

function examplesForRows(rows: MessageRow[], limit: number): ArcExampleMessage[] {
  return rows
    .filter((row) => stripUrls(row.text ?? "").trim().length > 0)
    .sort((a, b) => scoreRowForExample(b) - scoreRowForExample(a))
    .slice(0, limit)
    .sort((a, b) => a.ts - b.ts)
    .map((row) => ({
      ts: row.ts,
      sender: row.is_from_me === 1 ? "Me" : "Them",
      text: preview(stripUrls(row.text ?? ""), 180),
    }));
}

function scoreRowForExample(row: MessageRow) {
  const text = stripUrls(row.text ?? "");
  return Math.min(row.word_count, 45) +
    (LEXICONS.warmth.test(text) ? 12 : 0) +
    (LEXICONS.strain.test(text) ? 12 : 0) +
    (LEXICONS.repair.test(text) ? 10 : 0) +
    (LEXICONS.care.test(text) ? 8 : 0) +
    (text.includes("?") ? 4 : 0);
}

function per100(part: number, whole: number) {
  return whole === 0 ? 0 : (part / whole) * 100;
}

function mean(values: number[]) {
  return values.length === 0 ? 0 : sum(values) / values.length;
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function round(value: number) {
  return Math.round(value * 100) / 100;
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
