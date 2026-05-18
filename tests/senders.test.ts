import { describe, expect, it } from "vitest";
import { SENDERS, senderFor, senderKeyFor } from "~/lib/conversation/senders";

describe("sender mapping", () => {
  it("keeps self mapped to outbound messages", () => {
    expect(senderFor(1)).toBe("me");
    expect(senderFor(true)).toBe("me");
    expect(senderKeyFor(1)).toBe("me");
  });

  it("keeps counterpart mapped to inbound messages", () => {
    expect(senderFor(0)).toBe("them");
    expect(senderFor(false)).toBe("them");
    expect(senderKeyFor(0)).toBe("them");
  });

  it("documents the sender order used by filters and legends", () => {
    expect(SENDERS).toEqual([
      { key: "me", label: "me", isFromMe: 1 },
      { key: "them", label: "them", isFromMe: 0 },
    ]);
  });
});
