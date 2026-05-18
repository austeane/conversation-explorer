import { describe, expect, it } from "vitest";

import { pairReplies, REPLY_6H } from "~/lib/conversation/replies";
import { findRestarts } from "~/lib/conversation/silence";
import { parseSignals } from "~/lib/conversation/signals";
import { selectSnippets } from "~/lib/conversation/snippets";
import { collapseTurns, TURN_GAP_20M, type TurnMessage } from "~/lib/conversation/turns";

const messages: TurnMessage[] = [
  { id: 1, ts: 0, is_from_me: 1, text: "one", word_count: 1 },
  { id: 2, ts: 60, is_from_me: 1, text: "two words", word_count: 2 },
  { id: 3, ts: 300, is_from_me: 0, text: "reply", word_count: 1 },
  { id: 4, ts: 10_000, is_from_me: 1, text: "restart", word_count: 1 },
];

describe("signal parsing", () => {
  it("returns clean string arrays and tolerates invalid JSON", () => {
    expect(parseSignals('["warmth", 42, " "]')).toEqual(["warmth", "42"]);
    expect(parseSignals("{bad")).toEqual([]);
    expect(parseSignals(null)).toEqual([]);
  });
});

describe("turn and reply primitives", () => {
  it("collapses adjacent same-sender messages inside a named gap", () => {
    const turns = collapseTurns(messages, TURN_GAP_20M);

    expect(turns).toHaveLength(3);
    expect(turns[0]).toMatchObject({
      sender: "me",
      start_ts: 0,
      end_ts: 60,
      message_count: 2,
      word_count: 3,
      text: "one two words",
    });
  });

  it("pairs adjacent cross-sender turns inside a reply window", () => {
    const turns = collapseTurns(messages, TURN_GAP_20M);
    const pairs = pairReplies(turns, REPLY_6H);

    expect(pairs.map((pair) => [pair.direction, pair.gap_seconds])).toEqual([
      ["me_to_them", 240],
      ["them_to_me", 9700],
    ]);
  });
});

describe("silence restarts", () => {
  it("finds restarts after a long silence", () => {
    const restarts = findRestarts(messages, 6 * 60 * 60);
    expect(restarts).toEqual([]);

    const withLongGap = [...messages, { id: 5, ts: 40_000, is_from_me: 0, text: "after" }];
    expect(findRestarts(withLongGap, 6 * 60 * 60)).toMatchObject([
      {
        gap_seconds: 30_000,
        previous_sender: "me",
        restarted_by: "them",
      },
    ]);
  });
});

describe("snippet selection", () => {
  it("keeps high scoring items while spreading repeated diversity keys", () => {
    const items = [
      { id: "a1", score: 10, kind: "a" },
      { id: "a2", score: 9.9, kind: "a" },
      { id: "b1", score: 9.8, kind: "b" },
    ];

    expect(
      selectSnippets(items, (item) => item.score, 2, {
        diversityKey: (item) => item.kind,
        diversityPenalty: 0.3,
      }).map((item) => item.id),
    ).toEqual(["a1", "b1"]);
  });
});
