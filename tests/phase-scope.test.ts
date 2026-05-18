import { describe, expect, it } from "vitest";

import { resolveMessageScope } from "~/server/scope";

describe("phase-aware message scopes", () => {
  it("resolves a bare phase id to its materialized date range", () => {
    expect(resolveMessageScope({ sender: "both", phase: 1 })).toMatchObject({
      phase: 1,
      from: "2023-11-01",
      to: "2023-11-30",
    });
  });

  it("lets explicit date bounds narrow a selected phase", () => {
    expect(resolveMessageScope({ sender: "me", phase: 1, from: "2023-11-15" })).toMatchObject({
      sender: "me",
      phase: 1,
      from: "2023-11-15",
      to: "2023-11-30",
    });
  });
});
