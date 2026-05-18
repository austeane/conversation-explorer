import { createFileRoute } from "@tanstack/react-router";
import { PageTitleRow } from "~/components/PageTitleRow";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Sankey,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import {
  getCategoryShareOverTime,
  getCategoryTransitions,
  getConversationsOverview,
  getSegment,
  listSegments,
  listTopics,
  type ConversationsOverview,
  type CategoryTransition,
  type CategoryShareRow,
  type SegmentDetail,
  type SegmentRow,
  type TopicRow,
} from "~/server/conversation-queries";
import { EvidenceLink } from "~/components/EvidenceLink";
import { MethodBadge } from "~/components/MethodBadge";
import { bucket } from "~/lib/conversation/time";
import { fmtDate, fmtDuration, fmtInt, pct } from "~/lib/format";

export const Route = createFileRoute("/conversations")({
  loader: async () => {
    const [overview, topics, share, transitions, initialSegments] = await Promise.all([
      getConversationsOverview(),
      listTopics(),
      getCategoryShareOverTime(),
      getCategoryTransitions(),
      listSegments({ data: { limit: 60, offset: 0, order: "recent", minMsgs: 4 } }),
    ]);
    return { overview, topics, share, transitions, initialSegments };
  },
  component: ConversationsPage,
});

const CATEGORIES = [
  "unclassified",
  "logistics",
  "planning",
  "small_talk",
  "romantic_intimacy",
  "sexual_intimacy",
  "conflict",
  "emotional_support",
  "humor",
  "work_school",
  "family",
  "daily_check_in",
  "photo_sharing",
  "memes_links",
  "food",
  "travel",
  "games",
  "tech",
  "health",
  "household",
  "finance",
] as const;
type Cat = (typeof CATEGORIES)[number];

// Distinct, theme-friendly hand-picked palette. Avoids the existing me/them blue+red.
const CATEGORY_COLOR: Record<Cat, string> = {
  unclassified: "#8a7e70",
  logistics: "#5e7cb1",
  planning: "#9c7fbc",
  small_talk: "#cdb88a",
  romantic_intimacy: "#c95985",
  sexual_intimacy: "#8f3f73",
  conflict: "#a93428",
  emotional_support: "#3f8a85",
  humor: "#e0a23a",
  work_school: "#39606b",
  family: "#7b9468",
  daily_check_in: "#b39468",
  photo_sharing: "#7e6db3",
  memes_links: "#5fa3a8",
  food: "#cf6b3b",
  travel: "#3e8b5b",
  games: "#557f2d",
  tech: "#5b6f8f",
  health: "#b65f58",
  household: "#97764a",
  finance: "#4e7d65",
};

const THREAD_PALETTE = ["#b8432f", "#2c5d8f", "#7b9468", "#9c7fbc"];

function fmtCategory(c: string): string {
  return c.replace(/_/g, " ");
}

function ConversationsPage() {
  const { overview, topics, share, transitions, initialSegments } = Route.useLoaderData();
  const mostCommonCategory =
    overview.category_summary.find((category) => category.category !== "unclassified") ??
    overview.category_summary[0];

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">Topics, threads, and turns</div>
        <PageTitleRow activePath="/conversations" />
        <p className="page-lede">
          {fmtInt(overview.n_segments)} discrete conversations, segmented by silence and semantic
          drift; {overview.n_topics} topics surfaced by BERTopic; {fmtInt(overview.n_threads)}{" "}
          sub-threads disentangled inside long sessions. Median segment length{" "}
          {overview.median_segment_msgs} msgs, longest {fmtInt(overview.longest_segment_msgs)}.{" "}
          {pct(overview.n_topic_outliers, overview.n_segments)} sit outside topic clusters, so
          segment cards disclose the lexical label evidence.
        </p>
        <MethodBadge
          meta={{
            kind: "heuristic",
            sample: overview.n_segments,
            version: "segmented-conversations-v1",
            caveats: [
              "Topic and category labels are model-generated.",
              "UMAP placement is for orientation, not literal distance measurement.",
            ],
          }}
        />
      </div>

      <div className="stat-grid">
        <Stat label="Segments" value={fmtInt(overview.n_segments)} note={`mean ${overview.mean_segment_msgs} msgs`} />
        <Stat label="Topics" value={fmtInt(overview.n_topics)} note="BERTopic clusters" />
        <Stat label="Sub-threads" value={fmtInt(overview.n_threads)} note="Louvain communities" />
        <Stat label="Most common" value={fmtCategory(mostCommonCategory?.category ?? "n/a")} note={`${fmtInt(mostCommonCategory?.n ?? 0)} classified segments`} />
        <Stat label="Topic coverage" value={pct(overview.n_segments - overview.n_topic_outliers, overview.n_segments)} note={`${fmtInt(overview.n_topic_outliers)} topic outliers`} />
        <Stat label="Label trust" value={fmtConfidence(overview.mean_labeled_confidence)} note={`${fmtInt(overview.n_low_confidence)} labeled below 60%`} />
        <Stat label="Blended labels" value={fmtInt(overview.n_secondary_categories)} note="carry a secondary category" />
      </div>

      <CategoryInventory categories={overview.category_summary} />

      <SectionConversationsOverTime share={share} />

      <SectionTopicExplorer topics={topics} />

      <SectionSegmentBrowser
        topics={topics}
        categories={overview.category_summary}
        initial={initialSegments}
      />

      <SectionTransitions transitions={transitions} />

      <SectionCategoryShare share={share} />
    </div>
  );
}

function CategoryInventory({ categories }: { categories: ConversationsOverview["category_summary"] }) {
  return (
    <div className="panel category-inventory">
      <div className="hint category-inventory-label">SEGMENT CATEGORIES</div>
      <div className="category-inventory-list">
        {categories.map((c) => (
          <span key={c.category} className="category-inventory-pill">
            <span
              className="category-inventory-swatch"
              style={{ background: CATEGORY_COLOR[c.category as Cat] ?? "#888" }}
            />
            {fmtCategory(c.category)}
            <span className="category-inventory-count">{fmtInt(c.n)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// 01 stacked area
function SectionConversationsOverTime({ share }: { share: CategoryShareRow[] }) {
  const allCats = useMemo(() => {
    const set = new Set<string>();
    for (const row of share) {
      for (const k of Object.keys(row)) {
        if (k === "ym" || k === "total") continue;
        set.add(k);
      }
    }
    // Sort by total desc so the legend ordering is meaningful
    const tot = new Map<string, number>();
    for (const c of set) {
      tot.set(
        c,
        share.reduce((a, r) => a + (Number(r[c] ?? 0)), 0),
      );
    }
    return [...set].sort((a, b) => (tot.get(b)! - tot.get(a)!));
  }, [share]);

  return (
    <section className="section">
      <h2><span className="num">01</span> Conversations over time</h2>
      <div className="panel">
        <div className="hint" style={{ marginBottom: "0.6rem" }}>
          Monthly count of conversation segments, stacked by category. Hover any band.
        </div>
        <MeasuredChartFrame height={360}>
          {(width, height) => (
            <AreaChart width={width} height={height} data={share} margin={{ top: 8, right: 24, bottom: 4, left: -12 }}>
              <CartesianGrid stroke="var(--rule-light)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="ym" tick={{ fontSize: 9 }} interval={5} />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip
                contentStyle={{
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  background: "var(--bg)",
                  border: "1px solid var(--rule)",
                }}
                formatter={((v: number, k: string) => [fmtInt(v), fmtCategory(k)]) as any}
              />
              {allCats.map((c) => (
                <Area
                  key={c}
                  type="monotone"
                  dataKey={c}
                  stackId="cats"
                  stroke={CATEGORY_COLOR[c as Cat] ?? "#888"}
                  fill={CATEGORY_COLOR[c as Cat] ?? "#888"}
                  fillOpacity={0.78}
                  isAnimationActive={false}
                />
              ))}
            </AreaChart>
          )}
        </MeasuredChartFrame>
        <CategoryLegend cats={allCats} />
      </div>
    </section>
  );
}

function CategoryLegend({ cats, onClick, selected }: { cats: string[]; onClick?: (c: string) => void; selected?: string | null }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.45rem 0.7rem", marginTop: "0.8rem" }}>
      {cats.map((c) => {
        const active = selected ? selected === c : true;
        return (
          <button
            key={c}
            type="button"
            onClick={() => onClick?.(c)}
            style={{
              border: "1px solid var(--rule)",
              background: active ? (CATEGORY_COLOR[c as Cat] ?? "#888") : "transparent",
              color: active ? "white" : "var(--ink)",
              fontSize: "0.66rem",
              fontFamily: "var(--font-mono)",
              letterSpacing: "0.05em",
              padding: "0.2rem 0.55rem",
              cursor: onClick ? "pointer" : "default",
              textTransform: "uppercase",
              opacity: active ? 1 : 0.65,
            }}
          >
            <span
              style={{
                display: "inline-block",
                width: 8,
                height: 8,
                background: CATEGORY_COLOR[c as Cat] ?? "#888",
                marginRight: 6,
                verticalAlign: "middle",
                border: active ? "1px solid rgba(255,255,255,0.6)" : "none",
              }}
            />
            {fmtCategory(c)}
          </button>
        );
      })}
    </div>
  );
}

// 02 Topic explorer (list + scatter)
function SectionTopicExplorer({ topics }: { topics: TopicRow[] }) {
  const [highlightTopicId, setHighlightTopicId] = useState<number | null>(null);
  const [mapMode, setMapMode] = useState<"semantic" | "category">("semantic");

  const categoryPoints = useMemo(() => {
    const byCat = new Map<string, TopicRow[]>();
    for (const t of topics) {
      const c = t.label ?? "unclassified";
      if (!byCat.has(c)) byCat.set(c, []);
      byCat.get(c)!.push(t);
    }
    const cats = [...byCat.keys()];
    const cols = Math.ceil(Math.sqrt(cats.length));
    const out: Array<{ topic: TopicRow; cat: string; x: number; y: number; size: number }> = [];
    cats.forEach((cat, ci) => {
      const cx = (ci % cols) - cols / 2;
      const cy = Math.floor(ci / cols) - cols / 2;
      const list = byCat.get(cat)!.slice().sort((a, b) => b.n_segments - a.n_segments);
      list.forEach((t, idx) => {
        const angle = (idx / Math.max(1, list.length)) * Math.PI * 2;
        const r = 0.45 + 0.05 * Math.sqrt(idx);
        out.push({
          topic: t,
          cat,
          x: cx + Math.cos(angle) * r,
          y: cy + Math.sin(angle) * r,
          size: Math.max(20, Math.min(160, t.n_segments * 1.5)),
        });
      });
    });
    return out;
  }, [topics]);

  const semanticPoints = useMemo(() => {
    const out: Array<{ topic: TopicRow; cat: string; x: number; y: number; size: number }> = [];
    for (const t of topics) {
      if (t.umap_x == null || t.umap_y == null) continue;
      out.push({
        topic: t,
        cat: t.label ?? "unclassified",
        x: t.umap_x,
        y: t.umap_y,
        size: Math.max(20, Math.min(160, t.n_segments * 1.5)),
      });
    }
    return out;
  }, [topics]);

  const layoutPoints = mapMode === "semantic" && semanticPoints.length > 0
    ? semanticPoints
    : categoryPoints;

  return (
    <section className="section">
      <h2><span className="num">02</span> Topic explorer</h2>
      <div className="row row-2" style={{ alignItems: "stretch" }}>
        <div className="panel" style={{ display: "flex", flexDirection: "column" }}>
          <div className="hint" style={{ marginBottom: "0.5rem" }}>
            {topics.length} topics, ranked by segment count. Click to highlight in scatter.
          </div>
          <div style={{ overflowY: "auto", maxHeight: 460, paddingRight: "0.5rem" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
              <tbody>
                {topics.map((t) => {
                  const cat = (t.label ?? "unclassified") as Cat;
                  const active = highlightTopicId === t.id;
                  return (
                    <tr
                      key={t.id}
                      onClick={() => setHighlightTopicId(active ? null : t.id)}
                      style={{
                        cursor: "pointer",
                        background: active ? "var(--bg-warm)" : undefined,
                        borderBottom: "1px solid var(--rule-light)",
                      }}
                    >
                      <td style={{ padding: "0.4rem 0.5rem", verticalAlign: "top", width: 40 }}>
                        <span
                          style={{
                            display: "inline-block",
                            width: 10,
                            height: 10,
                            background: CATEGORY_COLOR[cat] ?? "#888",
                          }}
                        />
                      </td>
                      <td style={{ padding: "0.4rem 0.5rem", verticalAlign: "top" }}>
                        <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.75rem", color: "var(--ink-faded)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                          #{t.id} · {fmtCategory(cat)} · {fmtInt(t.n_segments)}
                          {t.category_confidence != null ? ` · ${fmtConfidence(t.category_confidence)} fit` : ""}
                        </div>
                        <div style={{ marginTop: 2, color: "var(--ink-light)", fontSize: "0.85rem" }}>
                          {t.top_words.slice(0, 8).join(" · ") || "(no keywords)"}
                        </div>
                        {t.top_phrases.length > 0 && (
                          <div className="conversation-topic-phrases">
                            {t.top_phrases.slice(0, 4).join(" / ")}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.6rem", marginBottom: "0.6rem", flexWrap: "wrap" }}>
            <div className="hint">
              {mapMode === "semantic"
                ? "Topic centroids in persisted UMAP space. Bubble size = segment count."
                : "Fallback category-ring layout. Bubble size = segment count."}
            </div>
            <div style={{ display: "flex", gap: "0.35rem" }}>
              <button
                type="button"
                className={`btn${mapMode === "semantic" ? " active" : ""}`}
                onClick={() => setMapMode("semantic")}
              >
                Semantic
              </button>
              <button
                type="button"
                className={`btn${mapMode === "category" ? " active" : ""}`}
                onClick={() => setMapMode("category")}
              >
                Category
              </button>
            </div>
          </div>
          <MeasuredChartFrame height={460}>
            {(width, height) => (
              <ScatterChart width={width} height={height} margin={{ top: 12, right: 18, bottom: 12, left: 12 }}>
                <CartesianGrid stroke="var(--rule-light)" strokeDasharray="3 3" />
                <XAxis type="number" dataKey="x" hide domain={["dataMin - 0.3", "dataMax + 0.3"]} />
                <YAxis type="number" dataKey="y" hide domain={["dataMin - 0.3", "dataMax + 0.3"]} />
                <ZAxis type="number" dataKey="size" range={[40, 320]} />
                <Tooltip
                  contentStyle={{
                    fontSize: 11,
                    fontFamily: "var(--font-mono)",
                    background: "var(--bg)",
                    border: "1px solid var(--rule)",
                  }}
                  formatter={((_v: any, _k: string, p: any) => {
                    const t = p?.payload?.topic as TopicRow | undefined;
                    if (!t) return ["", ""];
                    return [
                      `${fmtInt(t.n_segments)} segs · ${t.top_words.slice(0, 6).join(", ")}`,
                      `topic #${t.id} · ${fmtCategory(t.label ?? "n/a")}`,
                    ];
                  }) as any}
                />
                <Scatter data={layoutPoints}>
                  {layoutPoints.map((p) => {
                    const isHighlighted = highlightTopicId === p.topic.id;
                    const dimmed = highlightTopicId != null && !isHighlighted;
                    return (
                      <Cell
                        key={p.topic.id}
                        fill={CATEGORY_COLOR[p.cat as Cat] ?? "#888"}
                        fillOpacity={dimmed ? 0.18 : 0.78}
                        stroke={isHighlighted ? "var(--ink)" : "transparent"}
                        strokeWidth={isHighlighted ? 2 : 0}
                      />
                    );
                  })}
                </Scatter>
              </ScatterChart>
            )}
          </MeasuredChartFrame>
        </div>
      </div>
    </section>
  );
}

// 03 Segment browser
function SectionSegmentBrowser({ topics, categories, initial }: {
  topics: TopicRow[];
  categories: ConversationsOverview["category_summary"];
  initial: { rows: SegmentRow[]; total: number };
}) {
  const [topicId, setTopicId] = useState<number | null>(null);
  const [category, setCategory] = useState<Cat | null>(null);
  const [order, setOrder] = useState<"recent" | "longest">("recent");
  const [page, setPage] = useState(0);
  const [data, setData] = useState<{ rows: SegmentRow[]; total: number }>(initial);
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const PAGE = 60;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listSegments({
      data: {
        topicId: topicId ?? undefined,
        category: category ?? undefined,
        limit: PAGE,
        offset: page * PAGE,
        order,
        minMsgs: 4,
      },
    })
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [topicId, category, page, order]);

  const topicMap = useMemo(() => new Map(topics.map((t) => [t.id, t])), [topics]);
  const categoryCounts = useMemo(
    () => new Map(categories.map((c) => [c.category, c.n])),
    [categories],
  );

  return (
    <section className="section">
      <h2><span className="num">03</span> Browse segments</h2>
      <div className="panel">
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.8rem", alignItems: "center" }}>
          <span className="hint">FILTER:</span>
          <button
            type="button"
            className={`btn${topicId == null && category == null ? " active" : ""}`}
            onClick={() => {
              setTopicId(null);
              setCategory(null);
              setPage(0);
            }}
          >
            All ({fmtInt(data.total)})
          </button>
          <select
            value={category ?? ""}
            onChange={(e) => {
              setCategory((e.target.value as Cat) || null);
              setTopicId(null);
              setPage(0);
            }}
            style={{ padding: "0.5rem 0.7rem", border: "1px solid var(--ink)", background: "var(--bg)", fontFamily: "var(--font-mono)", fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.08em" }}
          >
            <option value="">Any category</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {fmtCategory(c)} ({fmtInt(categoryCounts.get(c) ?? 0)})
              </option>
            ))}
          </select>
          <select
            value={topicId ?? ""}
            onChange={(e) => {
              const v = e.target.value ? Number(e.target.value) : null;
              setTopicId(v);
              setCategory(null);
              setPage(0);
            }}
            style={{ padding: "0.5rem 0.7rem", border: "1px solid var(--ink)", background: "var(--bg)", fontFamily: "var(--font-mono)", fontSize: "0.7rem", letterSpacing: "0.05em", maxWidth: 260 }}
          >
            <option value="">Any topic</option>
            {topics.map((t) => (
              <option key={t.id} value={t.id}>
                #{t.id} · {(t.top_words || []).slice(0, 4).join(", ") || "(empty)"} ({t.n_segments})
              </option>
            ))}
          </select>
          <div style={{ marginLeft: "auto", display: "flex", gap: "0.4rem" }}>
            <button
              type="button"
              className={`btn${order === "recent" ? " active" : ""}`}
              onClick={() => setOrder("recent")}
            >
              Recent
            </button>
            <button
              type="button"
              className={`btn${order === "longest" ? " active" : ""}`}
              onClick={() => setOrder("longest")}
            >
              Longest
            </button>
          </div>
        </div>

        {loading && <div className="hint">Loading…</div>}

        <div style={{ display: "grid", gap: "0.55rem" }}>
          {data.rows.map((s) => {
            const cat = (s.category ?? "unclassified") as Cat;
            const topicWords = s.topic_id != null ? topicMap.get(s.topic_id)?.top_words.slice(0, 3) : null;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setOpenId(s.id)}
                style={{
                  textAlign: "left",
                  border: "1px solid var(--rule)",
                  background: "var(--bg)",
                  padding: "0.7rem 0.95rem",
                  cursor: "pointer",
                  display: "grid",
                  gridTemplateColumns: "auto minmax(0, 1fr) auto",
                  gap: "0.85rem",
                  alignItems: "center",
                  width: "100%",
                  maxWidth: "100%",
                  minWidth: 0,
                }}
              >
                <span style={{ width: 8, height: 36, background: CATEGORY_COLOR[cat] ?? "#888", display: "inline-block" }} />
                <div style={{ minWidth: 0 }}>
                  <div className="hint" style={{ marginBottom: 2 }}>
                    {fmtDate(s.start_ts, { withTime: true })} · {s.n_msgs} msgs
                    {" · "}{fmtCategory(cat)}
                    {s.topic_id == null ? " · topic outlier" : ` · #${s.topic_id}`}
                    {topicWords?.length ? ` · ${topicWords.join(" · ")}` : ""}
                  </div>
                  <div
                    style={{
                      fontSize: "0.88rem",
                      color: "var(--ink)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                    } as React.CSSProperties}
                  >
                    {(s.preview || "").slice(0, 280)}
                  </div>
                  <div className="conversation-card-flags">
                    {s.category_status && s.category_status !== "classified" && (
                      <span className="conversation-quality-pill low">{fmtCategory(s.category_status)}</span>
                    )}
                    {s.category_confidence != null && (
                      <span className={`conversation-quality-pill${s.category_confidence < 0.6 ? " low" : ""}`}>
                        {fmtConfidence(s.category_confidence)} label
                      </span>
                    )}
                    {s.secondary_category && (
                      <span>
                        also {fmtCategory(s.secondary_category)}
                        {s.secondary_confidence != null ? ` ${fmtConfidence(s.secondary_confidence)}` : ""}
                      </span>
                    )}
                    {s.signals.slice(0, 3).map((signal) => (
                      <span key={signal}>{signal}</span>
                    ))}
                  </div>
                </div>
                <div className="hint" style={{ fontFamily: "var(--font-mono)", whiteSpace: "nowrap" }}>
                  {s.n_me}/{s.n_them}
                </div>
              </button>
            );
          })}
        </div>

        <div style={{ marginTop: "1rem", display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <button
            type="button"
            className="btn"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            ← Prev
          </button>
          <span className="hint">
            page {page + 1} of {Math.max(1, Math.ceil(data.total / PAGE))} · {fmtInt(data.total)} total
          </span>
          <button
            type="button"
            className="btn"
            disabled={(page + 1) * PAGE >= data.total}
            onClick={() => setPage((p) => p + 1)}
          >
            Next →
          </button>
        </div>
      </div>

      {openId != null && <SegmentDrawer id={openId} onClose={() => setOpenId(null)} />}
    </section>
  );
}

function SegmentDrawer({ id, onClose }: { id: number; onClose: () => void }) {
  const [data, setData] = useState<SegmentDetail | null>(null);
  useEffect(() => {
    let cancelled = false;
    getSegment({ data: { id } }).then((d) => {
      if (!cancelled) setData(d);
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  return (
    <div
      role="presentation"
      tabIndex={-1}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(26,22,18,0.55)",
        zIndex: 50,
        display: "flex",
        justifyContent: "flex-end",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        style={{
          width: "min(640px, 92vw)",
          height: "100%",
          background: "var(--bg)",
          borderLeft: "1px solid var(--ink)",
          padding: "1.6rem 1.6rem 2rem",
          overflowY: "auto",
          boxShadow: "-2px 0 12px rgba(0,0,0,0.12)",
        }}
      >
        <button
          type="button"
          className="btn"
          onClick={onClose}
          style={{ float: "right" }}
        >
          Close ✕
        </button>
        {!data && <div className="hint">Loading…</div>}
        {data && (
          <>
            <div className="hint" style={{ marginBottom: "0.5rem" }}>
              Segment #{data.segment.id}
            </div>
            <h3 style={{ fontFamily: "var(--font-display)", fontSize: "1.4rem", margin: "0 0 0.3rem" }}>
              {data.segment.topic_label
                ? fmtCategory(data.segment.topic_label)
                : data.segment.category
                  ? fmtCategory(data.segment.category)
                  : "Unclassified segment"}
            </h3>
            <div className="hint" style={{ marginBottom: "1rem" }}>
              {fmtDate(data.segment.start_ts, { withTime: true })} →{" "}
              {fmtDate(data.segment.end_ts, { withTime: true })} · {data.segment.n_msgs} msgs
              {" · "}
              <span style={{ color: "var(--me)" }}>{data.segment.n_me} A</span>{" / "}
              <span style={{ color: "var(--them)" }}>{data.segment.n_them} S</span>
              {data.threads.length > 1 && ` · ${data.threads.length} sub-threads`}
              {data.segment.topic_id == null && " · topic outlier"}
            </div>
            <div className="evidence-action-row" style={{ marginBottom: "1rem" }}>
              <EvidenceLink
                evidence={{
                  label: "Open date range in Browse",
                  from: bucket(data.segment.start_ts, "ymd"),
                  to: bucket(data.segment.end_ts, "ymd"),
                  note: `${data.segment.n_msgs} messages in this segment`,
                }}
              />
            </div>
            {data.segment.topic_top_words.length > 0 && (
              <div className="hint" style={{ marginBottom: "1rem" }}>
                Topic keywords: {data.segment.topic_top_words.slice(0, 8).join(" · ")}
              </div>
            )}
            {data.segment.topic_top_phrases.length > 0 && (
              <div className="hint" style={{ marginBottom: "1rem" }}>
                Topic phrases: {data.segment.topic_top_phrases.slice(0, 6).join(" · ")}
              </div>
            )}

            <SegmentClassification segment={data.segment} />

            <div>
              {data.messages.map((m, idx) => {
                const me = m.is_from_me === 1;
                const threadColor = m.thread_idx != null
                  ? THREAD_PALETTE[m.thread_idx % THREAD_PALETTE.length]
                  : null;
                const showDate =
                  idx === 0 ||
                  new Date(m.ts * 1000).toDateString() !==
                    new Date(data.messages[idx - 1].ts * 1000).toDateString();
                return (
                  <div key={m.id}>
                    {showDate && (
                      <div className="day-divider">
                        {new Date(m.ts * 1000).toDateString()}
                      </div>
                    )}
                    <div className={`bubble-row${me ? " me" : ""}`}>
                      <div
                        className={`bubble ${me ? "me" : "them"}`}
                        style={
                          threadColor && data.threads.length > 1
                            ? { borderLeft: `4px solid ${threadColor}` }
                            : undefined
                        }
                      >
                        {m.text || (m.has_attachment ? "[attachment]" : "[no text]")}
                      </div>
                      <div className="bubble-meta">
                        {new Date(m.ts * 1000).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" })}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SegmentClassification({ segment }: { segment: SegmentDetail["segment"] }) {
  return (
    <div className="conversation-classification">
      <div className="conversation-classification-grid">
        <div>
          <span>Primary</span>
          <strong>{segment.category ? fmtCategory(segment.category) : "Unclassified"}</strong>
          <small>{fmtConfidence(segment.category_confidence)}</small>
        </div>
        <div>
          <span>Secondary</span>
          <strong>{segment.secondary_category ? fmtCategory(segment.secondary_category) : "None"}</strong>
          <small>
            {segment.secondary_confidence != null
              ? fmtConfidence(segment.secondary_confidence)
              : segment.secondary_score != null
                ? `score ${segment.secondary_score.toFixed(1)}`
                : "no second label"}
          </small>
        </div>
        <div>
          <span>Status</span>
          <strong>{segment.category_status ? fmtCategory(segment.category_status) : "Unknown"}</strong>
          <small>{segment.method ?? "no method"}</small>
        </div>
      </div>
      {segment.category_reason && (
        <p>Reason: {fmtCategory(segment.category_reason)}</p>
      )}
      {segment.signals.length > 0 && (
        <div className="conversation-signal-tags">
          {segment.signals.map((signal) => (
            <span key={signal}>{signal}</span>
          ))}
        </div>
      )}
    </div>
  );
}

// 04 Sankey transition graph
function SectionTransitions({ transitions }: { transitions: CategoryTransition[] }) {
  const [hideSmallTalk, setHideSmallTalk] = useState(false);
  const sankey = useMemo(() => {
    if (!transitions.length) return null;
    let top = transitions
      .slice()
      .filter((t) => t.from && t.to)
      .sort((a, b) => b.n - a.n);
    if (hideSmallTalk) {
      top = top.filter((t) => !["small_talk", "unclassified"].includes(t.from) && !["small_talk", "unclassified"].includes(t.to));
    }
    top = top.slice(0, 60);

    const nameToIndex = new Map<string, number>();
    const nodes: Array<{ name: string; cat: string }> = [];
    function addNode(cat: string, suffix: "from" | "to"): number {
      const key = `${cat}::${suffix}`;
      if (nameToIndex.has(key)) return nameToIndex.get(key)!;
      const idx = nodes.length;
      nameToIndex.set(key, idx);
      nodes.push({ name: fmtCategory(cat), cat });
      return idx;
    }
    const links = top.map((t) => ({
      source: addNode(t.from, "from"),
      target: addNode(t.to, "to"),
      value: t.n,
    }));
    return { nodes, links };
  }, [transitions, hideSmallTalk]);

  return (
    <section className="section">
      <h2><span className="num">04</span> Category transitions</h2>
      <div className="panel">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.6rem", flexWrap: "wrap", gap: "0.6rem" }}>
          <div className="hint">
            When one segment ends and another starts within 72 hours, what category does the
            conversation drift to? Top {Math.min(60, sankey?.links.length ?? 0)} flows shown.
          </div>
          <button
            type="button"
            className={`btn${hideSmallTalk ? " active" : ""}`}
            onClick={() => setHideSmallTalk(!hideSmallTalk)}
          >
            {hideSmallTalk ? "Include small talk" : "Hide small talk"}
          </button>
        </div>
        {sankey && sankey.links.length > 0 ? (
          <MeasuredChartFrame height={480}>
            {(width, height) => (
              <Sankey
                width={width}
                height={height}
                data={sankey}
                nodePadding={28}
                nodeWidth={12}
                margin={{ left: 10, right: 10, top: 10, bottom: 10 }}
                link={{ stroke: "var(--rule)" }}
                node={(props: any) => {
                  const { x, y, width, height, payload } = props;
                  const cat = (payload?.cat ?? "unclassified") as Cat;
                  return (
                    <g>
                      <rect x={x} y={y} width={width} height={height} fill={CATEGORY_COLOR[cat] ?? "#888"} fillOpacity={0.85} />
                      <text
                        x={x < 200 ? x + width + 6 : x - 6}
                        y={y + height / 2}
                        textAnchor={x < 200 ? "start" : "end"}
                        dominantBaseline="middle"
                        fontFamily="var(--font-mono)"
                        fontSize={10}
                        fill="var(--ink)"
                      >
                        {payload?.name}
                      </text>
                    </g>
                  );
                }}
              >
                <Tooltip
                  contentStyle={{
                    fontSize: 11,
                    fontFamily: "var(--font-mono)",
                    background: "var(--bg)",
                    border: "1px solid var(--rule)",
                  }}
                  formatter={((v: number) => fmtInt(v)) as any}
                />
              </Sankey>
            )}
          </MeasuredChartFrame>
        ) : (
          <div className="hint">No transitions to display.</div>
        )}

        <div style={{ marginTop: "1rem" }}>
          <div className="hint" style={{ marginBottom: "0.4rem" }}>Top 10 by count</div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
            <tbody>
              {transitions.slice(0, 10).map((t, i) => (
                <tr key={i} style={{ borderBottom: "1px solid var(--rule-light)" }}>
                  <td style={{ padding: "0.4rem 0.5rem", color: "var(--ink-faded)", fontFamily: "var(--font-mono)", fontSize: "0.7rem" }}>{i + 1}</td>
                  <td style={{ padding: "0.4rem 0.5rem" }}>
                    <Pill cat={t.from} /> → <Pill cat={t.to} />
                  </td>
                  <td style={{ padding: "0.4rem 0.5rem", textAlign: "right", fontFamily: "var(--font-mono)" }}>
                    {fmtInt(t.n)}
                  </td>
                  <td style={{ padding: "0.4rem 0.5rem", textAlign: "right", color: "var(--ink-faded)", fontFamily: "var(--font-mono)" }}>
                    {fmtDuration(t.mean_gap_seconds)} avg gap
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function Pill({ cat }: { cat: string }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "1px 8px",
        border: `1px solid ${CATEGORY_COLOR[cat as Cat] ?? "#888"}`,
        color: CATEGORY_COLOR[cat as Cat] ?? "#888",
        fontSize: "0.7rem",
        fontFamily: "var(--font-mono)",
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        marginRight: 4,
      }}
    >
      {fmtCategory(cat)}
    </span>
  );
}

// 05 Stacked area normalized to 100%
function SectionCategoryShare({ share }: { share: CategoryShareRow[] }) {
  const cats = useMemo(() => {
    const set = new Set<string>();
    for (const row of share) {
      for (const k of Object.keys(row)) {
        if (k === "ym" || k === "total") continue;
        set.add(k);
      }
    }
    const tot = new Map<string, number>();
    for (const c of set) {
      tot.set(c, share.reduce((a, r) => a + Number(r[c] ?? 0), 0));
    }
    return [...set].sort((a, b) => (tot.get(b)! - tot.get(a)!));
  }, [share]);

  // Normalize each row to 100%
  const data = useMemo(() => {
    return share.map((r) => {
      const tot = Number(r.total) || 1;
      const out: Record<string, number | string> = { ym: r.ym };
      for (const c of cats) {
        out[c] = (Number(r[c] ?? 0) / tot) * 100;
      }
      return out;
    });
  }, [share, cats]);

  return (
    <section className="section">
      <h2><span className="num">05</span> Category share over time</h2>
      <div className="panel">
        <div className="hint" style={{ marginBottom: "0.6rem" }}>
          Same data as section 01, normalized to 100% per month: what does each year emphasize?
        </div>
        <MeasuredChartFrame height={320}>
          {(width, height) => (
            <AreaChart width={width} height={height} data={data} margin={{ top: 8, right: 24, bottom: 4, left: 6 }}>
              <CartesianGrid stroke="var(--rule-light)" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="ym" tick={{ fontSize: 9 }} interval={5} />
              <YAxis
                tick={{ fontSize: 10 }}
                domain={[0, 100]}
                tickFormatter={(v: number) => `${Math.round(v)}%`}
              />
              <Tooltip
                contentStyle={{
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  background: "var(--bg)",
                  border: "1px solid var(--rule)",
                }}
                formatter={((v: number, k: string) => [`${v.toFixed(1)}%`, fmtCategory(k)]) as any}
              />
              {cats.map((c) => (
                <Area
                  key={c}
                  type="monotone"
                  dataKey={c}
                  stackId="cats"
                  stroke={CATEGORY_COLOR[c as Cat] ?? "#888"}
                  fill={CATEGORY_COLOR[c as Cat] ?? "#888"}
                  fillOpacity={0.78}
                  isAnimationActive={false}
                />
              ))}
            </AreaChart>
          )}
        </MeasuredChartFrame>
      </div>
    </section>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {note && <div className="stat-note">{note}</div>}
    </div>
  );
}

function MeasuredChartFrame({
  height,
  children,
}: {
  height: number;
  children: (width: number, height: number) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const update = () => setWidth(Math.floor(node.getBoundingClientRect().width));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className="conversation-measured-chart" style={{ height }}>
      {width > 0 ? children(width, height) : <div className="conversation-chart-placeholder">Preparing chart...</div>}
    </div>
  );
}

function fmtConfidence(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "n/a";
  return `${Math.round(value * 100)}%`;
}
