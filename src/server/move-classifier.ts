import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { db, DB_PATH } from "~/lib/server-db";

export const MOVE_KINDS = [
  "repair",
  "care",
  "affection",
  "vulnerable",
  "logistics",
  "question",
  "play",
  "object",
  "arrival",
  "status",
  "gratitude",
  "ambient",
] as const;

export type MoveKind = (typeof MOVE_KINDS)[number];
export type MoveSource = "embedding" | "regex" | "fallback";

export type MoveScore = {
  kind: MoveKind;
  label: string;
  score: number;
  probability: number;
};

export type MoveClassification = {
  kind: MoveKind;
  label: string;
  description: string;
  confidence: number;
  source: MoveSource;
  scores: MoveScore[];
};

export type MoveClassifierRow = {
  id?: number;
  text?: string | null;
  has_attachment?: number | boolean | null;
};

type RegexDefinition = {
  key: MoveKind;
  label: string;
  description: string;
  highConfidence: boolean;
  matches: (row: MoveClassifierRow, text: string) => boolean;
};

type NpyHeader = {
  descr: string;
  shape: number[];
  dataOffset: number;
};

type EmbeddingState = {
  ids: number[];
  idToIndex: Map<number, number>;
  embeddings: Float32Array;
  width: number;
  centroids: Map<MoveKind, Float32Array>;
  seedCounts: Map<MoveKind, number>;
};

const EMBEDDINGS_PATH = join(process.cwd(), "data/embeddings_msg.npy");
const EMBEDDING_IDS_PATH = join(process.cwd(), "data/embeddings_msg_ids.npy");
const TURN_MOVES_PATH = join(process.cwd(), "data/eval/turn_moves.jsonl");
const MAX_SILVER_SEEDS_PER_KIND = 650;
const MIN_SEEDS_PER_KIND = 12;
const EMBEDDING_MIN_PROBABILITY = 0.36;
const EMBEDDING_MIN_MARGIN = 0.045;
const EMBEDDING_MIN_SCORE = 0.22;

let embeddingState: EmbeddingState | null | false;

export const MOVE_META: Record<MoveKind, { label: string; description: string }> = {
  repair: { label: "Repair", description: "Apologies, clarification, accountability, and meta repair." },
  care: { label: "Care", description: "Checking on sleep, safety, health, feelings, food, or the day." },
  affection: { label: "Affection", description: "Love, missing, tenderness, and direct warmth." },
  vulnerable: { label: "Vulnerable", description: "Feeling, fear, sadness, stress, hurt, or uncertainty named directly." },
  logistics: { label: "Logistics", description: "Plans, timing, rides, food, locations, and concrete coordination." },
  question: { label: "Question", description: "A direct prompt that asks the other person to take the next turn." },
  play: { label: "Play", description: "Jokes, games, laughter, riffs, and low-friction sparks." },
  object: { label: "Object", description: "Photos, links, screenshots, attachments, and look-at-this drops." },
  arrival: { label: "Arrival", description: "Home, leaving, on-my-way, location, and movement updates." },
  status: { label: "Status", description: "Ordinary state updates about what the sender is doing or thinking." },
  gratitude: { label: "Gratitude", description: "Thanks, appreciation, and explicit recognition." },
  ambient: { label: "Ambient", description: "Low-signal thread-keeping without a sharper conversational move." },
};

const REGEX_DEFINITIONS: RegexDefinition[] = [
  {
    key: "repair",
    label: MOVE_META.repair.label,
    description: MOVE_META.repair.description,
    highConfidence: true,
    matches: (_row, text) => /\b(sorry|apologize|apologise|forgive|my bad|misunderstood|didn'?t mean|didnt mean|should have|i understand|that makes sense|talk about)\b/i.test(text),
  },
  {
    key: "care",
    label: MOVE_META.care.label,
    description: MOVE_META.care.description,
    highConfidence: true,
    matches: (_row, text) => /\b(how are you|how was your|how's your|are you ok|you okay|you ok|are you okay|hope you|feel better|sleep well|rest|did you eat|eat something|breakfast|food|safe|take care|checking in)\b/i.test(text),
  },
  {
    key: "affection",
    label: MOVE_META.affection.label,
    description: MOVE_META.affection.description,
    highConfidence: true,
    matches: (_row, text) => /\b(love you|i love|miss you|proud of you|sweetheart|darling|cute|beautiful|handsome|kiss|cuddle|snuggle|heart)\b/i.test(text),
  },
  {
    key: "vulnerable",
    label: MOVE_META.vulnerable.label,
    description: MOVE_META.vulnerable.description,
    highConfidence: true,
    matches: (_row, text) => /\b(i feel|i felt|feeling|i'?m sad|i am sad|sad|scared|afraid|worried|anxious|anxiety|stress|stressed|overwhelmed|lonely|hurt|cry|crying|upset|frustrated|rough|bad day|tired|exhausted)\b/i.test(text),
  },
  {
    key: "gratitude",
    label: MOVE_META.gratitude.label,
    description: MOVE_META.gratitude.description,
    highConfidence: true,
    matches: (_row, text) => /\b(thank you|thanks|appreciate|grateful|thankful|means a lot)\b/i.test(text),
  },
  {
    key: "logistics",
    label: MOVE_META.logistics.label,
    description: MOVE_META.logistics.description,
    highConfidence: true,
    matches: (_row, text) => /\b(when|where|tonight|tomorrow|today|time|meet|come over|coming over|dinner|lunch|breakfast|plans?|schedule|ride|pickup|pick up|drop off|book|reservation|flight|train|bus|calendar)\b/i.test(text),
  },
  {
    key: "question",
    label: MOVE_META.question.label,
    description: MOVE_META.question.description,
    highConfidence: false,
    matches: (_row, text) => text.includes("?") || /^(what|when|where|who|why|how|do you|did you|are you|can you|would you|could you)\b/i.test(text),
  },
  {
    key: "play",
    label: MOVE_META.play.label,
    description: MOVE_META.play.description,
    highConfidence: true,
    matches: (_row, text) => /\b(lol|lmao|haha|hehe|funny|silly|wild|ridiculous|joke|hilarious|codenames|wordle|factle|game|puzzle|meme)\b/i.test(text),
  },
  {
    key: "object",
    label: MOVE_META.object.label,
    description: MOVE_META.object.description,
    highConfidence: true,
    matches: (row, text) => hasAttachment(row) || /\b(photo|picture|pic|screenshot|link|look at|lookit|sent you|https?:\/\/)\b/i.test(text),
  },
  {
    key: "arrival",
    label: MOVE_META.arrival.label,
    description: MOVE_META.arrival.description,
    highConfidence: true,
    matches: (_row, text) => /\b(home|got home|made it|on my way|omw|leaving|heading|headed|arrived|there yet|almost there|at work|at school)\b/i.test(text),
  },
  {
    key: "status",
    label: MOVE_META.status.label,
    description: MOVE_META.status.description,
    highConfidence: false,
    matches: (_row, text) => /\b(i'?m|i am|i just|just got|finished|woke up|going to|i think|i was)\b/i.test(text),
  },
];

export function classifyMove(row: MoveClassifierRow): MoveClassification {
  const regex = regexClassify(row);
  const embedded = classifyWithEmbeddings(row, regex);
  return embedded ?? regex;
}

export function moveLabel(kind: MoveKind) {
  return MOVE_META[kind].label;
}

export function moveDescription(kind: MoveKind) {
  return MOVE_META[kind].description;
}

export function toStrainCompatibleKind(kind: MoveKind): MoveKind | "strain" {
  return kind === "vulnerable" ? "strain" : kind;
}

function regexClassify(row: MoveClassifierRow): MoveClassification {
  const text = row.text ?? "";
  if (!text.trim() && hasAttachment(row)) return classificationFor("object", "regex", 0.88);

  const definition = REGEX_DEFINITIONS.find((item) => item.matches(row, text));
  if (definition) return classificationFor(definition.key, "regex", definition.highConfidence ? 0.82 : 0.68);

  return classificationFor("ambient", "fallback", 0.42);
}

function classificationFor(kind: MoveKind, source: MoveSource, confidence: number, scores: MoveScore[] = []): MoveClassification {
  return {
    kind,
    label: MOVE_META[kind].label,
    description: MOVE_META[kind].description,
    confidence: round(confidence, 3),
    source,
    scores,
  };
}

function classifyWithEmbeddings(row: MoveClassifierRow, fallback: MoveClassification): MoveClassification | null {
  if (row.id == null || hasAttachment(row) && !(row.text ?? "").trim()) return null;
  const state = getEmbeddingState();
  if (!state) return null;
  const index = state.idToIndex.get(row.id);
  if (index == null) return null;

  const scores = scoreEmbedding(state, index);
  const top = scores[0];
  const second = scores[1];
  if (!top || !second) return null;
  const margin = top.probability - second.probability;

  if (
    top.score < EMBEDDING_MIN_SCORE ||
    top.probability < EMBEDDING_MIN_PROBABILITY ||
    margin < EMBEDDING_MIN_MARGIN
  ) {
    return null;
  }

  if (fallback.source === "regex" && fallback.confidence >= 0.8 && top.kind !== fallback.kind && margin < 0.16) {
    return null;
  }

  return classificationFor(top.kind, "embedding", top.probability, scores);
}

function scoreEmbedding(state: EmbeddingState, index: number): MoveScore[] {
  const offset = index * state.width;
  const rawScores = [...state.centroids.entries()].map(([kind, centroid]) => {
    let score = 0;
    for (let dim = 0; dim < state.width; dim += 1) {
      score += state.embeddings[offset + dim] * centroid[dim];
    }
    return { kind, score };
  });
  const maxScore = Math.max(...rawScores.map((item) => item.score));
  const expScores = rawScores.map((item) => Math.exp((item.score - maxScore) * 12));
  const expTotal = expScores.reduce((total, value) => total + value, 0) || 1;
  return rawScores
    .map((item, index) => ({
      kind: item.kind,
      label: MOVE_META[item.kind].label,
      score: round(item.score, 4),
      probability: round(expScores[index] / expTotal, 4),
    }))
    .sort((a, b) => b.probability - a.probability || b.score - a.score);
}

function getEmbeddingState(): EmbeddingState | null {
  if (embeddingState === false) return null;
  if (embeddingState) return embeddingState;
  try {
    if (isFixtureDb()) {
      embeddingState = false;
      return null;
    }
    if (!existsSync(EMBEDDINGS_PATH) || !existsSync(EMBEDDING_IDS_PATH)) {
      embeddingState = false;
      return null;
    }

    const embeddings = readFloat32Npy(EMBEDDINGS_PATH);
    const ids = readInt64Npy(EMBEDDING_IDS_PATH);
    if (embeddings.shape.length !== 2 || ids.length !== embeddings.shape[0]) {
      embeddingState = false;
      return null;
    }

    const idToIndex = new Map<number, number>();
    ids.forEach((id, index) => idToIndex.set(id, index));
    const width = embeddings.shape[1];
    const { centroids, seedCounts } = buildCentroids(idToIndex, embeddings.data, width);
    if (centroids.size < 4) {
      embeddingState = false;
      return null;
    }

    embeddingState = {
      ids,
      idToIndex,
      embeddings: embeddings.data,
      width,
      centroids,
      seedCounts,
    };
    return embeddingState;
  } catch {
    embeddingState = false;
    return null;
  }
}

function buildCentroids(idToIndex: Map<number, number>, embeddings: Float32Array, width: number) {
  const sums = new Map<MoveKind, Float64Array>();
  const seedCounts = new Map<MoveKind, number>();
  const silverCounts = new Map<MoveKind, number>();
  const gold = readGoldLabels();
  const rows = db()
    .prepare(
      `
      SELECT id, text, has_attachment
      FROM messages
      WHERE text IS NOT NULL OR has_attachment = 1
      ORDER BY id ASC
    `,
    )
    .all() as Array<{ id: number; text: string | null; has_attachment: number }>;

  for (const row of rows) {
    const index = idToIndex.get(row.id);
    if (index == null) continue;
    const goldKind = gold.get(row.id);
    const seed = goldKind ?? seedKindFromRegex(row);
    if (!seed || seed === "ambient") continue;

    if (!goldKind) {
      const count = silverCounts.get(seed) ?? 0;
      if (count >= MAX_SILVER_SEEDS_PER_KIND) continue;
      silverCounts.set(seed, count + 1);
    }

    addVector(sums, seedCounts, seed, embeddings, index * width, width);
  }

  const centroids = new Map<MoveKind, Float32Array>();
  for (const [kind, sum] of sums) {
    const count = seedCounts.get(kind) ?? 0;
    if (count < MIN_SEEDS_PER_KIND) continue;
    const centroid = new Float32Array(width);
    let norm = 0;
    for (let dim = 0; dim < width; dim += 1) {
      const value = sum[dim] / count;
      centroid[dim] = value;
      norm += value * value;
    }
    norm = Math.sqrt(norm) || 1;
    for (let dim = 0; dim < width; dim += 1) centroid[dim] /= norm;
    centroids.set(kind, centroid);
  }

  return { centroids, seedCounts };
}

function readGoldLabels() {
  const labels = new Map<number, MoveKind>();
  if (!existsSync(TURN_MOVES_PATH)) return labels;
  const fixtureDb = isFixtureDb();
  const contents = readFileSync(TURN_MOVES_PATH, "utf8");
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as { message_id?: number; gold_kind?: string; notes?: string };
      if (!row.message_id || !row.gold_kind) continue;
      if (!fixtureDb && row.notes?.toLowerCase().includes("fixture")) continue;
      const kind = normalizeGoldKind(row.gold_kind);
      if (kind) labels.set(row.message_id, kind);
    } catch {
      // Skip malformed local labels rather than disabling runtime classification.
    }
  }
  return labels;
}

function isFixtureDb() {
  return DB_PATH.endsWith("data/fixtures/tiny.db") || DB_PATH.endsWith("data\\fixtures\\tiny.db");
}

function normalizeGoldKind(kind: string): MoveKind | null {
  if (kind === "planning") return "logistics";
  if (kind === "strain") return "vulnerable";
  return (MOVE_KINDS as readonly string[]).includes(kind) ? (kind as MoveKind) : null;
}

function seedKindFromRegex(row: MoveClassifierRow): MoveKind | null {
  const text = row.text ?? "";
  const definition = REGEX_DEFINITIONS.find((item) => item.highConfidence && item.matches(row, text));
  return definition?.key ?? null;
}

function addVector(
  sums: Map<MoveKind, Float64Array>,
  seedCounts: Map<MoveKind, number>,
  kind: MoveKind,
  embeddings: Float32Array,
  offset: number,
  width: number,
) {
  let sum = sums.get(kind);
  if (!sum) {
    sum = new Float64Array(width);
    sums.set(kind, sum);
  }
  for (let dim = 0; dim < width; dim += 1) sum[dim] += embeddings[offset + dim];
  seedCounts.set(kind, (seedCounts.get(kind) ?? 0) + 1);
}

function readFloat32Npy(path: string) {
  const buffer = readFileSync(path);
  const header = readNpyHeader(buffer);
  if (header.descr !== "<f4" && header.descr !== "|f4") throw new Error(`Unsupported dtype ${header.descr}`);
  const length = header.shape.reduce((total, value) => total * value, 1);
  const start = buffer.byteOffset + header.dataOffset;
  const end = start + length * Float32Array.BYTES_PER_ELEMENT;
  return {
    data: new Float32Array(buffer.buffer.slice(start, end)),
    shape: header.shape,
  };
}

function readInt64Npy(path: string) {
  const buffer = readFileSync(path);
  const header = readNpyHeader(buffer);
  if (header.descr !== "<i8") throw new Error(`Unsupported dtype ${header.descr}`);
  const length = header.shape.reduce((total, value) => total * value, 1);
  const ids: number[] = [];
  for (let index = 0; index < length; index += 1) {
    ids.push(Number(buffer.readBigInt64LE(header.dataOffset + index * 8)));
  }
  return ids;
}

function readNpyHeader(buffer: Buffer): NpyHeader {
  if (buffer.toString("latin1", 0, 6) !== "\x93NUMPY") throw new Error("Invalid npy file");
  const major = buffer[6];
  const headerLenOffset = 8;
  const headerLength = major === 1 ? buffer.readUInt16LE(headerLenOffset) : buffer.readUInt32LE(headerLenOffset);
  const headerStart = major === 1 ? 10 : 12;
  const headerText = buffer.toString("latin1", headerStart, headerStart + headerLength);
  const descr = /'descr':\s*'([^']+)'/.exec(headerText)?.[1];
  const shapeText = /'shape':\s*\(([^)]*)\)/.exec(headerText)?.[1];
  if (!descr || !shapeText) throw new Error("Invalid npy header");
  const shape = shapeText
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map(Number);
  return { descr, shape, dataOffset: headerStart + headerLength };
}

function hasAttachment(row: MoveClassifierRow) {
  return row.has_attachment === true || row.has_attachment === 1;
}

function round(value: number, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
