import { createServerFn } from "@tanstack/react-start";
import { appendFileSync, mkdirSync } from "node:fs";
import { redactForExternalModel, type RedactionReport } from "~/lib/redact";
import { z } from "zod";
import { realMessageWhere } from "~/lib/conversation/filters";
import { senderFor, type Sender } from "~/lib/conversation/senders";
import { STOPWORDS } from "~/lib/conversation/stopwords";
import { tokenize } from "~/lib/conversation/tokenize";
import { db, getDataGeneratedAt, withDbCache } from "~/lib/server-db";

export type AskMessageHit = {
  id: number;
  segment_id: number | null;
  ts: number;
  sender: Sender;
  snippet: string;
  text: string;
  category: string;
  topic_label: string;
};

export type AskSegmentHit = {
  segment_id: number;
  category: string;
  topic_label: string;
  first_ts: number;
  last_ts: number;
  messages: AskMessageHit[];
};

export type AskResult = {
  q: string;
  mode: "retrieval" | "synthesis";
  total_messages: number;
  segments: AskSegmentHit[];
  loose_messages: AskMessageHit[];
  synthesis: AskSynthesis | null;
};

export type AskSynthesis = {
  status: "ready" | "disabled" | "error";
  answer: string | null;
  model: string;
  message: string;
  citations: number[];
  outbound_chars: number;
  redactions: RedactionReport;
  audit_path: string;
};

const askInput = z.object({
  q: z.string().trim().min(2).max(180),
  limit: z.number().int().min(5).max(80).default(40),
  sensitive: z.boolean().optional().default(false),
  synthesize: z.boolean().optional().default(false),
});

type AskRow = {
  id: number;
  segment_id: number | null;
  ts: number;
  is_from_me: number;
  snippet: string | null;
  text: string | null;
  category: string | null;
  topic_label: string | null;
};

type RetrievalInput = z.infer<typeof askInput>;

const AUDIT_DIR = `${process.cwd()}/data/ask`;
const AUDIT_PATH = `${AUDIT_DIR}/audit.jsonl`;
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5";

export const askArchive = createServerFn({ method: "GET" })
  .inputValidator((d: unknown) => askInput.parse(d))
  .handler(async ({ data }): Promise<AskResult> => {
    const retrieval = withDbCache(`ask:${JSON.stringify({ q: data.q, limit: data.limit, sensitive: data.sensitive })}`, () =>
      retrieveArchive(data),
    );
    if (!data.synthesize) return retrieval;
    const synthesis = await synthesizeAnswer(data, retrieval);
    return { ...retrieval, mode: "synthesis", synthesis };
  });

function retrieveArchive(data: RetrievalInput): AskResult {
  const fts = ftsQuery(data.q);
  const where = ["messages_fts MATCH ?", realMessageWhere("browsable_message", "m")];
  const args: Array<string | number> = [fts];
  if (!data.sensitive) {
    where.push("COALESCE(sc.category, '') != 'sexual_intimacy'");
  }

  const rows = db()
    .prepare(
      `
      SELECT
        m.id,
        sm.segment_id,
        m.ts,
        m.is_from_me,
        snippet(messages_fts, 0, '<mark>', '</mark>', '...', 28) AS snippet,
        m.text,
        COALESCE(sc.category, tc.category, 'unclassified') AS category,
        COALESCE(t.label, sc.category, tc.category, 'unlabeled') AS topic_label
      FROM messages_fts
      JOIN messages m ON m.id = messages_fts.rowid
      LEFT JOIN seg_msg_segment sm ON sm.msg_id = m.id
      LEFT JOIN seg_segments s ON s.id = sm.segment_id
      LEFT JOIN seg_topics t ON t.id = s.topic_id
      LEFT JOIN seg_segment_categories sc ON sc.segment_id = s.id
      LEFT JOIN seg_topic_categories tc ON tc.topic_id = s.topic_id
      WHERE ${where.join(" AND ")}
      ORDER BY bm25(messages_fts), m.ts DESC
      LIMIT ?
      `,
    )
    .all(...args, data.limit) as AskRow[];

  const messages = rows.map(toHit);
  const groups = new Map<number, AskSegmentHit>();
  const loose: AskMessageHit[] = [];
  for (const message of messages) {
    if (message.segment_id == null) {
      loose.push(message);
      continue;
    }
    const segment = groups.get(message.segment_id) ?? {
      segment_id: message.segment_id,
      category: message.category,
      topic_label: message.topic_label,
      first_ts: message.ts,
      last_ts: message.ts,
      messages: [],
    };
    segment.first_ts = Math.min(segment.first_ts, message.ts);
    segment.last_ts = Math.max(segment.last_ts, message.ts);
    segment.messages.push(message);
    groups.set(message.segment_id, segment);
  }

  return {
    q: data.q,
    mode: "retrieval",
    total_messages: messages.length,
    segments: [...groups.values()].sort((a, b) => b.messages.length - a.messages.length || b.last_ts - a.last_ts).slice(0, 16),
    loose_messages: loose.slice(0, 12),
    synthesis: null,
  };
}

async function synthesizeAnswer(input: RetrievalInput, result: AskResult): Promise<AskSynthesis> {
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL;
  const auditBase = {
    generated_at: getDataGeneratedAt(),
    q: input.q,
    sensitive: input.sensitive,
    model,
    total_messages: result.total_messages,
    segment_ids: result.segments.map((segment) => segment.segment_id),
  };
  const evidence = result.segments.slice(0, 8).flatMap((segment) =>
    segment.messages.slice(0, 3).map((message) => ({
      segment_id: segment.segment_id,
      message_id: message.id,
      sender: message.sender,
      text: message.text,
    })),
  );
  const rawPrompt = [
    `Question: ${input.q}`,
    "",
    "Retrieved snippets. Answer only from these snippets. Cite segment IDs inline like [#123]. If the evidence is thin, say so.",
    ...evidence.map((item) => `[#${item.segment_id}] ${item.sender}: ${item.text}`),
  ].join("\n");
  const redacted = redactForExternalModel(rawPrompt);
  const emptyRedactions = emptyRedactionReport();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const auditPath = displayPath(AUDIT_PATH);

  if (!apiKey) {
    writeAudit({
      ...auditBase,
      status: "disabled",
      outbound_request: false,
      outbound_chars: 0,
      redactions: emptyRedactions,
      reason: "ANTHROPIC_API_KEY missing",
    });
    return {
      status: "disabled",
      answer: null,
      model,
      message: "ANTHROPIC_API_KEY is not set; no outbound request was made.",
      citations: [],
      outbound_chars: 0,
      redactions: emptyRedactions,
      audit_path: auditPath,
    };
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: 700,
        system: "You synthesize a private message archive. Use only the provided redacted snippets. Keep the answer concise and cite segment IDs.",
        messages: [{ role: "user", content: redacted.text }],
      }),
    });
    const payload = await response.json().catch(() => null) as AnthropicMessageResponse | null;
    if (!response.ok) {
      const message = errorMessage(payload) || `Anthropic request failed with HTTP ${response.status}`;
      writeAudit({
        ...auditBase,
        status: "error",
        outbound_request: true,
        outbound_chars: redacted.text.length,
        redactions: redacted.report,
        error: message,
      });
      return {
        status: "error",
        answer: null,
        model,
        message,
        citations: [],
        outbound_chars: redacted.text.length,
        redactions: redacted.report,
        audit_path: auditPath,
      };
    }

    const answer = payload?.content?.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n").trim() || "";
    const citations = [...answer.matchAll(/\[#(\d+)\]/g)].map((match) => Number(match[1])).filter(Number.isFinite);
    writeAudit({
      ...auditBase,
      status: "ready",
      outbound_request: true,
      outbound_chars: redacted.text.length,
      redactions: redacted.report,
      citation_count: citations.length,
    });
    return {
      status: "ready",
      answer,
      model,
      message: "Synthesis requested from Anthropic using redacted retrieved snippets.",
      citations,
      outbound_chars: redacted.text.length,
      redactions: redacted.report,
      audit_path: auditPath,
    };
  } catch (err) {
    const message = (err as Error).message;
    writeAudit({
      ...auditBase,
      status: "error",
      outbound_request: true,
      outbound_chars: redacted.text.length,
      redactions: redacted.report,
      error: message,
    });
    return {
      status: "error",
      answer: null,
      model,
      message,
      citations: [],
      outbound_chars: redacted.text.length,
      redactions: redacted.report,
      audit_path: auditPath,
    };
  }
}

type AnthropicMessageResponse = {
  content?: Array<{ type: string; text?: string }>;
  error?: { message?: string };
};

function writeAudit(row: Record<string, unknown>) {
  mkdirSync(AUDIT_DIR, { recursive: true });
  appendFileSync(AUDIT_PATH, `${JSON.stringify(row)}\n`);
}

function emptyRedactionReport(): RedactionReport {
  return { phone: 0, email: 0, address: 0, name: 0 };
}

function errorMessage(payload: AnthropicMessageResponse | null) {
  return payload?.error?.message ?? null;
}

function displayPath(_path: string) {
  return "data/ask/audit.jsonl";
}

function toHit(row: AskRow): AskMessageHit {
  const text = clean(row.text ?? "");
  return {
    id: row.id,
    segment_id: row.segment_id,
    ts: row.ts,
    sender: senderFor(row.is_from_me),
    snippet: row.snippet ?? preview(text),
    text: preview(text),
    category: row.category ?? "unclassified",
    topic_label: row.topic_label ?? "unlabeled",
  };
}

function ftsQuery(q: string) {
  const terms = tokenize(q, { minLen: 2, maxLen: 24 })
    .filter((token) => !STOPWORDS.has(token))
    .slice(0, 10);
  if (terms.length === 0) return quoteFts(q);
  return terms.map(quoteFts).join(" OR ");
}

function quoteFts(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function clean(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function preview(value: string) {
  const cleaned = clean(value);
  return cleaned.length > 240 ? `${cleaned.slice(0, 237)}...` : cleaned;
}
