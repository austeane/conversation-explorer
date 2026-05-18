import { createServerFn } from "@tanstack/react-start";
import { realMessageWhere } from "~/lib/conversation/filters";
import { z } from "zod";
import { parseSignals } from "~/lib/conversation/signals";
import { messageScopeInput, messageScopeWhere } from "~/lib/conversation/scope";
import { bucket } from "~/lib/conversation/time";
import { db, withDbCache } from "~/lib/server-db";
import { resolveMessageScope } from "~/server/scope";

const REAL_MESSAGE_WHERE = realMessageWhere("text_turn", "m");
const SEXUAL_THRESHOLD = 2.3;
const ROMANTIC_THRESHOLD = 2.3;
const EPISODE_GAP_SECONDS = 6 * 3600;
const CONTEXT_SECONDS = 20 * 60;
const MAX_EPISODES = 14;

export type DesireSignalBucket = "desire" | "explicit" | "kink" | "media" | "play" | "care";

export type DesireOverview = {
  generated_at: string;
  messages_scored: number;
  sexual_messages: number;
  sexual_episodes: number;
  active_months: number;
  peak_month: string;
  current_phase: string;
  me_initiation_share: number;
};

export type DesireMonth = {
  ym: string;
  total_messages: number;
  sexual_messages: number;
  romantic_messages: number;
  sexual_score: number;
  romantic_score: number;
  me_score: number;
  them_score: number;
  me_initiations: number;
  them_initiations: number;
  signal_desire: number;
  signal_explicit: number;
  signal_kink: number;
  signal_media: number;
  signal_play: number;
  signal_care: number;
};

export type DesireEra = {
  label: string;
  start_ym: string;
  end_ym: string;
  months: number;
  sexual_score: number;
  sexual_messages: number;
  me_share: number;
  dominant_signal: string;
  note: string;
};

export type DesireSnippet = {
  msg_id: number;
  ts: number;
  sender: "Me" | "Them";
  text: string;
  sexual_score: number;
};

export type DesireEpisode = {
  key: string;
  start_ts: number;
  end_ts: number;
  ym: string;
  duration_minutes: number;
  sexual_messages: number;
  total_context_messages: number;
  intensity: number;
  me_score: number;
  them_score: number;
  initiator: "Me" | "Them";
  mode: string;
  signals: string[];
  snippets: DesireSnippet[];
};

export type DesireResult = {
  overview: DesireOverview;
  months: DesireMonth[];
  eras: DesireEra[];
  episodes: DesireEpisode[];
};

export type DesirePatternBucket = {
  key: DesireSignalBucket;
  label: string;
  description: string;
  sexual_messages: number;
  sessions: number;
  first_ym: string;
  peak_ym: string;
  share: number;
  me_share: number;
  average_score: number;
  examples: DesireSnippet[];
};

export type DesireKinkMotif = {
  key: string;
  label: string;
  description: string;
  messages: number;
  sessions: number;
  first_ym: string;
  peak_ym: string;
  share: number;
  me_share: number;
  average_score: number;
  examples: DesireSnippet[];
};

export type DesirePatternsResult = {
  overview: {
    generated_at: string;
    sexual_messages: number;
    sexual_sessions: number;
    active_buckets: number;
    active_motifs: number;
  };
  buckets: DesirePatternBucket[];
  motifs: DesireKinkMotif[];
};

export type DesireEvolutionYear = {
  year: string;
  start_ym: string;
  end_ym: string;
  sexual_messages: number;
  sexual_score: number;
  sessions: number;
  reciprocal_sessions: number;
  dominant_signal: string;
  dominant_motif: string;
  me_share: number;
  average_session_minutes: number;
  average_session_turns: number;
  change_from_previous: number | null;
  change_note: string;
};

export type DesireEvolutionResult = {
  generated_at: string;
  months: DesireMonth[];
  years: DesireEvolutionYear[];
};

export type DesireSessionDistribution = {
  label: string;
  sessions: number;
};

export type DesireBackAndForthSession = DesireEpisode & {
  back_and_forths: number;
  opposite_replies: number;
  longest_alternating_run: number;
  average_gap_minutes: number;
  motifs: string[];
};

export type DesireSessionsResult = {
  overview: {
    generated_at: string;
    sessions: number;
    reciprocal_sessions: number;
    max_back_and_forths: number;
    max_opposite_replies: number;
    longest_alternating_run: number;
  };
  distribution: DesireSessionDistribution[];
  sessions: DesireBackAndForthSession[];
};

type MessageRow = {
  id: number;
  ts: number;
  ymd: string;
  ym: string;
  is_from_me: number;
  text: string | null;
  romantic_score: number;
  sexual_score: number;
  signals: string;
};

type EpisodeBuild = {
  key: string;
  rows: MessageRow[];
};

const SIGNAL_DETAILS: Record<DesireSignalBucket, { label: string; description: string }> = {
  desire: {
    label: "Want and arousal",
    description: "Direct wanting, horny check-ins, getting turned on, and anticipation.",
  },
  explicit: {
    label: "Explicit sex talk",
    description: "Body, acts, orgasm language, and concrete sexual propositions.",
  },
  kink: {
    label: "Kink and power play",
    description: "Kink terms, dominance and submission, edging, restraint, strap play, and adjacent negotiation.",
  },
  media: {
    label: "Photos and visual play",
    description: "Nudes, photos, videos, porn references, and visual anticipation.",
  },
  play: {
    label: "Joking heat",
    description: "Silly, teasing, or funny sexual exchanges that keep the temperature light.",
  },
  care: {
    label: "Care and boundaries",
    description: "Comfort, consent, safety, apology, gentleness, and pressure checks inside sexual talk.",
  },
};

const KINK_MOTIFS = [
  {
    key: "teasing",
    label: "Teasing and anticipation",
    description: "Build-up, wanting, waiting, denial, or playful escalation before anything explicit.",
    pattern: /\b(teas(?:e|ing)|edge|edging|wait|anticipat|want|desire|turn(?:ed)? on|horny)\b/i,
  },
  {
    key: "power",
    label: "Power exchange",
    description: "Dominance, submission, control, commands, obedience, or similar power-play language.",
    pattern: /\b(dom|dominant|sub|submissive|control|command|obey|obedient|bossy)\b/i,
  },
  {
    key: "restraint",
    label: "Restraint and bondage",
    description: "Rope, tying, cuffs, blindfolds, restraints, or being held in place.",
    pattern: /\b(bondage|shibari|rope|tied?|tie me|cuffs?|handcuffs?|restrain|restraints?|blindfold)\b/i,
  },
  {
    key: "toys",
    label: "Toys and devices",
    description: "Toys, vibrators, app-controlled devices, strap play, pegging, and adjacent gear.",
    pattern: /\b(vibrator|lovense|wevibe|we-vibe|toy|toys|dildo|strap|strap-on|pegging)\b/i,
  },
  {
    key: "display",
    label: "Photos and display",
    description: "Nudes, lingerie, pics, videos, porn, showing, sending, and being looked at.",
    pattern: /\b(nude|nudes|naked|lingerie|photo|photos|pic|pics|snap|video|porn|show me|send me|sent you)\b/i,
  },
  {
    key: "body",
    label: "Body specifics",
    description: "Explicit body-part language and concrete descriptions of sex acts.",
    pattern: /\b(cock|pussy|clit|vagina|orgasm|cum|inside|fuck|fucking)\b/i,
  },
  {
    key: "care",
    label: "Aftercare and consent",
    description: "Safety, pressure checks, comfort, boundaries, gentleness, and repair around desire.",
    pattern: /\b(consent|safe|safety|comfortable|comfort|pressure|boundary|boundaries|gentle|okay|aftercare|sorry)\b/i,
  },
  {
    key: "roleplay",
    label: "Roleplay and fantasy",
    description: "Fantasy scenes, pretending, scenarios, roleplay, and named erotic hypotheticals.",
    pattern: /\b(role ?play|pretend|fantas(?:y|ies)|scenario|scene|taboo)\b/i,
  },
] as const;

const desireInput = messageScopeInput.extend({
  sensitive: z.boolean().optional(),
});

export const getDesire = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => desireInput.parse(d))
  .handler(async ({ data }): Promise<DesireResult> => {
    const resolved = resolveMessageScope(data);
    const scope = messageScopeWhere(resolved, "m", [
      REAL_MESSAGE_WHERE,
      "m.text IS NOT NULL",
      "length(trim(m.text)) > 0",
    ]);
    return withDbCache(`desire:${JSON.stringify(resolved)}`, () => {
      const meta = db().prepare("SELECT v FROM meta WHERE k = 'generated_at'").get() as { v: string } | undefined;
      const rows = loadDesireRowsFromScope(scope);

      const months = buildMonths(rows);
      const episodeBuilds = buildEpisodes(rows);
      const episodes = selectEpisodes(episodeBuilds.map((episode) => serializeEpisode(episode, rows, true)));
      const eras = buildEras(months);
      const overview = buildOverview(rows, months, episodeBuilds, meta?.v ?? null);

      return { overview, months, eras, episodes };
    });
  });

export const getDesirePatterns = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => messageScopeInput.parse(d))
  .handler(async ({ data }): Promise<DesirePatternsResult> => {
    const resolved = resolveMessageScope(data);
    return withDbCache(`desire-patterns:${JSON.stringify(resolved)}`, () => {
      const rows = loadDesireRows(resolved);
      const sexualRows = sexualOnly(rows);
      const episodes = buildEpisodes(rows);
      const generatedAt = getGeneratedAt();
      const buckets = buildPatternBuckets(sexualRows, episodes);
      const motifs = buildKinkMotifs(sexualRows, episodes);
      return {
        overview: {
          generated_at: generatedAt,
          sexual_messages: sexualRows.length,
          sexual_sessions: episodes.length,
          active_buckets: buckets.filter((bucket) => bucket.sexual_messages > 0).length,
          active_motifs: motifs.length,
        },
        buckets,
        motifs,
      };
    });
  });

export const getDesireEvolution = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => messageScopeInput.parse(d))
  .handler(async ({ data }): Promise<DesireEvolutionResult> => {
    const resolved = resolveMessageScope(data);
    return withDbCache(`desire-evolution:${JSON.stringify(resolved)}`, () => {
      const rows = loadDesireRows(resolved);
      const months = buildMonths(rows);
      const episodes = buildEpisodes(rows);
      return {
        generated_at: getGeneratedAt(),
        months,
        years: buildEvolutionYears(rows, episodes),
      };
    });
  });

export const getDesireSessions = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => messageScopeInput.parse(d))
  .handler(async ({ data }): Promise<DesireSessionsResult> => {
    const resolved = resolveMessageScope(data);
    return withDbCache(`desire-sessions:${JSON.stringify(resolved)}`, () => {
      const rows = loadDesireRows(resolved);
      const sessions = buildEpisodes(rows).map((episode) => serializeBackAndForthSession(episode, rows));
      const ranked = [...sessions]
        .sort(
          (a, b) =>
            b.back_and_forths - a.back_and_forths ||
            b.opposite_replies - a.opposite_replies ||
            b.sexual_messages - a.sexual_messages ||
            b.intensity - a.intensity,
        )
        .slice(0, 18);
      const reciprocal = sessions.filter((session) => session.opposite_replies > 0);
      return {
        overview: {
          generated_at: getGeneratedAt(),
          sessions: sessions.length,
          reciprocal_sessions: reciprocal.length,
          max_back_and_forths: max(sessions.map((session) => session.back_and_forths)),
          max_opposite_replies: max(sessions.map((session) => session.opposite_replies)),
          longest_alternating_run: max(sessions.map((session) => session.longest_alternating_run)),
        },
        distribution: buildSessionDistribution(sessions),
        sessions: ranked,
      };
    });
  });

function loadDesireRows(scope: Parameters<typeof messageScopeWhere>[0]) {
  const where = messageScopeWhere(scope, "m", [
    REAL_MESSAGE_WHERE,
    "m.text IS NOT NULL",
    "length(trim(m.text)) > 0",
  ]);
  return loadDesireRowsFromScope(where);
}

function loadDesireRowsFromScope(scope: { sql: string; args: Array<string | number> }): MessageRow[] {
  const rawRows = db()
    .prepare(
      `
      SELECT m.id,
             m.ts,
             m.ymd,
             m.is_from_me,
             m.text,
             s.romantic_score,
             s.sexual_score,
             s.signals
      FROM seg_message_intimacy_scores s
      JOIN messages m ON m.id = s.msg_id
      ${scope.sql}
      ORDER BY m.ts ASC, m.id ASC
      `,
    )
    .all(...scope.args) as Array<Omit<MessageRow, "ym">>;
  return rawRows.map((row) => ({ ...row, ym: bucket(row.ts, "ym") }));
}

function buildOverview(rows: MessageRow[], months: DesireMonth[], episodes: EpisodeBuild[], generatedAt: string | null): DesireOverview {
  const sexualMessages = rows.filter((row) => row.sexual_score >= SEXUAL_THRESHOLD);
  const activeMonths = months.filter((month) => month.sexual_messages > 0);
  const peak = [...months].sort((a, b) => b.sexual_score - a.sexual_score)[0];
  const initiations = months.reduce(
    (acc, month) => {
      acc.me += month.me_initiations;
      acc.them += month.them_initiations;
      return acc;
    },
    { me: 0, them: 0 },
  );
  const initiationTotal = initiations.me + initiations.them;

  return {
    generated_at: generatedAt ?? "unknown",
    messages_scored: rows.length,
    sexual_messages: sexualMessages.length,
    sexual_episodes: episodes.length,
    active_months: activeMonths.length,
    peak_month: peak?.ym ?? "n/a",
    current_phase: currentPhase(months),
    me_initiation_share: initiationTotal ? round(initiations.me / initiationTotal) : 0,
  };
}

function buildPatternBuckets(sexualRows: MessageRow[], episodes: EpisodeBuild[]): DesirePatternBucket[] {
  return (Object.keys(SIGNAL_DETAILS) as DesireSignalBucket[])
    .map((key) => {
      const rows = sexualRows.filter((row) => signalBuckets(row).includes(key));
      const score = sum(rows.map((row) => row.sexual_score));
      const detail = SIGNAL_DETAILS[key];
      return {
        key,
        label: detail.label,
        description: detail.description,
        sexual_messages: rows.length,
        sessions: countEpisodesWithRows(episodes, rows),
        first_ym: firstYm(rows),
        peak_ym: peakYm(rows),
        share: sexualRows.length ? round(rows.length / sexualRows.length) : 0,
        me_share: score ? round(sum(rows.filter((row) => row.is_from_me === 1).map((row) => row.sexual_score)) / score) : 0,
        average_score: rows.length ? round(score / rows.length) : 0,
        examples: examplesForRows(rows, 3),
      } satisfies DesirePatternBucket;
    })
    .sort((a, b) => b.sexual_messages - a.sexual_messages);
}

function buildKinkMotifs(sexualRows: MessageRow[], episodes: EpisodeBuild[]): DesireKinkMotif[] {
  return KINK_MOTIFS.map((motif) => {
    const rows = sexualRows.filter((row) => motif.pattern.test(searchableText(row)));
    const score = sum(rows.map((row) => row.sexual_score));
    return {
      key: motif.key,
      label: motif.label,
      description: motif.description,
      messages: rows.length,
      sessions: countEpisodesWithRows(episodes, rows),
      first_ym: firstYm(rows),
      peak_ym: peakYm(rows),
      share: sexualRows.length ? round(rows.length / sexualRows.length) : 0,
      me_share: score ? round(sum(rows.filter((row) => row.is_from_me === 1).map((row) => row.sexual_score)) / score) : 0,
      average_score: rows.length ? round(score / rows.length) : 0,
      examples: examplesForRows(rows, 3),
    } satisfies DesireKinkMotif;
  })
    .filter((motif) => motif.messages > 0)
    .sort((a, b) => b.messages - a.messages || b.average_score - a.average_score);
}

function buildEvolutionYears(rows: MessageRow[], episodes: EpisodeBuild[]): DesireEvolutionYear[] {
  const sexualRows = sexualOnly(rows);
  const byYear = groupBy(sexualRows, (row) => row.ym.slice(0, 4));
  const episodeByYear = groupBy(episodes, (episode) => episode.rows[0].ym.slice(0, 4));
  const years = [...byYear.entries()].sort(([a], [b]) => a.localeCompare(b));
  const out: DesireEvolutionYear[] = [];

  years.forEach(([year, yearRows], index) => {
    const yearEpisodes = episodeByYear.get(year) ?? [];
    const score = sum(yearRows.map((row) => row.sexual_score));
    const meScore = sum(yearRows.filter((row) => row.is_from_me === 1).map((row) => row.sexual_score));
    const prev = index > 0 ? years[index - 1][1].length : null;
    const dominantSignal = dominantFromSignalCounts(collectSignals(yearRows));
    const dominantMotif = topMotifForRows(yearRows);
    const sessionMinutes = yearEpisodes.map((episode) => Math.max(1, Math.round((episode.rows[episode.rows.length - 1].ts - episode.rows[0].ts) / 60)));
    return out.push({
      year,
      start_ym: yearRows[0].ym,
      end_ym: yearRows[yearRows.length - 1].ym,
      sexual_messages: yearRows.length,
      sexual_score: round(score),
      sessions: yearEpisodes.length,
      reciprocal_sessions: yearEpisodes.filter((episode) => new Set(episode.rows.map((row) => row.is_from_me)).size > 1).length,
      dominant_signal: dominantSignal,
      dominant_motif: dominantMotif,
      me_share: score ? round(meScore / score) : 0,
      average_session_minutes: sessionMinutes.length ? round(sum(sessionMinutes) / sessionMinutes.length) : 0,
      average_session_turns: yearEpisodes.length ? round(sum(yearEpisodes.map((episode) => episode.rows.length)) / yearEpisodes.length) : 0,
      change_from_previous: prev == null ? null : yearRows.length - prev,
      change_note: prev == null ? "first active year" : changeNote(yearRows.length, prev, dominantSignal),
    });
  });

  return out;
}

function serializeBackAndForthSession(episode: EpisodeBuild, allRows: MessageRow[]): DesireBackAndForthSession {
  const serialized = serializeEpisode(episode, allRows, true);
  const sexualRows = episode.rows;
  const oppositeReplies = countSenderSwitches(sexualRows);
  const gaps = sexualRows.slice(1).map((row, index) => (row.ts - sexualRows[index].ts) / 60);
  const motifs = KINK_MOTIFS.map((motif) => ({
    label: motif.label,
    score: sum(sexualRows.filter((row) => motif.pattern.test(searchableText(row))).map((row) => row.sexual_score)),
  }))
    .filter((motif) => motif.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map((motif) => motif.label);

  return {
    ...serialized,
    back_and_forths: Math.floor(oppositeReplies / 2),
    opposite_replies: oppositeReplies,
    longest_alternating_run: longestAlternatingRun(sexualRows),
    average_gap_minutes: gaps.length ? round(sum(gaps) / gaps.length) : 0,
    motifs,
  };
}

function buildSessionDistribution(sessions: DesireBackAndForthSession[]): DesireSessionDistribution[] {
  const buckets = [
    { label: "0", min: 0, max: 0 },
    { label: "1", min: 1, max: 1 },
    { label: "2", min: 2, max: 2 },
    { label: "3 to 4", min: 3, max: 4 },
    { label: "5+", min: 5, max: Infinity },
  ];
  return buckets.map((bucket) => ({
    label: bucket.label,
    sessions: sessions.filter((session) => session.back_and_forths >= bucket.min && session.back_and_forths <= bucket.max).length,
  }));
}

function buildMonths(rows: MessageRow[]) {
  const byMonth = new Map<string, DesireMonth>();
  const sexualByMonth = new Map<string, MessageRow[]>();

  for (const row of rows) {
    const month = byMonth.get(row.ym) ?? createMonth(row.ym);
    month.total_messages++;
    if (row.romantic_score >= ROMANTIC_THRESHOLD) {
      month.romantic_messages++;
      month.romantic_score += row.romantic_score;
    }
    if (row.sexual_score >= SEXUAL_THRESHOLD) {
      month.sexual_messages++;
      month.sexual_score += row.sexual_score;
      if (row.is_from_me === 1) month.me_score += row.sexual_score;
      else month.them_score += row.sexual_score;
      addSignalScores(month, row);
      const sexualRows = sexualByMonth.get(row.ym) ?? [];
      sexualRows.push(row);
      sexualByMonth.set(row.ym, sexualRows);
    }
    byMonth.set(row.ym, month);
  }

  for (const [ym, sexualRows] of sexualByMonth.entries()) {
    const episodes = buildEpisodes(sexualRows);
    const month = byMonth.get(ym);
    if (!month) continue;
    for (const episode of episodes) {
      const first = episode.rows[0];
      if (first.is_from_me === 1) month.me_initiations++;
      else month.them_initiations++;
    }
  }

  return [...byMonth.values()]
    .sort((a, b) => a.ym.localeCompare(b.ym))
    .map((month) => ({
      ...month,
      sexual_score: round(month.sexual_score),
      romantic_score: round(month.romantic_score),
      me_score: round(month.me_score),
      them_score: round(month.them_score),
      signal_desire: round(month.signal_desire),
      signal_explicit: round(month.signal_explicit),
      signal_kink: round(month.signal_kink),
      signal_media: round(month.signal_media),
      signal_play: round(month.signal_play),
      signal_care: round(month.signal_care),
    }));
}

function createMonth(ym: string): DesireMonth {
  return {
    ym,
    total_messages: 0,
    sexual_messages: 0,
    romantic_messages: 0,
    sexual_score: 0,
    romantic_score: 0,
    me_score: 0,
    them_score: 0,
    me_initiations: 0,
    them_initiations: 0,
    signal_desire: 0,
    signal_explicit: 0,
    signal_kink: 0,
    signal_media: 0,
    signal_play: 0,
    signal_care: 0,
  };
}

function buildEpisodes(rows: MessageRow[]): EpisodeBuild[] {
  const sexualRows = rows.filter((row) => row.sexual_score >= SEXUAL_THRESHOLD);
  const episodes: EpisodeBuild[] = [];
  let current: MessageRow[] = [];

  for (const row of sexualRows) {
    const prev = current[current.length - 1];
    if (!prev || row.ts - prev.ts <= EPISODE_GAP_SECONDS) {
      current.push(row);
      continue;
    }
    episodes.push({ key: `${current[0].id}-${current[current.length - 1].id}`, rows: current });
    current = [row];
  }
  if (current.length) {
    episodes.push({ key: `${current[0].id}-${current[current.length - 1].id}`, rows: current });
  }
  return episodes;
}

function serializeEpisode(episode: EpisodeBuild, allRows: MessageRow[], revealSnippets: boolean): DesireEpisode {
  const start = episode.rows[0].ts;
  const end = episode.rows[episode.rows.length - 1].ts;
  const context = allRows.filter((row) => row.ts >= start - CONTEXT_SECONDS && row.ts <= end + CONTEXT_SECONDS);
  const meScore = sum(episode.rows.filter((row) => row.is_from_me === 1).map((row) => row.sexual_score));
  const themScore = sum(episode.rows.filter((row) => row.is_from_me !== 1).map((row) => row.sexual_score));
  const signalCounts = collectSignals(episode.rows);
  const signals = [...signalCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([signal]) => signal);
  const intensity = sum(episode.rows.map((row) => row.sexual_score)) * Math.log1p(episode.rows.length + context.length / 3);

  return {
    key: episode.key,
    start_ts: start,
    end_ts: end,
    ym: episode.rows[0].ym,
    duration_minutes: Math.max(1, Math.round((end - start) / 60)),
    sexual_messages: episode.rows.length,
    total_context_messages: context.length,
    intensity: round(intensity),
    me_score: round(meScore),
    them_score: round(themScore),
    initiator: episode.rows[0].is_from_me === 1 ? "Me" : "Them",
    mode: modeForEpisode(episode.rows, signalCounts),
    signals,
    snippets: contextSnippets(context, episode.rows, revealSnippets),
  };
}

function selectEpisodes(episodes: DesireEpisode[]) {
  const pool = [...episodes].sort((a, b) => b.intensity - a.intensity);
  const selected: DesireEpisode[] = [];
  const usedYears = new Map<string, number>();
  for (const episode of pool) {
    const year = episode.ym.slice(0, 4);
    const yearCount = usedYears.get(year) ?? 0;
    if (yearCount >= 3 && selected.length < 10) continue;
    selected.push(episode);
    usedYears.set(year, yearCount + 1);
    if (selected.length >= MAX_EPISODES) break;
  }
  return selected.sort((a, b) => a.start_ts - b.start_ts);
}

function buildEras(months: DesireMonth[]) {
  const active = months.filter((month) => month.total_messages > 0);
  if (!active.length) return [];
  const years = groupBy(active, (month) => month.ym.slice(0, 4));
  return [...years.entries()].map(([year, yearMonths]) => {
    const sexualScore = sum(yearMonths.map((month) => month.sexual_score));
    const sexualMessages = sum(yearMonths.map((month) => month.sexual_messages));
    const meScore = sum(yearMonths.map((month) => month.me_score));
    const themScore = sum(yearMonths.map((month) => month.them_score));
    const dominantSignal = dominantSignalForMonths(yearMonths);
    return {
      label: year,
      start_ym: yearMonths[0].ym,
      end_ym: yearMonths[yearMonths.length - 1].ym,
      months: yearMonths.length,
      sexual_score: round(sexualScore),
      sexual_messages: sexualMessages,
      me_share: meScore + themScore ? round(meScore / (meScore + themScore)) : 0,
      dominant_signal: dominantSignal,
      note: eraNote(sexualMessages, dominantSignal),
    } satisfies DesireEra;
  });
}

function currentPhase(months: DesireMonth[]) {
  const recent = months.slice(-6);
  const previous = months.slice(-12, -6);
  const recentScore = sum(recent.map((month) => month.sexual_score));
  const previousScore = sum(previous.map((month) => month.sexual_score));
  if (recentScore === 0) return "quiet";
  if (previousScore === 0) return "reappearing";
  const ratio = recentScore / previousScore;
  if (ratio >= 1.5) return "rising";
  if (ratio <= 0.5) return "quieter";
  return "steady";
}

function addSignalScores(month: DesireMonth, row: MessageRow) {
  const buckets = signalBuckets(row);
  const weight = row.sexual_score / Math.max(buckets.length, 1);
  for (const bucket of buckets) {
    if (bucket === "desire") month.signal_desire += weight;
    else if (bucket === "explicit") month.signal_explicit += weight;
    else if (bucket === "kink") month.signal_kink += weight;
    else if (bucket === "media") month.signal_media += weight;
    else if (bucket === "play") month.signal_play += weight;
    else month.signal_care += weight;
  }
}

function signalBuckets(row: MessageRow): DesireSignalBucket[] {
  const text = (row.text ?? "").toLowerCase();
  const signals = parseSignals(row.signals).join(" ").toLowerCase();
  const buckets = new Set<string>();
  if (/horny|turn(ed)? on|desire|want/.test(text) || /horny|desire/.test(signals)) buckets.add("desire");
  if (/sex|fuck|cum|cock|pussy|clit|vagina|orgasm|inside/.test(text) || /body\/sex|explicit/.test(signals)) buckets.add("explicit");
  if (/kink|edge|edging|dom|sub|bdsm|shibari|strap|pegging/.test(text) || /kink|edging|dom/.test(signals)) buckets.add("kink");
  if (/nude|snap|photo|pic|video|porn|gif|sent you/.test(text) || /porn|nude/.test(signals)) buckets.add("media");
  if (/lol|lmao|haha|funny|silly/.test(text)) buckets.add("play");
  if (/sorry|okay|pressure|safe|consent|comfortable|kind|gentle/.test(text)) buckets.add("care");
  if (!buckets.size) buckets.add("desire");
  return [...buckets] as DesireSignalBucket[];
}

function collectSignals(rows: MessageRow[]) {
  const out = new Map<string, number>();
  for (const row of rows) {
    for (const bucket of signalBuckets(row)) {
      out.set(bucket, (out.get(bucket) ?? 0) + row.sexual_score);
    }
  }
  return out;
}

function modeForEpisode(rows: MessageRow[], signalCounts: Map<string, number>) {
  const dominant = [...signalCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "desire";
  const both = new Set(rows.map((row) => row.is_from_me)).size > 1;
  if (dominant === "kink") return both ? "kink exchange" : "kink signal";
  if (dominant === "media") return "media and anticipation";
  if (dominant === "play") return "sexual humor";
  if (dominant === "care") return "careful negotiation";
  if (dominant === "explicit") return both ? "explicit exchange" : "explicit disclosure";
  return both ? "mutual desire" : "desire signal";
}

function dominantFromSignalCounts(signalCounts: Map<string, number>) {
  const dominant = [...signalCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "desire";
  return SIGNAL_DETAILS[dominant as DesireSignalBucket]?.label ?? dominant;
}

function topMotifForRows(rows: MessageRow[]) {
  const top = KINK_MOTIFS.map((motif) => ({
    label: motif.label,
    count: rows.filter((row) => motif.pattern.test(searchableText(row))).length,
  })).sort((a, b) => b.count - a.count)[0];
  return top && top.count > 0 ? top.label : "No motif detected";
}

function contextSnippets(context: MessageRow[], sexualRows: MessageRow[], revealSnippets: boolean) {
  const sexualIds = new Set(sexualRows.map((row) => row.id));
  const scored = context.map((row, index) => ({
    row,
    index,
    score: (sexualIds.has(row.id) ? 10 : 0) + row.sexual_score + row.romantic_score * 0.15,
  }));
  const chosen = scored
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 8)
    .sort((a, b) => a.row.ts - b.row.ts);
  return chosen.map(({ row }) => ({
    msg_id: row.id,
    ts: row.ts,
    sender: row.is_from_me === 1 ? ("Me" as const) : ("Them" as const),
    text: revealSnippets ? cleanText(row.text ?? "") : "Excerpt hidden until sensitive excerpts are enabled.",
    sexual_score: round(row.sexual_score),
  }));
}

function examplesForRows(rows: MessageRow[], limit: number): DesireSnippet[] {
  return [...rows]
    .sort((a, b) => b.sexual_score - a.sexual_score || a.ts - b.ts)
    .slice(0, limit)
    .sort((a, b) => a.ts - b.ts)
    .map(snippetForRow);
}

function snippetForRow(row: MessageRow): DesireSnippet {
  return {
    msg_id: row.id,
    ts: row.ts,
    sender: row.is_from_me === 1 ? "Me" : "Them",
    text: cleanText(row.text ?? ""),
    sexual_score: round(row.sexual_score),
  };
}

function countEpisodesWithRows(episodes: EpisodeBuild[], rows: MessageRow[]) {
  const ids = new Set(rows.map((row) => row.id));
  return episodes.filter((episode) => episode.rows.some((row) => ids.has(row.id))).length;
}

function countSenderSwitches(rows: MessageRow[]) {
  let switches = 0;
  for (let index = 1; index < rows.length; index++) {
    if (rows[index].is_from_me !== rows[index - 1].is_from_me) switches++;
  }
  return switches;
}

function longestAlternatingRun(rows: MessageRow[]) {
  if (!rows.length) return 0;
  let best = 1;
  let current = 1;
  for (let index = 1; index < rows.length; index++) {
    if (rows[index].is_from_me !== rows[index - 1].is_from_me) {
      current++;
    } else {
      current = 1;
    }
    best = Math.max(best, current);
  }
  return best;
}

function firstYm(rows: MessageRow[]) {
  return rows[0]?.ym ?? "n/a";
}

function peakYm(rows: MessageRow[]) {
  const byMonth = groupBy(rows, (row) => row.ym);
  const peak = [...byMonth.entries()]
    .map(([ym, monthRows]) => ({ ym, score: sum(monthRows.map((row) => row.sexual_score)) }))
    .sort((a, b) => b.score - a.score)[0];
  return peak?.ym ?? "n/a";
}

function sexualOnly(rows: MessageRow[]) {
  return rows.filter((row) => row.sexual_score >= SEXUAL_THRESHOLD);
}

function searchableText(row: MessageRow) {
  return `${row.text ?? ""} ${parseSignals(row.signals).join(" ")}`;
}

function changeNote(current: number, previous: number, signal: string) {
  if (previous === 0) return `${signal} appears after a quiet year`;
  const ratio = current / previous;
  if (ratio >= 1.6) return `${signal} rises sharply`;
  if (ratio >= 1.15) return `${signal} rises`;
  if (ratio <= 0.45) return `${signal} falls sharply`;
  if (ratio <= 0.85) return `${signal} softens`;
  return `${signal} stays steady`;
}

function getGeneratedAt() {
  const meta = db().prepare("SELECT v FROM meta WHERE k = 'generated_at'").get() as { v: string } | undefined;
  return meta?.v ?? "unknown";
}

function dominantSignalForMonths(months: DesireMonth[]) {
  const entries = [
    ["desire", sum(months.map((month) => month.signal_desire))],
    ["explicit", sum(months.map((month) => month.signal_explicit))],
    ["kink", sum(months.map((month) => month.signal_kink))],
    ["media", sum(months.map((month) => month.signal_media))],
    ["play", sum(months.map((month) => month.signal_play))],
    ["care", sum(months.map((month) => month.signal_care))],
  ] as const;
  return [...entries].sort((a, b) => b[1] - a[1])[0][0];
}

function eraNote(sexualMessages: number, signal: string) {
  if (sexualMessages === 0) return "quiet year";
  if (sexualMessages < 20) return `${signal} appears in small bursts`;
  if (sexualMessages < 80) return `${signal} becomes a recurring channel`;
  return `${signal} is a sustained channel`;
}

function groupBy<T>(items: T[], keyFor: (item: T) => string) {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFor(item);
    const bucket = out.get(key) ?? [];
    bucket.push(item);
    out.set(key, bucket);
  }
  return out;
}

function cleanText(text: string) {
  return text.replace(/\s+/g, " ").trim().slice(0, 280);
}

function sum(values: number[]) {
  return values.reduce((acc, value) => acc + value, 0);
}

function max(values: number[]) {
  return values.length ? Math.max(...values) : 0;
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}
