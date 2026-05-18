import { describe, expect, it } from "vitest";
import { matchesLexicon } from "~/lib/conversation/lexicons";
import { tokenize } from "~/lib/conversation/tokenize";
import { tokenizeWithNegation } from "~/lib/conversation/negation";
import { STOPWORDS } from "~/lib/conversation/stopwords";

describe("conversation tokenizer", () => {
  it("normalizes curly apostrophes and trims edge punctuation", () => {
    expect(tokenize("I’m going, but 'excited'!", { minLen: 1 })).toEqual(["i'm", "going", "but", "excited"]);
  });

  it("shares the stopword set used by word analysis", () => {
    expect(STOPWORDS.has("don't")).toBe(true);
    expect(STOPWORDS.has("youre")).toBe(true);
  });
});

describe("lexicon negation", () => {
  it("does not count negated warmth as warmth", () => {
    expect(matchesLexicon("I love that", "warmth")).toBe(true);
    expect(matchesLexicon("I don't love that", "warmth")).toBe(false);
  });

  it("does not count negated strain as strain", () => {
    expect(matchesLexicon("I feel sad", "strain")).toBe(true);
    expect(matchesLexicon("I am not sad", "strain")).toBe(false);
  });

  it("keeps direct repair separate from logistical sorry openers", () => {
    expect(matchesLexicon("I am sorry, that came out wrong", "repair")).toBe(true);
    expect(matchesLexicon("Sorry, when is dinner?", "repair")).toBe(false);
  });

  it("tags tokens within the negation window", () => {
    expect(tokenizeWithNegation("not really feeling sad today")).toEqual(["not", "really_NEG", "feeling_NEG", "sad_NEG", "today_NEG"]);
  });
});
