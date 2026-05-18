import { createServerFn } from "@tanstack/react-start";
import { realMessageWhere } from "~/lib/conversation/filters";
import { messageScopeInput, messageScopeWhere } from "~/lib/conversation/scope";
import { db, getDataGeneratedAt, withDbCache } from "~/lib/server-db";
import { resolveMessageScope } from "~/server/scope";

const REAL_MESSAGE_WHERE = realMessageWhere("browsable_message", "m");
const REPLY_WINDOW_SECONDS = 48 * 60 * 60;
const FAST_CLOSE_SECONDS = 6 * 60 * 60;
const REOPEN_WINDOW_SECONDS = 12 * 60 * 60;

export type Sender = "Me" | "Them";
export type LoopStatus = "closed" | "delayed" | "reopened" | "open";
export type LoopKind = "question" | "logistics" | "invitation" | "repair" | "care" | "task";

export type OpenLoopOverview = {
  generated_at: string;
  real_messages: number;
  loops: number;
  closed: number;
  closure_rate: number;
  median_close_seconds: number | null;
  delayed: number;
  reopened: number;
  open: number;
  most_open_kind: string;
};

export type OpenLoopMonth = {
  ym: string;
  loops: number;
  closed: number;
  open: number;
  delayed: number;
  reopened: number;
  closure_rate: number;
};

export type OpenLoopKind = {
  kind: LoopKind;
  label: string;
  description: string;
  loops: number;
  closed: number;
  delayed: number;
  reopened: number;
  open: number;
  closure_rate: number;
  median_close_seconds: number | null;
  me_loops: number;
  them_loops: number;
  examples: OpenLoop[];
};

export type OpenLoopDay = {
  ymd: string;
  ts: number;
  loops: number;
  open: number;
  delayed: number;
  reopened: number;
  debt_score: number;
  examples: OpenLoop[];
};

export type ClosureToken = {
  token: string;
  closed_count: number;
  open_count: number;
  lift: number;
};

export type OpenLoop = {
  id: number;
  ts: number;
  ym: string;
  ymd: string;
  sender: Sender;
  kind: LoopKind;
  label: string;
  status: LoopStatus;
  preview: string;
  reply_preview: string | null;
  reply_ts: number | null;
  reply_ymd: string | null;
  reply_seconds: number | null;
  same_sender_followups: number;
  closure_score: number;
};

export type OpenLoopResult = {
  overview: OpenLoopOverview;
  months: OpenLoopMonth[];
  kinds: OpenLoopKind[];
  debt_days: OpenLoopDay[];
  closure_tokens: ClosureToken[];
  examples: OpenLoop[];
};

export type OpenLoopMessageRow = {
  id: number;
  ts: number;
  ym: string;
  ymd: string;
  is_from_me: number;
  word_count: number;
  text: string | null;
};

type LoopKindDefinition = {
  kind: LoopKind;
  label: string;
  description: string;
  matches: (text: string) => boolean;
};

type LoopAccumulator = {
  kind: LoopKind;
  label: string;
  description: string;
  loops: OpenLoop[];
};

type MonthAccumulator = {
  ym: string;
  loops: number;
  closed: number;
  open: number;
  delayed: number;
  reopened: number;
};

type DayAccumulator = {
  ymd: string;
  ts: number;
  loops: OpenLoop[];
};

const KIND_DEFINITIONS: LoopKindDefinition[] = [
  {
    kind: "repair",
    label: "Repair loops",
    description: "Apologies, clarifications, and attempts to resolve tension.",
    matches: (text) => /\b(sorry|apologize|apologise|forgive|my bad|didn'?t mean|can we talk|i understand|misunderstood)\b/i.test(text),
  },
  {
    kind: "care",
    label: "Care loops",
    description: "Checks about safety, sleep, food, health, feelings, or the day.",
    matches: (text) => /\b(how are you|how was your|are you ok|you okay|you ok|did you eat|sleep well|safe|feel better|checking in|take care)\b/i.test(text),
  },
  {
    kind: "invitation",
    label: "Invitation loops",
    description: "Requests to do something together or enter the same space.",
    matches: (text) => /\b(want to|wanna|should we|can we|come over|come by|hang out|go to|join me|with me|let'?s)\b/i.test(text),
  },
  {
    kind: "logistics",
    label: "Logistics loops",
    description: "Time, place, travel, pickup, scheduling, and concrete coordination.",
    matches: (text) => /\b(what time|when|where|which|schedule|reservation|pickup|pick up|drop off|meet|arrive|leaving|ride|address|tonight|tomorrow)\b/i.test(text),
  },
  {
    kind: "task",
    label: "Task loops",
    description: "Can-you, I-will, remind-me, and other lightweight obligations.",
    matches: (text) => /\b(can you|could you|would you|i'?ll|i will|remind me|need to|don'?t forget|please send|send me)\b/i.test(text),
  },
  {
    kind: "question",
    label: "Question loops",
    description: "Direct questions that put the next conversational move with the other person.",
    matches: (text) => text.includes("?") || /^(what|when|where|who|why|how|do you|did you|are you|can you|would you|could you)\b/i.test(text),
  },
];

const CLOSE_WORDS = new Set([
  "absolutely",
  "because",
  "cool",
  "done",
  "fine",
  "got",
  "great",
  "haha",
  "love",
  "maybe",
  "no",
  "okay",
  "ok",
  "sorry",
  "sure",
  "thank",
  "thanks",
  "understand",
  "yeah",
  "yep",
  "yes",
]);

export const getOpenLoops = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => messageScopeInput.parse(d ?? {}))
  .handler(async ({ data }): Promise<OpenLoopResult> => {
    const resolved = resolveMessageScope(data);
    return withDbCache(`open-loops:${JSON.stringify(resolved)}`, () => {
      const scanScope = { ...resolved, sender: "both" as const };
      const scope = messageScopeWhere(scanScope, "m", [REAL_MESSAGE_WHERE]);
      const rows = db()
        .prepare(
          `
          SELECT m.id, m.ts, m.ym, m.ymd, m.is_from_me, m.word_count, m.text
          FROM messages m
          ${scope.sql}
          ORDER BY m.ts ASC, m.id ASC
        `,
        )
        .all(...scope.args) as OpenLoopMessageRow[];

      const sourceRows = rows.filter((row) => senderMatches(row, resolved.sender));
      const loops = buildLoops(rows).filter((loop) => senderMatchesLoop(loop, resolved.sender));
      const closedLoops = loops.filter((loop) => loop.status === "closed");
      const closeSeconds = closedLoops
        .map((loop) => loop.reply_seconds)
        .filter((seconds): seconds is number => seconds != null);
      const kinds = buildKinds(loops);
      const mostOpenKind = kinds
        .slice()
        .sort((a, b) => b.open + b.reopened + b.delayed - (a.open + a.reopened + a.delayed) || b.loops - a.loops)[0];

      return {
        overview: {
          generated_at: getDataGeneratedAt(),
          real_messages: sourceRows.length,
          loops: loops.length,
          closed: closedLoops.length,
          closure_rate: rate(closedLoops.length, loops.length),
          median_close_seconds: median(closeSeconds),
          delayed: loops.filter((loop) => loop.status === "delayed").length,
          reopened: loops.filter((loop) => loop.status === "reopened").length,
          open: loops.filter((loop) => loop.status === "open").length,
          most_open_kind: mostOpenKind?.label ?? "n/a",
        },
        months: buildMonths(loops),
        kinds,
        debt_days: buildDebtDays(loops),
        closure_tokens: buildClosureTokens(loops),
        examples: loops
          .slice()
          .sort((a, b) => statusWeight(b.status) - statusWeight(a.status) || b.same_sender_followups - a.same_sender_followups || b.ts - a.ts)
          .slice(0, 18),
      };
    });
  });

export function buildLoops(rows: OpenLoopMessageRow[]): OpenLoop[] {
  const loops: OpenLoop[] = [];

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const preview = cleanPreview(row.text);
    const text = stripUrls(preview);
    if (text.length < 4) continue;
    const definition = classifyLoop(text);
    if (!definition) continue;

    const sender = senderFor(row);
    let reply: OpenLoopMessageRow | null = null;
    let sameSenderFollowups = 0;
    for (let nextIndex = index + 1; nextIndex < rows.length; nextIndex++) {
      const next = rows[nextIndex];
      const delta = next.ts - row.ts;
      if (delta > REPLY_WINDOW_SECONDS) break;
      if (senderFor(next) === sender) {
        if (delta <= REOPEN_WINDOW_SECONDS && classifyLoop(stripUrls(cleanPreview(next.text)))?.kind === definition.kind) {
          sameSenderFollowups++;
        }
        continue;
      }
      reply = next;
      break;
    }

    const replySeconds = reply ? reply.ts - row.ts : null;
    const replyPreview = reply ? cleanPreview(reply.text) : null;
    const closureScore = scoreClosure(definition.kind, replyPreview, reply?.word_count ?? 0);
    const status = loopStatus(replySeconds, sameSenderFollowups, closureScore);

    loops.push({
      id: row.id,
      ts: row.ts,
      ym: row.ym,
      ymd: row.ymd,
      sender,
      kind: definition.kind,
      label: definition.label,
      status,
      preview,
      reply_preview: replyPreview,
      reply_ts: reply?.ts ?? null,
      reply_ymd: reply?.ymd ?? null,
      reply_seconds: replySeconds,
      same_sender_followups: sameSenderFollowups,
      closure_score: round(closureScore),
    });
  }

  return loops;
}

function classifyLoop(text: string) {
  return KIND_DEFINITIONS.find((definition) => definition.matches(text));
}

function loopStatus(replySeconds: number | null, sameSenderFollowups: number, closureScore: number): LoopStatus {
  if (replySeconds == null) return "open";
  if (sameSenderFollowups > 0 && (replySeconds > FAST_CLOSE_SECONDS || closureScore < 0.75)) return "reopened";
  if (replySeconds <= FAST_CLOSE_SECONDS && closureScore >= 0.55) return "closed";
  if (closureScore >= 0.75) return "closed";
  return "delayed";
}

function scoreClosure(kind: LoopKind, reply: string | null, wordCount: number) {
  if (!reply) return 0;
  const lower = reply.toLowerCase();
  const tokens = tokenize(lower);
  let score = Math.min(0.45, wordCount / 30);
  if (tokens.some((token) => CLOSE_WORDS.has(token))) score += 0.28;
  if (/\b(yes|yeah|yep|no|nope|sure|ok|okay|maybe)\b/i.test(lower)) score += 0.22;
  if (kind === "logistics" && /\b(\d{1,2}(:\d{2})?|am|pm|there|here|home|address|tonight|tomorrow|today)\b/i.test(lower)) score += 0.28;
  if (kind === "repair" && /\b(sorry|understand|okay|ok|love|thank|forgive|safe)\b/i.test(lower)) score += 0.34;
  if (kind === "care" && /\b(ok|okay|better|good|safe|sleep|ate|home|thank|love)\b/i.test(lower)) score += 0.26;
  if (kind === "invitation" && /\b(yes|yeah|sure|lets|let'?s|can|cant|come|go|maybe|tonight|tomorrow)\b/i.test(lower)) score += 0.3;
  if (kind === "task" && /\b(done|will|sent|send|yes|yeah|sure|can|cant|remind|got)\b/i.test(lower)) score += 0.3;
  return Math.min(1, score);
}

function buildKinds(loops: OpenLoop[]): OpenLoopKind[] {
  const accumulators = new Map<LoopKind, LoopAccumulator>();
  for (const definition of KIND_DEFINITIONS) {
    accumulators.set(definition.kind, {
      kind: definition.kind,
      label: definition.label,
      description: definition.description,
      loops: [],
    });
  }
  for (const loop of loops) {
    accumulators.get(loop.kind)?.loops.push(loop);
  }

  return [...accumulators.values()]
    .map((accumulator) => {
      const closed = accumulator.loops.filter((loop) => loop.status === "closed");
      const closeSeconds = closed
        .map((loop) => loop.reply_seconds)
        .filter((seconds): seconds is number => seconds != null);
      return {
        kind: accumulator.kind,
        label: accumulator.label,
        description: accumulator.description,
        loops: accumulator.loops.length,
        closed: closed.length,
        delayed: accumulator.loops.filter((loop) => loop.status === "delayed").length,
        reopened: accumulator.loops.filter((loop) => loop.status === "reopened").length,
        open: accumulator.loops.filter((loop) => loop.status === "open").length,
        closure_rate: rate(closed.length, accumulator.loops.length),
        median_close_seconds: median(closeSeconds),
        me_loops: accumulator.loops.filter((loop) => loop.sender === "Me").length,
        them_loops: accumulator.loops.filter((loop) => loop.sender === "Them").length,
        examples: accumulator.loops
          .slice()
          .sort((a, b) => statusWeight(b.status) - statusWeight(a.status) || b.same_sender_followups - a.same_sender_followups)
          .slice(0, 2),
      };
    })
    .filter((kind) => kind.loops > 0)
    .sort((a, b) => b.loops - a.loops);
}

function buildMonths(loops: OpenLoop[]): OpenLoopMonth[] {
  const months = new Map<string, MonthAccumulator>();
  for (const loop of loops) {
    const month = months.get(loop.ym) ?? { ym: loop.ym, loops: 0, closed: 0, open: 0, delayed: 0, reopened: 0 };
    month.loops++;
    if (loop.status === "closed") month.closed++;
    if (loop.status === "open") month.open++;
    if (loop.status === "delayed") month.delayed++;
    if (loop.status === "reopened") month.reopened++;
    months.set(loop.ym, month);
  }

  return [...months.values()]
    .sort((a, b) => a.ym.localeCompare(b.ym))
    .map((month) => ({
      ym: month.ym,
      loops: month.loops,
      closed: month.closed,
      open: month.open,
      delayed: month.delayed,
      reopened: month.reopened,
      closure_rate: rate(month.closed, month.loops),
    }));
}

function buildDebtDays(loops: OpenLoop[]): OpenLoopDay[] {
  const days = new Map<string, DayAccumulator>();
  for (const loop of loops) {
    const day = days.get(loop.ymd) ?? { ymd: loop.ymd, ts: ymdToTs(loop.ymd), loops: [] };
    day.loops.push(loop);
    days.set(loop.ymd, day);
  }

  return [...days.values()]
    .map((day) => {
      const open = day.loops.filter((loop) => loop.status === "open").length;
      const delayed = day.loops.filter((loop) => loop.status === "delayed").length;
      const reopened = day.loops.filter((loop) => loop.status === "reopened").length;
      return {
        ymd: day.ymd,
        ts: day.ts,
        loops: day.loops.length,
        open,
        delayed,
        reopened,
        debt_score: open * 2 + reopened * 1.5 + delayed + Math.max(0, day.loops.length - 4) * 0.35,
        examples: day.loops
          .slice()
          .sort((a, b) => statusWeight(b.status) - statusWeight(a.status))
          .slice(0, 3),
      };
    })
    .filter((day) => day.open + day.reopened + day.delayed > 0)
    .sort((a, b) => b.debt_score - a.debt_score || b.loops - a.loops)
    .slice(0, 14);
}

function buildClosureTokens(loops: OpenLoop[]): ClosureToken[] {
  const closed = new Map<string, number>();
  const open = new Map<string, number>();
  for (const loop of loops) {
    const target = loop.status === "closed" || loop.status === "delayed" ? closed : open;
    const text = stripUrls(loop.reply_preview ?? loop.preview);
    for (const token of new Set(tokenize(text))) {
      if (token.length < 3 || STOPWORDS.has(token)) continue;
      target.set(token, (target.get(token) ?? 0) + 1);
    }
  }
  const closedTotal = sumMap(closed);
  const openTotal = sumMap(open);
  return [...closed.entries()]
    .map(([token, closedCount]) => {
      const openCount = open.get(token) ?? 0;
      const lift = ((closedCount + 0.5) / (closedTotal + 10)) / ((openCount + 0.5) / (openTotal + 10));
      return { token, closed_count: closedCount, open_count: openCount, lift: round(lift) };
    })
    .filter((token) => token.closed_count >= 5 && token.lift > 1.5)
    .sort((a, b) => b.lift - a.lift || b.closed_count - a.closed_count)
    .slice(0, 18);
}

const STOPWORDS = new Set([
  "and",
  "are",
  "but",
  "can",
  "did",
  "for",
  "from",
  "have",
  "here",
  "just",
  "like",
  "not",
  "okay",
  "really",
  "that",
  "the",
  "this",
  "was",
  "with",
  "you",
  "your",
]);

function senderFor(row: OpenLoopMessageRow): Sender {
  return row.is_from_me ? "Me" : "Them";
}

function senderMatches(row: OpenLoopMessageRow, sender: "me" | "them" | "both" = "both") {
  if (sender === "both") return true;
  return sender === "me" ? row.is_from_me === 1 : row.is_from_me === 0;
}

function senderMatchesLoop(loop: OpenLoop, sender: "me" | "them" | "both" = "both") {
  if (sender === "both") return true;
  return sender === "me" ? loop.sender === "Me" : loop.sender === "Them";
}

function tokenize(text: string) {
  return text.toLowerCase().replace(/[']/g, "").match(/[a-z0-9]{2,}/g) ?? [];
}

function cleanPreview(text: string | null) {
  return (text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function stripUrls(text: string) {
  return text
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\b[a-z0-9.-]+\.(com|ca|org|net|app|io|dev|co)\/?\S*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function statusWeight(status: LoopStatus) {
  if (status === "open") return 4;
  if (status === "reopened") return 3;
  if (status === "delayed") return 2;
  return 1;
}

function ymdToTs(ymd: string) {
  const [year, month, day] = ymd.split("-").map(Number);
  return Date.UTC(year, month - 1, day, 12) / 1000;
}

function rate(part: number, whole: number) {
  return whole ? part / whole : 0;
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function sumMap(map: Map<string, number>) {
  let total = 0;
  for (const value of map.values()) total += value;
  return total;
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}
