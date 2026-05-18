import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { realMessageWhere } from "~/lib/conversation/filters";
import { bucket, dayBounds } from "~/lib/conversation/time";
import { db } from "~/lib/server-db";

const REAL_MESSAGE_WHERE = realMessageWhere("browsable_message", "m");

export type EvidenceMessage = {
  id: number;
  ts: number;
  ymd: string;
  is_from_me: number;
  has_attachment: number;
  text: string | null;
  associated_message_type: number | null;
  rich_link_url: string | null;
};

const evidenceInput = z.object({
  ids: z.array(z.number().int().positive()).max(20).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sender: z.enum(["me", "them", "both"]).optional().default("both"),
  limit: z.number().int().min(1).max(160).default(80),
});

export const getEvidenceMessages = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => evidenceInput.parse(d))
  .handler(async ({ data }): Promise<EvidenceMessage[]> => {
    if (data.ids?.length) {
      const placeholders = data.ids.map(() => "?").join(", ");
      const rows = db()
        .prepare(
          `
          SELECT m.id, m.ts, m.ymd, m.is_from_me, m.has_attachment, m.text,
                 m.associated_message_type, m.rich_link_url
          FROM messages m
          WHERE m.id IN (${placeholders})
          ORDER BY m.ts ASC, m.id ASC
        `,
        )
        .all(...data.ids) as EvidenceMessage[];
      return rows.map((row) => ({ ...row, ymd: bucket(row.ts, "ymd") }));
    }

    if (data.date || data.from || data.to) {
      const startYmd = data.date ?? data.from;
      const start = startYmd ? dayBounds(startYmd).start : Number.MIN_SAFE_INTEGER;
      const end = data.date
        ? dayBounds(data.date).end
        : data.to
          ? dayBounds(data.to).end
          : Number.MAX_SAFE_INTEGER;
      const where = [REAL_MESSAGE_WHERE, "m.ts >= ?", "m.ts < ?"];
      const args: Array<string | number> = [start, end];
      if (data.sender === "me") where.push("m.is_from_me = 1");
      if (data.sender === "them") where.push("m.is_from_me = 0");
      args.push(data.limit);
      const rows = db()
        .prepare(
          `
          SELECT m.id, m.ts, m.ymd, m.is_from_me, m.has_attachment, m.text,
                 m.associated_message_type, m.rich_link_url
          FROM messages m
          WHERE ${where.join(" AND ")}
          ORDER BY m.ts ASC, m.id ASC
          LIMIT ?
        `,
        )
        .all(...args) as EvidenceMessage[];
      return rows.map((row) => ({ ...row, ymd: bucket(row.ts, "ymd") }));
    }

    return [];
  });
