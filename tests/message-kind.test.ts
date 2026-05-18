import { describe, expect, it } from "vitest";
import { isRealMessage, realMessageWhere, type MessageKind, type MessageKindRow } from "~/lib/conversation/filters";

const rows: MessageKindRow[] = [
  { associated_message_type: null, text: "null normal" },
  { associated_message_type: 0, text: "ordinary text" },
  { associated_message_type: 0, text: "" },
  { associated_message_type: 2, text: "expressive style" },
  { associated_message_type: 3, text: "rich object" },
  { associated_message_type: 2000, text: "tapback add" },
  { associated_message_type: 2001, text: "tapback add variant" },
  { associated_message_type: 2006, text: "other add range" },
  { associated_message_type: 3000, text: "tapback remove" },
  { associated_message_type: 3001, text: "tapback remove variant" },
];

function matchedTypes(kind: MessageKind) {
  return rows
    .filter((row) => isRealMessage(row, kind))
    .map((row) => row.associated_message_type);
}

describe("message-kind predicates", () => {
  it("keeps ordinary text turns separate from objects and reactions", () => {
    expect(matchedTypes("text_turn")).toEqual([null, 0, 0]);
  });

  it("requires non-empty text for segmentation", () => {
    expect(matchedTypes("segmentable_text")).toEqual([null, 0]);
  });

  it("keeps browsable non-reaction messages wider than text turns", () => {
    expect(matchedTypes("browsable_message")).toEqual([null, 0, 0, 2, 3]);
    expect(matchedTypes("visible_message")).toEqual([null, 0, 0, 2, 3]);
  });

  it("splits tapback additions from removals", () => {
    expect(matchedTypes("reaction_add")).toEqual([2000, 2001, 2006]);
    expect(matchedTypes("reaction_remove")).toEqual([3000, 3001]);
  });

  it("identifies non-reaction object rows", () => {
    expect(matchedTypes("object_message")).toEqual([2, 3]);
    expect(matchedTypes("all_row")).toHaveLength(rows.length);
  });

  it("aliases SQL predicates without changing semantics", () => {
    expect(realMessageWhere("text_turn", "m")).toBe("(m.associated_message_type IS NULL OR m.associated_message_type = 0)");
    expect(realMessageWhere("reaction_add", "m")).toBe("(m.associated_message_type >= 2000 AND m.associated_message_type < 3000)");
    expect(realMessageWhere("segmentable_text")).toContain("text IS NOT NULL");
  });
});
