import { createServerFn } from "@tanstack/react-start";
import { realMessageWhere } from "~/lib/conversation/filters";
import { matchesLexicon } from "~/lib/conversation/lexicons";
import { messageScopeInput, messageScopeWhere, type MessageScope } from "~/lib/conversation/scope";
import { bucket, dayBounds } from "~/lib/conversation/time";
import { db, withDbCache } from "~/lib/server-db";
import { resolveMessageScope } from "~/server/scope";

const DAY_SECONDS = 86400;
const WINDOW_DAYS = 56;
const WINDOW_STEP_DAYS = 14;
const MAX_PERIOD_DAYS = 180;
const MAX_PERIODS = 12;
const MAX_WINDOWS = 12;
const MAX_LAGS = 29;
const REAL_MESSAGE_WHERE = realMessageWhere("text_turn", "m");

export type Sender = "Me" | "Them";

export type RhythmOverview = {
  generated_at: string;
  days: number;
  active_days: number;
  messages: number;
  strongest_period: string;
  strongest_period_feature: string;
  strongest_lag: string;
  synchrony: number;
  current_tempo: string;
};

export type RhythmPeriod = {
  feature: string;
  label: string;
  period_days: number;
  strength: number;
  baseline_strength: number;
  lift: number;
  phase_label: string;
  sparkline: number[];
};

export type RhythmLag = {
  lag_days: number;
  label: string;
  correlation: number;
  direction: "Me leads" | "Them leads" | "same day";
};

export type RhythmMonth = {
  ym: string;
  total: number;
  active_days: number;
  synchrony: number;
  weekly_memory: number;
  warmth_rate: number;
  strain_rate: number;
  intensity_index: number;
};

export type RhythmWindow = {
  start_ymd: string;
  end_ymd: string;
  label: string;
  score: number;
  messages: number;
  active_days: number;
  synchrony: number;
  weekly_memory: number;
  dominant_period_days: number;
  warmth_rate: number;
  strain_rate: number;
  peak_ymd: string;
  snippets: RhythmSnippet[];
};

export type RhythmSnippet = {
  ts: number;
  sender: Sender;
  text: string;
};

export type RhythmResult = {
  overview: RhythmOverview;
  periods: RhythmPeriod[];
  lags: RhythmLag[];
  months: RhythmMonth[];
  windows: RhythmWindow[];
};

type MessageRow = {
  ts: number;
  is_from_me: number;
  text: string | null;
  word_count: number | null;
  has_attachment: number | null;
};

type DayPoint = {
  ymd: string;
  ym: string;
  index: number;
  total: number;
  me: number;
  them: number;
  words: number;
  attachments: number;
  warmth: number;
  strain: number;
  care: number;
  humor: number;
};

type FeatureDef = {
  key: string;
  label: string;
  values: (day: DayPoint) => number;
};

export const getRhythms = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => messageScopeInput.parse(d ?? {}))
  .handler(async ({ data }): Promise<RhythmResult> => {
    const resolved = resolveMessageScope(data);
    return withDbCache(`rhythms:${JSON.stringify(resolved)}`, () => {
      const generated = db().prepare("SELECT v FROM meta WHERE k = 'generated_at'").get() as { v: string } | undefined;
      const scope = messageScopeWhere(resolved, "m", [REAL_MESSAGE_WHERE]);
      const rows = db()
        .prepare(
          `
          SELECT m.ts, m.is_from_me, m.text, m.word_count, m.has_attachment
          FROM messages m
          ${scope.sql}
          ORDER BY m.ts ASC, m.id ASC
        `,
        )
        .all(...scope.args) as MessageRow[];

      const days = buildDailySeries(rows);
      const periods = buildPeriods(days);
      const lags = buildLags(days);
      const months = buildMonths(days);
      const windows = hydrateWindows(selectDistinctWindows(buildWindows(days), MAX_WINDOWS), resolved);
      const sameDaySynchrony = lags.find((lag) => lag.lag_days === 0)?.correlation ?? 0;
      const strongestLag = lags
        .filter((lag) => lag.lag_days !== 0)
        .slice()
        .sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation))[0];
      const topPeriod = periods[0];
      const recentWindow = windows
        .slice()
        .sort((a, b) => dayNumber(b.end_ymd) - dayNumber(a.end_ymd))[0];

      return {
        overview: {
          generated_at: generated?.v ?? "unknown",
          days: days.length,
          active_days: days.filter((day) => day.total > 0).length,
          messages: sum(days.map((day) => day.total)),
          strongest_period: topPeriod ? periodLabel(topPeriod.period_days) : "n/a",
          strongest_period_feature: topPeriod?.label ?? "n/a",
          strongest_lag: strongestLag ? lagPhrase(strongestLag) : "n/a",
          synchrony: round(sameDaySynchrony),
          current_tempo: recentWindow?.label ?? "n/a",
        },
        periods,
        lags,
        months,
        windows,
      };
    });
  });

function buildDailySeries(rows: MessageRow[]): DayPoint[] {
  if (rows.length === 0) return [];
  const first = dayNumber(bucket(rows[0].ts, "ymd"));
  const last = dayNumber(bucket(rows[rows.length - 1].ts, "ymd"));
  const days: DayPoint[] = [];
  const byDay = new Map<string, DayPoint>();

  for (let index = first; index <= last; index += 1) {
    const ymd = ymdFromDay(index);
    const day = {
      ymd,
      ym: ymd.slice(0, 7),
      index,
      total: 0,
      me: 0,
      them: 0,
      words: 0,
      attachments: 0,
      warmth: 0,
      strain: 0,
      care: 0,
      humor: 0,
    };
    days.push(day);
    byDay.set(ymd, day);
  }

  for (const row of rows) {
    const ymd = bucket(row.ts, "ymd");
    const day = byDay.get(ymd);
    if (!day) continue;
    const text = row.text ?? "";
    day.total += 1;
    day.words += row.word_count ?? wordCount(text);
    day.attachments += row.has_attachment ? 1 : 0;
    if (row.is_from_me === 1) day.me += 1;
    else day.them += 1;
    if (matchesLexicon(text, "warmth")) day.warmth += 1;
    if (matchesLexicon(text, "strain")) day.strain += 1;
    if (matchesLexicon(text, "care")) day.care += 1;
    if (matchesLexicon(text, "humor")) day.humor += 1;
  }

  return days;
}

const FEATURE_DEFS: FeatureDef[] = [
  { key: "volume", label: "Message volume", values: (day) => Math.log1p(day.total) },
  { key: "me", label: "Me volume", values: (day) => Math.log1p(day.me) },
  { key: "them", label: "Them volume", values: (day) => Math.log1p(day.them) },
  { key: "objects", label: "Object sharing", values: (day) => Math.log1p(day.attachments) },
  { key: "warmth", label: "Warmth language", values: (day) => Math.log1p(day.warmth + day.care + day.humor * 0.5) },
  { key: "strain", label: "Strain language", values: (day) => Math.log1p(day.strain) },
  { key: "balance", label: "Reciprocity balance", values: (day) => day.total ? 1 - Math.abs(day.me - day.them) / day.total : 0 },
];

function buildPeriods(days: DayPoint[]): RhythmPeriod[] {
  const periods: RhythmPeriod[] = [];
  for (const feature of FEATURE_DEFS) {
    const raw = days.map(feature.values);
    const detrended = zScore(subtractMovingAverage(raw, 45));
    const spectrum = periodSpectrum(detrended, 2, MAX_PERIOD_DAYS);
    const baseline = median(spectrum.map((point) => point.strength)) || 0.001;
    const selected: Array<{ period: number; strength: number }> = [];
    for (const point of spectrum.slice().sort((a, b) => b.strength - a.strength)) {
      if (selected.some((item) => Math.abs(item.period - point.period) <= Math.max(2, point.period * 0.07))) continue;
      selected.push(point);
      if (selected.length >= 2) break;
    }
    for (const point of selected) {
      periods.push({
        feature: feature.key,
        label: feature.label,
        period_days: point.period,
        strength: round(point.strength),
        baseline_strength: round(baseline),
        lift: round(point.strength / baseline),
        phase_label: phaseLabel(point.period),
        sparkline: sampleSparkline(raw, point.period),
      });
    }
  }
  return periods
    .sort((a, b) => b.lift - a.lift || b.strength - a.strength)
    .slice(0, MAX_PERIODS);
}

function buildLags(days: DayPoint[]): RhythmLag[] {
  const me = zScore(days.map((day) => Math.log1p(day.me)));
  const them = zScore(days.map((day) => Math.log1p(day.them)));
  const lags: RhythmLag[] = [];
  for (let lag = -14; lag <= 14; lag += 1) {
    const correlation = lagCorrelation(me, them, lag);
    lags.push({
      lag_days: lag,
      label: lag === 0 ? "same day" : `${Math.abs(lag)}d`,
      correlation: round(correlation),
      direction: lag > 0 ? "Me leads" : lag < 0 ? "Them leads" : "same day",
    });
  }
  return lags
    .sort((a, b) => a.lag_days - b.lag_days)
    .slice(Math.max(0, 29 - MAX_LAGS));
}

function buildMonths(days: DayPoint[]): RhythmMonth[] {
  const grouped = groupBy(days, (day) => day.ym);
  const months = [...grouped.entries()].map(([ym, monthDays]) => {
    const total = sum(monthDays.map((day) => day.total));
    const me = monthDays.map((day) => Math.log1p(day.me));
    const them = monthDays.map((day) => Math.log1p(day.them));
    const volume = monthDays.map((day) => Math.log1p(day.total));
    return {
      ym,
      total,
      active_days: monthDays.filter((day) => day.total > 0).length,
      synchrony: round(correlation(me, them)),
      weekly_memory: round(autocorrelation(volume, 7)),
      warmth_rate: round(per100(sum(monthDays.map((day) => day.warmth + day.care + day.humor * 0.5)), total)),
      strain_rate: round(per100(sum(monthDays.map((day) => day.strain)), total)),
      intensity_index: 0,
    };
  });
  const intensities = zScore(months.map((month) => Math.log1p(month.total)));
  return months.map((month, index) => ({
    ...month,
    intensity_index: round(intensities[index]),
  }));
}

function buildWindows(days: DayPoint[]): RhythmWindow[] {
  const windows: RhythmWindow[] = [];
  for (let start = 0; start + WINDOW_DAYS <= days.length; start += WINDOW_STEP_DAYS) {
    const slice = days.slice(start, start + WINDOW_DAYS);
    const messages = sum(slice.map((day) => day.total));
    if (messages < 70) continue;
    const volume = slice.map((day) => Math.log1p(day.total));
    const me = slice.map((day) => Math.log1p(day.me));
    const them = slice.map((day) => Math.log1p(day.them));
    const weeklyMemory = autocorrelation(volume, 7);
    const synchrony = correlation(me, them);
    const dominant = strongestShortPeriod(volume);
    const warmthRate = per100(sum(slice.map((day) => day.warmth + day.care + day.humor * 0.5)), messages);
    const strainRate = per100(sum(slice.map((day) => day.strain)), messages);
    const peak = slice.slice().sort((a, b) => b.total - a.total)[0];
    const score = Math.max(0, weeklyMemory) * 1.25 + Math.max(0, synchrony) + Math.log1p(messages) / 7 + Math.max(0, warmthRate - strainRate) / 26;
    windows.push({
      start_ymd: slice[0].ymd,
      end_ymd: slice[slice.length - 1].ymd,
      label: windowLabel(weeklyMemory, synchrony, warmthRate, strainRate),
      score: round(score),
      messages,
      active_days: slice.filter((day) => day.total > 0).length,
      synchrony: round(synchrony),
      weekly_memory: round(weeklyMemory),
      dominant_period_days: dominant,
      warmth_rate: round(warmthRate),
      strain_rate: round(strainRate),
      peak_ymd: peak.ymd,
      snippets: [],
    });
  }
  return windows.sort((a, b) => b.score - a.score || b.messages - a.messages);
}

function hydrateWindows(windows: RhythmWindow[], scope: MessageScope) {
  return windows.map((window) => ({
    ...window,
    snippets: snippetsForDay(window.peak_ymd, scope),
  }));
}

function selectDistinctWindows(windows: RhythmWindow[], limit: number) {
  const selected: RhythmWindow[] = [];
  const backups: RhythmWindow[] = [];

  for (const window of windows) {
    if (selected.every((existing) => windowOverlapRatio(window, existing) <= 0.35)) {
      selected.push(window);
    } else {
      backups.push(window);
    }
    if (selected.length >= limit) return selected;
  }

  for (const window of backups) {
    selected.push(window);
    if (selected.length >= limit) return selected;
  }

  return selected;
}

function windowOverlapRatio(left: RhythmWindow, right: RhythmWindow) {
  const start = Math.max(dayNumber(left.start_ymd), dayNumber(right.start_ymd));
  const end = Math.min(dayNumber(left.end_ymd), dayNumber(right.end_ymd));
  if (end < start) return 0;
  return (end - start + 1) / WINDOW_DAYS;
}

function periodSpectrum(values: number[], minPeriod: number, maxPeriod: number) {
  const spectrum: Array<{ period: number; strength: number }> = [];
  for (let period = minPeriod; period <= maxPeriod; period += 1) {
    let cos = 0;
    let sin = 0;
    const frequency = (Math.PI * 2) / period;
    for (let index = 0; index < values.length; index += 1) {
      const angle = frequency * index;
      cos += values[index] * Math.cos(angle);
      sin += values[index] * Math.sin(angle);
    }
    spectrum.push({ period, strength: Math.sqrt(cos * cos + sin * sin) / values.length });
  }
  return spectrum;
}

function strongestShortPeriod(values: number[]) {
  const spectrum = periodSpectrum(zScore(values), 3, 21);
  return spectrum.sort((a, b) => b.strength - a.strength)[0]?.period ?? 7;
}

function subtractMovingAverage(values: number[], radius: number) {
  return values.map((value, index) => {
    const start = Math.max(0, index - radius);
    const end = Math.min(values.length, index + radius + 1);
    const local = values.slice(start, end);
    return value - sum(local) / local.length;
  });
}

function sampleSparkline(values: number[], period: number) {
  const phaseBuckets = Array.from({ length: period }, () => [] as number[]);
  for (let index = 0; index < values.length; index += 1) {
    phaseBuckets[index % period].push(values[index]);
  }
  const phaseMeans = phaseBuckets.map((bucket) => bucket.length ? sum(bucket) / bucket.length : 0);
  const target = 24;
  if (phaseMeans.length <= target) return normalize01(phaseMeans).map(round);
  const sampled: number[] = [];
  for (let index = 0; index < target; index += 1) {
    const start = Math.floor((index / target) * phaseMeans.length);
    const end = Math.max(start + 1, Math.floor(((index + 1) / target) * phaseMeans.length));
    const slice = phaseMeans.slice(start, end);
    sampled.push(sum(slice) / slice.length);
  }
  return normalize01(sampled).map(round);
}

function snippetsForDay(ymd: string, scope: MessageScope): RhythmSnippet[] {
  const bounds = dayBounds(ymd);
  const snippetScope = messageScopeWhere(scope, "m", [
    REAL_MESSAGE_WHERE,
    "m.text IS NOT NULL",
    "trim(m.text) != ''",
  ]);
  const rows = db()
    .prepare(
      `
      SELECT m.ts, m.is_from_me, m.text
      FROM messages m
      ${snippetScope.sql}
        AND m.ts >= ?
        AND m.ts < ?
      ORDER BY m.word_count DESC, m.ts ASC
      LIMIT 4
    `,
    )
    .all(...snippetScope.args, bounds.start, bounds.end) as Array<{ ts: number; is_from_me: number; text: string | null }>;
  return rows
    .sort((a, b) => a.ts - b.ts)
    .slice(0, 3)
    .map((row) => ({
      ts: row.ts,
      sender: row.is_from_me === 1 ? "Me" : "Them",
      text: preview(row.text),
    }));
}

function lagCorrelation(left: number[], right: number[], lag: number) {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let index = 0; index < left.length; index += 1) {
    const j = index + lag;
    if (j < 0 || j >= right.length) continue;
    xs.push(left[index]);
    ys.push(right[j]);
  }
  return correlation(xs, ys);
}

function autocorrelation(values: number[], lag: number) {
  if (values.length <= lag + 3) return 0;
  return correlation(values.slice(0, values.length - lag), values.slice(lag));
}

function correlation(left: number[], right: number[]) {
  const n = Math.min(left.length, right.length);
  if (n < 3) return 0;
  const xs = left.slice(0, n);
  const ys = right.slice(0, n);
  const xMean = sum(xs) / n;
  const yMean = sum(ys) / n;
  let numerator = 0;
  let x2 = 0;
  let y2 = 0;
  for (let index = 0; index < n; index += 1) {
    const dx = xs[index] - xMean;
    const dy = ys[index] - yMean;
    numerator += dx * dy;
    x2 += dx * dx;
    y2 += dy * dy;
  }
  return x2 === 0 || y2 === 0 ? 0 : numerator / Math.sqrt(x2 * y2);
}

function zScore(values: number[]) {
  if (values.length === 0) return [];
  const mean = sum(values) / values.length;
  const variance = sum(values.map((value) => (value - mean) ** 2)) / values.length;
  const sd = Math.sqrt(variance) || 1;
  return values.map((value) => (value - mean) / sd);
}

function normalize01(values: number[]) {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 0.5);
  return values.map((value) => (value - min) / (max - min));
}

function groupBy<T>(items: T[], keyFn: (item: T) => string) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function per100(part: number, whole: number) {
  return whole ? (part / whole) * 100 : 0;
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

function wordCount(text: string) {
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

function dayNumber(ymd: string) {
  return Math.floor(Date.parse(`${ymd}T00:00:00Z`) / (DAY_SECONDS * 1000));
}

function ymdFromDay(day: number) {
  return new Date(day * DAY_SECONDS * 1000).toISOString().slice(0, 10);
}

function periodLabel(days: number) {
  if (days === 7) return "weekly";
  if (days < 7) return `${days}-day`;
  if (days < 31) return `${days}-day`;
  if (days < 80) return `${Math.round(days / 7)}-week`;
  return `${Math.round(days / 30)}-month`;
}

function phaseLabel(period: number) {
  if (period <= 4) return "micro-cycle";
  if (period <= 9) return "weekly beat";
  if (period <= 18) return "fortnight pulse";
  if (period <= 45) return "monthly tide";
  if (period <= 100) return "seasonal swell";
  return "long wave";
}

function lagPhrase(lag: RhythmLag) {
  if (lag.lag_days === 0) return "same-day synchrony";
  return `${lag.direction} by ${Math.abs(lag.lag_days)}d`;
}

function windowLabel(weekly: number, synchrony: number, warmth: number, strain: number) {
  if (synchrony > 0.68 && weekly > 0.28) return "phase-locked";
  if (warmth > strain * 2 && warmth > 8) return "warm cadence";
  if (strain > warmth && strain > 3.5) return "weathered rhythm";
  if (weekly > 0.35) return "weekly groove";
  if (synchrony > 0.72) return "same-day lock";
  return "high-tempo window";
}

function preview(text: string | null) {
  const cleaned = (text ?? "").replace(/\s+/g, " ").trim();
  return cleaned.length > 170 ? `${cleaned.slice(0, 167)}...` : cleaned;
}
