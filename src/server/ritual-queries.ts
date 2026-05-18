import { createServerFn } from "@tanstack/react-start";
import { realMessageWhere } from "~/lib/conversation/filters";
import { messageScopeInput, messageScopeWhere } from "~/lib/conversation/scope";
import { db, getDataGeneratedAt, withDbCache } from "~/lib/server-db";
import { resolveMessageScope } from "~/server/scope";

const REAL_MESSAGE_WHERE = realMessageWhere("browsable_message", "m");
const RESTART_GAP_SECONDS = 6 * 60 * 60;
const TIME_ZONE = "America/Vancouver";

export type Sender = "Me" | "Them";

export type RitualOverview = {
  generated_at: string;
  real_messages: number;
  active_days: number;
  ritual_hits: number;
  peak_hour: number;
  peak_hour_messages: number;
  top_phrase: string;
  top_phrase_count: number;
};

export type HourCell = {
  weekday: number;
  weekday_label: string;
  hour: number;
  total: number;
  me: number;
  them: number;
  level: number;
};

export type DaypartRitual = {
  key: string;
  label: string;
  total: number;
  me: number;
  them: number;
  share: number;
  me_share: number;
  peak_hour: number;
};

export type RitualPattern = {
  key: string;
  label: string;
  description: string;
  count: number;
  me: number;
  them: number;
  first_ts: number;
  last_ts: number;
  peak_hour: number;
  peak_weekday: string;
  examples: RitualExample[];
};

export type PhraseAnchor = {
  phrase: string;
  count: number;
  me: number;
  them: number;
  days: number;
  months: number;
  peak_hour: number;
  sharedness: number;
};

export type RestartAnchor = {
  phrase: string;
  count: number;
  me: number;
  them: number;
  avg_gap_hours: number;
  examples: RitualExample[];
};

export type RitualExample = {
  ts: number;
  ymd: string;
  sender: Sender;
  preview: string;
};

export type RitualsResult = {
  overview: RitualOverview;
  hour_cells: HourCell[];
  dayparts: DaypartRitual[];
  patterns: RitualPattern[];
  phrase_anchors: PhraseAnchor[];
  restart_anchors: RestartAnchor[];
};

type MessageRow = {
  id: number;
  ts: number;
  ymd: string;
  ym: string;
  is_from_me: number;
  text: string | null;
};

type TimeParts = {
  weekday: number;
  weekdayLabel: string;
  hour: number;
};

type PatternDefinition = {
  key: string;
  label: string;
  description: string;
  regex: RegExp;
};

type PatternAccumulator = {
  key: string;
  label: string;
  description: string;
  count: number;
  me: number;
  them: number;
  firstTs: number;
  lastTs: number;
  hourCounts: number[];
  weekdayCounts: number[];
  examples: RitualExample[];
};

type PhraseAccumulator = {
  phrase: string;
  count: number;
  me: number;
  them: number;
  days: Set<string>;
  months: Set<string>;
  hourCounts: number[];
};

type RestartAccumulator = {
  phrase: string;
  count: number;
  me: number;
  them: number;
  gapHoursTotal: number;
  examples: RitualExample[];
};

type DaypartAccumulator = {
  key: string;
  label: string;
  total: number;
  me: number;
  them: number;
  hourCounts: number[];
};

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const PATTERNS: PatternDefinition[] = [
  {
    key: "morning",
    label: "Morning touchpoints",
    description: "Messages that explicitly mark the morning or open the day.",
    regex: /\b(good ?morning|mornin+|morning love|morning tons|gm)\b/i,
  },
  {
    key: "night",
    label: "Goodnight ritual",
    description: "Night closings, sleep signoffs, and love-at-night phrases.",
    regex: /\b(good ?night|goodnight|g ?night|night love|sweet dreams|sleep well)\b/i,
  },
  {
    key: "love",
    label: "Love signoffs",
    description: "Explicit love formulas and the thread's repeated affection tokens.",
    regex: /\b(i love you|love you|love tons|love lots|love much|ily)\b/i,
  },
  {
    key: "arrival",
    label: "Arrival checks",
    description: "Home, safe-arrival, and location-status check-ins.",
    regex: /\b(home safe|got home|made it home|am home|i'?m home|at home|just got home)\b/i,
  },
  {
    key: "motion",
    label: "On-my-way logistics",
    description: "Movement, leaving, heading over, and handoff coordination.",
    regex: /\b(on my way|omw|heading over|headed over|leaving now|be there|almost there)\b/i,
  },
  {
    key: "soon",
    label: "Anticipation",
    description: "Looking-forward-to-seeing-you phrases.",
    regex: /\b(see you soon|see soon|excited to see|can't wait to see|cant wait to see|miss you)\b/i,
  },
  {
    key: "repair",
    label: "Repair moves",
    description: "Apologies and small repairs that keep the conversation moving.",
    regex: /\b(sorry|apologize|apologise|forgive)\b/i,
  },
  {
    key: "thanks",
    label: "Gratitude",
    description: "Thank-you loops and acknowledgement habits.",
    regex: /\b(thank you|thanks|thank u|ty)\b/i,
  },
  {
    key: "games",
    label: "Game rituals",
    description: "Recurring game links and puzzle habits that become part of the thread.",
    regex: /\b(codenames|wordle|factle|game room)\b/i,
  },
  {
    key: "sleep",
    label: "Sleep and tiredness",
    description: "Bed, sleep, tired, and sleepy check-ins.",
    regex: /\b(sleep|sleepy|tired|bedtime|going to bed)\b/i,
  },
];

const STOPWORDS = new Set([
  "the","and","for","with","you","your","are","was","were","that","this","they","have","has",
  "had","but","not","just","really","very","from","into","about","would","could","should","there",
  "here","what","when","where","which","who","then","than","also","too","can","will","get","got",
  "getting","going","went","gone","good","okay","yeah","yep","yup","sure","right","fine","like",
  "dont","doesnt","didnt","cant","wont","im","ive","ill","youre","youve","youll","thats","theres",
]);

export const getRituals = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => messageScopeInput.parse(d ?? {}))
  .handler(async ({ data }): Promise<RitualsResult> => {
    const resolved = resolveMessageScope(data);
    return withDbCache(`rituals:${JSON.stringify(resolved)}`, () => {
      const scanScope = { ...resolved, sender: "both" as const };
      const scope = messageScopeWhere(scanScope, "m", [REAL_MESSAGE_WHERE]);
      const rows = db()
        .prepare(
          `
          SELECT m.id, m.ts, m.ymd, m.ym, m.is_from_me, m.text
          FROM messages m
          ${scope.sql}
          ORDER BY m.ts ASC
        `,
        )
        .all(...scope.args) as MessageRow[];

      const sourceRows = rows.filter((row) => senderMatches(row, resolved.sender));

      const activeDays = new Set<string>();
      const hourCells = createHourCells();
      const dayparts = createDayparts();
      const patternStats = new Map(PATTERNS.map((p) => [p.key, createPatternAccumulator(p)]));
      const phraseStats = new Map<string, PhraseAccumulator>();
      const restartStats = new Map<string, RestartAccumulator>();

      let ritualHits = 0;
      let previous: MessageRow | null = null;

      for (const row of rows) {
        const includeSource = senderMatches(row, resolved.sender);
        const sender = senderFor(row);
        const text = row.text ?? "";
        const parts = localParts(row.ts);

        if (previous) {
          const gapSeconds = row.ts - previous.ts;
          if (includeSource && gapSeconds >= RESTART_GAP_SECONDS) {
            const phrase = restartPhrase(text);
            if (phrase) addRestartAnchor(restartStats, phrase, row, sender, text, gapSeconds / 3600);
          }
        }

        if (!includeSource) {
          previous = row;
          continue;
        }

        activeDays.add(row.ymd);

        const cell = hourCells[parts.weekday * 24 + parts.hour];
        cell.total += 1;
        if (sender === "Me") cell.me += 1;
        else cell.them += 1;

        const daypart = dayparts.get(daypartKeyFor(parts.hour))!;
        daypart.total += 1;
        daypart.hourCounts[parts.hour] += 1;
        if (sender === "Me") daypart.me += 1;
        else daypart.them += 1;

        let matchedAnyPattern = false;
        for (const pattern of PATTERNS) {
          if (!pattern.regex.test(text)) continue;
          matchedAnyPattern = true;
          addPatternMatch(patternStats.get(pattern.key)!, row, sender, parts, text);
        }
        if (matchedAnyPattern) ritualHits += 1;

        addPhraseAnchors(phraseStats, row, sender, parts, text);

        previous = row;
      }

      const maxHour = Math.max(...hourCells.map((cell) => cell.total), 1);
      for (const cell of hourCells) {
        cell.level = Math.round((cell.total / maxHour) * 100) / 100;
      }

      const phraseAnchors = scorePhraseAnchors(phraseStats);
      const peakCell = [...hourCells].sort((a, b) => b.total - a.total)[0];

      return {
        overview: {
          generated_at: getDataGeneratedAt(),
          real_messages: sourceRows.length,
          active_days: activeDays.size,
          ritual_hits: ritualHits,
          peak_hour: peakCell.hour,
          peak_hour_messages: peakCell.total,
          top_phrase: phraseAnchors[0]?.phrase ?? "",
          top_phrase_count: phraseAnchors[0]?.count ?? 0,
        },
        hour_cells: hourCells,
        dayparts: [...dayparts.values()].map((part) => ({
          key: part.key,
          label: part.label,
          total: part.total,
          me: part.me,
          them: part.them,
          share: sourceRows.length ? part.total / sourceRows.length : 0,
          me_share: part.total ? part.me / part.total : 0,
          peak_hour: peakHour(part.hourCounts),
        })),
        patterns: [...patternStats.values()]
          .filter((p) => p.count > 0)
          .map(patternResult)
          .sort((a, b) => b.count - a.count),
        phrase_anchors: phraseAnchors,
        restart_anchors: [...restartStats.values()]
          .filter((r) => r.count >= 4)
          .sort((a, b) => b.count - a.count)
          .slice(0, 14)
          .map((r) => ({
            phrase: r.phrase,
            count: r.count,
            me: r.me,
            them: r.them,
            avg_gap_hours: Math.round((r.gapHoursTotal / r.count) * 10) / 10,
            examples: r.examples,
          })),
      };
    });
  });

function createHourCells(): HourCell[] {
  const cells: HourCell[] = [];
  for (let weekday = 0; weekday < 7; weekday += 1) {
    for (let hour = 0; hour < 24; hour += 1) {
      cells.push({
        weekday,
        weekday_label: WEEKDAY_LABELS[weekday],
        hour,
        total: 0,
        me: 0,
        them: 0,
        level: 0,
      });
    }
  }
  return cells;
}

function createDayparts() {
  return new Map<string, DaypartAccumulator>([
    ["morning", createDaypart("morning", "Morning", [])],
    ["midday", createDaypart("midday", "Midday", [])],
    ["evening", createDaypart("evening", "Evening", [])],
    ["late", createDaypart("late", "Late night", [])],
  ]);
}

function createDaypart(key: string, label: string, hourCounts: number[]): DaypartAccumulator {
  return {
    key,
    label,
    total: 0,
    me: 0,
    them: 0,
    hourCounts: hourCounts.length ? hourCounts : Array.from({ length: 24 }, () => 0),
  };
}

function createPatternAccumulator(pattern: PatternDefinition): PatternAccumulator {
  return {
    key: pattern.key,
    label: pattern.label,
    description: pattern.description,
    count: 0,
    me: 0,
    them: 0,
    firstTs: Number.POSITIVE_INFINITY,
    lastTs: 0,
    hourCounts: Array.from({ length: 24 }, () => 0),
    weekdayCounts: Array.from({ length: 7 }, () => 0),
    examples: [],
  };
}

function addPatternMatch(
  stat: PatternAccumulator,
  row: MessageRow,
  sender: Sender,
  parts: TimeParts,
  text: string,
) {
  stat.count += 1;
  stat.firstTs = Math.min(stat.firstTs, row.ts);
  stat.lastTs = Math.max(stat.lastTs, row.ts);
  stat.hourCounts[parts.hour] += 1;
  stat.weekdayCounts[parts.weekday] += 1;
  if (sender === "Me") stat.me += 1;
  else stat.them += 1;
  pushExample(stat.examples, row.ts, sender, text);
}

function addPhraseAnchors(
  phraseStats: Map<string, PhraseAccumulator>,
  row: MessageRow,
  sender: Sender,
  parts: TimeParts,
  text: string,
) {
  const tokens = tokenize(text);
  if (tokens.length < 2) return;
  const seenInMessage = new Set<string>();
  for (const size of [2, 3]) {
    for (let i = 0; i <= tokens.length - size; i += 1) {
      const phrase = tokens.slice(i, i + size).join(" ");
      if (seenInMessage.has(phrase) || !isUsefulPhrase(phrase)) continue;
      seenInMessage.add(phrase);
      const stat = phraseStats.get(phrase) ?? createPhraseAccumulator(phrase);
      stat.count += 1;
      stat.days.add(row.ymd);
      stat.months.add(row.ym);
      stat.hourCounts[parts.hour] += 1;
      if (sender === "Me") stat.me += 1;
      else stat.them += 1;
      phraseStats.set(phrase, stat);
    }
  }
}

function createPhraseAccumulator(phrase: string): PhraseAccumulator {
  return {
    phrase,
    count: 0,
    me: 0,
    them: 0,
    days: new Set(),
    months: new Set(),
    hourCounts: Array.from({ length: 24 }, () => 0),
  };
}

function addRestartAnchor(
  restartStats: Map<string, RestartAccumulator>,
  phrase: string,
  row: MessageRow,
  sender: Sender,
  text: string,
  gapHours: number,
) {
  const stat = restartStats.get(phrase) ?? {
    phrase,
    count: 0,
    me: 0,
    them: 0,
    gapHoursTotal: 0,
    examples: [],
  };
  stat.count += 1;
  stat.gapHoursTotal += gapHours;
  if (sender === "Me") stat.me += 1;
  else stat.them += 1;
  pushExample(stat.examples, row.ts, sender, text);
  restartStats.set(phrase, stat);
}

function scorePhraseAnchors(phraseStats: Map<string, PhraseAccumulator>): PhraseAnchor[] {
  return [...phraseStats.values()]
    .filter((p) => p.count >= 35 && p.days.size >= 12 && p.months.size >= 3)
    .map((p) => {
      const sharedness =
        p.me && p.them ? Math.min(p.me, p.them) / Math.max(p.me, p.them) : 0;
      const spread = Math.log1p(p.days.size) * Math.log1p(p.months.size);
      const score = p.count * spread * (0.8 + sharedness);
      return {
        phrase: p.phrase,
        count: p.count,
        me: p.me,
        them: p.them,
        days: p.days.size,
        months: p.months.size,
        peak_hour: peakHour(p.hourCounts),
        sharedness: Math.round(sharedness * 100) / 100,
        score,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 24)
    .map(({ score: _score, ...anchor }) => anchor);
}

function patternResult(p: PatternAccumulator): RitualPattern {
  return {
    key: p.key,
    label: p.label,
    description: p.description,
    count: p.count,
    me: p.me,
    them: p.them,
    first_ts: p.firstTs === Number.POSITIVE_INFINITY ? 0 : p.firstTs,
    last_ts: p.lastTs,
    peak_hour: peakHour(p.hourCounts),
    peak_weekday: WEEKDAY_LABELS[peakHour(p.weekdayCounts)] ?? "Mon",
    examples: p.examples,
  };
}

function pushExample(examples: RitualExample[], ts: number, sender: Sender, text: string) {
  if (examples.length >= 3) return;
  const preview = cleanPreview(text);
  if (!preview || preview === "No text body") return;
  examples.push({ ts, ymd: ymdFromTs(ts), sender, preview });
}

function cleanPreview(text: string | null) {
  return (text ?? "No text body")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function restartPhrase(text: string) {
  const lower = text.toLowerCase();
  if (/\bmorning love\b/.test(lower)) return "morning love";
  if (/\bgood ?morning|mornin+\b/.test(lower)) return "morning";
  if (/\bnight love\b/.test(lower)) return "night love";
  if (/\bgood ?night|goodnight|g ?night\b/.test(lower)) return "goodnight";
  if (/\blove tons\b/.test(lower)) return "love tons";
  if (/\blove lots\b/.test(lower)) return "love lots";
  if (/\blove much\b/.test(lower)) return "love much";
  if (/\bsorry\b/.test(lower)) return "sorry";
  if (/\bthank(s| you)\b/.test(lower)) return "thanks";
  const tokens = tokenize(text);
  if (tokens.length >= 2) return tokens.slice(0, 2).join(" ");
  return tokens[0] ?? "";
}

function tokenize(text: string) {
  return (
    text
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[‘’‛ʼ]/g, "'")
      .match(/[a-z][a-z']{2,}/g)
      ?.map((token) => token.replace(/^'+|'+$/g, ""))
      .filter((token) => token.length >= 3 && token.length <= 18 && !STOPWORDS.has(token)) ?? []
  );
}

function isUsefulPhrase(phrase: string) {
  if (/https|www|http|goo|google|maps|com|dib|tag|keywords|preview/.test(phrase)) return false;
  const words = phrase.split(" ");
  if (words.every((word) => STOPWORDS.has(word))) return false;
  if (words.some((word) => word.length < 3 || /^\d+$/.test(word))) return false;
  return true;
}

function daypartKeyFor(hour: number) {
  if (hour >= 5 && hour < 11) return "morning";
  if (hour >= 11 && hour < 17) return "midday";
  if (hour >= 17 && hour < 22) return "evening";
  return "late";
}

function peakHour(counts: number[]) {
  let bestIndex = 0;
  let best = -1;
  for (let i = 0; i < counts.length; i += 1) {
    if (counts[i] > best) {
      best = counts[i];
      bestIndex = i;
    }
  }
  return bestIndex;
}

function senderFor(row: MessageRow): Sender {
  return row.is_from_me === 1 ? "Me" : "Them";
}

function senderMatches(row: MessageRow, sender: "me" | "them" | "both" = "both") {
  if (sender === "both") return true;
  return sender === "me" ? row.is_from_me === 1 : row.is_from_me === 0;
}

function ymdFromTs(ts: number) {
  return new Date(ts * 1000).toLocaleDateString("en-CA", {
    timeZone: TIME_ZONE,
  });
}

const TIME_PARTS_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  weekday: "short",
  hour: "2-digit",
  hourCycle: "h23",
});

function localParts(ts: number): TimeParts {
  const date = new Date(ts * 1000);
  const parts = TIME_PARTS_FORMATTER.formatToParts(date);
  const weekdayLabel = parts.find((p) => p.type === "weekday")?.value ?? "Mon";
  const rawHour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const weekday = WEEKDAY_LABELS.indexOf(weekdayLabel);
  return {
    weekday: weekday >= 0 ? weekday : 0,
    weekdayLabel,
    hour: Number.isFinite(rawHour) ? rawHour % 24 : 0,
  };
}
