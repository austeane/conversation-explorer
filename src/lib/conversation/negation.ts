import { tokenize } from "./tokenize";

export const NEGATION_WINDOW = 4;

const NEGATORS = new Set([
  "not",
  "no",
  "never",
  "hardly",
  "barely",
  "rarely",
  "dont",
  "don't",
  "doesnt",
  "doesn't",
  "didnt",
  "didn't",
  "cant",
  "can't",
  "wont",
  "won't",
  "isnt",
  "isn't",
  "wasnt",
  "wasn't",
  "werent",
  "weren't",
  "wouldnt",
  "wouldn't",
  "couldnt",
  "couldn't",
  "shouldnt",
  "shouldn't",
]);

export function tokenizeWithNegation(text: string) {
  const tokens = tokenize(text, { minLen: 1, maxLen: 40 });
  const tagged: string[] = [];
  let remaining = 0;
  for (const token of tokens) {
    if (NEGATORS.has(token)) {
      remaining = NEGATION_WINDOW;
      tagged.push(token);
      continue;
    }
    if (remaining > 0) {
      tagged.push(`${token}_NEG`);
      remaining -= 1;
      continue;
    }
    tagged.push(token);
  }
  return tagged;
}

export function isNegatedToken(token: string) {
  return token.endsWith("_NEG");
}

export function baseToken(token: string) {
  return isNegatedToken(token) ? token.slice(0, -4) : token;
}
