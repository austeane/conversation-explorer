import { createServerFn } from "@tanstack/react-start";
import { parseSignals } from "~/lib/conversation/signals";
import { addMessageScopeFilters, messageScopeInput, type MessageScope } from "~/lib/conversation/scope";
import { bucket } from "~/lib/conversation/time";
import { db, withDbCache } from "~/lib/server-db";
import { resolveMessageScope } from "~/server/scope";

const MAX_CAPSULES = 18;
const ROLLING_CONTEXT = 40;
const MIN_MESSAGES = 10;

export type Sender = "Me" | "Them";

export type CapsuleOverview = {
  generated_at: string;
  segments_scored: number;
  capsules_selected: number;
  months_covered: number;
  categories_covered: number;
  avg_novelty: number;
  top_category: string;
};

export type CapsuleExcerpt = {
  msg_id: number;
  ts: number;
  sender: Sender;
  text: string;
};

export type MemoryCapsule = {
  id: number;
  rank: number;
  start_ts: number;
  end_ts: number;
  ym: string;
  n_msgs: number;
  n_me: number;
  n_them: number;
  category: string;
  category_confidence: number;
  secondary_category: string | null;
  local_label: string;
  topic_label: string | null;
  topic_words: string[];
  score: number;
  novelty: number;
  balance: number;
  rarity: number;
  why: string[];
  excerpts: CapsuleExcerpt[];
};

export type CapsuleCoverage = {
  category: string;
  count: number;
  messages: number;
};

export type CapsulesResult = {
  overview: CapsuleOverview;
  capsules: MemoryCapsule[];
  coverage: CapsuleCoverage[];
};

type SegmentRow = {
  id: number;
  start_ts: number;
  end_ts: number;
  n_msgs: number;
  n_me: number;
  n_them: number;
  topic_id: number | null;
  umap_x: number | null;
  umap_y: number | null;
  category: string | null;
  confidence: number | null;
  secondary_category: string | null;
  signals: string | null;
  topic_label: string | null;
  top_words: string | null;
  ym: string;
};

type ScoredSegment = SegmentRow & {
  score: number;
  novelty: number;
  balance: number;
  rarity: number;
  lengthScore: number;
  selectedRank: number;
};

type MessageRow = {
  id: number;
  ts: number;
  is_from_me: number;
  text: string | null;
  has_attachment: number;
};

export const getCapsules = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => messageScopeInput.parse(d ?? {}))
  .handler(async ({ data }): Promise<CapsulesResult> => {
    const resolved = resolveMessageScope(data);
    return withDbCache(`capsules:${JSON.stringify(resolved)}`, () => {
      const generated = db().prepare("SELECT v FROM meta WHERE k = 'generated_at'").get() as { v: string } | undefined;
      const scope = segmentScope(resolved);
      const rawRows = db()
        .prepare(
          `
          SELECT s.id,
                 s.start_ts,
                 s.end_ts,
                 s.n_msgs,
                 s.n_me,
                 s.n_them,
                 s.topic_id,
                 s.umap_x,
                 s.umap_y,
                 COALESCE(c.category, 'unclassified') AS category,
                 c.confidence,
                 c.secondary_category,
                 c.signals,
                 t.label AS topic_label,
                 t.top_words
          FROM seg_segments s
          LEFT JOIN seg_segment_categories c ON c.segment_id = s.id
          LEFT JOIN seg_topics t ON t.id = s.topic_id
          ${scope.sql}
          ORDER BY s.start_ts ASC
        `,
        )
        .all(...scope.args) as Array<Omit<SegmentRow, "ym">>;
      const rows: SegmentRow[] = rawRows.map((row) => ({ ...row, ym: bucket(row.start_ts, "ym") }));

      const scored = scoreSegments(rows);
      const selected = selectDiverseCapsules(scored, MAX_CAPSULES);
      const capsules = selected
        .sort((a, b) => a.start_ts - b.start_ts)
        .map((segment, index) => {
          const excerpts = excerptsForSegment(segment.id, resolved);
          return {
            id: segment.id,
            rank: index + 1,
            start_ts: segment.start_ts,
            end_ts: segment.end_ts,
            ym: segment.ym,
            n_msgs: segment.n_msgs,
            n_me: segment.n_me,
            n_them: segment.n_them,
            category: segment.category ?? "unclassified",
            category_confidence: round(segment.confidence ?? 0),
            secondary_category: segment.secondary_category ?? null,
            local_label: localLabelFor(segment, excerpts),
            topic_label: segment.topic_label,
            topic_words: parseWords(segment.top_words),
            score: round(segment.score),
            novelty: round(segment.novelty),
            balance: round(segment.balance),
            rarity: round(segment.rarity),
            why: reasonsFor(segment),
            excerpts,
          };
        });

      const coverage = buildCoverage(capsules);
      const topCoverage = coverage[0];
      return {
        overview: {
          generated_at: generated?.v ?? "unknown",
          segments_scored: scored.length,
          capsules_selected: capsules.length,
          months_covered: new Set(capsules.map((c) => c.ym)).size,
          categories_covered: coverage.length,
          avg_novelty: round(average(capsules.map((c) => c.novelty))),
          top_category: topCoverage?.category ?? "n/a",
        },
        capsules,
        coverage,
      };
    });
  });

function scoreSegments(rows: SegmentRow[]): ScoredSegment[] {
  const maxLogLength = Math.max(...rows.map((r) => Math.log1p(r.n_msgs)), 1);
  const categoryCounts = new Map<string, number>();
  for (const row of rows) {
    const category = row.category ?? "unclassified";
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
  }
  const maxCategoryLog = Math.log1p(rows.length);
  const rawNovelty = rows.map((row, index) => semanticNovelty(row, rows.slice(Math.max(0, index - ROLLING_CONTEXT), index)));
  const maxNovelty = Math.max(...rawNovelty, 1);

  return rows.map((row, index) => {
    const category = row.category ?? "unclassified";
    const balance = row.n_msgs ? Math.min(row.n_me, row.n_them) / row.n_msgs : 0;
    const lengthScore = Math.log1p(row.n_msgs) / maxLogLength;
    const rarity = 1 - Math.log1p(categoryCounts.get(category) ?? 1) / maxCategoryLog;
    const confidence = row.confidence ?? 0.5;
    const novelty = rawNovelty[index] / maxNovelty;
    const topicBonus = row.topic_id == null ? 0 : 0.06;
    const categoryPenalty = category === "small_talk" ? 0.08 : 0;
    const score =
      0.34 * lengthScore +
      0.24 * novelty +
      0.18 * balance +
      0.14 * confidence +
      0.1 * rarity +
      topicBonus -
      categoryPenalty;
    return {
      ...row,
      category,
      score,
      novelty,
      balance,
      rarity,
      lengthScore,
      selectedRank: 0,
    };
  });
}

function selectDiverseCapsules(scored: ScoredSegment[], limit: number) {
  const pool = scored.sort((a, b) => b.score - a.score).slice(0, 420);
  const selected: ScoredSegment[] = [];

  while (selected.length < limit && pool.length > 0) {
    let bestIndex = 0;
    let bestValue = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < pool.length; i += 1) {
      const candidate = pool[i];
      const maxSimilarity = selected.length
        ? Math.max(...selected.map((segment) => similarity(candidate, segment)))
        : 0;
      const value = candidate.score - 0.32 * maxSimilarity;
      if (value > bestValue) {
        bestValue = value;
        bestIndex = i;
      }
    }
    const [chosen] = pool.splice(bestIndex, 1);
    chosen.selectedRank = selected.length + 1;
    selected.push(chosen);
  }

  return selected;
}

function semanticNovelty(row: SegmentRow, context: SegmentRow[]) {
  if (row.umap_x == null || row.umap_y == null || context.length === 0) return 0.15;
  const usable = context.filter((r) => r.umap_x != null && r.umap_y != null);
  if (usable.length === 0) return 0.15;
  const meanX = usable.reduce((sum, r) => sum + (r.umap_x ?? 0), 0) / usable.length;
  const meanY = usable.reduce((sum, r) => sum + (r.umap_y ?? 0), 0) / usable.length;
  return distance(row.umap_x, row.umap_y, meanX, meanY);
}

function similarity(a: ScoredSegment, b: ScoredSegment) {
  let score = 0;
  if (a.category === b.category) score += 0.35;
  if (a.topic_id != null && a.topic_id === b.topic_id) score += 0.35;
  if (a.ym === b.ym) score += 0.18;
  if (a.umap_x != null && a.umap_y != null && b.umap_x != null && b.umap_y != null) {
    score += 0.45 / (1 + distance(a.umap_x, a.umap_y, b.umap_x, b.umap_y));
  }
  return score;
}

function segmentScope(scope: MessageScope) {
  const where = ["s.n_msgs >= ?"];
  const args: Array<string | number> = [MIN_MESSAGES];
  if (hasActiveScope(scope)) {
    const messageWhere = [
      "sms_scope.segment_id = s.id",
      "(m_scope.associated_message_type IS NULL OR m_scope.associated_message_type < 2000)",
    ];
    addMessageScopeFilters(messageWhere, args, scope, "m_scope");
    where.push(`
      EXISTS (
        SELECT 1
        FROM seg_msg_segment sms_scope
        JOIN messages m_scope ON m_scope.id = sms_scope.msg_id
        WHERE ${messageWhere.join(" AND ")}
      )
    `);
  }

  return {
    sql: `WHERE ${where.join(" AND ")}`,
    args,
  };
}

function hasActiveScope(scope: MessageScope) {
  return Boolean(scope.from || scope.to || (scope.sender && scope.sender !== "both"));
}

function excerptsForSegment(segmentId: number, scope: MessageScope): CapsuleExcerpt[] {
  const where = [
    "sms.segment_id = ?",
    "(m.associated_message_type IS NULL OR m.associated_message_type < 2000)",
  ];
  const args: Array<string | number> = [segmentId];
  addMessageScopeFilters(where, args, scope, "m");
  const rows = db()
    .prepare(
      `
      SELECT m.id, m.ts, m.is_from_me, m.text, m.has_attachment
      FROM seg_msg_segment sms
      JOIN messages m ON m.id = sms.msg_id
      WHERE ${where.join(" AND ")}
      ORDER BY m.ts ASC, m.id ASC
    `,
    )
    .all(...args) as MessageRow[];

  const textRows = rows.filter((row) => row.text?.trim()).length
    ? rows.filter((row) => row.text?.trim())
    : rows.filter((row) => cleanText(row).length > 0);
  if (textRows.length <= 6) return textRows.map(messageResult);

  const indexes = [0, 1, Math.floor(textRows.length * 0.34), Math.floor(textRows.length * 0.66), textRows.length - 2, textRows.length - 1];
  const seen = new Set<number>();
  return indexes
    .map((index) => textRows[Math.max(0, Math.min(textRows.length - 1, index))])
    .filter((row) => {
      if (!row || seen.has(row.id)) return false;
      seen.add(row.id);
      return true;
    })
    .map(messageResult);
}

function messageResult(row: MessageRow): CapsuleExcerpt {
  return {
    msg_id: row.id,
    ts: row.ts,
    sender: row.is_from_me === 1 ? "Me" : "Them",
    text: cleanText(row),
  };
}

function cleanText(row: MessageRow) {
  if (row.text?.trim()) return row.text.replace(/\s+/g, " ").trim().slice(0, 260);
  return row.has_attachment ? "Attachment" : "";
}

function reasonsFor(segment: ScoredSegment) {
  const reasons: string[] = [];
  if (segment.n_msgs >= 45) reasons.push("large sustained exchange");
  if (segment.balance >= 0.38) reasons.push("strong back-and-forth");
  if (segment.novelty >= 0.55) reasons.push("semantic departure");
  if (segment.rarity >= 0.25) reasons.push("rarer category");
  if ((segment.confidence ?? 0) >= 0.7) reasons.push("strong category evidence");
  if (segment.secondary_category) reasons.push(`mixed with ${formatCategory(segment.secondary_category)}`);
  if (reasons.length === 0) reasons.push("representative passage");
  return reasons.slice(0, 4);
}

function localLabelFor(segment: SegmentRow, excerpts: CapsuleExcerpt[]) {
  const category = segment.category ?? "unclassified";
  const signals = parseSignals(segment.signals);
  const signalText = signals.join(" ").toLowerCase();
  if (category === "games" && /wordle|connections/.test(signalText)) return "Wordle and Connections";
  if (category === "tech" && /command|safari|phone|browser/.test(signalText)) return "Phone and app help";
  if (category === "romantic_intimacy") return "Romantic affection";
  if (category === "sexual_intimacy") return "Sexual texting";
  if (category === "emotional_support") return "Care and support";
  if (category === "daily_check_in") return "Daily check-in";
  if (category === "photo_sharing") return "Photo exchange";
  if (category === "memes_links") return "Links and media";

  const words = parseWords(segment.top_words)
    .filter((word) => !["love", "tons", "thanks", "okay", "yeah", "lol"].includes(word.toLowerCase()))
    .slice(0, 3);
  if (words.length >= 2) return words.join(" / ");

  const excerptWords = excerpts
    .flatMap((excerpt) => tokenize(excerpt.text))
    .filter((word) => word.length >= 4 && !COMMON_TITLE_WORDS.has(word))
    .slice(0, 4);
  if (excerptWords.length >= 2) return [...new Set(excerptWords)].slice(0, 3).join(" / ");

  return formatCategory(category);
}

function formatCategory(category: string) {
  return category.replace(/_/g, " ");
}

function tokenize(text: string) {
  return text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
}

const COMMON_TITLE_WORDS = new Set([
  "about",
  "after",
  "also",
  "because",
  "been",
  "could",
  "doing",
  "from",
  "good",
  "have",
  "just",
  "like",
  "love",
  "okay",
  "really",
  "sounds",
  "that",
  "this",
  "tons",
  "want",
  "with",
  "would",
  "yeah",
  "you",
]);

function buildCoverage(capsules: MemoryCapsule[]) {
  const byCategory = new Map<string, CapsuleCoverage>();
  for (const capsule of capsules) {
    const slot = byCategory.get(capsule.category) ?? {
      category: capsule.category,
      count: 0,
      messages: 0,
    };
    slot.count += 1;
    slot.messages += capsule.n_msgs;
    byCategory.set(capsule.category, slot);
  }
  return [...byCategory.values()].sort((a, b) => b.count - a.count || b.messages - a.messages);
}

function parseWords(raw: string | null) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, 6).map(String) : [];
  } catch {
    return raw.split(",").map((word) => word.trim()).filter(Boolean).slice(0, 6);
  }
}

function distance(ax: number, ay: number, bx: number, by: number) {
  return Math.hypot(ax - bx, ay - by);
}

function average(values: number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}
