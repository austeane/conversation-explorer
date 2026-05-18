import { describe, expect, it } from "vitest";
import { messageScopeInput } from "~/lib/conversation/scope";
import { globalSearchSchema } from "~/routes/_search";

describe("URL search parsing", () => {
  it("keeps numeric phase IDs parsed by the router", () => {
    expect(globalSearchSchema.parse({ phase: 4 }).phase).toBe(4);
    expect(globalSearchSchema.parse({ phase: "4" }).phase).toBe(4);
    expect(globalSearchSchema.parse({ phase: '"4"' }).phase).toBe(4);
    expect(messageScopeInput.parse({ phase: 4 }).phase).toBe(4);
  });

  it("drops invalid phase IDs without throwing", () => {
    expect(globalSearchSchema.parse({ phase: -1 }).phase).toBeUndefined();
    expect(globalSearchSchema.parse({ phase: "latest" }).phase).toBeUndefined();
  });
});
