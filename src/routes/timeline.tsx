import { createFileRoute } from "@tanstack/react-router";
import { PageTitleRow } from "~/components/PageTitleRow";
import { EvidenceLink } from "~/components/EvidenceLink";
import { MethodBadge } from "~/components/MethodBadge";
import { fmtInt } from "~/lib/format";
import { globalSearchSchema } from "~/routes/_search";
import { getMonthly, getHeatmap, getDaily, getStats } from "~/server/queries";
import { useState } from "react";

export const Route = createFileRoute("/timeline")({
  validateSearch: (search) => globalSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => {
    const [monthly, heatmap, stats] = await Promise.all([
      getMonthly({ data: deps }),
      getHeatmap({ data: deps }),
      getStats({ data: deps }),
    ]);
    return { monthly, heatmap, stats };
  },
  component: TimelinePage,
});

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function TimelinePage() {
  const { monthly, heatmap, stats } = Route.useLoaderData();
  const search = Route.useSearch();
  const [selectedYm, setSelectedYm] = useState<string | null>(null);
  const [daily, setDaily] = useState<Array<{ ymd: string; me: number; them: number; total: number }>>([]);
  const hasFilters = Boolean(search.from || search.to || search.phase != null || (search.sender && search.sender !== "both"));

  // Build heatmap matrix [7 days][24 hours]
  const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
  let max = 0;
  for (const row of heatmap) {
    grid[row.dow][row.hour] = row.n;
    if (row.n > max) max = row.n;
  }

  async function loadMonth(ym: string) {
    setSelectedYm(ym);
    const d = await getDaily({ data: { ...search, ym } });
    setDaily(d);
  }

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">Volume over time</div>
        <PageTitleRow activePath="/timeline" />
        <p className="page-lede">
          Raw message cadence by month, day, weekday, and local hour. Click any month to drill
          into daily counts.
        </p>
        <MethodBadge
          meta={{
            kind: "descriptive",
            sample: stats.total,
            version: `timeline-${String(stats.generated_at ?? "unknown").slice(0, 10)}`,
            caveats: [
              "Counts include all message records, including reactions and other non-text events.",
              "Heatmap buckets use Vancouver local time.",
            ],
          }}
          confidence="high"
        />
        {hasFilters && (
          <p className="browse-filter-note">
            Filtered{search.from ? ` from ${search.from}` : ""}{search.to ? ` to ${search.to}` : ""}{search.phase != null ? `, phase ${search.phase}` : ""}{search.sender && search.sender !== "both" ? `, ${search.sender} only` : ""}.
          </p>
        )}
      </div>

      <section className="section">
        <h2><span className="num">01</span> Monthly</h2>
        <div className="panel">
          <StackedBars rows={monthly} labelKey="ym" onSelect={loadMonth} />
        </div>
      </section>

      {selectedYm && (
        <section className="section">
          <h2><span className="num">02</span> Daily — {selectedYm}</h2>
          <div className="panel">
            <div className="evidence-action-row" style={{ marginBottom: "0.8rem" }}>
              <EvidenceLink
                evidence={{
                  label: "Open month in Browse",
                  from: `${selectedYm}-01`,
                  to: monthEndYmd(selectedYm),
                  sender: search.sender === "me" || search.sender === "them" ? search.sender : "both",
                  note: `${fmtInt(daily.reduce((total, day) => total + day.total, 0))} messages`,
                }}
              />
            </div>
            <StackedBars rows={daily} labelKey="ymd" />
          </div>
        </section>
      )}

      <section className="section">
        <h2><span className="num">03</span> When you talk — heatmap</h2>
        <div className="panel">
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: 11 }}>
              <thead>
                <tr>
                  <th style={{ padding: "4px 6px", textAlign: "right", color: "var(--ink-faded)", fontWeight: 400 }}></th>
                  {Array.from({ length: 24 }, (_, h) => (
                    <th key={h} style={{ padding: "2px 4px", color: "var(--ink-faded)", fontWeight: 400, textAlign: "center" }}>
                      {h % 6 === 0 ? h : ""}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {grid.map((row, dow) => (
                  <tr key={dow}>
                    <td style={{ padding: "2px 8px", textAlign: "right", color: "var(--ink-faded)" }}>{DAY_LABELS[dow]}</td>
                    {row.map((n, h) => {
                      const intensity = max > 0 ? n / max : 0;
                      const bg = `rgba(184, 67, 47, ${intensity.toFixed(3)})`;
                      return (
                        <td key={h} title={`${DAY_LABELS[dow]} ${h}:00 — ${fmtInt(n)} msgs`}
                            style={{ width: 22, height: 22, background: bg, border: "1px solid var(--bg)" }}
                        />
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="hint" style={{ marginTop: "0.6rem" }}>Local time. Darker = more messages.</div>
        </div>
      </section>
    </div>
  );
}

function StackedBars({
  rows,
  labelKey,
  onSelect,
}: {
  rows: Array<{ me: number; them: number; total: number } & Record<string, string | number>>;
  labelKey: "ym" | "ymd";
  onSelect?: (value: string) => void;
}) {
  const maxTotal = Math.max(...rows.map((row) => row.total), 1);
  const labelEvery = labelKey === "ym" ? 4 : 7;

  return (
    <div className="timeline-chart" role="img" aria-label={labelKey === "ym" ? "Monthly message counts by sender" : "Daily message counts by sender"}>
      <div className="timeline-chart-axis">
        <span>{fmtInt(maxTotal)}</span>
        <span>{fmtInt(Math.round(maxTotal / 2))}</span>
        <span>0</span>
      </div>
      <div
        className="timeline-bars"
        style={{ gridTemplateColumns: `repeat(${rows.length}, minmax(${labelKey === "ym" ? 12 : 7}px, 1fr))` }}
      >
        {rows.map((row, index) => {
          const label = String(row[labelKey]);
          const height = Math.max(2, (row.total / maxTotal) * 100);
          const meShare = row.total ? (row.me / row.total) * 100 : 0;
          const themShare = row.total ? (row.them / row.total) * 100 : 0;
          const title = `${label}: ${fmtInt(row.total)} messages, ${fmtInt(row.me)} Me, ${fmtInt(row.them)} Them`;
          const inner = (
            <>
              <span className="timeline-stack" style={{ height: `${height}%` }}>
                <i className="me" style={{ height: `${meShare}%` }} />
                <i className="them" style={{ height: `${themShare}%` }} />
              </span>
              <small>{index % labelEvery === 0 ? compactTick(label) : ""}</small>
            </>
          );

          return onSelect ? (
            <button key={label} type="button" className="timeline-bar-column" title={title} aria-label={title} onClick={() => onSelect(label)}>
              {inner}
            </button>
          ) : (
            <div key={label} className="timeline-bar-column" title={title} aria-label={title}>
              {inner}
            </div>
          );
        })}
      </div>
      <div className="timeline-legend" aria-hidden="true">
        <span><i className="me" />Me</span>
        <span><i className="them" />Them</span>
      </div>
    </div>
  );
}

function compactTick(value: string) {
  if (value.length === 7) {
    const month = Number(value.slice(5, 7));
    return MONTH_TICKS[month - 1] ?? value.slice(5);
  }
  return value.slice(8);
}

const MONTH_TICKS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthEndYmd(ym: string) {
  const [year, month] = ym.split("-").map(Number);
  const end = new Date(Date.UTC(year, month, 0));
  return end.toISOString().slice(0, 10);
}
