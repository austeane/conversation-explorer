import { createFileRoute } from "@tanstack/react-router";
import { PageTitleRow } from "~/components/PageTitleRow";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { listMessages, searchMessages, jumpToDate } from "~/server/queries";
import { fmtDate, fmtInt, fmtTime } from "~/lib/format";
import { bucket } from "~/lib/conversation/time";
import { phaseId } from "~/routes/_search";

type Msg = {
  id: number;
  ts: number;
  date_iso: string;
  ymd: string;
  is_from_me: number;
  has_attachment: number;
  text: string | null;
  reply_to_guid: string | null;
  associated_message_type: number | null;
  balloon_bundle_id: string | null;
  rich_link_url: string | null;
  segment_id: number | null;
  topic_id: number | null;
  segment_category: string | null;
  segment_category_status: string | null;
};

type SearchHit = {
  id: number;
  ts: number;
  date_iso: string;
  is_from_me: number;
  has_attachment: number;
  associated_message_type: number | null;
  segment_id: number | null;
  topic_id: number | null;
  segment_category: string | null;
  segment_category_status: string | null;
  snippet: string;
  text: string;
};

type SearchResults = { rows: SearchHit[]; total: number };

const browseSearchSchema = z.object({
  q: z.string().catch(""),
  date: z.string().catch(""),
  filter: z.enum(["all", "with_attachment", "tapbacks", "replies"]).catch("all"),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().catch(undefined),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().catch(undefined),
  sender: z.enum(["me", "them", "both"]).catch("both"),
  phase: phaseId,
});

export const Route = createFileRoute("/browse")({
  validateSearch: (search) => browseSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const initial = (await listMessages({
      data: {
        limit: 100,
        before: null,
        filter: deps.filter,
        from: deps.from,
        to: deps.to,
        sender: deps.sender,
        phase: deps.phase,
      },
    })) as Msg[];
    return { initial };
  },
  component: BrowsePage,
});

function BrowsePage() {
  const { initial } = Route.useLoaderData();
  const initialSearch = Route.useSearch();

  const [filter, setFilter] = useState<"all" | "with_attachment" | "tapbacks" | "replies">(initialSearch.filter);
  const [messages, setMessages] = useState<Msg[]>(initial);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState(initialSearch.q);
  const [searchResults, setSearchResults] = useState<SearchResults | null>(null);
  const [jumpDate, setJumpDate] = useState(initialSearch.date);

  const scrollRef = useRef<HTMLDivElement>(null);
  const oldestRef = useRef<number | null>(messages[0]?.ts ?? null);
  const didApplyInitialDate = useRef(false);

  // Reload when filter changes
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listMessages({
      data: {
        limit: 100,
        before: null,
        filter,
        from: initialSearch.from,
        to: initialSearch.to,
        sender: initialSearch.sender,
        phase: initialSearch.phase,
      },
    }).then((rows) => {
      if (cancelled) return;
      const arr = rows as Msg[];
      setMessages(arr);
      oldestRef.current = arr[0]?.ts ?? null;
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [filter, initialSearch.from, initialSearch.phase, initialSearch.sender, initialSearch.to]);

  // Live FTS search (debounced)
  useEffect(() => {
    if (search.trim().length < 2) {
      setSearchResults(null);
      return;
    }
    const handle = setTimeout(async () => {
      const r = await searchMessages({
        data: {
          q: search.trim(),
          limit: 100,
          offset: 0,
          filter,
          from: initialSearch.from,
          to: initialSearch.to,
          sender: initialSearch.sender,
          phase: initialSearch.phase,
        },
      });
      setSearchResults(r);
    }, 220);
    return () => clearTimeout(handle);
  }, [filter, initialSearch.from, initialSearch.phase, initialSearch.sender, initialSearch.to, search]);

  async function loadMoreSearchResults() {
    if (!searchResults || loading) return;
    const query = search.trim();
    if (query.length < 2 || searchResults.rows.length >= searchResults.total) return;
    setLoading(true);
    const next = await searchMessages({
      data: {
        q: query,
        limit: 100,
        offset: searchResults.rows.length,
        filter,
        from: initialSearch.from,
        to: initialSearch.to,
        sender: initialSearch.sender,
        phase: initialSearch.phase,
      },
    });
    setSearchResults((current) => {
      if (!current) return next;
      const seen = new Set(current.rows.map((row) => row.id));
      const rows = [...current.rows, ...next.rows.filter((row) => !seen.has(row.id))];
      return { total: next.total, rows };
    });
    setLoading(false);
  }

  async function loadOlder() {
    if (loading || !oldestRef.current) return;
    setLoading(true);
    const more = (await listMessages({
      data: {
        limit: 100,
        before: oldestRef.current,
        filter,
        from: initialSearch.from,
        to: initialSearch.to,
        sender: initialSearch.sender,
        phase: initialSearch.phase,
      },
    })) as Msg[];
    if (more.length === 0) {
      setLoading(false);
      return;
    }
    const wrap = scrollRef.current;
    const prevH = wrap?.scrollHeight ?? 0;
    const prevTop = wrap?.scrollTop ?? 0;
    setMessages((cur) => [...more, ...cur]);
    oldestRef.current = more[0]?.ts ?? oldestRef.current;
    requestAnimationFrame(() => {
      if (wrap) {
        const newH = wrap.scrollHeight;
        wrap.scrollTop = newH - prevH + prevTop;
      }
      setLoading(false);
    });
  }

  async function loadNewer() {
    if (loading) return;
    const newest = messages[messages.length - 1]?.ts;
    if (!newest) return;
    setLoading(true);
    const more = (await listMessages({
      data: {
        limit: 100,
        after: newest,
        filter,
        from: initialSearch.from,
        to: initialSearch.to,
        sender: initialSearch.sender,
        phase: initialSearch.phase,
      },
    })) as Msg[];
    setMessages((cur) => [...cur, ...more]);
    setLoading(false);
  }

  async function loadAroundDate(date: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const target = await jumpToDate({ data: { ymd: date } });
    if (!target) return;
    setLoading(true);
    const around = (await listMessages({
      data: {
        limit: 100,
        before: target.ts + 86400,
        filter,
        from: initialSearch.from,
        to: initialSearch.to,
        sender: initialSearch.sender,
        phase: initialSearch.phase,
      },
    })) as Msg[];
    setMessages(around);
    oldestRef.current = around[0]?.ts ?? null;
    requestAnimationFrame(() => {
      const wrap = scrollRef.current;
      if (wrap) wrap.scrollTop = wrap.scrollHeight;
    });
    setLoading(false);
  }

  async function onJump() {
    await loadAroundDate(jumpDate);
  }

  useEffect(() => {
    if (didApplyInitialDate.current || !initialSearch.date) return;
    didApplyInitialDate.current = true;
    void loadAroundDate(initialSearch.date);
  }, [initialSearch.date]);

  // attach scroll handler for "load older when scrolled to top"
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      if (el.scrollTop < 80) loadOlder();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  });

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">All 159,751 messages</div>
        <PageTitleRow activePath="/browse" />
        <p className="page-lede">Scroll up to load older. Search uses FTS5 over decoded text.</p>
        {(initialSearch.from || initialSearch.to || initialSearch.sender !== "both" || initialSearch.phase != null) && (
          <p className="browse-filter-note">
            Filtered{initialSearch.from ? ` from ${initialSearch.from}` : ""}{initialSearch.to ? ` to ${initialSearch.to}` : ""}{initialSearch.phase != null ? `, phase ${initialSearch.phase}` : ""}{initialSearch.sender !== "both" ? `, ${initialSearch.sender} only` : ""}.
          </p>
        )}
      </div>

      <div className="browse-controls">
        <input
          className="search-input"
          placeholder="Search…  (e.g. mexico, anniversary, sorry)"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <input
          className="search-input"
          placeholder="Jump to YYYY-MM-DD"
          value={jumpDate}
          onChange={(e) => setJumpDate(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onJump(); }}
        />
        <select
          className="search-input"
          value={filter}
          onChange={(e) => setFilter(e.target.value as any)}
        >
          <option value="all">All messages</option>
          <option value="with_attachment">With attachment</option>
          <option value="replies">Threaded replies</option>
          <option value="tapbacks">Tapbacks</option>
        </select>
      </div>

      {searchResults ? (
        <div>
          <div className="hint" style={{ marginBottom: "0.6rem" }}>
            {fmtInt(searchResults.total)} hits for <strong>"{search}"</strong> in {filterLabel(filter)} — showing newest {fmtInt(searchResults.rows.length)}
          </div>
          {searchResults.rows.map((r) => (
            <div key={r.id} className={`bubble-row ${r.is_from_me ? "me" : "them"}`}>
              <div className={`bubble ${r.is_from_me ? "me" : "them"}`}>
                <Snippet html={r.snippet} />
                <SegmentContextBadge message={r} />
              </div>
              <div className="bubble-meta">{fmtDate(r.ts, { withTime: true })}</div>
            </div>
          ))}
          {searchResults.rows.length < searchResults.total && (
            <div className="browse-search-more">
              <button className="btn" type="button" onClick={loadMoreSearchResults} disabled={loading}>
                {loading ? "Loading..." : `Load older hits (${fmtInt(searchResults.total - searchResults.rows.length)} remaining)`}
              </button>
            </div>
          )}
        </div>
      ) : (
        <div ref={scrollRef} style={{ maxHeight: "70vh", overflowY: "auto", border: "1px solid var(--rule)", padding: "0.6rem 0.8rem", background: "var(--bg)" }}>
          {loading && <div className="hint" style={{ textAlign: "center", padding: "0.6rem" }}>loading…</div>}
          <MessageStream messages={messages} />
          <div style={{ textAlign: "center", padding: "0.8rem" }}>
            <button className="btn" onClick={loadNewer} disabled={loading}>Load newer →</button>
          </div>
        </div>
      )}
    </div>
  );
}

function MessageStream({ messages }: { messages: Msg[] }) {
  let lastYmd = "";
  return (
    <>
      {messages.map((m) => {
        const ymd = bucket(m.ts, "ymd");
        const showDay = ymd !== lastYmd;
        lastYmd = ymd;
        const isTapback = m.associated_message_type !== null && m.associated_message_type >= 2000 && m.associated_message_type < 3000;
        return (
          <div key={m.id}>
            {showDay && <div className="day-divider"><span>{fmtDate(m.ts)}</span></div>}
            <div className={`bubble-row ${m.is_from_me ? "me" : "them"}`}>
              <div className={`bubble ${m.is_from_me ? "me" : "them"}`} style={isTapback ? { fontStyle: "italic", opacity: 0.7 } : undefined}>
                {m.text || (m.has_attachment ? <em>📎 attachment</em> : <em>—</em>)}
                {m.rich_link_url && (
                  <div className="hint" style={{ marginTop: 4 }}>↗ {m.rich_link_url.slice(0, 60)}</div>
                )}
                <SegmentContextBadge message={m} />
              </div>
              <div className="bubble-meta">{fmtTime(m.ts)}</div>
            </div>
          </div>
        );
      })}
    </>
  );
}

type SegmentContextMessage = {
  segment_id: number | null;
  topic_id: number | null;
  segment_category: string | null;
  segment_category_status: string | null;
};

function SegmentContextBadge({ message }: { message: SegmentContextMessage }) {
  if (message.segment_id == null) return null;
  const category = message.segment_category ?? "unclassified";
  const status = message.segment_category_status;
  const label = status && status !== "classified" ? status : category;
  return (
    <div className="browse-segment-context">
      <span>{formatSegmentLabel(label)}</span>
      <span>segment {message.segment_id}</span>
      {message.topic_id != null ? <span>topic {message.topic_id}</span> : <span>topic outlier</span>}
    </div>
  );
}

function formatSegmentLabel(value: string) {
  return value.replace(/_/g, " ");
}

function filterLabel(filter: "all" | "with_attachment" | "tapbacks" | "replies") {
  if (filter === "with_attachment") return "messages with attachments";
  if (filter === "tapbacks") return "tapbacks";
  if (filter === "replies") return "threaded replies";
  return "all messages";
}

function Snippet({ html }: { html: string }) {
  const parts = html.split(/(<mark>|<\/mark>)/);
  let marked = false;
  let cursor = 0;
  return (
    <>
      {parts.map((part) => {
        const key = `${cursor}:${part}`;
        cursor += part.length;
        if (part === "<mark>") {
          marked = true;
          return null;
        }
        if (part === "</mark>") {
          marked = false;
          return null;
        }
        return marked ? <mark key={key}>{part}</mark> : <span key={key}>{part}</span>;
      })}
    </>
  );
}
