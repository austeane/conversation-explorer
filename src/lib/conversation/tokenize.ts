export type TokenizeOptions = {
  lowercase?: boolean;
  stripQuotes?: boolean;
  minLen?: number;
  maxLen?: number;
};

const DEFAULT_OPTIONS: Required<TokenizeOptions> = {
  lowercase: true,
  stripQuotes: true,
  minLen: 1,
  maxLen: 40,
};

export function normalizeApostrophes(text: string) {
  return text.replace(/[‘’‛ʼ]/g, "'");
}

export function tokenize(text: string, options: TokenizeOptions = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const normalized = normalizeApostrophes(opts.lowercase ? text.toLowerCase() : text).replace(/[^a-z0-9' ]+/gi, " ");
  const tokens: string[] = [];
  for (const raw of normalized.split(/\s+/)) {
    const token = opts.stripQuotes ? raw.replace(/^'+|'+$/g, "") : raw;
    if (!token) continue;
    if (token.length < opts.minLen || token.length > opts.maxLen) continue;
    tokens.push(token);
  }
  return tokens;
}
