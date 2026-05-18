import { createServerFn } from "@tanstack/react-start";
import { FALLBACK_RUNTIME_IDENTITY, type RuntimeIdentity } from "~/lib/conversation/runtime-identity";
import { db, getDbVersion, withDbCache } from "~/lib/server-db";

const META_KEYS = [
  "conversation_id",
  "conversation_title",
  "conversation_brand",
  "conversation_subtitle",
  "timezone",
  "self_label",
  "self_short_label",
  "counterpart_label",
  "counterpart_short_label",
] as const;

export function readRuntimeIdentity(): RuntimeIdentity {
  return withDbCache(`runtime-identity:${getDbVersion()}`, () => {
    try {
      const rows = db()
        .prepare(`SELECT k, v FROM meta WHERE k IN (${META_KEYS.map(() => "?").join(",")})`)
        .all(...META_KEYS) as Array<{ k: string; v: string }>;
      const meta = Object.fromEntries(rows.map((row) => [row.k, row.v]));
      return {
        conversationId: meta.conversation_id ?? FALLBACK_RUNTIME_IDENTITY.conversationId,
        title: meta.conversation_title ?? FALLBACK_RUNTIME_IDENTITY.title,
        brand: meta.conversation_brand ?? FALLBACK_RUNTIME_IDENTITY.brand,
        subtitle: meta.conversation_subtitle ?? FALLBACK_RUNTIME_IDENTITY.subtitle,
        timezone: meta.timezone ?? FALLBACK_RUNTIME_IDENTITY.timezone,
        selfLabel: meta.self_label ?? FALLBACK_RUNTIME_IDENTITY.selfLabel,
        selfShortLabel: meta.self_short_label ?? meta.self_label ?? FALLBACK_RUNTIME_IDENTITY.selfShortLabel,
        counterpartLabel: meta.counterpart_label ?? FALLBACK_RUNTIME_IDENTITY.counterpartLabel,
        counterpartShortLabel:
          meta.counterpart_short_label ?? meta.counterpart_label ?? FALLBACK_RUNTIME_IDENTITY.counterpartShortLabel,
      };
    } catch {
      return FALLBACK_RUNTIME_IDENTITY;
    }
  });
}

export const getRuntimeIdentity = createServerFn({ method: "GET" }).handler(
  async (): Promise<RuntimeIdentity> => readRuntimeIdentity(),
);
