import { createServerFn } from "@tanstack/react-start";
import { realMessageWhere } from "~/lib/conversation/filters";
import { REPAIR_FLOW_LEXICON_KEYS, matchesLexicon } from "~/lib/conversation/lexicons";
import { messageScopeInput, messageScopeWhere } from "~/lib/conversation/scope";
import { senderFor, type Sender } from "~/lib/conversation/senders";
import { bucket } from "~/lib/conversation/time";
import { db, getDataGeneratedAt, withDbCache } from "~/lib/server-db";
import { resolveMessageScope } from "~/server/scope";

const REAL_MESSAGE_WHERE = realMessageWhere("browsable_message", "m");
const EPISODE_GAP_SECONDS = 2 * 60 * 60;
const RECOVERY_WINDOW_SECONDS = 24 * 60 * 60;
const FAST_RECOVERY_SECONDS = 6 * 60 * 60;
const MIN_EXAMPLE_RECOVERY_SECONDS = 30;

export type RecoveryKind = "repair" | "care" | "warmth" | "gratitude" | "humor";

export type RepairOverview = {
  generated_at: string;
  real_messages: number;
  strain_episodes: number;
  recovered_within_24h: number;
  recovery_rate: number;
  fast_recovery_rate: number;
  direct_repair_rate: number;
  median_recovery_seconds: number;
  me_first_move_share: number;
  them_first_move_share: number;
};

export type MonthlyRepair = {
  ym: string;
  episodes: number;
  recovered: number;
  direct_repairs: number;
  fast_recoveries: number;
  recovery_rate: number;
  median_recovery_seconds: number | null;
};

export type RepairMover = {
  sender: Sender;
  first_moves: number;
  direct_repairs: number;
  care_or_warmth: number;
  humor_softenings: number;
  median_recovery_seconds: number | null;
};

export type RepairEpisode = {
  id: number;
  start_ts: number;
  end_ts: number;
  ym: string;
  strain_sender: Sender;
  strain_messages: number;
  strain_preview: string;
  recovery_ts: number | null;
  recovery_sender: Sender | null;
  recovery_kind: RecoveryKind | null;
  recovery_seconds: number | null;
  recovery_preview: string | null;
  next_preview: string | null;
};

export type RepairResult = {
  overview: RepairOverview;
  monthly: MonthlyRepair[];
  movers: RepairMover[];
  fast_loops: RepairEpisode[];
  long_loops: RepairEpisode[];
  open_loops: RepairEpisode[];
};

type MessageRow = {
  id: number;
  ts: number;
  ym: string;
  is_from_me: number;
  text: string | null;
};

type LexiconKind = (typeof REPAIR_FLOW_LEXICON_KEYS)[number];

type ClassifiedMessage = {
  row: MessageRow;
  sender: Sender;
  text: string;
  kinds: LexiconKind[];
};

type EpisodeDraft = {
  id: number;
  startIndex: number;
  endIndex: number;
  strainRows: ClassifiedMessage[];
};

type MonthAccumulator = {
  ym: string;
  episodes: number;
  recovered: number;
  directRepairs: number;
  fastRecoveries: number;
  recoverySeconds: number[];
};

type MoverAccumulator = {
  sender: Sender;
  firstMoves: number;
  directRepairs: number;
  careOrWarmth: number;
  humorSoftenings: number;
  recoverySeconds: number[];
};

export const getRepair = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => messageScopeInput.parse(d ?? {}))
  .handler(async ({ data }): Promise<RepairResult> => {
    const resolved = resolveMessageScope(data);
    return withDbCache(`repair:${JSON.stringify(resolved)}`, () => {
    const scope = messageScopeWhere(resolved, "m", [REAL_MESSAGE_WHERE]);

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

    const classified = rows.map((row) => ({
      row,
      sender: senderFor(row.is_from_me),
      text: cleanText(row.text),
      kinds: classify(row.text ?? ""),
    }));

    const drafts = buildEpisodeDrafts(classified);
    const episodes = drafts.map((draft, index) => finalizeEpisode(draft, index, classified, drafts[index + 1]));
    const recovered = episodes.filter((episode) => episode.recovery_seconds !== null);
    const directRepairs = episodes.filter((episode) => episode.recovery_kind === "repair");
    const fastRecoveries = recovered.filter((episode) => (episode.recovery_seconds ?? Number.POSITIVE_INFINITY) <= FAST_RECOVERY_SECONDS);
    const recoverySeconds = recovered.map((episode) => episode.recovery_seconds ?? 0);
    const months = buildMonths(episodes);
    const movers = buildMovers(recovered);

    return {
      overview: {
        generated_at: getDataGeneratedAt(),
        real_messages: rows.length,
        strain_episodes: episodes.length,
        recovered_within_24h: recovered.length,
        recovery_rate: ratio(recovered.length, episodes.length),
        fast_recovery_rate: ratio(fastRecoveries.length, episodes.length),
        direct_repair_rate: ratio(directRepairs.length, episodes.length),
        median_recovery_seconds: median(recoverySeconds) ?? 0,
        me_first_move_share: ratio(movers.find((m) => m.sender === "me")?.first_moves ?? 0, recovered.length),
        them_first_move_share: ratio(movers.find((m) => m.sender === "them")?.first_moves ?? 0, recovered.length),
      },
      monthly: months,
      movers,
      fast_loops: recovered
        .filter((episode) => {
          const seconds = episode.recovery_seconds ?? 0;
          return seconds >= MIN_EXAMPLE_RECOVERY_SECONDS && seconds <= FAST_RECOVERY_SECONDS;
        })
        .sort((a, b) => (a.recovery_seconds ?? 0) - (b.recovery_seconds ?? 0))
        .slice(0, 8),
      long_loops: recovered
        .filter((episode) => (episode.recovery_seconds ?? 0) > FAST_RECOVERY_SECONDS)
        .sort((a, b) => (b.recovery_seconds ?? 0) - (a.recovery_seconds ?? 0))
        .slice(0, 8),
      open_loops: episodes
        .filter((episode) => episode.recovery_seconds === null)
        .sort((a, b) => b.strain_messages - a.strain_messages || b.start_ts - a.start_ts)
        .slice(0, 8),
    };
    });
  });

function buildEpisodeDrafts(messages: ClassifiedMessage[]): EpisodeDraft[] {
  const episodes: EpisodeDraft[] = [];
  let current: EpisodeDraft | null = null;

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (!message.kinds.includes("strain")) continue;
    if (!current || message.row.ts - messages[current.endIndex].row.ts > EPISODE_GAP_SECONDS) {
      current = {
        id: episodes.length + 1,
        startIndex: i,
        endIndex: i,
        strainRows: [message],
      };
      episodes.push(current);
    } else {
      current.endIndex = i;
      current.strainRows.push(message);
    }
  }

  return episodes;
}

function finalizeEpisode(
  draft: EpisodeDraft,
  index: number,
  messages: ClassifiedMessage[],
  nextDraft: EpisodeDraft | undefined,
): RepairEpisode {
  const first = draft.strainRows[0];
  const last = draft.strainRows[draft.strainRows.length - 1];
  const scanEndTs = Math.min(last.row.ts + RECOVERY_WINDOW_SECONDS, nextDraft ? messages[nextDraft.startIndex].row.ts : Number.POSITIVE_INFINITY);
  let recovery: ClassifiedMessage | null = null;
  let recoveryKind: RecoveryKind | null = null;
  let nextPreview: string | null = null;

  for (let i = draft.endIndex + 1; i < messages.length; i += 1) {
    const candidate = messages[i];
    if (candidate.row.ts > scanEndTs) break;
    if (candidate.row.ts <= last.row.ts) continue;
    if (!candidate.text) continue;
    if (!nextPreview && isUsefulPreview(candidate.text)) nextPreview = preview([candidate]);
    const kind = recoveryKindFor(candidate.kinds);
    if (kind) {
      recovery = candidate;
      recoveryKind = kind;
      break;
    }
  }

  return {
    id: index + 1,
    start_ts: first.row.ts,
    end_ts: last.row.ts,
    ym: first.row.ym,
    strain_sender: first.sender,
    strain_messages: draft.strainRows.length,
    strain_preview: preview(draft.strainRows),
    recovery_ts: recovery?.row.ts ?? null,
    recovery_sender: recovery?.sender ?? null,
    recovery_kind: recoveryKind,
    recovery_seconds: recovery ? recovery.row.ts - last.row.ts : null,
    recovery_preview: recovery ? preview([recovery]) : null,
    next_preview: nextPreview,
  };
}

function recoveryKindFor(kinds: LexiconKind[]): RecoveryKind | null {
  if (kinds.includes("repair")) return "repair";
  if (kinds.includes("care")) return "care";
  if (kinds.includes("warmth")) return "warmth";
  if (kinds.includes("gratitude")) return "gratitude";
  if (kinds.includes("humor")) return "humor";
  return null;
}

function buildMonths(episodes: RepairEpisode[]): MonthlyRepair[] {
  const months = new Map<string, MonthAccumulator>();
  for (const episode of episodes) {
    const slot = monthSlot(months, episode.ym);
    slot.episodes += 1;
    if (episode.recovery_seconds !== null) {
      slot.recovered += 1;
      slot.recoverySeconds.push(episode.recovery_seconds);
      if (episode.recovery_seconds <= FAST_RECOVERY_SECONDS) slot.fastRecoveries += 1;
    }
    if (episode.recovery_kind === "repair") slot.directRepairs += 1;
  }

  return [...months.values()]
    .sort((a, b) => a.ym.localeCompare(b.ym))
    .map((month) => ({
      ym: month.ym,
      episodes: month.episodes,
      recovered: month.recovered,
      direct_repairs: month.directRepairs,
      fast_recoveries: month.fastRecoveries,
      recovery_rate: ratio(month.recovered, month.episodes),
      median_recovery_seconds: median(month.recoverySeconds),
    }));
}

function buildMovers(episodes: RepairEpisode[]): RepairMover[] {
  const movers = new Map<Sender, MoverAccumulator>([
    ["me", moverSlot("me")],
    ["them", moverSlot("them")],
  ]);

  for (const episode of episodes) {
    if (!episode.recovery_sender || episode.recovery_seconds === null) continue;
    const slot = movers.get(episode.recovery_sender) ?? moverSlot(episode.recovery_sender);
    slot.firstMoves += 1;
    slot.recoverySeconds.push(episode.recovery_seconds);
    if (episode.recovery_kind === "repair") slot.directRepairs += 1;
    if (episode.recovery_kind === "care" || episode.recovery_kind === "warmth" || episode.recovery_kind === "gratitude") {
      slot.careOrWarmth += 1;
    }
    if (episode.recovery_kind === "humor") slot.humorSoftenings += 1;
    movers.set(episode.recovery_sender, slot);
  }

  return [...movers.values()].map((mover) => ({
    sender: mover.sender,
    first_moves: mover.firstMoves,
    direct_repairs: mover.directRepairs,
    care_or_warmth: mover.careOrWarmth,
    humor_softenings: mover.humorSoftenings,
    median_recovery_seconds: median(mover.recoverySeconds),
  }));
}

function monthSlot(months: Map<string, MonthAccumulator>, ym: string) {
  const existing = months.get(ym);
  if (existing) return existing;
  const created: MonthAccumulator = {
    ym,
    episodes: 0,
    recovered: 0,
    directRepairs: 0,
    fastRecoveries: 0,
    recoverySeconds: [],
  };
  months.set(ym, created);
  return created;
}

function moverSlot(sender: Sender): MoverAccumulator {
  return {
    sender,
    firstMoves: 0,
    directRepairs: 0,
    careOrWarmth: 0,
    humorSoftenings: 0,
    recoverySeconds: [],
  };
}

function classify(text: string): LexiconKind[] {
  return REPAIR_FLOW_LEXICON_KEYS.filter((kind) => matchesLexicon(text, kind));
}

function preview(messages: ClassifiedMessage[]) {
  const text = messages
    .map((message) => message.text)
    .filter(Boolean)
    .slice(0, 4)
    .join(" / ");
  return truncate(text, 260);
}

function cleanText(text: string | null) {
  return (text ?? "")
    .replace(/\s+/g, " ")
    .replace(/\uFFFC/g, "")
    .trim();
}

function isUsefulPreview(text: string) {
  if (!text) return false;
  return !/^https?:\/\/\S+$/i.test(text);
}

function truncate(text: string, maxChars: number) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1).trim()}...`;
}

function ratio(part: number, whole: number) {
  return whole ? part / whole : 0;
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
