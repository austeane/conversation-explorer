import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { realMessageWhere } from "~/lib/conversation/filters";
import { messageScopeInput, messageScopeWhere } from "~/lib/conversation/scope";
import { bucket } from "~/lib/conversation/time";
import { db, getDataGeneratedAt, withDbCache } from "~/lib/server-db";
import { confidenceFor, type Confidence, type MethodMeta } from "~/lib/method";
import type { EvidenceRef } from "~/components/EvidenceLink";
import type { InsightFraming } from "~/routes/_meta";
import { buildLoops } from "~/server/open-loop-queries";
import { resolveMessageScope } from "~/server/scope";

const REAL_MESSAGE_WHERE = realMessageWhere("text_turn", "m");
const DAY = 86400;
const RECENT_WINDOW_DAYS = 90;
const SUPPORT_WINDOW_SECONDS = 6 * 60 * 60;
type SenderFilter = "me" | "them" | "both";

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

export type InsightCard = {
  framing: InsightFraming;
  headline: string;
  subhead: string;
  body: string;
  method: MethodMeta;
  sampleSize: number;
  confidence: Confidence;
  evidence: EvidenceRef[];
  sourceRoute: string;
  metric?: string;
};

export type InsightResult = {
  generated_at: string;
  last_ymd: string;
  cards: InsightCard[];
};

const insightInput = messageScopeInput.extend({
  sensitive: z.boolean().optional().default(false),
  evidenceOnly: z.boolean().optional().default(false),
});

export const getInsights = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => insightInput.parse(d ?? {}))
  .handler(async ({ data }): Promise<InsightResult> => {
    const resolved = resolveMessageScope(data);
    return withDbCache(`insights:${JSON.stringify(resolved)}`, () => {
      const contextScope = { ...resolved, sender: "both" as const };
      const scope = messageScopeWhere(contextScope, "m", [REAL_MESSAGE_WHERE]);

      const rawRows = db()
        .prepare(
          `
          SELECT id, ts, ymd, ym, is_from_me, word_count, has_attachment, text
          FROM messages m
          ${scope.sql}
          ORDER BY ts ASC, id ASC
        `,
        )
        .all(...scope.args) as MessageRow[];
      const rows = rawRows.map((row) => ({ ...row, ymd: bucket(row.ts, "ymd"), ym: bucket(row.ts, "ym") }));
      const sourceRows = rows.filter((row) => matchesSender(row, resolved.sender));

      if (sourceRows.length === 0) {
        const empty = {
          generated_at: getDataGeneratedAt(),
          last_ymd: "",
          cards: [],
        } satisfies InsightResult;
        return empty;
      }

      let cards = [
        buildVolumeShiftCard(sourceRows),
        buildRhythmCard(sourceRows),
        buildSupportCard(rows, resolved.sender),
        buildOpenLoopDebtCard(rows, resolved.sender),
        buildSilenceCard(sourceRows),
      ];

      if (resolved.evidenceOnly) cards = cards.filter((card) => card.evidence.length > 0);

      const result = {
        generated_at: getDataGeneratedAt(),
        last_ymd: sourceRows[sourceRows.length - 1].ymd,
        cards,
      } satisfies InsightResult;
      return result;
    });
  });

function buildVolumeShiftCard(rows: MessageRow[]): InsightCard {
  const lastTs = rows[rows.length - 1].ts;
  const recentStart = lastTs - RECENT_WINDOW_DAYS * DAY;
  const priorStart = lastTs - RECENT_WINDOW_DAYS * 2 * DAY;
  const recent = rows.filter((row) => row.ts >= recentStart);
  const prior = rows.filter((row) => row.ts >= priorStart && row.ts < recentStart);
  const recentPerDay = recent.length / RECENT_WINDOW_DAYS;
  const priorPerDay = prior.length / RECENT_WINDOW_DAYS;
  const delta = priorPerDay === 0 ? 0 : (recentPerDay - priorPerDay) / priorPerDay;
  const direction = delta >= 0 ? "busier" : "quieter";
  const method = {
    kind: "descriptive",
    sample: recent.length + prior.length,
    version: "insights-runtime-v1",
  } satisfies MethodMeta;

  return {
    framing: "changed",
    headline: `The last ${RECENT_WINDOW_DAYS} days are ${Math.abs(delta * 100).toFixed(0)}% ${direction}`,
    subhead: "Recent message volume compared with the prior 90-day window.",
    body: `Recent pace is ${recentPerDay.toFixed(1)} messages per day versus ${priorPerDay.toFixed(1)} before it. This is descriptive volume only, not an explanation for why the pace changed.`,
    method,
    sampleSize: method.sample,
    confidence: confidenceFor(method),
    evidence: evidenceFromRows(recent, 4),
    sourceRoute: "/timeline",
    metric: `${recent.length.toLocaleString("en-US")} recent messages`,
  };
}

function buildRhythmCard(rows: MessageRow[]): InsightCard {
  const slots = new Map<string, { label: string; n: number; rows: MessageRow[] }>();
  for (const row of rows) {
    const date = new Date(row.ts * 1000);
    const label = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Vancouver",
      weekday: "long",
      hour: "numeric",
      hour12: true,
    }).format(date);
    const slot = slots.get(label) ?? { label, n: 0, rows: [] };
    slot.n += 1;
    if (slot.rows.length < 8) slot.rows.push(row);
    slots.set(label, slot);
  }
  const peak = [...slots.values()].sort((a, b) => b.n - a.n)[0];
  const method = {
    kind: "descriptive",
    sample: rows.length,
    version: "insights-runtime-v1",
  } satisfies MethodMeta;

  return {
    framing: "repeats",
    headline: `${peak.label} is the strongest recurring time slot`,
    subhead: "Messages grouped by Vancouver weekday and hour.",
    body: `${peak.n.toLocaleString("en-US")} messages land in this slot. It is a recurring clock pattern, not proof that the slot is emotionally or practically special by itself.`,
    method,
    sampleSize: method.sample,
    confidence: confidenceFor(method),
    evidence: evidenceFromRows(peak.rows, 4),
    sourceRoute: "/timeline",
    metric: `${peak.n.toLocaleString("en-US")} messages`,
  };
}

function buildSupportCard(rows: MessageRow[], sender: SenderFilter): InsightCard {
  const strainIndexes: number[] = [];
  const supportedRows: MessageRow[] = [];

  rows.forEach((row, index) => {
    if (!matchesSender(row, sender)) return;
    if (!isStrain(row.text ?? "")) return;
    strainIndexes.push(index);
    const support = findNextOther(rows, index, SUPPORT_WINDOW_SECONDS, (candidate) => isSupport(candidate.text ?? ""));
    if (support) supportedRows.push(support);
  });

  const rate = strainIndexes.length ? supportedRows.length / strainIndexes.length : 0;
  const method = {
    kind: "heuristic",
    sample: strainIndexes.length,
    version: "lexicon-runtime-v0",
    caveats: ["Windowed lexicon match", "No negation or sarcasm handling yet"],
  } satisfies MethodMeta;

  return {
    framing: "helps",
    headline: `${(rate * 100).toFixed(0)}% of${senderPhrase(sender)} strain signals get a supportive reply within 6 hours`,
    subhead: "A lightweight support-after-strain check using the current affect lexicons.",
    body: "Care, warmth, repair, and gratitude count as supportive replies here. This is a useful orientation signal, but it still needs the planned shared lexicon and eval gate before it should be treated as calibrated.",
    method,
    sampleSize: method.sample,
    confidence: confidenceFor(method),
    evidence: evidenceFromRows(supportedRows, 5),
    sourceRoute: "/repair",
    metric: `${supportedRows.length.toLocaleString("en-US")} supported strain messages`,
  };
}

function buildOpenLoopDebtCard(rows: MessageRow[], sender: SenderFilter): InsightCard {
  const loops = buildLoops(rows).filter((loop) => matchesLoopSender(loop.sender, sender));
  const unresolved = loops.filter((loop) => loop.status === "open" || loop.status === "reopened" || loop.status === "delayed");
  const pressureRate = loops.length ? unresolved.length / loops.length : 0;
  const kindCounts = new Map<string, number>();
  for (const loop of unresolved) {
    kindCounts.set(loop.label, (kindCounts.get(loop.label) ?? 0) + 1);
  }
  const topKind = [...kindCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Open loops";
  const method = {
    kind: "heuristic",
    sample: loops.length,
    version: "open-loop-v1",
    caveats: ["Regex-classified obligations", "Closure is inferred from reply timing and same-sender follow-up"],
  } satisfies MethodMeta;

  return {
    framing: "missed",
    headline: `${(pressureRate * 100).toFixed(0)}% of${senderPhrase(sender)} obligations stay delayed, reopened, or open`,
    subhead: "Open-loop pressure from questions, repairs, care checks, invitations, logistics, and small tasks.",
    body: `${topKind} are the largest unresolved bucket in this slice. This is a stronger missed-signal proxy than a bare question-mark check because it tracks delayed replies and same-sender follow-ups before closure.`,
    method,
    sampleSize: method.sample,
    confidence: confidenceFor(method),
    evidence: unresolved.slice(0, 5).map((loop) => ({
      label: `${loop.ymd} ${loop.label}`,
      date: loop.ymd,
      ids: [loop.id],
      note: loop.preview,
      sender: sender === "both" ? undefined : sender,
    })),
    sourceRoute: "/open-loops",
    metric: `${unresolved.length.toLocaleString("en-US")} unresolved loops`,
  };
}

function buildSilenceCard(rows: MessageRow[]): InsightCard {
  let longest: { before: MessageRow; after: MessageRow; gap: number } | null = null;
  for (let i = 1; i < rows.length; i += 1) {
    const gap = rows[i].ts - rows[i - 1].ts;
    if (!longest || gap > longest.gap) longest = { before: rows[i - 1], after: rows[i], gap };
  }

  const days = longest ? longest.gap / DAY : 0;
  const method = {
    kind: "descriptive",
    sample: rows.length,
    version: "insights-runtime-v1",
  } satisfies MethodMeta;

  return {
    framing: "discuss",
    headline: `The longest silence before a restart was ${days.toFixed(0)} days`,
    subhead: "Largest gap between adjacent real messages.",
    body: "Long gaps are often better prompts than conclusions. This card points to a concrete before-and-after moment that may be worth reading in context.",
    method,
    sampleSize: method.sample,
    confidence: confidenceFor(method),
    evidence: longest ? evidenceFromRows([longest.before, longest.after], 2) : [],
    sourceRoute: "/dynamics",
    metric: `${days.toFixed(1)} days`,
  };
}

function findNextOther(
  rows: MessageRow[],
  index: number,
  windowSeconds: number,
  predicate: (row: MessageRow) => boolean = () => true,
) {
  const source = rows[index];
  for (let i = index + 1; i < rows.length; i += 1) {
    const candidate = rows[i];
    if (candidate.ts - source.ts > windowSeconds) return null;
    if (candidate.is_from_me === source.is_from_me) continue;
    return predicate(candidate) ? candidate : null;
  }
  return null;
}

function evidenceFromRows(rows: MessageRow[], limit: number): EvidenceRef[] {
  const selected: MessageRow[] = [];
  const seenDates = new Set<string>();
  for (const row of rows) {
    if (seenDates.has(row.ymd) && selected.length < limit - 1) continue;
    selected.push(row);
    seenDates.add(row.ymd);
    if (selected.length >= limit) break;
  }
  return selected.map((row) => ({
    label: row.ymd,
    date: row.ymd,
    ids: [row.id],
    note: preview(row.text),
  }));
}

function isStrain(text: string) {
  return /\b(sad|anxious|anxiety|worried|worry|scared|afraid|hurt|cry|crying|upset|stress|stressed|hard|tired|exhausted|lonely|overwhelmed|frustrated)\b/i.test(text);
}

function isSupport(text: string) {
  return /\b(sorry|apologize|apologise|forgive|my bad|understand|love|miss|proud|sweet|hope you|you okay|you ok|feel better|sleep well|safe|take care|thank you|thanks|appreciate|grateful)\b/i.test(text);
}

function matchesSender(row: Pick<MessageRow, "is_from_me">, sender: SenderFilter) {
  if (sender === "me") return row.is_from_me === 1;
  if (sender === "them") return row.is_from_me === 0;
  return true;
}

function matchesLoopSender(sender: "Me" | "Them", filter: SenderFilter) {
  if (filter === "me") return sender === "Me";
  if (filter === "them") return sender === "Them";
  return true;
}

function senderPhrase(sender: SenderFilter) {
  if (sender === "me") return " Me's";
  if (sender === "them") return " Them's";
  return "";
}

function preview(text: string | null) {
  const cleaned = (text ?? "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "Open in browse";
  return cleaned.length > 72 ? `${cleaned.slice(0, 69)}...` : cleaned;
}
