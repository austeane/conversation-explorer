/**
 * Server functions for phrase- and sentence-level analysis.
 *
 * Reads pre-computed tables produced by scripts/extract-phrases.ts:
 *   phrase_bigrams, phrase_trigrams, phrase_collocations,
 *   phrase_divergence_2, phrase_divergence_3,
 *   sentence_stats, sentence_length_hist
 *
 * All counts and scores are computed once at ETL time; this file just slices
 * and serves them.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { db } from "~/lib/server-db";

// ----- shared types -----

export type CollocationRow = {
  gram: string;
  score: number;
  n_count: number;
};

export type PhraseDivergence = {
  gram: string;
  count_me: number;
  count_them: number;
  log_odds_z: number;
  combined_count: number;
};

export type SentenceStat = {
  sender: "me" | "them";
  n_sentences: number;
  mean_words: number;
  median_words: number;
  p90_words: number;
  question_rate: number;
  excl_rate: number;
  emoji_rate: number;
  fk_grade: number;
};

export type SentenceHistRow = { bucket: string; n_count: number };

export type SentenceStatsResponse = {
  me: SentenceStat;
  them: SentenceStat;
  hist: { me: SentenceHistRow[]; them: SentenceHistRow[] };
};

export type TopPhraseRow = { gram: string; n_count: number };

// ----- collocations -----

const collocInput = z.object({
  metric: z.enum(["llr", "pmi", "tscore"]).default("llr"),
  limit: z.number().int().min(1).max(500).default(50),
});

export const getCollocations = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => collocInput.parse(d))
  .handler(async ({ data }): Promise<CollocationRow[]> => {
    const col = data.metric === "pmi" ? "pmi" : data.metric === "tscore" ? "tscore" : "llr";
    const rows = db()
      .prepare(
        `SELECT gram, ${col} AS score, n_count FROM phrase_collocations ORDER BY ${col} DESC LIMIT ?`,
      )
      .all(data.limit) as Array<CollocationRow>;
    return rows;
  });

// ----- distinctive phrases (per-direction log-odds with Dirichlet prior) -----

const divInput = z.object({
  n: z.union([z.literal(2), z.literal(3)]),
  direction: z.enum(["me", "them", "all"]).default("all"),
  limit: z.number().int().min(1).max(1000).default(60),
});

export const getDistinctivePhrases = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => divInput.parse(d))
  .handler(async ({ data }): Promise<PhraseDivergence[]> => {
    const table = data.n === 2 ? "phrase_divergence_2" : "phrase_divergence_3";
    if (data.direction === "me") {
      return db()
        .prepare(
          `SELECT gram, count_me, count_them, log_odds_z, combined_count FROM ${table}
           WHERE log_odds_z > 0 ORDER BY log_odds_z DESC LIMIT ?`,
        )
        .all(data.limit) as PhraseDivergence[];
    }
    if (data.direction === "them") {
      return db()
        .prepare(
          `SELECT gram, count_me, count_them, log_odds_z, combined_count FROM ${table}
           WHERE log_odds_z < 0 ORDER BY log_odds_z ASC LIMIT ?`,
        )
        .all(data.limit) as PhraseDivergence[];
    }
    // 'all' — return everything we have, ordered by |z| desc, capped by limit
    return db()
      .prepare(
        `SELECT gram, count_me, count_them, log_odds_z, combined_count FROM ${table}
         ORDER BY ABS(log_odds_z) DESC LIMIT ?`,
      )
      .all(data.limit) as PhraseDivergence[];
  });

// ----- sentence stats -----

export const getSentenceStats = createServerFn({ method: "GET" }).handler(
  async (): Promise<SentenceStatsResponse> => {
    const d = db();
    const rows = d.prepare(`SELECT * FROM sentence_stats`).all() as SentenceStat[];
    const me = rows.find((r) => r.sender === "me") ?? emptyStat("me");
    const them = rows.find((r) => r.sender === "them") ?? emptyStat("them");
    const hist = d
      .prepare(`SELECT sender, bucket, n_count FROM sentence_length_hist`)
      .all() as Array<{ sender: string; bucket: string; n_count: number }>;
    const order = ["0-4", "5-9", "10-19", "20-49", "50+"];
    function pickAndSort(sender: string) {
      return hist
        .filter((r) => r.sender === sender)
        .sort((a, b) => order.indexOf(a.bucket) - order.indexOf(b.bucket))
        .map((r) => ({ bucket: r.bucket, n_count: r.n_count }));
    }
    return {
      me,
      them,
      hist: { me: pickAndSort("me"), them: pickAndSort("them") },
    };
  },
);

function emptyStat(sender: "me" | "them"): SentenceStat {
  return {
    sender,
    n_sentences: 0,
    mean_words: 0,
    median_words: 0,
    p90_words: 0,
    question_rate: 0,
    excl_rate: 0,
    emoji_rate: 0,
    fk_grade: 0,
  };
}

// ----- top phrases by raw count -----

const topInput = z.object({
  n: z.union([z.literal(2), z.literal(3)]),
  sender: z.enum(["me", "them", "all"]).default("all"),
  limit: z.number().int().min(1).max(200).default(40),
});

export const getTopPhrases = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => topInput.parse(d))
  .handler(async ({ data }): Promise<TopPhraseRow[]> => {
    const table = data.n === 2 ? "phrase_bigrams" : "phrase_trigrams";
    return db()
      .prepare(
        `SELECT gram, n_count FROM ${table} WHERE sender = ? ORDER BY n_count DESC LIMIT ?`,
      )
      .all(data.sender, data.limit) as TopPhraseRow[];
  });
