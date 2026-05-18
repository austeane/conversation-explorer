import { createServerFn } from "@tanstack/react-start";
import { realMessageWhere } from "~/lib/conversation/filters";
import { AFFECT_LEXICON_KEYS, matchesLexicon } from "~/lib/conversation/lexicons";
import { messageScopeInput, messageScopeWhere } from "~/lib/conversation/scope";
import { senderFor, type Sender } from "~/lib/conversation/senders";
import { bucket } from "~/lib/conversation/time";
import { db, withDbCache } from "~/lib/server-db";
import { resolveMessageScope } from "~/server/scope";

const REAL_MESSAGE_WHERE = realMessageWhere("browsable_message", "m");
const SUPPORT_WINDOW_SECONDS = 6 * 60 * 60;

export type WeatherOverview = {
  generated_at: string;
  real_messages: number;
  months_analyzed: number;
  affect_messages: number;
  support_rate: number;
  warmest_month: string;
  stormiest_month: string;
};

export type MonthlyWeather = {
  ym: string;
  total: number;
  warmth: number;
  strain: number;
  repair: number;
  gratitude: number;
  care: number;
  humor: number;
  warmth_rate: number;
  strain_rate: number;
  repair_rate: number;
  gratitude_rate: number;
  care_rate: number;
  humor_rate: number;
  support_rate: number | null;
  weather_index: number;
};

export type WeatherMonth = MonthlyWeather & {
  label: string;
  examples: WeatherExample[];
};

export type WeatherExample = {
  ts: number;
  sender: Sender;
  kind: string;
  text: string;
};

export type WeatherResult = {
  overview: WeatherOverview;
  monthly: MonthlyWeather[];
  warm_months: WeatherMonth[];
  storm_months: WeatherMonth[];
  repair_months: WeatherMonth[];
  gratitude_months: WeatherMonth[];
  care_months: WeatherMonth[];
  humor_months: WeatherMonth[];
};

type MessageRow = {
  id: number;
  ts: number;
  ym: string;
  is_from_me: number;
  text: string | null;
};

type MonthAccumulator = {
  ym: string;
  total: number;
  warmth: number;
  strain: number;
  repair: number;
  gratitude: number;
  care: number;
  humor: number;
  supportOpportunities: number;
  supports: number;
  examples: WeatherExample[];
};

type WeatherLexiconKind = (typeof AFFECT_LEXICON_KEYS)[number];

export const getWeather = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => messageScopeInput.parse(d ?? {}))
  .handler(async ({ data }): Promise<WeatherResult> => {
    const resolved = resolveMessageScope(data);
    return withDbCache(`weather:${JSON.stringify(resolved)}`, () => {
      const scope = messageScopeWhere(resolved, "m", [REAL_MESSAGE_WHERE]);
      const generated = db().prepare("SELECT v FROM meta WHERE k = 'generated_at'").get() as { v: string } | undefined;

      const rawRows = db()
        .prepare(
          `
        SELECT m.id, m.ts, m.is_from_me, m.text
        FROM messages m
        ${scope.sql}
        ORDER BY m.ts ASC, m.id ASC
      `,
        )
        .all(...scope.args) as Array<Omit<MessageRow, "ym">>;
      const rows: MessageRow[] = rawRows.map((row) => ({ ...row, ym: bucket(row.ts, "ym") }));

      const months = new Map<string, MonthAccumulator>();
      let affectMessages = 0;

      const classified = rows.map((row) => {
        const kinds = classify(row.text ?? "");
        if (kinds.length > 0) affectMessages += 1;
        const month = monthSlot(months, row.ym);
        month.total += 1;
        for (const kind of kinds) {
          month[kind] += 1;
          pushExample(month, row, kind);
        }
        return { row, kinds };
      });

      for (let i = 0; i < classified.length; i += 1) {
        const item = classified[i];
        if (!item.kinds.includes("strain")) continue;
        const responder = findSupportResponse(classified, i);
        const month = monthSlot(months, item.row.ym);
        month.supportOpportunities += 1;
        if (responder) month.supports += 1;
      }

      const monthly = [...months.values()]
        .sort((a, b) => a.ym.localeCompare(b.ym))
        .map(monthResult);
      const warmMonths = monthCards(monthly, months, "warmth").slice(0, 6);
      const stormMonths = monthCards(monthly, months, "strain").slice(0, 6);
      const repairMonths = monthCards(monthly, months, "repair").slice(0, 6);
      const gratitudeMonths = monthCards(monthly, months, "gratitude").slice(0, 6);
      const careMonths = monthCards(monthly, months, "care").slice(0, 6);
      const humorMonths = monthCards(monthly, months, "humor").slice(0, 6);
      const supportTotals = [...months.values()].reduce(
        (acc, month) => {
          acc.opportunities += month.supportOpportunities;
          acc.supports += month.supports;
          return acc;
        },
        { opportunities: 0, supports: 0 },
      );

      return {
        overview: {
          generated_at: generated?.v ?? "unknown",
          real_messages: rows.length,
          months_analyzed: monthly.length,
          affect_messages: affectMessages,
          support_rate: supportTotals.opportunities ? supportTotals.supports / supportTotals.opportunities : 0,
          warmest_month: warmMonths[0]?.ym ?? "n/a",
          stormiest_month: stormMonths[0]?.ym ?? "n/a",
        },
        monthly,
        warm_months: warmMonths,
        storm_months: stormMonths,
        repair_months: repairMonths,
        gratitude_months: gratitudeMonths,
        care_months: careMonths,
        humor_months: humorMonths,
      };
    });
  });

function classify(text: string): WeatherLexiconKind[] {
  return AFFECT_LEXICON_KEYS.filter((kind) => matchesLexicon(text, kind));
}

function findSupportResponse(classified: Array<{ row: MessageRow; kinds: WeatherLexiconKind[] }>, index: number) {
  const source = classified[index].row;
  for (let i = index + 1; i < classified.length; i += 1) {
    const candidate = classified[i];
    const gap = candidate.row.ts - source.ts;
    if (gap > SUPPORT_WINDOW_SECONDS) return null;
    if (candidate.row.is_from_me === source.is_from_me) continue;
    if (candidate.kinds.some((kind) => kind === "care" || kind === "warmth" || kind === "repair" || kind === "gratitude")) {
      return candidate;
    }
    return null;
  }
  return null;
}

function monthSlot(months: Map<string, MonthAccumulator>, ym: string) {
  const existing = months.get(ym);
  if (existing) return existing;
  const created: MonthAccumulator = {
    ym,
    total: 0,
    warmth: 0,
    strain: 0,
    repair: 0,
    gratitude: 0,
    care: 0,
    humor: 0,
    supportOpportunities: 0,
    supports: 0,
    examples: [],
  };
  months.set(ym, created);
  return created;
}

function monthResult(month: MonthAccumulator): MonthlyWeather {
  const warmthRate = per100(month.warmth, month.total);
  const strainRate = per100(month.strain, month.total);
  const repairRate = per100(month.repair, month.total);
  const gratitudeRate = per100(month.gratitude, month.total);
  const careRate = per100(month.care, month.total);
  const humorRate = per100(month.humor, month.total);
  return {
    ym: month.ym,
    total: month.total,
    warmth: month.warmth,
    strain: month.strain,
    repair: month.repair,
    gratitude: month.gratitude,
    care: month.care,
    humor: month.humor,
    warmth_rate: round(warmthRate),
    strain_rate: round(strainRate),
    repair_rate: round(repairRate),
    gratitude_rate: round(gratitudeRate),
    care_rate: round(careRate),
    humor_rate: round(humorRate),
    support_rate: month.supportOpportunities ? round(month.supports / month.supportOpportunities) : null,
    weather_index: round((warmthRate + (careRate + gratitudeRate + humorRate) * 0.45) - strainRate * 0.9 + repairRate * 0.35),
  };
}

function monthCards(
  monthly: MonthlyWeather[],
  months: Map<string, MonthAccumulator>,
  kind: WeatherLexiconKind,
): WeatherMonth[] {
  return [...monthly]
    .filter((month) => month.total >= 200)
    .sort((a, b) => weatherRate(b, kind) - weatherRate(a, kind))
    .map((month) => ({
      ...month,
      label: kind,
      examples: (months.get(month.ym)?.examples ?? []).filter((example) => example.kind === kind).slice(0, 3),
    }));
}

function weatherRate(month: MonthlyWeather, kind: WeatherLexiconKind) {
  if (kind === "warmth") return month.warmth_rate;
  if (kind === "strain") return month.strain_rate;
  if (kind === "repair") return month.repair_rate;
  if (kind === "gratitude") return month.gratitude_rate;
  if (kind === "care") return month.care_rate;
  return month.humor_rate;
}

function pushExample(month: MonthAccumulator, row: MessageRow, kind: WeatherLexiconKind) {
  if (month.examples.filter((example) => example.kind === kind).length >= 3) return;
  const text = cleanPreview(row.text);
  if (!text) return;
  month.examples.push({
    ts: row.ts,
    sender: senderFor(row.is_from_me),
    kind,
    text,
  });
}

function cleanPreview(text: string | null) {
  return (text ?? "").replace(/\s+/g, " ").trim().slice(0, 220);
}

function per100(count: number, total: number) {
  return total ? (count / total) * 100 : 0;
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}
