import { createServerFn } from "@tanstack/react-start";
import { realMessageWhere } from "~/lib/conversation/filters";
import { messageScopeInput, messageScopeWhere } from "~/lib/conversation/scope";
import { senderFor, type Sender } from "~/lib/conversation/senders";
import { bucket } from "~/lib/conversation/time";
import { db, getDataGeneratedAt, withDbCache } from "~/lib/server-db";
import { resolveMessageScope } from "~/server/scope";

export type { Sender } from "~/lib/conversation/senders";

const REAL_MESSAGE_WHERE = realMessageWhere("browsable_message", "m");
const REPLY_WINDOW_SECONDS = 24 * 60 * 60;
const RESTART_GAP_SECONDS = 6 * 60 * 60;
const LULL_MIN_END_TS = Math.floor(Date.UTC(2022, 0, 1) / 1000);

export type DynamicsOverview = {
  generated_at: string;
  real_messages: number;
  turns: number;
  median_me_reply_seconds: number | null;
  median_them_reply_seconds: number | null;
  me_restart_share: number;
  avg_me_run_messages: number;
  avg_them_run_messages: number;
  longest_lull_seconds: number;
};

export type MonthlyDynamics = {
  ym: string;
  total: number;
  me_messages: number;
  them_messages: number;
  me_share: number;
  median_me_reply_seconds: number | null;
  median_them_reply_seconds: number | null;
  me_restarts: number;
  them_restarts: number;
  me_restart_share: number | null;
  avg_me_run_messages: number | null;
  avg_them_run_messages: number | null;
};

export type LullRecovery = {
  start_ts: number;
  end_ts: number;
  gap_seconds: number;
  reopened_by: Sender;
  previous_sender: Sender;
  preview: string;
};

export type LongRun = {
  start_ts: number;
  end_ts: number;
  sender: Sender;
  n_messages: number;
  words: number;
  duration_seconds: number;
  preview: string;
};

export type DynamicsOverviewResult = {
  overview: DynamicsOverview;
  monthly: MonthlyDynamics[];
  lulls: LullRecovery[];
  runs: LongRun[];
};

type MessageRow = {
  id: number;
  ts: number;
  is_from_me: number;
  word_count: number;
  text: string | null;
};

type MonthAccumulator = {
  ym: string;
  total: number;
  meMessages: number;
  themMessages: number;
  meReplies: number[];
  themReplies: number[];
  meRestarts: number;
  themRestarts: number;
  meRuns: number[];
  themRuns: number[];
};

export const getDynamics = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => messageScopeInput.parse(d ?? {}))
  .handler(async ({ data }): Promise<DynamicsOverviewResult> => {
    const resolved = resolveMessageScope(data);
    return withDbCache(`dynamics:${JSON.stringify(resolved)}`, () => {
    const scope = messageScopeWhere(resolved, "m", [REAL_MESSAGE_WHERE]);

    const rows = db()
      .prepare(
        `
        SELECT m.id, m.ts, m.is_from_me, m.word_count, m.text
        FROM messages m
        ${scope.sql}
        ORDER BY m.ts ASC
      `,
      )
      .all(...scope.args) as MessageRow[];

    const months = new Map<string, MonthAccumulator>();
    const meReplies: number[] = [];
    const themReplies: number[] = [];
    const lulls: LullRecovery[] = [];
    const runs: LongRun[] = [];
    let meRestarts = 0;
    let themRestarts = 0;

    let currentRun: LongRun | null = null;
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const sender = senderFor(row.is_from_me);
      const month = monthSlot(months, bucket(row.ts, "ym"));
      month.total += 1;
      if (sender === "me") month.meMessages += 1;
      else month.themMessages += 1;

      const previous = rows[i - 1];
      if (previous) {
        const gap = row.ts - previous.ts;
        const previousSender = senderFor(previous.is_from_me);
        if (previousSender !== sender && gap <= REPLY_WINDOW_SECONDS) {
          if (sender === "me") {
            meReplies.push(gap);
            month.meReplies.push(gap);
          } else {
            themReplies.push(gap);
            month.themReplies.push(gap);
          }
        }

        if (gap >= RESTART_GAP_SECONDS) {
          if (sender === "me") {
            meRestarts += 1;
            month.meRestarts += 1;
          } else {
            themRestarts += 1;
            month.themRestarts += 1;
          }
        }

        lulls.push({
          start_ts: previous.ts,
          end_ts: row.ts,
          gap_seconds: gap,
          reopened_by: sender,
          previous_sender: previousSender,
          preview: cleanPreview(row.text),
        });

        if (currentRun && currentRun.sender === sender) {
          currentRun.end_ts = row.ts;
          currentRun.n_messages += 1;
          currentRun.words += row.word_count;
          currentRun.duration_seconds = row.ts - currentRun.start_ts;
          if (currentRun.preview.length < 220 && row.text) {
            currentRun.preview = joinPreview(currentRun.preview, row.text);
          }
        } else {
          if (currentRun) {
            runs.push(currentRun);
            const runMonth = monthSlot(months, ymFromTs(currentRun.start_ts));
            if (currentRun.sender === "me") runMonth.meRuns.push(currentRun.n_messages);
            else runMonth.themRuns.push(currentRun.n_messages);
          }
          currentRun = {
            start_ts: row.ts,
            end_ts: row.ts,
            sender,
            n_messages: 1,
            words: row.word_count,
            duration_seconds: 0,
            preview: cleanPreview(row.text),
          };
        }
      } else {
        currentRun = {
          start_ts: row.ts,
          end_ts: row.ts,
          sender,
          n_messages: 1,
          words: row.word_count,
          duration_seconds: 0,
          preview: cleanPreview(row.text),
        };
      }
    }
    if (currentRun) {
      runs.push(currentRun);
      const runMonth = monthSlot(months, ymFromTs(currentRun.start_ts));
      if (currentRun.sender === "me") runMonth.meRuns.push(currentRun.n_messages);
      else runMonth.themRuns.push(currentRun.n_messages);
    }

    const meRuns = runs.filter((r) => r.sender === "me").map((r) => r.n_messages);
    const themRuns = runs.filter((r) => r.sender === "them").map((r) => r.n_messages);
    const totalRestarts = meRestarts + themRestarts;
    const sortedLulls = lulls
      .filter((l) => l.end_ts >= LULL_MIN_END_TS)
      .sort((a, b) => b.gap_seconds - a.gap_seconds);

    const result = {
      overview: {
        generated_at: getDataGeneratedAt(),
        real_messages: rows.length,
        turns: runs.length,
        median_me_reply_seconds: median(meReplies),
        median_them_reply_seconds: median(themReplies),
        me_restart_share: totalRestarts ? meRestarts / totalRestarts : 0,
        avg_me_run_messages: average(meRuns),
        avg_them_run_messages: average(themRuns),
        longest_lull_seconds: sortedLulls[0]?.gap_seconds ?? 0,
      },
      monthly: [...months.values()]
        .sort((a, b) => a.ym.localeCompare(b.ym))
        .slice(1)
        .map((m) => {
          const restarts = m.meRestarts + m.themRestarts;
          return {
            ym: m.ym,
            total: m.total,
            me_messages: m.meMessages,
            them_messages: m.themMessages,
            me_share: m.total ? m.meMessages / m.total : 0,
            median_me_reply_seconds: median(m.meReplies),
            median_them_reply_seconds: median(m.themReplies),
            me_restarts: m.meRestarts,
            them_restarts: m.themRestarts,
            me_restart_share: restarts ? m.meRestarts / restarts : null,
            avg_me_run_messages: m.meRuns.length ? average(m.meRuns) : null,
            avg_them_run_messages: m.themRuns.length ? average(m.themRuns) : null,
          };
        }),
      lulls: sortedLulls.slice(0, 15),
      runs: runs
        .filter((r) => r.n_messages >= 5)
        .sort((a, b) => b.n_messages - a.n_messages || b.words - a.words)
        .slice(0, 18),
    };
    return result;
    });
  },
);

function monthSlot(months: Map<string, MonthAccumulator>, ym: string) {
  const existing = months.get(ym);
  if (existing) return existing;
  const created: MonthAccumulator = {
    ym,
    total: 0,
    meMessages: 0,
    themMessages: 0,
    meReplies: [],
    themReplies: [],
    meRestarts: 0,
    themRestarts: 0,
    meRuns: [],
    themRuns: [],
  };
  months.set(ym, created);
  return created;
}

function median(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function average(values: number[]) {
  if (values.length === 0) return 0;
  return Math.round((values.reduce((sum, n) => sum + n, 0) / values.length) * 100) / 100;
}

function cleanPreview(text: string | null) {
  return (text ?? "No text body")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 260);
}

function joinPreview(current: string, next: string) {
  const cleaned = cleanPreview(next);
  if (!cleaned || cleaned === "No text body") return current;
  return `${current} • ${cleaned}`.slice(0, 260);
}

function ymFromTs(ts: number) {
  return bucket(ts, "ym");
}
