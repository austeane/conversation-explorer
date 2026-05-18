import { describe, expect, it } from "vitest";
import { evidenceHref } from "~/components/EvidenceLink";

describe("evidence links", () => {
  it("preserves date ranges when opening evidence in Browse", () => {
    expect(evidenceHref({ label: "May 2023", from: "2023-05-01", to: "2023-05-31" })).toBe(
      "/browse?from=2023-05-01&to=2023-05-31",
    );
  });

  it("combines range and text search params", () => {
    expect(evidenceHref({ label: "Repair month", from: "2024-01-01", to: "2024-01-31", q: "sorry" })).toBe(
      "/browse?from=2024-01-01&to=2024-01-31&q=sorry",
    );
  });

  it("opens phrase evidence as a browse search", () => {
    expect(evidenceHref({ label: "night love", q: "night love" })).toBe("/browse?q=night+love");
  });

  it("preserves an active sender scope", () => {
    expect(evidenceHref({ label: "Me day", from: "2024-01-01", to: "2024-01-01", sender: "me" })).toBe(
      "/browse?from=2024-01-01&to=2024-01-01&sender=me",
    );
  });
});
