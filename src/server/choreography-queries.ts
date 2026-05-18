import { createServerFn } from "@tanstack/react-start";
import { realMessageWhere } from "~/lib/conversation/filters";
import { messageScopeInput, messageScopeWhere, type MessageScope } from "~/lib/conversation/scope";
import { bucket } from "~/lib/conversation/time";
import { db, getDataGeneratedAt, withDbCache } from "~/lib/server-db";
import { resolveMessageScope } from "~/server/scope";
import { classifyMove, type MoveKind as ClassifiedMoveKind } from "./move-classifier";

const REAL_MESSAGE_WHERE = realMessageWhere("browsable_message", "m");
const EPISODE_GAP_SECONDS = 2 * 60 * 60;
const PATH_LENGTH = 3;
const MIN_PATH_COUNT = 10;
const TOP_PATHS = 24;
const TOP_TRANSITIONS = 18;
const MAX_CONTEXT_MOVES = 8;
const MIN_PREDICTION_SUPPORT = 6;
const TOP_PREDICTIONS = 8;

export type Sender = "Me" | "Them";
export type MoveKind =
  | "affection"
  | "care"
  | "question"
  | "logistics"
  | "play"
  | "object"
  | "repair"
  | "strain"
  | "gratitude"
  | "status"
  | "ambient";
type DisplayMoveKind = Exclude<MoveKind, "object" | "gratitude" | "ambient">;

export type ChoreographyOverview = {
  generated_at: string;
  real_messages: number;
  episodes: number;
  duet_episodes: number;
  collapsed_moves: number;
  recurring_paths: number;
  strongest_path: string;
  top_transition: string;
};

export type ChoreographyMonth = {
  ym: string;
  episodes: number;
  moves: number;
  affection: number;
  care: number;
  question: number;
  logistics: number;
  play: number;
  repair: number;
  strain: number;
  status: number;
  max_path_score: number;
};

export type ChoreographyStep = {
  sender: Sender;
  kind: MoveKind;
  label: string;
};

export type ChoreographyExample = ChoreographyStep & {
  ts: number;
  ymd: string;
  text: string;
};

export type ChoreographyPath = {
  key: string;
  steps: ChoreographyStep[];
  count: number;
  lift: number;
  score: number;
  episode_months: number;
  examples: ChoreographyExample[][];
};

export type ChoreographyTransition = {
  from: MoveKind;
  to: MoveKind;
  from_label: string;
  to_label: string;
  count: number;
  lift: number;
  examples: ChoreographyExample[][];
};

export type ChoreographyPredictionOption = {
  kind: MoveKind;
  label: string;
  probability: number;
  count: number;
  lift: number;
};

export type ChoreographyPrediction = {
  key: string;
  context: ChoreographyStep[];
  support: number;
  entropy: number;
  next: ChoreographyPredictionOption[];
  examples: ChoreographyExample[][];
};

export type ChoreographyResult = {
  overview: ChoreographyOverview;
  months: ChoreographyMonth[];
  paths: ChoreographyPath[];
  transitions: ChoreographyTransition[];
  predictions: ChoreographyPrediction[];
};

type MessageRow = {
  id: number;
  ts: number;
  ym: string;
  ymd: string;
  is_from_me: number;
  has_attachment: number;
  text: string | null;
};

type Move = {
  id: number;
  ts: number;
  ym: string;
  ymd: string;
  sender: Sender;
  kind: MoveKind;
  text: string;
};

type Episode = {
  id: number;
  ym: string;
  startTs: number;
  endTs: number;
  moves: Move[];
};

type PathAccumulator = {
  steps: ChoreographyStep[];
  count: number;
  months: Set<string>;
  examples: ChoreographyExample[][];
};

type TransitionAccumulator = {
  from: MoveKind;
  to: MoveKind;
  count: number;
  examples: ChoreographyExample[][];
};

type PredictionAccumulator = {
  key: string;
  context: ChoreographyStep[];
  support: number;
  nextCounts: Map<MoveKind, number>;
  examples: ChoreographyExample[][];
  lastTs: number;
};

const MOVE_META: Record<MoveKind, { label: string; description: string }> = {
  affection: { label: "Affection", description: "Love, missing, tenderness, and direct warmth." },
  care: { label: "Care", description: "Checking on sleep, safety, health, feelings, and the day." },
  question: { label: "Question", description: "Direct bids for information or response." },
  logistics: { label: "Logistics", description: "Plans, times, rides, food, locations, and coordination." },
  play: { label: "Play", description: "Jokes, games, laughter, riffs, and low-friction sparks." },
  object: { label: "Object", description: "Photos, links, screenshots, attachments, and look-at-this drops." },
  repair: { label: "Repair", description: "Apologies, clarification, accountability, and meta repair." },
  strain: { label: "Strain", description: "Stress, sadness, anxiety, frustration, fatigue, and hurt." },
  gratitude: { label: "Gratitude", description: "Thanks, appreciation, and explicit recognition." },
  status: { label: "Status", description: "Current state, movement, arrivals, and ordinary updates." },
  ambient: { label: "Ambient", description: "Everything that keeps the thread alive without a sharper move." },
};

const DISPLAY_KINDS: DisplayMoveKind[] = ["affection", "care", "question", "logistics", "play", "repair", "strain", "status"];

export const getChoreography = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => messageScopeInput.parse(d ?? {}))
  .handler(async ({ data }): Promise<ChoreographyResult> => {
    const resolved = resolveMessageScope(data);
    return withDbCache(`choreography:${JSON.stringify(resolved)}`, () => {
      const scanScope = { ...resolved, sender: "both" as const };
      const scope = messageScopeWhere(scanScope, "m", [REAL_MESSAGE_WHERE]);
      const rawRows = db()
        .prepare(
          `
          SELECT m.id, m.ts, m.ymd, m.is_from_me, m.has_attachment, m.text
          FROM messages m
          ${scope.sql}
          ORDER BY m.ts ASC, m.id ASC
        `,
        )
        .all(...scope.args) as Array<Omit<MessageRow, "ym">>;
      const rows: MessageRow[] = rawRows.map((row) => ({ ...row, ym: bucket(row.ts, "ym") }));

      const rawMoves = rows.map(toMove).filter((move): move is Move => move != null);
      const episodes = buildEpisodes(rawMoves).filter((episode) => episodeMatchesSender(episode, resolved.sender));
      const months = buildMonths(episodes);
      const { paths, transitions } = mineSequences(episodes, months);
      const predictions = buildPredictions(episodes);

      return {
        overview: {
          generated_at: getDataGeneratedAt(),
          real_messages: rows.filter((row) => senderMatches(senderFor(row), resolved.sender)).length,
          episodes: episodes.length,
          duet_episodes: episodes.filter(hasBothSenders).length,
          collapsed_moves: episodes.reduce((sum, episode) => sum + episode.moves.length, 0),
          recurring_paths: paths.length,
          strongest_path: paths[0]?.steps.map((step) => step.label).join(" -> ") ?? "n/a",
          top_transition: transitions[0] ? `${MOVE_META[transitions[0].from].label} -> ${MOVE_META[transitions[0].to].label}` : "n/a",
        },
        months,
        paths,
        transitions,
        predictions,
      };
    });
  });

function toMove(row: MessageRow): Move | null {
  const text = cleanPreview(row.text);
  if (!text && row.has_attachment !== 1) return null;
  const kind = toChoreographyKind(classifyMove(row).kind);
  return {
    id: row.id,
    ts: row.ts,
    ym: row.ym,
    ymd: row.ymd,
    sender: row.is_from_me === 1 ? "Me" : "Them",
    kind,
    text: text || "[attachment]",
  };
}

function toChoreographyKind(kind: ClassifiedMoveKind): MoveKind {
  if (kind === "vulnerable") return "strain";
  if (kind === "arrival") return "status";
  return kind;
}

function buildEpisodes(moves: Move[]): Episode[] {
  const episodes: Episode[] = [];
  let current: Move[] = [];
  let episodeId = 0;

  for (const move of moves) {
    const previous = current[current.length - 1];
    if (previous && move.ts - previous.ts > EPISODE_GAP_SECONDS) {
      pushEpisode(episodes, episodeId, current);
      episodeId += 1;
      current = [];
    }
    current.push(move);
  }
  pushEpisode(episodes, episodeId, current);
  return episodes.filter((episode) => episode.moves.length >= PATH_LENGTH && hasBothSenders(episode));
}

function pushEpisode(episodes: Episode[], id: number, moves: Move[]) {
  const collapsed = collapseMoves(moves);
  if (collapsed.length < PATH_LENGTH) return;
  episodes.push({
    id,
    ym: collapsed[0].ym,
    startTs: collapsed[0].ts,
    endTs: collapsed[collapsed.length - 1].ts,
    moves: collapsed,
  });
}

function collapseMoves(moves: Move[]): Move[] {
  const collapsed: Move[] = [];
  for (const move of moves) {
    const previous = collapsed[collapsed.length - 1];
    if (previous && previous.sender === move.sender && previous.kind === move.kind) {
      previous.text = move.text.length > previous.text.length ? move.text : previous.text;
      previous.ts = move.ts;
      continue;
    }
    collapsed.push({ ...move });
  }
  return collapsed;
}

function hasBothSenders(episode: Episode) {
  return episode.moves.some((move) => move.sender === "Me") && episode.moves.some((move) => move.sender === "Them");
}

function buildMonths(episodes: Episode[]): ChoreographyMonth[] {
  const months = new Map<string, ChoreographyMonth>();
  for (const episode of episodes) {
    const month = months.get(episode.ym) ?? {
      ym: episode.ym,
      episodes: 0,
      moves: 0,
      affection: 0,
      care: 0,
      question: 0,
      logistics: 0,
      play: 0,
      repair: 0,
      strain: 0,
      status: 0,
      max_path_score: 0,
    };
    month.episodes += 1;
    month.moves += episode.moves.length;
    for (const move of episode.moves) {
      if (isDisplayKind(move.kind)) month[move.kind] += 1;
    }
    months.set(episode.ym, month);
  }
  return [...months.values()].sort((a, b) => a.ym.localeCompare(b.ym));
}

function isDisplayKind(kind: MoveKind): kind is DisplayMoveKind {
  return (DISPLAY_KINDS as readonly MoveKind[]).includes(kind);
}

function mineSequences(episodes: Episode[], months: ChoreographyMonth[]) {
  const pathStats = new Map<string, PathAccumulator>();
  const transitionStats = new Map<string, TransitionAccumulator>();
  const stepCounts = new Map<string, number>();
  let totalMoves = 0;
  let totalWindows = 0;
  let totalTransitions = 0;

  for (const episode of episodes) {
    for (const move of episode.moves) {
      stepCounts.set(stepKey(move), (stepCounts.get(stepKey(move)) ?? 0) + 1);
      totalMoves += 1;
    }

    for (let i = 0; i <= episode.moves.length - PATH_LENGTH; i += 1) {
      const window = episode.moves.slice(i, i + PATH_LENGTH);
      const key = window.map(stepKey).join(">");
      const existing = pathStats.get(key) ?? {
        steps: window.map(toStep),
        count: 0,
        months: new Set<string>(),
        examples: [],
      };
      existing.count += 1;
      existing.months.add(episode.ym);
      if (existing.examples.length < 2) existing.examples.push(window.map(toExample));
      pathStats.set(key, existing);
      totalWindows += 1;
    }

    for (let i = 0; i < episode.moves.length - 1; i += 1) {
      const from = episode.moves[i];
      const to = episode.moves[i + 1];
      const key = `${from.kind}>${to.kind}`;
      const existing = transitionStats.get(key) ?? {
        from: from.kind,
        to: to.kind,
        count: 0,
        examples: [],
      };
      existing.count += 1;
      if (existing.examples.length < 2) existing.examples.push([toExample(from), toExample(to)]);
      transitionStats.set(key, existing);
      totalTransitions += 1;
    }
  }

  const vocabSize = Math.max(1, stepCounts.size);
  const paths = [...pathStats.entries()]
    .filter(([, stat]) => stat.count >= MIN_PATH_COUNT)
    .map(([key, stat]) => {
      const expected = totalWindows * stat.steps.reduce((product, step) => product * (((stepCounts.get(stepKey(step)) ?? 0) + 1) / (totalMoves + vocabSize)), 1);
      const lift = stat.count / Math.max(expected, 0.001);
      const score = Math.log2(Math.max(lift, 1)) * Math.sqrt(stat.count) + stat.count / 80;
      return {
        key,
        steps: stat.steps,
        count: stat.count,
        lift: round(lift),
        score: round(score),
        episode_months: stat.months.size,
        examples: stat.examples,
      };
    })
    .filter((path) => path.lift >= 1.25 && path.steps.filter((step) => step.kind !== "ambient").length >= 2 && !isObjectOnlyPath(path.steps))
    .sort((a, b) => b.score - a.score || b.count - a.count)
    .slice(0, TOP_PATHS);

  const moveKindCounts = new Map<MoveKind, number>();
  for (const countKey of stepCounts.keys()) {
    const kind = countKey.split(":")[1] as MoveKind;
    moveKindCounts.set(kind, (moveKindCounts.get(kind) ?? 0) + (stepCounts.get(countKey) ?? 0));
  }

  const transitions = [...transitionStats.values()]
    .filter((transition) => transition.count >= 25)
    .map((transition) => {
      const fromCount = moveKindCounts.get(transition.from) ?? 0;
      const toCount = moveKindCounts.get(transition.to) ?? 0;
      const expected = (fromCount * toCount) / Math.max(totalMoves, 1);
      return {
        from: transition.from,
        to: transition.to,
        from_label: MOVE_META[transition.from].label,
        to_label: MOVE_META[transition.to].label,
        count: transition.count,
        lift: round(transition.count / Math.max(expected, 0.001)),
        examples: transition.examples,
      };
    })
    .filter((transition) => transition.lift >= 1.08 && transition.from !== "ambient" && transition.to !== "ambient")
    .sort((a, b) => b.lift * Math.sqrt(b.count) - a.lift * Math.sqrt(a.count))
    .slice(0, TOP_TRANSITIONS);

  for (const month of months) {
    month.max_path_score = Math.max(
      0,
      ...paths.filter((path) => path.examples.some((examples) => examples[0]?.ts && month.ym === ymFromTs(examples[0].ts))).map((path) => path.score),
    );
  }

  return { paths, transitions };
}

function buildPredictions(episodes: Episode[]): ChoreographyPrediction[] {
  const baseCounts = new Map<MoveKind, number>();
  const contexts = new Map<string, PredictionAccumulator>();
  let totalMoves = 0;

  for (const episode of episodes) {
    for (const move of episode.moves) {
      baseCounts.set(move.kind, (baseCounts.get(move.kind) ?? 0) + 1);
      totalMoves += 1;
    }

    for (let index = 1; index < episode.moves.length; index += 1) {
      const next = episode.moves[index];
      const maxContext = Math.min(MAX_CONTEXT_MOVES, index);
      for (let length = 2; length <= maxContext; length += 1) {
        const contextMoves = episode.moves.slice(index - length, index);
        if (contextMoves.every((move) => move.kind === "ambient")) continue;
        const key = contextMoves.map(stepKey).join(">");
        const accumulator = contexts.get(key) ?? {
          key,
          context: contextMoves.map(toStep),
          support: 0,
          nextCounts: new Map<MoveKind, number>(),
          examples: [],
          lastTs: 0,
        };
        accumulator.support += 1;
        accumulator.nextCounts.set(next.kind, (accumulator.nextCounts.get(next.kind) ?? 0) + 1);
        accumulator.lastTs = Math.max(accumulator.lastTs, next.ts);
        if (accumulator.examples.length < 2) accumulator.examples.push([...contextMoves, next].map(toExample));
        contexts.set(key, accumulator);
      }
    }
  }

  return [...contexts.values()]
    .filter((context) => context.support >= MIN_PREDICTION_SUPPORT)
    .map((context) => predictionFromAccumulator(context, baseCounts, totalMoves))
    .filter((prediction): prediction is ChoreographyPrediction => prediction != null)
    .sort((a, b) => predictionScore(b) - predictionScore(a) || b.support - a.support)
    .slice(0, TOP_PREDICTIONS);
}

function predictionFromAccumulator(
  context: PredictionAccumulator,
  baseCounts: Map<MoveKind, number>,
  totalMoves: number,
): ChoreographyPrediction | null {
  const next = [...context.nextCounts.entries()]
    .map(([kind, count]) => {
      const probability = count / context.support;
      const baseRate = (baseCounts.get(kind) ?? 0) / Math.max(totalMoves, 1);
      return {
        kind,
        label: MOVE_META[kind].label,
        probability: round(probability),
        count,
        lift: round(baseRate ? probability / baseRate : 0),
      };
    })
    .sort((a, b) => b.probability - a.probability || b.count - a.count)
    .slice(0, 4);

  const top = next[0];
  if (!top || top.count < 3 || top.probability < 0.38) return null;

  return {
    key: context.key,
    context: context.context,
    support: context.support,
    entropy: round(entropy([...context.nextCounts.values()])),
    next,
    examples: context.examples,
  };
}

function predictionScore(prediction: ChoreographyPrediction) {
  const top = prediction.next[0];
  const contextBonus = Math.min(prediction.context.length, 5) / 5;
  return (top?.probability ?? 0) * Math.log1p(prediction.support) * (1 + contextBonus) * Math.max(top?.lift ?? 0, 0.1);
}

function toStep(move: Move | ChoreographyStep): ChoreographyStep {
  return {
    sender: move.sender,
    kind: move.kind,
    label: MOVE_META[move.kind].label,
  };
}

function toExample(move: Move): ChoreographyExample {
  return {
    ...toStep(move),
    ts: move.ts,
    ymd: move.ymd,
    text: move.text,
  };
}

function senderFor(row: MessageRow): Sender {
  return row.is_from_me === 1 ? "Me" : "Them";
}

function senderMatches(sender: Sender, scopeSender: MessageScope["sender"]) {
  if (scopeSender === "me") return sender === "Me";
  if (scopeSender === "them") return sender === "Them";
  return true;
}

function episodeMatchesSender(episode: Episode, scopeSender: MessageScope["sender"]) {
  const first = episode.moves[0];
  return first ? senderMatches(first.sender, scopeSender) : true;
}

function stepKey(move: Move | ChoreographyStep) {
  return `${move.sender === "Me" ? "A" : "S"}:${move.kind}`;
}

function isObjectOnlyPath(steps: ChoreographyStep[]) {
  const nonAmbientKinds = new Set(steps.filter((step) => step.kind !== "ambient").map((step) => step.kind));
  return nonAmbientKinds.size === 1 && nonAmbientKinds.has("object");
}

function cleanPreview(text: string | null) {
  return (text ?? "").replace(/\s+/g, " ").trim().slice(0, 220);
}

function ymFromTs(ts: number) {
  return new Date(ts * 1000).toLocaleDateString("en-CA", {
    year: "numeric",
    month: "2-digit",
    timeZone: "America/Vancouver",
  });
}

function entropy(counts: number[]) {
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (!total) return 0;
  return counts.reduce((sum, count) => {
    if (!count) return sum;
    const p = count / total;
    return sum - p * Math.log2(p);
  }, 0);
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}
