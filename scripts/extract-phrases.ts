/**
 * Phrase- and sentence-level analysis for runtime conversation DB.
 *
 * Reads messages from data/runtime/conversation.db, computes:
 *   - Bigrams + trigrams per sender (me / them / all) — sentence-bounded.
 *   - Collocation scores on combined-corpus bigrams: Dunning's log-likelihood
 *     ratio (LLR), pointwise mutual information (PMI), Student's t-score.
 *   - Distinctive bigrams + trigrams per sender via Monroe, Colaresi & Quinn
 *     (2008) log-odds ratio with informative Dirichlet prior, z-scored.
 *   - Sentence stats per sender: mean/median/p90 word length, question rate,
 *     exclamation rate, emoji rate, Flesch-Kincaid grade level.
 *   - Sentence length histogram per sender.
 *
 * Persists results into new tables on the same SQLite file (idempotent: drops
 * the relevant tables first).
 *
 * Run with:
 *     pnpm extract:phrases
 *   or
 *     npx tsx scripts/extract-phrases.ts
 */
import Database from "better-sqlite3";
import { join } from "node:path";

const DB_PATH = join(process.cwd(), "data/runtime/conversation.db");

// ----- tokenizer (mirrors src/server/queries.ts::WORD_STOP & getWordTops) -----

const WORD_STOP = new Set([
  "the","a","an","and","or","but","if","so","of","in","on","at","to","for","with","by",
  "is","are","was","were","be","been","being","have","has","had","do","does","did",
  "i","you","we","they","he","she","it","me","my","your","our","their","his","her","its",
  "this","that","these","those","as","not","no","yes","ok","okay","oh","um","uh","like","just",
  "really","very","up","down","out","off","over","there","here","then","than","when","where","what","which","who",
  "from","into","about","also","too","can","will","would","could","should",
  "u","ur","ya","yeah","yep","yup","ima","gotta","ah","mm","mhm","mmm","hm","hmm","huh",
  "lol","lmao","haha","hehe","nah","yo","hi","hey","hello","well","got","get","gets","getting","gotten",
  "go","goes","going","went","gone","good","bad","sure","right","fine","one","two","three",
  "im","i'm","ive","i've","ill","i'll","id","i'd",
  "dont","don't","doesnt","doesn't","didnt","didn't","cant","can't","wont","won't","aint","ain't",
  "thats","that's","theres","there's","whats","what's","heres","here's","its","it's",
  "youre","you're","youve","you've","youll","you'll","youd","you'd",
  "shes","she's","hes","he's","theyre","they're","weve","we've","were","we're",
  "gonna","wanna","kinda","sorta","didn","doesn","wasn","wasn't","isn","isn't",
  "wouldn","wouldn't","couldn","couldn't","shouldn","shouldn't","haven","haven't","hadn","hadn't","hasn","hasn't",
]);

const EMOJI_RE = /(?:\p{Extended_Pictographic}(?:‍\p{Extended_Pictographic})*️?)/gu;

// Try Intl.Segmenter for sentence boundaries; fall back to a simple regex split.
type SentenceSplitter = (text: string) => string[];

const SENTENCE_FALLBACK: SentenceSplitter = (text) =>
  text
    .split(/(?<=[.!?…])\s+|\n+/g)
    .map((s) => s.trim())
    .filter(Boolean);

function makeSentenceSplitter(): SentenceSplitter {
  // @ts-ignore — Intl.Segmenter exists in Node 18+ but TS lib config may not pick up
  const Segmenter = (Intl as any).Segmenter;
  if (!Segmenter) return SENTENCE_FALLBACK;
  try {
    const seg = new Segmenter("en", { granularity: "sentence" });
    return (text: string) => {
      const out: string[] = [];
      for (const part of seg.segment(text) as Iterable<{ segment: string }>) {
        const trimmed = part.segment.trim();
        if (trimmed) out.push(trimmed);
      }
      return out;
    };
  } catch {
    return SENTENCE_FALLBACK;
  }
}

const splitSentences = makeSentenceSplitter();

function tokenize(s: string): string[] {
  const t = s
    .toLowerCase()
    .replace(/[‘’‛ʼ]/g, "'")
    .replace(/[^a-z' ]+/g, " ");
  const out: string[] = [];
  for (const raw of t.split(/\s+/)) {
    if (!raw) continue;
    const w = raw.replace(/^'+|'+$/g, "");
    if (w.length < 2 || w.length > 24) continue;
    if (WORD_STOP.has(w)) continue;
    out.push(w);
  }
  return out;
}

// Approximate syllable count: vowel groups, minus silent terminal "e".
function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  const groups = w.match(/[aeiouy]+/g);
  let n = groups ? groups.length : 0;
  if (w.length > 3 && /e$/.test(w) && !/le$/.test(w)) n--;
  return Math.max(1, n);
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[m - 1] + sorted[m]) / 2 : sorted[m];
}

function quantile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[idx];
}

// ----- main -----

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

console.log("[phrases] starting against", DB_PATH);

console.log("[phrases] dropping existing phrase_* + sentence_* tables");
db.exec(`
  DROP TABLE IF EXISTS phrase_bigrams;
  DROP TABLE IF EXISTS phrase_trigrams;
  DROP TABLE IF EXISTS phrase_collocations;
  DROP TABLE IF EXISTS phrase_divergence_2;
  DROP TABLE IF EXISTS phrase_divergence_3;
  DROP TABLE IF EXISTS sentence_stats;
  DROP TABLE IF EXISTS sentence_length_hist;
`);

db.exec(`
  CREATE TABLE phrase_bigrams (
    gram TEXT NOT NULL,
    sender TEXT NOT NULL,
    n_count INTEGER NOT NULL,
    PRIMARY KEY (gram, sender)
  );
  CREATE INDEX phrase_bigrams_count_idx ON phrase_bigrams(sender, n_count DESC);

  CREATE TABLE phrase_trigrams (
    gram TEXT NOT NULL,
    sender TEXT NOT NULL,
    n_count INTEGER NOT NULL,
    PRIMARY KEY (gram, sender)
  );
  CREATE INDEX phrase_trigrams_count_idx ON phrase_trigrams(sender, n_count DESC);

  CREATE TABLE phrase_collocations (
    gram TEXT PRIMARY KEY,
    llr REAL NOT NULL,
    pmi REAL NOT NULL,
    tscore REAL NOT NULL,
    n_count INTEGER NOT NULL
  );
  CREATE INDEX phrase_collocations_llr_idx ON phrase_collocations(llr DESC);
  CREATE INDEX phrase_collocations_pmi_idx ON phrase_collocations(pmi DESC);
  CREATE INDEX phrase_collocations_tscore_idx ON phrase_collocations(tscore DESC);

  CREATE TABLE phrase_divergence_2 (
    gram TEXT PRIMARY KEY,
    count_me INTEGER NOT NULL,
    count_them INTEGER NOT NULL,
    log_odds_z REAL NOT NULL,
    combined_count INTEGER NOT NULL
  );
  CREATE INDEX phrase_divergence_2_z_idx ON phrase_divergence_2(log_odds_z);

  CREATE TABLE phrase_divergence_3 (
    gram TEXT PRIMARY KEY,
    count_me INTEGER NOT NULL,
    count_them INTEGER NOT NULL,
    log_odds_z REAL NOT NULL,
    combined_count INTEGER NOT NULL
  );
  CREATE INDEX phrase_divergence_3_z_idx ON phrase_divergence_3(log_odds_z);

  CREATE TABLE sentence_stats (
    sender TEXT PRIMARY KEY,
    n_sentences INTEGER NOT NULL,
    mean_words REAL NOT NULL,
    median_words REAL NOT NULL,
    p90_words REAL NOT NULL,
    question_rate REAL NOT NULL,
    excl_rate REAL NOT NULL,
    emoji_rate REAL NOT NULL,
    fk_grade REAL NOT NULL
  );

  CREATE TABLE sentence_length_hist (
    sender TEXT NOT NULL,
    bucket TEXT NOT NULL,
    n_count INTEGER NOT NULL,
    PRIMARY KEY (sender, bucket)
  );
`);

// Read messages once, stream.
const rows = db
  .prepare(`SELECT is_from_me, text FROM messages WHERE text IS NOT NULL AND text != ''`)
  .iterate() as IterableIterator<{ is_from_me: number; text: string }>;

// per-sender, per-n: bigrams + trigrams
const bigramCounts = { me: new Map<string, number>(), them: new Map<string, number>() };
const trigramCounts = { me: new Map<string, number>(), them: new Map<string, number>() };

// unigram counts (combined corpus only) — we need them for collocation marginals
const uniCounts = new Map<string, number>(); // word → count (anywhere in tokenized stream, sentence-bounded)
let uniTotal = 0; // total unigram tokens (≈ N for collocation marginals, after stop-removal)

// sentence stats accumulators
type SentAcc = {
  n: number;
  totalWords: number;
  totalWordsSq: number;
  questions: number;
  excl: number;
  emoji: number;
  syllables: number;
  lengths: number[]; // captured for median/p90 + histogram (memory: ~200k floats per sender, fine)
};
function newSentAcc(): SentAcc {
  return { n: 0, totalWords: 0, totalWordsSq: 0, questions: 0, excl: 0, emoji: 0, syllables: 0, lengths: [] };
}
const sentAcc = { me: newSentAcc(), them: newSentAcc() };

const HIST_BUCKETS: Array<{ label: string; max: number }> = [
  { label: "0-4", max: 4 },
  { label: "5-9", max: 9 },
  { label: "10-19", max: 19 },
  { label: "20-49", max: 49 },
  { label: "50+", max: Infinity },
];

function bucketLabel(n: number): string {
  for (const b of HIST_BUCKETS) if (n <= b.max) return b.label;
  return HIST_BUCKETS[HIST_BUCKETS.length - 1].label;
}

let msgRows = 0;
for (const r of rows) {
  msgRows++;
  const senderKey = r.is_from_me === 1 ? "me" : "them";
  const accForSender = sentAcc[senderKey];

  const sentences = splitSentences(r.text);
  for (const sent of sentences) {
    const tokens = tokenize(sent);
    if (tokens.length === 0 && !sent.trim()) continue;

    // Sentence-level stats use raw sentence text — words counted before stop-removal,
    // because sentence length is a stylistic property, not a vocab one.
    const rawWords = sent.trim().split(/\s+/).filter(Boolean);
    const wordCount = rawWords.length;
    if (wordCount === 0) continue;

    accForSender.n++;
    accForSender.totalWords += wordCount;
    accForSender.totalWordsSq += wordCount * wordCount;
    accForSender.lengths.push(wordCount);
    if (/[?]\s*$/.test(sent)) accForSender.questions++;
    if (/[!]\s*$/.test(sent)) accForSender.excl++;
    const emojiMatches = sent.match(EMOJI_RE);
    accForSender.emoji += emojiMatches ? emojiMatches.length : 0;
    for (const w of rawWords) accForSender.syllables += syllables(w);

    // n-grams: only over tokenized (stop-removed) tokens, sentence-bounded.
    if (tokens.length >= 1) {
      for (const t of tokens) {
        uniCounts.set(t, (uniCounts.get(t) ?? 0) + 1);
        uniTotal++;
      }
    }
    if (tokens.length >= 2) {
      for (let i = 0; i < tokens.length - 1; i++) {
        const g = `${tokens[i]} ${tokens[i + 1]}`;
        const cMap = bigramCounts[senderKey];
        cMap.set(g, (cMap.get(g) ?? 0) + 1);
      }
    }
    if (tokens.length >= 3) {
      for (let i = 0; i < tokens.length - 2; i++) {
        const g = `${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`;
        const cMap = trigramCounts[senderKey];
        cMap.set(g, (cMap.get(g) ?? 0) + 1);
      }
    }
  }
  if (msgRows % 25_000 === 0) console.log(`[phrases] scanned ${msgRows} messages`);
}
console.log(`[phrases] scanned ${msgRows} messages, ${uniTotal} tokens`);

// ----- save bigram + trigram per-sender counts (with min-count filter) -----

const MIN_BIGRAM = 10;
const MIN_TRIGRAM = 5;

const insBi = db.prepare(`INSERT OR REPLACE INTO phrase_bigrams (gram, sender, n_count) VALUES (?, ?, ?)`);
const insTri = db.prepare(`INSERT OR REPLACE INTO phrase_trigrams (gram, sender, n_count) VALUES (?, ?, ?)`);

// Build the combined-sender map once and write 'all' rows alongside per-sender rows.
function combine(a: Map<string, number>, b: Map<string, number>): Map<string, number> {
  const out = new Map(a);
  for (const [k, v] of b) out.set(k, (out.get(k) ?? 0) + v);
  return out;
}

const bigramAll = combine(bigramCounts.me, bigramCounts.them);
const trigramAll = combine(trigramCounts.me, trigramCounts.them);

let nBigramsWritten = 0;
let nTrigramsWritten = 0;

const txWriteNGrams = db.transaction(() => {
  for (const [g, c] of bigramCounts.me) if (c >= MIN_BIGRAM) { insBi.run(g, "me", c); nBigramsWritten++; }
  for (const [g, c] of bigramCounts.them) if (c >= MIN_BIGRAM) { insBi.run(g, "them", c); nBigramsWritten++; }
  for (const [g, c] of bigramAll) if (c >= MIN_BIGRAM) { insBi.run(g, "all", c); nBigramsWritten++; }
  for (const [g, c] of trigramCounts.me) if (c >= MIN_TRIGRAM) { insTri.run(g, "me", c); nTrigramsWritten++; }
  for (const [g, c] of trigramCounts.them) if (c >= MIN_TRIGRAM) { insTri.run(g, "them", c); nTrigramsWritten++; }
  for (const [g, c] of trigramAll) if (c >= MIN_TRIGRAM) { insTri.run(g, "all", c); nTrigramsWritten++; }
});
txWriteNGrams();
console.log(`[phrases] wrote bigrams: ${nBigramsWritten} rows  (≥${MIN_BIGRAM} per sender/all)`);
console.log(`[phrases] wrote trigrams: ${nTrigramsWritten} rows  (≥${MIN_TRIGRAM} per sender/all)`);

// ----- collocation scores on combined corpus -----
//
// For each bigram (w1 w2) appearing ≥10 times combined:
//   c12 = bigram count
//   c1  = sum over j of count(w1 w_j)        // "w1 as first word" count
//   c2  = sum over i of count(w_i w2)        // "w2 as second word" count
//   N   = total bigram instances (sum of all bigram counts in combined corpus)
//
// PMI    = log2( (c12 / N) / ((c1/N) * (c2/N)) )
// t-test = (c12/N − c1*c2/N²) / sqrt(c12 / N²)
// LLR    = 2 · sum_{ij} O_ij · log(O_ij / E_ij), with the 2x2 contingency table:
//          [[c12,         c1 - c12],
//           [c2 - c12,    N - c1 - c2 + c12]]

console.log(`[phrases] computing collocation scores`);

// Build first-word and second-word marginals from the combined bigram map.
let totalBigrams = 0;
const c1Map = new Map<string, number>();
const c2Map = new Map<string, number>();
for (const [g, c] of bigramAll) {
  totalBigrams += c;
  const sp = g.indexOf(" ");
  const w1 = g.slice(0, sp);
  const w2 = g.slice(sp + 1);
  c1Map.set(w1, (c1Map.get(w1) ?? 0) + c);
  c2Map.set(w2, (c2Map.get(w2) ?? 0) + c);
}
const N = totalBigrams;
console.log(`[phrases] total bigram instances (combined): ${N}`);

type CollocRow = { gram: string; llr: number; pmi: number; tscore: number; n_count: number };
const collocRows: CollocRow[] = [];

for (const [g, c12] of bigramAll) {
  if (c12 < 10) continue;
  const sp = g.indexOf(" ");
  const w1 = g.slice(0, sp);
  const w2 = g.slice(sp + 1);
  const c1 = c1Map.get(w1) ?? 0;
  const c2 = c2Map.get(w2) ?? 0;

  // PMI (log2)
  const pBoth = c12 / N;
  const pW1 = c1 / N;
  const pW2 = c2 / N;
  const pmi = pBoth > 0 && pW1 > 0 && pW2 > 0 ? Math.log2(pBoth / (pW1 * pW2)) : 0;

  // t-score
  const expected = (c1 * c2) / N;
  const tscore = c12 > 0 ? (c12 - expected) / Math.sqrt(c12) : 0;

  // LLR — Dunning's log-likelihood ratio against the 2x2 contingency table.
  const a = c12;
  const b = c1 - c12;
  const cc = c2 - c12;
  const d = N - c1 - c2 + c12;
  if (b < 0 || cc < 0 || d < 0) continue; // sanity (shouldn't happen with consistent counts)
  const total = a + b + cc + d; // == N
  const eA = ((a + b) * (a + cc)) / total;
  const eB = ((a + b) * (b + d)) / total;
  const eC = ((cc + d) * (a + cc)) / total;
  const eD = ((cc + d) * (b + d)) / total;
  function term(o: number, e: number): number {
    if (o <= 0 || e <= 0) return 0;
    return o * Math.log(o / e);
  }
  const llr = 2 * (term(a, eA) + term(b, eB) + term(cc, eC) + term(d, eD));

  collocRows.push({ gram: g, llr, pmi, tscore, n_count: c12 });
}

// Keep top 5000 of each metric, deduplicated.
function topByKey<T>(arr: T[], k: number, key: (x: T) => number): T[] {
  return [...arr].sort((a, b) => key(b) - key(a)).slice(0, k);
}
const TOP_N = 5000;
const topLlr = new Map(topByKey(collocRows, TOP_N, (r) => r.llr).map((r) => [r.gram, r] as const));
const topPmi = new Map(topByKey(collocRows, TOP_N, (r) => r.pmi).map((r) => [r.gram, r] as const));
const topT = new Map(topByKey(collocRows, TOP_N, (r) => r.tscore).map((r) => [r.gram, r] as const));
const collocSeen = new Map<string, CollocRow>();
for (const m of [topLlr, topPmi, topT]) for (const [g, r] of m) collocSeen.set(g, r);

const insCol = db.prepare(`INSERT OR REPLACE INTO phrase_collocations (gram, llr, pmi, tscore, n_count) VALUES (?,?,?,?,?)`);
const txCol = db.transaction(() => {
  for (const r of collocSeen.values()) {
    insCol.run(r.gram, r.llr, r.pmi, r.tscore, r.n_count);
  }
});
txCol();
console.log(`[phrases] wrote phrase_collocations: ${collocSeen.size} rows`);

// ----- distinctive phrases per sender (Monroe et al. 2008) -----

function divergence(
  meCounts: Map<string, number>,
  themCounts: Map<string, number>,
  minCombined: number,
): Array<{ gram: string; count_me: number; count_them: number; log_odds_z: number; combined_count: number }> {
  let nMe = 0;
  let nThem = 0;
  for (const c of meCounts.values()) nMe += c;
  for (const c of themCounts.values()) nThem += c;
  const totalN = nMe + nThem;
  const ALPHA0 = 100;
  const vocab = new Set<string>([...meCounts.keys(), ...themCounts.keys()]);
  const out: ReturnType<typeof divergence> = [];
  for (const w of vocab) {
    const yMe = meCounts.get(w) ?? 0;
    const yThem = themCounts.get(w) ?? 0;
    const yW = yMe + yThem;
    if (yW < minCombined) continue;
    const alphaW = ALPHA0 * (yW / totalN);
    const logOddsMe = Math.log((yMe + alphaW) / (nMe + ALPHA0 - yMe - alphaW));
    const logOddsThem = Math.log((yThem + alphaW) / (nThem + ALPHA0 - yThem - alphaW));
    const delta = logOddsMe - logOddsThem;
    const variance = 1 / (yMe + alphaW) + 1 / (yThem + alphaW);
    const z = delta / Math.sqrt(variance);
    out.push({ gram: w, count_me: yMe, count_them: yThem, log_odds_z: z, combined_count: yW });
  }
  return out;
}

console.log(`[phrases] computing log-odds divergence (bigrams)`);
const div2 = divergence(bigramCounts.me, bigramCounts.them, 5);
console.log(`[phrases] computing log-odds divergence (trigrams)`);
const div3 = divergence(trigramCounts.me, trigramCounts.them, 5);

// Cap at top 1000 per direction for both bigrams and trigrams.
function topByDirection(rows: ReturnType<typeof divergence>, k: number) {
  const me = [...rows].filter((r) => r.log_odds_z > 0).sort((a, b) => b.log_odds_z - a.log_odds_z).slice(0, k);
  const them = [...rows].filter((r) => r.log_odds_z < 0).sort((a, b) => a.log_odds_z - b.log_odds_z).slice(0, k);
  const merged = new Map<string, (typeof rows)[number]>();
  for (const r of [...me, ...them]) merged.set(r.gram, r);
  return merged;
}
const div2Keep = topByDirection(div2, 1000);
const div3Keep = topByDirection(div3, 1000);

const insDiv2 = db.prepare(
  `INSERT OR REPLACE INTO phrase_divergence_2 (gram, count_me, count_them, log_odds_z, combined_count) VALUES (?,?,?,?,?)`,
);
const insDiv3 = db.prepare(
  `INSERT OR REPLACE INTO phrase_divergence_3 (gram, count_me, count_them, log_odds_z, combined_count) VALUES (?,?,?,?,?)`,
);
const txDiv = db.transaction(() => {
  for (const r of div2Keep.values()) insDiv2.run(r.gram, r.count_me, r.count_them, r.log_odds_z, r.combined_count);
  for (const r of div3Keep.values()) insDiv3.run(r.gram, r.count_me, r.count_them, r.log_odds_z, r.combined_count);
});
txDiv();
console.log(`[phrases] wrote phrase_divergence_2: ${div2Keep.size} rows`);
console.log(`[phrases] wrote phrase_divergence_3: ${div3Keep.size} rows`);

// ----- sentence stats -----

const insStats = db.prepare(
  `INSERT OR REPLACE INTO sentence_stats
   (sender, n_sentences, mean_words, median_words, p90_words, question_rate, excl_rate, emoji_rate, fk_grade)
   VALUES (?,?,?,?,?,?,?,?,?)`,
);
const insHist = db.prepare(
  `INSERT OR REPLACE INTO sentence_length_hist (sender, bucket, n_count) VALUES (?,?,?)`,
);

function summarize(sender: string, acc: SentAcc) {
  const n = acc.n;
  if (n === 0) {
    insStats.run(sender, 0, 0, 0, 0, 0, 0, 0, 0);
    return;
  }
  const meanWords = acc.totalWords / n;
  const medianWords = median(acc.lengths);
  const p90 = quantile(acc.lengths, 0.9);
  const qRate = acc.questions / n;
  const eRate = acc.excl / n;
  const emRate = acc.emoji / n;
  const syllPerWord = acc.syllables / Math.max(1, acc.totalWords);
  const fk = 0.39 * (acc.totalWords / n) + 11.8 * syllPerWord - 15.59;
  insStats.run(sender, n, meanWords, medianWords, p90, qRate, eRate, emRate, fk);

  // histogram
  const buckets = new Map<string, number>();
  for (const b of HIST_BUCKETS) buckets.set(b.label, 0);
  for (const len of acc.lengths) {
    const lab = bucketLabel(len);
    buckets.set(lab, (buckets.get(lab) ?? 0) + 1);
  }
  for (const [lab, c] of buckets) insHist.run(sender, lab, c);
}

const txSent = db.transaction(() => {
  summarize("me", sentAcc.me);
  summarize("them", sentAcc.them);
});
txSent();
console.log(
  `[phrases] sentence_stats — me: ${sentAcc.me.n} sentences, them: ${sentAcc.them.n} sentences`,
);

// ----- sanity-check output -----

console.log("\n[phrases] top 5 collocations by LLR:");
const llrTop = db.prepare(`SELECT gram, llr, n_count FROM phrase_collocations ORDER BY llr DESC LIMIT 5`).all() as Array<{ gram: string; llr: number; n_count: number }>;
for (const r of llrTop) console.log(`  ${r.gram.padEnd(36)}  llr=${r.llr.toFixed(1).padStart(8)}  n=${r.n_count}`);

console.log("\n[phrases] top 5 distinctive bigrams (Me direction):");
const div2A = db.prepare(`SELECT gram, count_me, count_them, log_odds_z, combined_count FROM phrase_divergence_2 WHERE log_odds_z > 0 ORDER BY log_odds_z DESC LIMIT 5`).all() as Array<{ gram: string; count_me: number; count_them: number; log_odds_z: number; combined_count: number }>;
for (const r of div2A) console.log(`  ${r.gram.padEnd(28)}  z=${r.log_odds_z.toFixed(2).padStart(6)}  me=${r.count_me} them=${r.count_them}`);

console.log("\n[phrases] top 5 distinctive bigrams (Them direction):");
const div2S = db.prepare(`SELECT gram, count_me, count_them, log_odds_z, combined_count FROM phrase_divergence_2 WHERE log_odds_z < 0 ORDER BY log_odds_z ASC LIMIT 5`).all() as Array<{ gram: string; count_me: number; count_them: number; log_odds_z: number; combined_count: number }>;
for (const r of div2S) console.log(`  ${r.gram.padEnd(28)}  z=${r.log_odds_z.toFixed(2).padStart(6)}  me=${r.count_me} them=${r.count_them}`);

console.log("\n[phrases] sentence stats:");
const stats = db.prepare(`SELECT * FROM sentence_stats`).all() as Array<{
  sender: string; n_sentences: number; mean_words: number; median_words: number; p90_words: number;
  question_rate: number; excl_rate: number; emoji_rate: number; fk_grade: number;
}>;
for (const r of stats) {
  console.log(
    `  ${r.sender.padEnd(6)} n=${String(r.n_sentences).padStart(7)}  mean=${r.mean_words.toFixed(1)}  ` +
      `med=${r.median_words.toFixed(0)}  p90=${r.p90_words.toFixed(0)}  ` +
      `q%=${(r.question_rate * 100).toFixed(1)}  !%=${(r.excl_rate * 100).toFixed(1)}  ` +
      `emoji/sent=${r.emoji_rate.toFixed(2)}  FK=${r.fk_grade.toFixed(1)}`,
  );
}

db.exec(`ANALYZE;`);
db.close();
console.log("\n[phrases] done.");
