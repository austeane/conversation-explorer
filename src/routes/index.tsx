import { Link, createFileRoute } from "@tanstack/react-router";
import { EvidenceDrawer } from "~/components/EvidenceDrawer";
import { EvidenceLink, type EvidenceRef } from "~/components/EvidenceLink";
import { MethodBadge } from "~/components/MethodBadge";
import { getStats, getMonthly, getEmojiTop, getWordTops } from "~/server/queries";
import { fmtInt, fmtDate, fmtDuration, pct } from "~/lib/format";
import { useRuntimeIdentity } from "~/lib/conversation/runtime-identity";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip } from "recharts";
import { useMemo, useState } from "react";
import { globalSearchSchema, type GlobalSearch } from "./_search";

type MonthlyRow = {
  ym: string;
  me: number;
  them: number;
  total: number;
};

type HomeRoutePath = "/browse" | "/timeline" | "/dynamics" | "/vocabulary" | "/attachments" | "/gestures";
type HomeLinkSearch = Record<string, string | number | boolean>;

const HOME_ENTRIES = [
  {
    path: "/insights",
    eyebrow: "Questions",
    label: "What changed recently?",
    description: "Recent shifts, reopeners, missed bids, and repeating patterns with evidence attached.",
  },
  {
    path: "/browse",
    eyebrow: "Record",
    label: "Where are the messages?",
    description: "Search, dates, attachments, replies, and the underlying message stream.",
  },
  {
    path: "/methods",
    eyebrow: "Trust",
    label: "How was this measured?",
    description: "Method notes, caveats, freshness, and the boundaries around generated claims.",
  },
  {
    path: "/comparisons",
    eyebrow: "Between us",
    label: "What differs by sender?",
    description: "Sender splits, asymmetries, and side-by-side contrasts.",
  },
  {
    path: "/gestures",
    eyebrow: "Signals",
    label: "What happens around replies?",
    description: "Tapbacks, threaded replies, links, games, media, and small acts of response.",
  },
  {
    path: "/desire",
    eyebrow: "Sensitive",
    label: "What carries charge?",
    description: "A more careful surface for attraction, intimacy, intensity, and boundaries.",
  },
] as const;

export const Route = createFileRoute("/")({
  validateSearch: (search) => globalSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const [stats, monthly, emojis, words] = await Promise.all([
      getStats({ data: deps }),
      getMonthly({ data: deps }),
      getEmojiTop({ data: deps }),
      getWordTops({ data: deps }),
    ]);
    return { stats, monthly, emojis, words };
  },
  component: StatsPage,
});

function StatsPage() {
  const { stats, monthly, emojis, words } = Route.useLoaderData();
  const identity = useRuntimeIdentity();
  const search = Route.useSearch();
  const [selectedEvidence, setSelectedEvidence] = useState<EvidenceRef | null>(null);
  const hasFilters = Boolean(search.from || search.to || search.phase != null || (search.sender && search.sender !== "both"));

  const yearsSpan = useMemo(() => {
    const sec = stats.last_ts - stats.first_ts;
    return (sec / (365.25 * 86400)).toFixed(1);
  }, [stats]);

  const peakMonthEvidence = useMemo(() => {
    const peak = (monthly as MonthlyRow[]).reduce<MonthlyRow | null>(
      (best, row) => (!best || row.total > best.total ? row : best),
      null,
    );
    return peak ? monthEvidenceRef(peak, identity.selfShortLabel, identity.counterpartShortLabel) : null;
  }, [identity.counterpartShortLabel, identity.selfShortLabel, monthly]);

  function openMonthEvidence(entry: unknown) {
    const row = monthlyRowFromChartEntry(entry);
    if (!row) return;
    setSelectedEvidence(monthEvidenceRef(row, identity.selfShortLabel, identity.counterpartShortLabel));
  }

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">A conversation, observed</div>
        <h1 className="page-title">{identity.title}</h1>
        <p className="page-lede">
          {stats.total > 0 ? (
            <>
              {fmtInt(stats.total)} messages over {yearsSpan} years, from{" "}
              <strong>{fmtDate(stats.first_ts)}</strong> through{" "}
              <strong>{fmtDate(stats.last_ts)}</strong>.
            </>
          ) : (
            "No messages match the current filters."
          )}
        </p>
        <MethodBadge
          meta={{
            kind: "descriptive",
            sample: stats.total,
            version: "archive-stats-v1",
            caveats: [
              "Counts reflect the current extracted DB, not live Messages.",
              "Date and sender filters are applied before summary statistics.",
            ],
          }}
        />
        {hasFilters && (
          <p className="browse-filter-note">
            Filtered{search.from ? ` from ${search.from}` : ""}{search.to ? ` to ${search.to}` : ""}{search.phase != null ? `, phase ${search.phase}` : ""}{search.sender && search.sender !== "both" ? `, ${search.sender} only` : ""}.
          </p>
        )}
      </div>

      <div className="stat-grid">
        <Stat label="Total messages" value={fmtInt(stats.total)} note={`${stats.days_with_messages} days w/ activity`} to="/browse" search={browseLinkSearch(search)} />
        <Stat label={`From ${identity.selfShortLabel}`} value={fmtInt(stats.me)} note={pct(stats.me, stats.total)} to="/browse" search={browseLinkSearch(search, { sender: "me" })} />
        <Stat label={`From ${identity.counterpartShortLabel}`} value={fmtInt(stats.them)} note={pct(stats.them, stats.total)} to="/browse" search={browseLinkSearch(search, { sender: "them" })} />
        <Stat label="Words written" value={fmtInt(stats.total_words)} note={`${(stats.total_chars / 1_000_000).toFixed(1)}M chars`} to="/vocabulary" search={languageLinkSearch(search)} />
        <Stat label="Attachments" value={fmtInt(stats.attachments)} note="msgs with media" to="/attachments" search={globalLinkSearch(search)} />
        <Stat label="Tapbacks" value={fmtInt(stats.tapbacks)} note={`${fmtInt(stats.replies)} threaded replies`} to="/gestures" search={globalLinkSearch(search)} />
      </div>

      <section className="section">
        <h2><span className="num">01</span> Start here</h2>
        <div className="analysis-grid">
          {HOME_ENTRIES.map((item) => (
            <Link key={item.path} to={item.path as any} className="analysis-card">
              <span>{item.eyebrow}</span>
              <strong>{item.label}</strong>
              <p>{item.description}</p>
            </Link>
          ))}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">02</span> Cadence</h2>
        <div className="row row-2">
          <Link to="/dynamics" search={globalLinkSearch(search) as any} className="panel home-widget-link">
            <table className="kv-list">
              <tbody>
                <tr><td>Median gap between msgs</td><td>{fmtDuration(stats.median_gap_seconds)}</td></tr>
                <tr><td>Longest silence</td><td>{stats.longest_gap_days} days {stats.longest_gap_start > 0 && <span className="hint">({fmtDate(stats.longest_gap_start)} → {fmtDate(stats.longest_gap_end)})</span>}</td></tr>
                <tr><td>Busiest day</td><td>{stats.busiest_day_count} msgs {stats.busiest_day_ymd && <span className="hint">on {stats.busiest_day_ymd}</span>}</td></tr>
                <tr><td>Avg msgs / active day</td><td>{stats.days_with_messages ? Math.round(stats.total / stats.days_with_messages) : 0}</td></tr>
                <tr><td>Median {identity.selfShortLabel} to {identity.counterpartShortLabel} reply</td><td>{fmtDuration(stats.reply_med_me_to_them)}</td></tr>
                <tr><td>Median {identity.counterpartShortLabel} to {identity.selfShortLabel} reply</td><td>{fmtDuration(stats.reply_med_them_to_me)}</td></tr>
              </tbody>
            </table>
          </Link>
          <div className="panel">
            <Link to="/timeline" search={globalLinkSearch(search) as any} className="hint monthly-chart-label home-widget-heading-link">
              Monthly volume
            </Link>
            <div className="stats-chart-frame">
              <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 620, height: 260 }}>
                <BarChart data={monthly} margin={{ top: 4, right: 8, bottom: 4, left: -10 }}>
                  <XAxis dataKey="ym" tick={{ fontSize: 9 }} interval={5} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip
                    contentStyle={{ fontSize: 12, fontFamily: "var(--font-mono)" }}
                    formatter={((v: number, k: string) => [fmtInt(v), k]) as any}
                  />
                  <Bar className="evidence-bar" dataKey="me" stackId="a" fill="var(--me)" onClick={openMonthEvidence} />
                  <Bar className="evidence-bar" dataKey="them" stackId="a" fill="var(--them)" onClick={openMonthEvidence} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            {peakMonthEvidence && (
              <div className="monthly-evidence-access">
                <EvidenceLink evidence={peakMonthEvidence} onSelect={setSelectedEvidence} />
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="section">
        <h2><span className="num">03</span> Most-used words</h2>
        <div className="row row-2">
          <WordCloud title={identity.selfShortLabel} words={words.me} accent="var(--me)" to="/vocabulary" search={languageLinkSearch(search)} />
          <WordCloud title={identity.counterpartShortLabel} words={words.them} accent="var(--them)" to="/vocabulary" search={languageLinkSearch(search)} />
        </div>
      </section>

      <section className="section">
        <h2><span className="num">04</span> Top emojis</h2>
        <Link to="/gestures" search={globalLinkSearch(search) as any} className="panel home-widget-link" aria-label="Top emojis">
          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.6rem 1.2rem" }}>
            {emojis.map((e) => (
              <div key={e.emoji} style={{ display: "flex", alignItems: "baseline", gap: "0.5rem" }}>
                <span style={{ fontSize: "1.4rem" }}>{e.emoji}</span>
                <span className="hint">{fmtInt(e.n)}</span>
              </div>
            ))}
          </div>
        </Link>
      </section>

      <p className="hint" style={{ marginTop: "3rem", textAlign: "center" }}>
        Generated {stats.generated_at.slice(0, 19).replace("T", " ")} UTC. All data lives in <code>data/runtime/conversation.db</code>.
      </p>

      <EvidenceDrawer evidence={selectedEvidence} onClose={() => setSelectedEvidence(null)} />
    </div>
  );
}

function monthlyRowFromChartEntry(entry: unknown): MonthlyRow | null {
  const candidate = typeof entry === "object" && entry !== null && "payload" in entry
    ? (entry as { payload?: unknown }).payload
    : entry;
  if (typeof candidate !== "object" || candidate === null) return null;

  const row = candidate as Partial<MonthlyRow>;
  if (typeof row.ym !== "string") return null;
  return {
    ym: row.ym,
    me: Number(row.me ?? 0),
    them: Number(row.them ?? 0),
    total: Number(row.total ?? 0),
  };
}

function monthEvidenceRef(row: MonthlyRow, selfLabel = "Me", counterpartLabel = "Them"): EvidenceRef {
  const bounds = monthBoundsYmd(row.ym);
  return {
    label: `${row.ym} monthly volume`,
    from: bounds.from,
    to: bounds.to,
    note: `${fmtInt(row.total)} messages; ${selfLabel} ${fmtInt(row.me)}; ${counterpartLabel} ${fmtInt(row.them)}`,
  };
}

function monthBoundsYmd(ym: string) {
  const [year, month] = ym.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    from: `${ym}-01`,
    to: `${ym}-${String(lastDay).padStart(2, "0")}`,
  };
}

function Stat({
  label,
  value,
  note,
  to,
  search,
}: {
  label: string;
  value: string;
  note?: string;
  to?: HomeRoutePath;
  search?: HomeLinkSearch;
}) {
  const body = (
    <>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {note && <div className="stat-note">{note}</div>}
    </>
  );

  return to ? (
    <Link to={to as any} search={search as any} className="stat stat-link">
      {body}
    </Link>
  ) : (
    <div className="stat">
      {body}
    </div>
  );
}

function WordCloud({
  title,
  words,
  accent,
  to,
  search,
}: {
  title: string;
  words: { word: string; n: number }[];
  accent: string;
  to?: HomeRoutePath;
  search?: HomeLinkSearch;
}) {
  const max = words[0]?.n ?? 1;
  const body = (
    <>
      <div className="hint" style={{ marginBottom: "0.7rem", color: accent, fontWeight: 600 }}>{title.toUpperCase()}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem 0.8rem", lineHeight: 1.4 }}>
        {words.map((w) => {
          const ratio = w.n / max;
          const size = 0.85 + ratio * 1.0;
          return (
            <span key={w.word} style={{ fontSize: `${size}rem`, color: ratio > 0.5 ? accent : "var(--ink)" }}>
              {w.word} <span className="word-count">{fmtInt(w.n)}</span>
            </span>
          );
        })}
      </div>
    </>
  );

  return to ? (
    <Link to={to as any} search={search as any} className="panel home-widget-link">
      {body}
    </Link>
  ) : (
    <div className="panel">
      {body}
    </div>
  );
}

function globalLinkSearch(search: GlobalSearch, overrides: Partial<GlobalSearch> = {}): HomeLinkSearch {
  return compactSearch({
    from: search.from,
    to: search.to,
    phase: search.phase,
    sender: search.sender,
    ...overrides,
  });
}

function languageLinkSearch(search: GlobalSearch): HomeLinkSearch {
  return compactSearch({
    from: search.from,
    to: search.to,
    phase: search.phase,
  });
}

function browseLinkSearch(search: GlobalSearch, overrides: Partial<GlobalSearch> = {}): HomeLinkSearch {
  return compactSearch({
    from: search.from,
    to: search.to,
    phase: search.phase,
    sender: search.sender,
    ...overrides,
  });
}

function compactSearch(values: Record<string, string | number | boolean | undefined>): HomeLinkSearch {
  const search: HomeLinkSearch = {};
  for (const [key, value] of Object.entries(values)) {
    if (value == null || value === false || value === "") continue;
    if (key === "sender" && value === "both") continue;
    search[key] = value;
  }
  return search;
}
