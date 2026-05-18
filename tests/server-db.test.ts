import { describe, expect, it, beforeEach, afterEach } from "vitest";

import {
  clearDbCache,
  getBundleVersion,
  getDbVersion,
  getMethodVersion,
  withDbCache,
} from "~/lib/server-db";

describe("versioned DB cache", () => {
  beforeEach(() => {
    clearDbCache();
  });

  afterEach(() => {
    clearDbCache();
  });

  it("reports non-empty version inputs", () => {
    expect(getDbVersion()).toMatch(/^(meta|mtime):/);
    expect(getMethodVersion()).toMatch(/^[a-f0-9]{16}$/);
    expect(getBundleVersion()).toContain("db=");
    expect(getBundleVersion()).toContain("method=");
    expect(getBundleVersion()).toContain("baseline=");
    expect(getBundleVersion()).toContain("eval=");
    expect(getBundleVersion()).toContain("migration=");
  });

  it("caches by scope under the current bundle version", () => {
    let calls = 0;

    const first = withDbCache("test-cache:one", () => ({ calls: ++calls }));
    const second = withDbCache("test-cache:one", () => ({ calls: ++calls }));
    const third = withDbCache("test-cache:two", () => ({ calls: ++calls }));

    expect(second).toBe(first);
    expect(third).not.toBe(first);
    expect(calls).toBe(2);
  });

  it("clears a scope prefix without touching other scopes", () => {
    let calls = 0;

    withDbCache("test-cache:clear:one", () => ++calls);
    withDbCache("test-cache:keep:one", () => ++calls);

    expect(clearDbCache("test-cache:clear:")).toBe(1);
    expect(withDbCache("test-cache:clear:one", () => ++calls)).toBe(3);
    expect(withDbCache("test-cache:keep:one", () => ++calls)).toBe(2);
    expect(calls).toBe(3);
  });
});
