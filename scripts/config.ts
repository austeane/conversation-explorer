import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

export const PROJECT_ROOT = resolve(new URL("..", import.meta.url).pathname);
export const DEFAULT_CONFIG_PATH = join(PROJECT_ROOT, "config/conversation.local.json");
export const DEFAULT_RUNTIME_DB_PATH = join(PROJECT_ROOT, "data/runtime/conversation.db");

const rawConversationConfigSchema = z.object({
  conversation: z.object({
    id: z.string().trim().min(1, "conversation.id is required"),
    title: z.string().trim().min(1, "conversation.title is required"),
    brand: z.string().trim().min(1, "conversation.brand is required"),
    subtitle: z.string().trim().min(1, "conversation.subtitle is required"),
    timezone: z.string().trim().min(1, "conversation.timezone is required"),
  }),
  self: z.object({
    label: z.string().trim().min(1, "self.label is required"),
    shortLabel: z.string().trim().min(1, "self.shortLabel is required"),
  }),
  counterpart: z.object({
    label: z.string().trim().min(1, "counterpart.label is required"),
    shortLabel: z.string().trim().min(1, "counterpart.shortLabel is required"),
    handles: z.array(z.string().trim().min(1)).min(1, "counterpart.handles must include at least one handle"),
  }),
  source: z.object({
    messagesDir: z.string().trim().min(1, "source.messagesDir is required"),
    includeGroups: z.boolean().default(false),
  }),
  output: z.object({
    dbPath: z.string().trim().min(1, "output.dbPath is required"),
    rawSnapshotDir: z.string().trim().min(1, "output.rawSnapshotDir is required"),
    attachmentsPublicDir: z.string().trim().min(1, "output.attachmentsPublicDir is required"),
  }),
  comparison: z.object({
    enabled: z.boolean().default(true),
    minMessages: z.number().int().positive().default(100),
    resolveContactNames: z.boolean().default(true),
  }).default({
    enabled: true,
    minMessages: 100,
    resolveContactNames: true,
  }),
});

export type RawConversationConfig = z.input<typeof rawConversationConfigSchema>;
export type ConversationConfig = z.output<typeof conversationConfigSchema>;

const conversationConfigSchema = rawConversationConfigSchema.transform((config) => ({
  ...config,
  counterpart: {
    ...config.counterpart,
    handles: [...new Set(config.counterpart.handles.map(normalizeHandle))],
  },
  source: {
    ...config.source,
    messagesDir: resolveConfigPath(config.source.messagesDir),
  },
  output: {
    dbPath: resolveConfigPath(config.output.dbPath),
    rawSnapshotDir: resolveConfigPath(config.output.rawSnapshotDir),
    attachmentsPublicDir: resolveConfigPath(config.output.attachmentsPublicDir),
  },
}));

export type LoadConversationConfigOptions = {
  configPath?: string;
  validateMessagesDir?: boolean;
  ensureOutputDirs?: boolean;
};

export function configPathFromArgs(argv = process.argv.slice(2)): string {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") {
      const value = argv[index + 1];
      if (!value) throw new Error("Missing value for --config");
      return resolveConfigPath(value);
    }
    if (arg.startsWith("--config=")) {
      return resolveConfigPath(arg.slice("--config=".length));
    }
  }
  return resolveConfigPath(process.env.CONVERSATION_CONFIG ?? DEFAULT_CONFIG_PATH);
}

export function hasFlag(flag: string, argv = process.argv.slice(2)): boolean {
  return argv.includes(flag);
}

export function stringArg(name: string, argv = process.argv.slice(2)): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === name) return argv[index + 1];
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

export function numberArg(name: string, argv = process.argv.slice(2)): number | undefined {
  const raw = stringArg(name, argv);
  if (raw == null) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Expected numeric value for ${name}, got ${raw}`);
  return parsed;
}

export function loadConversationConfig(options: LoadConversationConfigOptions = {}): ConversationConfig {
  const configPath = resolveConfigPath(options.configPath ?? configPathFromArgs());
  if (!existsSync(configPath)) {
    throw new Error(
      `Conversation config not found at ${configPath}. Copy config/conversation.example.json to config/conversation.local.json and fill in your local values.`,
    );
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read conversation config at ${configPath}: ${(error as Error).message}`);
  }

  const parsed = conversationConfigSchema.safeParse(parsedJson);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("\n");
    throw new Error(`Invalid conversation config at ${configPath}:\n${issues}`);
  }

  const config = parsed.data;
  if (options.validateMessagesDir ?? true) {
    validateMessagesDir(config.source.messagesDir);
  }
  validateOutputDbPath(config.output.dbPath);
  if (options.ensureOutputDirs) {
    mkdirSync(config.output.rawSnapshotDir, { recursive: true });
    mkdirSync(dirname(config.output.dbPath), { recursive: true });
  }
  return config;
}

export function resolveConfigPath(pathValue: string): string {
  const expanded = expandHome(pathValue);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(PROJECT_ROOT, expanded);
}

export function expandHome(pathValue: string): string {
  if (pathValue === "~") return homedir();
  if (pathValue.startsWith("~/")) return join(homedir(), pathValue.slice(2));
  return pathValue;
}

export function normalizeHandle(handle: string): string {
  const trimmed = handle.trim();
  if (!trimmed) return "";
  if (trimmed.includes("@")) return trimmed.toLowerCase();
  const hasLeadingPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  return `${hasLeadingPlus ? "+" : ""}${digits}`;
}

export function handleMatchesConfigured(identifier: string, handles: ReadonlySet<string>): boolean {
  return handles.has(normalizeHandle(identifier));
}

function validateMessagesDir(messagesDir: string) {
  if (!existsSync(messagesDir)) {
    throw new Error(`Messages directory does not exist: ${messagesDir}`);
  }
  const stat = statSync(messagesDir);
  if (!stat.isDirectory()) {
    throw new Error(`source.messagesDir is not a directory: ${messagesDir}`);
  }
  const chatDb = join(messagesDir, "chat.db");
  if (!existsSync(chatDb)) {
    throw new Error(`Messages database not found: ${chatDb}`);
  }
}

function validateOutputDbPath(dbPath: string) {
  if (!dbPath.endsWith(".db")) {
    throw new Error(`output.dbPath must point to a .db file: ${dbPath}`);
  }
  if (dbPath.includes(`${join(PROJECT_ROOT, "public")}/`)) {
    throw new Error(`output.dbPath must not be inside public/: ${dbPath}`);
  }
}
