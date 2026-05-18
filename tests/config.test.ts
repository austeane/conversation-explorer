import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  expandHome,
  loadConversationConfig,
  normalizeHandle,
  resolveConfigPath,
} from "../scripts/config";

let tempDir: string;

describe("conversation config", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "conversation-config-"));
  });

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it("normalizes phone and email handles consistently", () => {
    expect(normalizeHandle(" person@example.COM ")).toBe("person@example.com");
    expect(normalizeHandle(" +1 (555) 555-0123 ")).toBe("+15555550123");
    expect(normalizeHandle("555.555.0123")).toBe("5555550123");
  });

  it("expands home paths and resolves relative paths from the project root", () => {
    expect(expandHome("~/Library/Messages")).toContain("/Library/Messages");
    expect(resolveConfigPath("data/runtime/conversation.db")).toMatch(/data\/runtime\/conversation\.db$/);
  });

  it("loads a minimal valid config and prepares output directories", () => {
    const messagesDir = join(tempDir, "Messages");
    const outputDir = join(tempDir, "runtime");
    const rawDir = join(tempDir, "raw");
    mkdirSync(messagesDir);
    writeFileSync(join(messagesDir, "chat.db"), "");

    const configPath = join(tempDir, "conversation.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        conversation: {
          id: "fixture",
          title: "Fixture Conversation",
          brand: "fixture",
          subtitle: "synthetic fixture conversation",
          timezone: "America/Vancouver",
        },
        self: { label: "Me", shortLabel: "Me" },
        counterpart: {
          label: "Them",
          shortLabel: "Them",
          handles: ["person@example.COM", "+1 (555) 555-0123"],
        },
        source: {
          messagesDir,
          includeGroups: false,
        },
        output: {
          dbPath: join(outputDir, "conversation.db"),
          rawSnapshotDir: rawDir,
          attachmentsPublicDir: join(tempDir, "attachments"),
        },
      }),
    );

    const config = loadConversationConfig({ configPath, ensureOutputDirs: true });

    expect(config.counterpart.handles).toEqual(["person@example.com", "+15555550123"]);
    expect(config.output.dbPath).toBe(join(outputDir, "conversation.db"));
  });

  it("fails before touching outputs when required values are missing", () => {
    const configPath = join(tempDir, "bad.json");
    writeFileSync(configPath, JSON.stringify({}));

    expect(() => loadConversationConfig({ configPath })).toThrow(/conversation/);
  });
});
