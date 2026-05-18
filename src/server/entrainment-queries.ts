import { createServerFn } from "@tanstack/react-start";
import { realMessageWhere } from "~/lib/conversation/filters";
import { messageScopeInput, messageScopeWhere } from "~/lib/conversation/scope";
import { STOPWORDS } from "~/lib/conversation/stopwords";
import { tokenize as tokenizeText } from "~/lib/conversation/tokenize";
import { db, withDbCache } from "~/lib/server-db";
import { resolveMessageScope } from "~/server/scope";

const REAL_MESSAGE_WHERE = realMessageWhere("browsable_message", "m");
const MIN_MONTH_TOKENS = 200;
const ADOPTION_MIN_TOTAL = 40;
const CACHE_SCOPE = "entrainment:v2-shared-tokenizer";

export type LexicalSimilarity = {
  ym: string;
  cosine: number;
  me_tokens: number;
  them_tokens: number;
};

export type AdoptionWord = {
  word: string;
  source: "Me" | "Them";
  first_source_ym: string;
  first_adopter_ym: string;
  lag_months: number;
  source_count_before: number;
  adopter_count_after: number;
};

export type SignatureWord = {
  word: string;
  me_count: number;
  them_count: number;
  z: number;
};

export type SharedWord = {
  word: string;
  me_count: number;
  them_count: number;
  total: number;
};

export type EntrainmentOverview = {
  generated_at: string;
  months_analyzed: number;
  median_cosine: number;
  shared_word_count: number;
  me_tokens: number;
  them_tokens: number;
  monthly: LexicalSimilarity[];
  me_first: AdoptionWord[];
  them_first: AdoptionWord[];
  me_signature: SignatureWord[];
  them_signature: SignatureWord[];
  shared_words: SharedWord[];
};

type MessageRow = {
  ym: string;
  is_from_me: number;
  text: string | null;
};

type TokenSlot = {
  me: Map<string, number>;
  them: Map<string, number>;
  meTokens: number;
  themTokens: number;
};

type WordHistory = {
  me: Map<string, number>;
  them: Map<string, number>;
  meTotal: number;
  themTotal: number;
};

export const getEntrainment = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => messageScopeInput.parse(d ?? {}))
  .handler(async ({ data }): Promise<EntrainmentOverview> => {
    const resolved = resolveMessageScope({ ...data, sender: "both" });
    return withDbCache(`${CACHE_SCOPE}:${JSON.stringify(resolved)}`, () => {
      const scope = messageScopeWhere(resolved, "m", [
        REAL_MESSAGE_WHERE,
        "m.text IS NOT NULL",
        "length(trim(m.text)) > 0",
      ]);
      const generated = db().prepare("SELECT v FROM meta WHERE k = 'generated_at'").get() as { v: string } | undefined;
      const rows = db()
        .prepare(
          `
          SELECT m.ym, m.is_from_me, m.text
          FROM messages m
          ${scope.sql}
          ORDER BY m.ts ASC
        `,
        )
        .all(...scope.args) as MessageRow[];

      const monthly = new Map<string, TokenSlot>();
      const histories = new Map<string, WordHistory>();
      let meTokens = 0;
      let themTokens = 0;

      for (const row of rows) {
        const tokens = tokenize(row.text ?? "");
        if (tokens.length === 0) continue;
        const month = monthSlot(monthly, row.ym);
        const fromMe = row.is_from_me === 1;
        for (const token of tokens) {
          const history = wordHistory(histories, token);
          if (fromMe) {
            month.me.set(token, (month.me.get(token) ?? 0) + 1);
            month.meTokens += 1;
            history.me.set(row.ym, (history.me.get(row.ym) ?? 0) + 1);
            history.meTotal += 1;
            meTokens += 1;
          } else {
            month.them.set(token, (month.them.get(token) ?? 0) + 1);
            month.themTokens += 1;
            history.them.set(row.ym, (history.them.get(row.ym) ?? 0) + 1);
            history.themTotal += 1;
            themTokens += 1;
          }
        }
      }

      const monthOrder = [...monthly.keys()].sort();
      const monthIndex = new Map(monthOrder.map((ym, index) => [ym, index]));
      const similarities = monthOrder
        .map((ym) => {
          const slot = monthly.get(ym)!;
          return {
            ym,
            cosine: cosine(slot.me, slot.them),
            me_tokens: slot.meTokens,
            them_tokens: slot.themTokens,
          };
        })
        .filter((m) => m.me_tokens >= MIN_MONTH_TOKENS && m.them_tokens >= MIN_MONTH_TOKENS);

      const signatures = signatureWords(histories, meTokens, themTokens);
      const adoptions = adoptionWords(histories, monthIndex);
      const sharedWords = sharedCore(histories);

      return {
        generated_at: generated?.v ?? "unknown",
        months_analyzed: similarities.length,
        median_cosine: median(similarities.map((m) => m.cosine)) ?? 0,
        shared_word_count: sharedWords.length,
        me_tokens: meTokens,
        them_tokens: themTokens,
        monthly: similarities,
        me_first: adoptions.filter((w) => w.source === "Me").slice(0, 30),
        them_first: adoptions.filter((w) => w.source === "Them").slice(0, 30),
        me_signature: signatures.me.slice(0, 35),
        them_signature: signatures.them.slice(0, 35),
        shared_words: sharedWords.slice(0, 60),
      };
    });
  });

function monthSlot(monthly: Map<string, TokenSlot>, ym: string) {
  const existing = monthly.get(ym);
  if (existing) return existing;
  const created = {
    me: new Map<string, number>(),
    them: new Map<string, number>(),
    meTokens: 0,
    themTokens: 0,
  };
  monthly.set(ym, created);
  return created;
}

function wordHistory(histories: Map<string, WordHistory>, word: string) {
  const existing = histories.get(word);
  if (existing) return existing;
  const created = {
    me: new Map<string, number>(),
    them: new Map<string, number>(),
    meTotal: 0,
    themTotal: 0,
  };
  histories.set(word, created);
  return created;
}

function tokenize(text: string) {
  return tokenizeText(text.replace(/https?:\/\/\S+/g, " "), { minLen: 3, maxLen: 20 }).filter(
    (token) => !STOPWORDS.has(token),
  );
}

function cosine(a: Map<string, number>, b: Map<string, number>) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const av of a.values()) normA += av * av;
  for (const bv of b.values()) normB += bv * bv;
  const [smaller, larger] = a.size < b.size ? [a, b] : [b, a];
  for (const [word, value] of smaller.entries()) {
    dot += value * (larger.get(word) ?? 0);
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}

function signatureWords(histories: Map<string, WordHistory>, meTokens: number, themTokens: number) {
  const vocab = histories.size;
  const alpha = 0.1;
  const scored: SignatureWord[] = [];
  for (const [word, history] of histories.entries()) {
    const a = history.meTotal;
    const s = history.themTotal;
    if (a + s < 25 || a < 2 || s < 2) continue;
    const logOdds =
      Math.log((a + alpha) / (meTokens - a + alpha * vocab)) -
      Math.log((s + alpha) / (themTokens - s + alpha * vocab));
    const variance = 1 / (a + alpha) + 1 / (s + alpha);
    scored.push({ word, me_count: a, them_count: s, z: logOdds / Math.sqrt(variance) });
  }
  scored.sort((a, b) => b.z - a.z);
  return {
    me: scored,
    them: [...scored].reverse().map((w) => ({ ...w, z: Math.abs(w.z) })),
  };
}

function adoptionWords(histories: Map<string, WordHistory>, monthIndex: Map<string, number>) {
  const out: AdoptionWord[] = [];
  for (const [word, history] of histories.entries()) {
    if (history.meTotal + history.themTotal < ADOPTION_MIN_TOTAL) continue;
    if (history.meTotal < 8 || history.themTotal < 8) continue;
    const firstMe = firstMonth(history.me);
    const firstThem = firstMonth(history.them);
    if (!firstMe || !firstThem || firstMe === firstThem) continue;
    const aIndex = monthIndex.get(firstMe) ?? 0;
    const sIndex = monthIndex.get(firstThem) ?? 0;
    if (Math.abs(aIndex - sIndex) < 2) continue;
    if (aIndex < sIndex) {
      out.push({
        word,
        source: "Me",
        first_source_ym: firstMe,
        first_adopter_ym: firstThem,
        lag_months: sIndex - aIndex,
        source_count_before: countThrough(history.me, firstThem, false),
        adopter_count_after: countThrough(history.them, firstThem, true),
      });
    } else {
      out.push({
        word,
        source: "Them",
        first_source_ym: firstThem,
        first_adopter_ym: firstMe,
        lag_months: aIndex - sIndex,
        source_count_before: countThrough(history.them, firstMe, false),
        adopter_count_after: countThrough(history.me, firstMe, true),
      });
    }
  }
  return out
    .filter((w) => w.source_count_before >= 4 && w.adopter_count_after >= 6)
    .sort((a, b) => b.adopter_count_after - a.adopter_count_after || b.source_count_before - a.source_count_before);
}

function sharedCore(histories: Map<string, WordHistory>) {
  const shared: SharedWord[] = [];
  for (const [word, history] of histories.entries()) {
    if (history.meTotal >= 20 && history.themTotal >= 20) {
      const balance = Math.min(history.meTotal, history.themTotal) / Math.max(history.meTotal, history.themTotal);
      if (balance >= 0.25) {
        shared.push({
          word,
          me_count: history.meTotal,
          them_count: history.themTotal,
          total: history.meTotal + history.themTotal,
        });
      }
    }
  }
  return shared.sort((a, b) => b.total - a.total);
}

function firstMonth(counts: Map<string, number>) {
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort(([a], [b]) => a.localeCompare(b))[0]?.[0] ?? null;
}

function countThrough(counts: Map<string, number>, ym: string, inclusiveAndAfter: boolean) {
  let total = 0;
  for (const [month, n] of counts.entries()) {
    if (inclusiveAndAfter ? month >= ym : month < ym) total += n;
  }
  return total;
}

function median(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
