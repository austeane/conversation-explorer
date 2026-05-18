import { baseToken, isNegatedToken, tokenizeWithNegation } from "./negation";

export type LexiconKind =
  | "warmth"
  | "strain"
  | "repair"
  | "gratitude"
  | "care"
  | "humor"
  | "planning"
  | "affection";

export type VersionedLexicon = {
  version: string;
  regex: RegExp;
  tokens: string[];
  phrases?: RegExp[];
  examples: {
    positive: string[];
    negative: string[];
  };
};

export const AFFECT_LEXICON_KEYS = ["warmth", "strain", "repair", "gratitude", "care", "humor"] as const;
export const REPAIR_FLOW_LEXICON_KEYS = ["strain", "repair", "warmth", "gratitude", "care", "humor"] as const;

export const LEXICONS: Record<LexiconKind, VersionedLexicon> = {
  warmth: lexicon(
    ["love", "miss", "proud", "sweet", "cute", "beautiful", "handsome", "excited", "cuddle", "snuggle", "kiss", "sweetheart", "darling", "adorable", "lovely"],
    ["I love you", "proud of you"],
    ["I don't love that"],
  ),
  strain: lexicon(
    ["sad", "anxious", "anxiety", "worried", "worry", "scared", "afraid", "hurt", "cry", "crying", "upset", "stress", "stressed", "hard", "tired", "exhausted", "lonely", "overwhelmed", "frustrated"],
    ["I feel sad", "that hurt"],
    ["not sad", "not hard"],
  ),
  repair: lexicon(
    ["sorry", "apologize", "apologise", "forgive", "misunderstood"],
    ["I'm sorry", "I apologize"],
    ["sorry, when is dinner?"],
    [/\bmy bad\b/i, /\bdidn'?t mean\b/i, /\bshould have\b/i, /\bi understand\b/i, /\bthat makes sense\b/i],
  ),
  gratitude: lexicon(
    ["thanks", "appreciate", "grateful", "thankful", "bless"],
    ["thank you", "I appreciate you"],
    ["no thanks"],
    [/\bthank you\b/i, /\bmeans a lot\b/i],
  ),
  care: lexicon(
    ["rest", "eat", "safe"],
    ["hope you feel better", "sleep well"],
    ["not safe"],
    [/\bhope you\b/i, /\bare you ok(?:ay)?\b/i, /\byou ok(?:ay)?\b/i, /\bfeel better\b/i, /\bsleep well\b/i, /\btake care\b/i, /\bchecking in\b/i, /\bhow are you\b/i, /\bhow was your day\b/i],
  ),
  humor: lexicon(
    ["lol", "lmao", "haha", "hehe", "funny", "silly", "wild", "ridiculous", "joke", "hilarious"],
    ["lol that is funny"],
    ["not funny"],
  ),
  planning: lexicon(
    ["plan", "plans", "schedule", "calendar", "dinner", "tomorrow", "tonight"],
    ["what time is dinner"],
    ["no plan"],
    [/\bwhat time\b/i, /\bwhen should\b/i],
  ),
  affection: lexicon(
    ["love", "kiss", "cuddle", "snuggle", "sweetheart", "darling"],
    ["kiss you", "want to cuddle"],
    ["don't kiss"],
  ),
};

export function matchesLexicon(text: string, kind: LexiconKind) {
  if (kind === "repair" && isLogisticsSorry(text)) return false;
  const lexicon = LEXICONS[kind];
  let negatedHit = false;
  for (const tagged of tokenizeWithNegation(text)) {
    const token = baseToken(tagged);
    if (!lexicon.tokens.includes(token)) continue;
    if (isNegatedToken(tagged)) {
      negatedHit = true;
      continue;
    }
    return true;
  }
  if (negatedHit) return false;
  return (lexicon.phrases ?? []).some((phrase) => phrase.test(text)) || lexicon.regex.test(text);
}

function lexicon(tokens: string[], positive: string[], negative: string[], phrases: RegExp[] = []): VersionedLexicon {
  return {
    version: "lexicon-1.0.0",
    regex: new RegExp(`\\b(${tokens.map(escapeRegex).join("|")})\\b`, "i"),
    tokens,
    phrases,
    examples: { positive, negative },
  };
}

function isLogisticsSorry(text: string) {
  return /\bsorry[,.!?]?\s+(when|where|what time|which|can you|could you|did you|is dinner|are we)\b/i.test(text);
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
