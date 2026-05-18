import { describe, expect, it } from "vitest";
import { classifyMove } from "../src/server/move-classifier";

describe("shared move classifier", () => {
  it("keeps care checks ahead of generic question detection", () => {
    const result = classifyMove({ text: "Are you okay? Did you eat?", has_attachment: 0 });
    expect(result.kind).toBe("care");
  });

  it("recognizes logistics questions as logistics", () => {
    const result = classifyMove({ text: "What time should we meet for dinner tonight?", has_attachment: 0 });
    expect(result.kind).toBe("logistics");
  });

  it("recognizes vulnerable disclosures", () => {
    const result = classifyMove({ text: "I feel really overwhelmed and stressed", has_attachment: 0 });
    expect(result.kind).toBe("vulnerable");
  });

  it("recognizes attachment-only rows as object moves", () => {
    const result = classifyMove({ text: "", has_attachment: 1 });
    expect(result.kind).toBe("object");
  });
});
