import { createServerFn } from "@tanstack/react-start";
import { realMessageWhere } from "~/lib/conversation/filters";
import { messageScopeInput, messageScopeWhere } from "~/lib/conversation/scope";
import { db, getDataGeneratedAt, withDbCache } from "~/lib/server-db";
import { resolveMessageScope } from "~/server/scope";

const REAL_MESSAGE_WHERE = realMessageWhere("browsable_message", "m");
const MIN_DORMANT_DAYS = 30;
const MIN_OCCURRENCES = 5;
const MIN_DAYS = 3;
const MIN_MONTHS = 2;
const MAX_OCCURRENCES = 180;
const TOP_MOTIFS = 30;
const TOP_RETURNS = 24;

export type Sender = "Me" | "Them";

export type EchoOverview = {
  generated_at: string;
  scanned_messages: number;
  candidate_phrases: number;
  echo_phrases: number;
  echo_returns: number;
  shared_echo_rate: number;
  longest_gap_days: number;
  strongest_phrase: string;
};

export type EchoMonth = {
  ym: string;
  returns: number;
  shared_returns: number;
  max_gap_days: number;
};

export type EchoExample = {
  ts: number;
  ymd: string;
  sender: Sender;
  role: "origin" | "return" | "recent";
  preview: string;
};

export type EchoMotif = {
  phrase: string;
  count: number;
  days: number;
  months: number;
  first_ts: number;
  last_ts: number;
  me_count: number;
  them_count: number;
  sharedness: number;
  max_gap_days: number;
  return_count: number;
  sender_switches: number;
  score: number;
  examples: EchoExample[];
};

export type EchoReturn = {
  phrase: string;
  gap_days: number;
  from_ts: number;
  from_ymd: string;
  to_ts: number;
  to_ymd: string;
  previous_sender: Sender;
  return_sender: Sender;
  before_preview: string;
  return_preview: string;
  score: number;
};

export type EchoResult = {
  overview: EchoOverview;
  months: EchoMonth[];
  motifs: EchoMotif[];
  returns: EchoReturn[];
  handoffs: EchoReturn[];
};

type MessageRow = {
  id: number;
  ts: number;
  ymd: string;
  ym: string;
  is_from_me: number;
  text: string | null;
};

type Occurrence = {
  id: number;
  ts: number;
  ymd: string;
  ym: string;
  sender: Sender;
  preview: string;
};

type ScoredMotif = EchoMotif & {
  allReturns: EchoReturn[];
};

const STOPWORDS = new Set([
  "a","an","and","are","as","at","be","been","but","by","can","could","did","do","does",
  "for","from","get","got","had","has","have","he","her","here","him","his","how","i",
  "if","im","in","is","it","its","just","like","me","my","not","of","on","or","our","out",
  "she","so","that","the","their","them","then","there","they","this","to","too","up","us",
  "was","we","were","what","when","where","which","who","why","will","with","would","yeah",
  "you","your","youre","youve","about","again","also","back","don","dont","don't","doesn",
  "doesnt","doesn't","didn","didnt","didn't","i'm","i've","i'll","i'd","thats","that's",
  "wanna","gonna","kinda","sorta","okay","ok","good","know","think","see","said","talked",
  "it's","might","all","one","probably","same","should","those","any","more","other",
  "some","than",
]);

const ALLOWED_PHRASES = new Set([
  "love you",
  "miss you",
  "good morning",
  "good night",
  "sleep well",
  "anxiety brain",
]);

const BLOCKED_PHRASES = new Set([
  "all good",
  "don't know",
  "don't see",
  "don't wanna",
  "good i'm",
  "i'm sorry",
  "love you",
  "talked about",
]);

const GENERIC_CONTENT = new Set([
  "definitely",
  "early",
  "else",
  "figure",
  "helpful",
  "night",
  "longer",
  "lot",
  "people",
  "second",
  "pretty",
  "say",
  "something",
  "spending",
  "sure",
  "thing",
  "things",
  "time",
  "trying",
  "wanted",
]);

export const getEchoes = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => messageScopeInput.parse(d ?? {}))
  .handler(async ({ data }): Promise<EchoResult> => {
    const resolved = resolveMessageScope(data);
    return withDbCache(`echoes:${JSON.stringify(resolved)}`, () => {
      const scope = messageScopeWhere(resolved, "m", [REAL_MESSAGE_WHERE]);
      const rows = db()
        .prepare(
          `
          SELECT m.id, m.ts, m.ymd, m.ym, m.is_from_me, m.text
          FROM messages m
          ${scope.sql}
          ORDER BY m.ts ASC, m.id ASC
        `,
        )
        .all(...scope.args) as MessageRow[];

      const phraseOccurrences = collectOccurrences(rows);
      const scored = scoreMotifs(phraseOccurrences);
      const motifs = scored.slice(0, TOP_MOTIFS);
      const returns = scored
        .flatMap((motif) => motif.allReturns.map((item) => ({ ...item, score: round(item.score + motif.score / 8) })))
        .sort((a, b) => b.score - a.score || b.gap_days - a.gap_days)
        .slice(0, TOP_RETURNS);
      const handoffs = returns
        .filter((item) => item.previous_sender !== item.return_sender)
        .slice(0, 18);
      const months = buildMonths(scored.flatMap((motif) => motif.allReturns));
      const allReturnCount = scored.reduce((sum, motif) => sum + motif.return_count, 0);
      const sharedReturnCount = scored.reduce((sum, motif) => sum + motif.sender_switches, 0);
      const longest = scored.reduce((max, motif) => Math.max(max, motif.max_gap_days), 0);

      return {
        overview: {
          generated_at: getDataGeneratedAt(),
          scanned_messages: rows.length,
          candidate_phrases: phraseOccurrences.size,
          echo_phrases: scored.length,
          echo_returns: allReturnCount,
          shared_echo_rate: rate(sharedReturnCount, allReturnCount),
          longest_gap_days: longest,
          strongest_phrase: motifs[0]?.phrase ?? "n/a",
        },
        months,
        motifs,
        returns,
        handoffs,
      };
    });
  });

function collectOccurrences(rows: MessageRow[]) {
  const phrases = new Map<string, Occurrence[]>();
  for (const row of rows) {
    const text = cleanText(row.text);
    if (!text || /^https?:\/\/\S+$/i.test(text)) continue;
    const tokens = tokenize(text);
    if (tokens.length < 2) continue;
    const seen = new Set<string>();
    for (let n = 2; n <= 4; n += 1) {
      for (let i = 0; i <= tokens.length - n; i += 1) {
        const gramTokens = tokens.slice(i, i + n);
        if (!isCandidate(gramTokens)) continue;
        const phrase = gramTokens.join(" ");
        if (seen.has(phrase)) continue;
        seen.add(phrase);
        const occurrence = {
          id: row.id,
          ts: row.ts,
          ymd: row.ymd,
          ym: row.ym,
          sender: senderFor(row),
          preview: truncate(text, 220),
        };
        const existing = phrases.get(phrase);
        if (existing) existing.push(occurrence);
        else phrases.set(phrase, [occurrence]);
      }
    }
  }
  return phrases;
}

function scoreMotifs(phraseOccurrences: Map<string, Occurrence[]>): ScoredMotif[] {
  const motifs: ScoredMotif[] = [];
  for (const [phrase, occurrences] of phraseOccurrences.entries()) {
    if (occurrences.length < MIN_OCCURRENCES || occurrences.length > MAX_OCCURRENCES) continue;
    const sorted = [...occurrences].sort((a, b) => a.ts - b.ts || a.id - b.id);
    const days = new Set(sorted.map((item) => item.ymd));
    const months = new Set(sorted.map((item) => item.ym));
    if (days.size < MIN_DAYS || months.size < MIN_MONTHS) continue;

    const returns: EchoReturn[] = [];
    for (let i = 1; i < sorted.length; i += 1) {
      const previous = sorted[i - 1];
      const current = sorted[i];
      const gapDays = (current.ts - previous.ts) / 86400;
      if (gapDays < MIN_DORMANT_DAYS) continue;
      returns.push({
        phrase,
        gap_days: round(gapDays),
        from_ts: previous.ts,
        from_ymd: previous.ymd,
        to_ts: current.ts,
        to_ymd: current.ymd,
        previous_sender: previous.sender,
        return_sender: current.sender,
        before_preview: previous.preview,
        return_preview: current.preview,
        score: round(Math.log1p(gapDays) * (previous.sender === current.sender ? 1 : 1.35)),
      });
    }
    if (!returns.length) continue;

    const meCount = sorted.filter((item) => item.sender === "Me").length;
    const themCount = sorted.length - meCount;
    const sharedness = sorted.length ? (2 * Math.min(meCount, themCount)) / sorted.length : 0;
    const senderSwitches = returns.filter((item) => item.previous_sender !== item.return_sender).length;
    const maxGap = Math.max(...returns.map((item) => item.gap_days));
    const score =
      countValue(sorted.length) * 1.8 +
      Math.log1p(maxGap) * 1.7 +
      Math.log1p(returns.length) * 1.25 +
      sharedness * 2 +
      Math.log1p(senderSwitches) * 1.4 +
      Math.min(1.2, phrase.split(" ").length * 0.25);
    const origin = sorted[0];
    const strongestReturn = [...returns].sort((a, b) => b.gap_days - a.gap_days)[0];
    const returnOccurrence = sorted.find((item) => item.ts === strongestReturn.to_ts) ?? sorted[1];
    const recent = sorted[sorted.length - 1];

    motifs.push({
      phrase,
      count: sorted.length,
      days: days.size,
      months: months.size,
      first_ts: origin.ts,
      last_ts: recent.ts,
      me_count: meCount,
      them_count: themCount,
      sharedness: round(sharedness),
      max_gap_days: round(maxGap),
      return_count: returns.length,
      sender_switches: senderSwitches,
      score: round(score),
      examples: uniqueExamples([
        { ts: origin.ts, ymd: origin.ymd, sender: origin.sender, role: "origin", preview: origin.preview },
        {
          ts: returnOccurrence.ts,
          ymd: returnOccurrence.ymd,
          sender: returnOccurrence.sender,
          role: "return",
          preview: returnOccurrence.preview,
        },
        { ts: recent.ts, ymd: recent.ymd, sender: recent.sender, role: "recent", preview: recent.preview },
      ]),
      allReturns: returns.sort((a, b) => b.gap_days - a.gap_days).slice(0, 4),
    });
  }
  return motifs.sort((a, b) => b.score - a.score || b.max_gap_days - a.max_gap_days);
}

function buildMonths(returns: EchoReturn[]): EchoMonth[] {
  const months = new Map<string, EchoMonth>();
  for (const item of returns) {
    const ym = ymFromTs(item.to_ts);
    const month = months.get(ym) ?? {
      ym,
      returns: 0,
      shared_returns: 0,
      max_gap_days: 0,
    };
    month.returns += 1;
    if (item.previous_sender !== item.return_sender) month.shared_returns += 1;
    month.max_gap_days = Math.max(month.max_gap_days, item.gap_days);
    months.set(ym, month);
  }
  return [...months.values()].sort((a, b) => a.ym.localeCompare(b.ym));
}

function uniqueExamples(examples: EchoExample[]) {
  const seen = new Set<string>();
  return examples.filter((example) => {
    const key = `${example.ts}-${example.sender}-${example.preview}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isCandidate(tokens: string[]) {
  const phrase = tokens.join(" ");
  if (BLOCKED_PHRASES.has(phrase)) return false;
  if (ALLOWED_PHRASES.has(phrase)) return true;
  if (tokens[0].length <= 1 || tokens[tokens.length - 1].length <= 1) return false;
  if (STOPWORDS.has(tokens[0]) || STOPWORDS.has(tokens[tokens.length - 1])) return false;
  const meaningful = tokens.filter((token) => !STOPWORDS.has(token) && token.length > 2);
  if (meaningful.length > 0 && meaningful.every((token) => GENERIC_CONTENT.has(token))) return false;
  if (tokens.length === 2) return meaningful.length === 2;
  return meaningful.length >= 2;
}

function countValue(count: number) {
  const sweetSpot = Math.min(count, 45);
  const overusePenalty = Math.max(0, count - 45) / 75;
  return Math.max(0.4, Math.log1p(sweetSpot) - overusePenalty);
}

function tokenize(text: string) {
  return text
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .match(/[a-z0-9]+(?:'[a-z0-9]+)?/g) ?? [];
}

function cleanText(text: string | null) {
  return (text ?? "")
    .replace(/\s+/g, " ")
    .replace(/\uFFFC/g, "")
    .trim();
}

function senderFor(row: MessageRow): Sender {
  return row.is_from_me === 1 ? "Me" : "Them";
}

function ymFromTs(ts: number) {
  const date = new Date(ts * 1000);
  return date.toLocaleDateString("en-CA", {
    year: "numeric",
    month: "2-digit",
    timeZone: "America/Vancouver",
  });
}

function truncate(text: string, maxChars: number) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1).trim()}...`;
}

function rate(part: number, whole: number) {
  return whole ? part / whole : 0;
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}
