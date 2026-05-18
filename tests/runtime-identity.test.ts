import { describe, expect, it } from "vitest";

import { readRuntimeIdentity } from "~/server/runtime-identity";

describe("runtime identity", () => {
  it("reads display identity from DB metadata", () => {
    expect(readRuntimeIdentity()).toMatchObject({
      conversationId: "fixture",
      title: "Fixture Conversation",
      brand: "fixture",
      subtitle: "synthetic fixture conversation",
      timezone: "America/Vancouver",
      selfLabel: "Me",
      selfShortLabel: "Me",
      counterpartLabel: "Them",
      counterpartShortLabel: "Them",
    });
  });
});
