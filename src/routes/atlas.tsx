import { createFileRoute } from "@tanstack/react-router";
import { PageTitleRow } from "~/components/PageTitleRow";
import { EvidenceLink } from "~/components/EvidenceLink";
import { MethodBadge } from "~/components/MethodBadge";
import { TopicStabilityBadge } from "~/components/TopicStabilityBadge";
import { bucket } from "~/lib/conversation/time";
import { fmtDate, fmtDuration, fmtInt } from "~/lib/format";
import {
  getAtlas,
  type AtlasBridge,
  type AtlasIsland,
  type AtlasMonth,
  type AtlasResult,
  type AtlasSegmentExample,
} from "~/server/atlas-queries";

export const Route = createFileRoute("/atlas")({
  loader: async () => getAtlas(),
  component: AtlasPage,
});

function AtlasPage() {
  const data = Route.useLoaderData();
  const legend = legendCategories(data);

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">Semantic cartography</div>
        <PageTitleRow activePath="/atlas" />
        <p className="page-lede">
          A map of conversation neighborhoods from segment embeddings. Nearby regions are
          semantically similar; density tiles show where the thread spends time, islands
          name recurring topics, and bridge lines mark abrupt jumps across the map.
        </p>
        <MethodBadge
          meta={{
            kind: "heuristic",
            sample: data.overview.mapped_segments,
            version: `atlas-${String(data.overview.generated_at ?? "unknown").slice(0, 10)}`,
            caveats: [
              "Full-archive view; date and sender filters are not applied to the offline UMAP geometry.",
              "UMAP distances are local orientation cues, not calibrated semantic distances.",
            ],
          }}
          confidence="medium"
        />
      </div>

      <div className="stat-grid">
        <Stat label="Mapped segments" value={fmtInt(data.overview.mapped_segments)} note={`${fmtInt(data.overview.month_steps)} monthly centroids`} />
        <Stat label="Topic islands" value={fmtInt(data.overview.topic_islands)} note={`${fmtInt(data.overview.categories)} categories`} />
        <Stat label="Densest region" value={labelize(data.overview.densest_category)} note={`largest island: ${data.overview.largest_island}`} />
        <Stat label="Longest bridge" value={data.overview.longest_bridge} note="largest semantic jump between adjacent segments" />
      </div>

      <section className="section">
        <h2><span className="num">01</span> Conversation map</h2>
        <div className="panel atlas-map-panel">
          <div className="atlas-legend">
            {legend.map((category) => (
              <span key={category} className={`atlas-legend-pill ${categoryClass(category)}`}>{labelize(category)}</span>
            ))}
          </div>
          <div className="atlas-map-frame">
            <svg className="atlas-map" viewBox="0 0 1000 620" role="img" aria-label="Semantic map of conversation segments">
              <rect className="atlas-map-bg" x="0" y="0" width="1000" height="620" />
              {data.tiles.map((tile) => (
                <rect
                  key={tile.id}
                  className={`atlas-tile ${categoryClass(tile.category)}`}
                  x={tile.x}
                  y={tile.y}
                  width={tile.width}
                  height={tile.height}
                  opacity={Math.max(0.08, Math.min(0.78, tile.intensity * 0.82))}
                />
              ))}
              <polyline className="atlas-month-path" points={pathPoints(data.months)} />
              {data.bridges.slice(0, 10).map((bridge) => (
                <line
                  key={`${bridge.from_id}-${bridge.to_id}`}
                  className="atlas-bridge-line"
                  x1={bridge.from_x}
                  y1={bridge.from_y}
                  x2={bridge.to_x}
                  y2={bridge.to_y}
                />
              ))}
              {data.islands.map((island) => (
                <circle
                  key={island.topic_id}
                  className={`atlas-island ${categoryClass(island.category)}`}
                  cx={island.x}
                  cy={island.y}
                  r={island.radius}
                />
              ))}
              {data.attachment_density.map((density) => (
                <circle
                  key={`attachment-${density.segment_id}`}
                  className="atlas-attachment-density"
                  cx={density.x}
                  cy={density.y}
                  r={density.radius}
                />
              ))}
              {data.points.map((point) => (
                <circle
                  key={point.id}
                  className={`atlas-point ${categoryClass(point.category)}`}
                  cx={point.x}
                  cy={point.y}
                  r={point.radius}
                />
              ))}
              {monthTicks(data.months).map((month) => (
                <circle key={month.ym} className="atlas-month-dot" cx={month.x} cy={month.y} r="4" />
              ))}
              {data.islands.slice(0, 14).map((island) => (
                <text key={`label-${island.topic_id}`} className="atlas-label" x={island.x + island.radius * 0.35} y={island.y - island.radius * 0.2}>
                  {truncate(island.label, 22)}
                </text>
              ))}
            </svg>
          </div>
          <div className="hint atlas-map-note">
            Density is binned over {fmtInt(data.overview.mapped_segments)} UMAP-positioned segments.
            The line traces month-to-month semantic drift; circles are high-volume segments and
            topic neighborhoods. Gold rings mark local attachment-cluster density.
            UMAP distances are local orientation cues, not calibrated measurements; bridge scores
            should be read as prompts for inspection, not as precise semantic distance.
          </div>
        </div>
      </section>

      <section className="section">
        <h2><span className="num">02</span> Topic islands</h2>
        <div className="atlas-island-grid">
          {data.islands.map((island) => (
            <IslandCard key={island.topic_id} island={island} />
          ))}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">03</span> Semantic bridges</h2>
        <div className="atlas-bridge-grid">
          {data.bridges.map((bridge) => (
            <BridgeCard key={`${bridge.from_id}-${bridge.to_id}`} bridge={bridge} />
          ))}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">04</span> Map evidence</h2>
        <div className="atlas-example-grid">
          {data.examples.map((example) => (
            <ExampleCard key={example.id} example={example} />
          ))}
        </div>
      </section>

      <p className="hint turn-generated">
        Data generated {formatGeneratedAt(data.overview.generated_at)}. Method:
        precomputed segment embeddings and UMAP coordinates, density binning, topic centroids,
        category labels, adjacent-segment semantic distance, and representative message snippets.
      </p>
    </div>
  );
}

function IslandCard({ island }: { island: AtlasIsland }) {
  return (
    <article className={`panel atlas-island-card ${categoryClass(island.category)}`}>
      <div className="atlas-card-head">
        <div>
          <div className="turn-block-title">{island.label}</div>
          <p>{labelize(island.category)}</p>
        </div>
        <strong>{fmtInt(island.segments)}</strong>
      </div>
      <div className="atlas-metrics">
        <span>{fmtInt(island.messages)} msgs</span>
        <span>{formatPct(island.me_share)} Me</span>
        <span>{fmtDate(island.first_ts)} - {fmtDate(island.last_ts)}</span>
        <TopicStabilityBadge value={island.topic_stability} />
      </div>
      <div className="atlas-keywords">
        {island.keywords.map((keyword) => <span key={`${island.topic_id}-${keyword}`}>{keyword}</span>)}
      </div>
      {island.representative ? (
        <div className="atlas-representative">
          <strong>Representative segment</strong>
          <p>{island.representative.snippets[0]?.text ?? "No preview text"}</p>
          <EvidenceLink
            evidence={{
              label: "Open representative segment",
              from: bucket(island.representative.start_ts, "ymd"),
              to: bucket(island.representative.end_ts, "ymd"),
              note: island.label,
            }}
          />
        </div>
      ) : null}
    </article>
  );
}

function BridgeCard({ bridge }: { bridge: AtlasBridge }) {
  return (
    <article className="panel atlas-bridge-card">
      <div className="atlas-bridge-head">
        <div>
          <span>{labelize(bridge.from_category)}</span>
          <strong>{bridge.from_label}</strong>
        </div>
        <b>{bridge.semantic_distance.toFixed(0)}</b>
        <div>
          <span>{labelize(bridge.to_category)}</span>
          <strong>{bridge.to_label}</strong>
        </div>
      </div>
      <div className="atlas-metrics">
        <span>{fmtDuration(bridge.gap_seconds)} gap</span>
        <span>score {bridge.score.toFixed(0)}</span>
      </div>
      <div className="atlas-bridge-copy">
        <p>{bridge.from_preview || "No preview text"}</p>
        <p>{bridge.to_preview || "No preview text"}</p>
      </div>
    </article>
  );
}

function ExampleCard({ example }: { example: AtlasSegmentExample }) {
  return (
    <article className={`panel atlas-example-card ${categoryClass(example.category)}`}>
      <div className="atlas-card-head">
        <div>
          <span>{labelize(example.category)}</span>
          <div className="turn-block-title">{example.topic_label}</div>
        </div>
        <strong>{fmtInt(example.n_msgs)}</strong>
      </div>
      <div className="atlas-metrics">
        <span>{formatPct(example.me_share)} Me</span>
        <span>{fmtDate(example.start_ts, { withTime: true })}</span>
        <span>{fmtDuration(Math.max(0, example.end_ts - example.start_ts))}</span>
      </div>
      <div className="evidence-action-row">
        <EvidenceLink
          evidence={{
            label: "Open segment in Browse",
            from: bucket(example.start_ts, "ymd"),
            to: bucket(example.end_ts, "ymd"),
            note: example.topic_label,
          }}
        />
      </div>
      <div className="atlas-snippets">
        {example.snippets.map((snippet) => (
          <div key={`${example.id}-${snippet.ts}-${snippet.sender}-${snippet.text.slice(0, 24)}`}>
            <span>{snippet.sender} · {fmtDate(snippet.ts, { withTime: true })}</span>
            <p>{snippet.text}</p>
          </div>
        ))}
      </div>
    </article>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-note">{note}</div>
    </div>
  );
}

function legendCategories(data: AtlasResult) {
  const categories = new Map<string, number>();
  for (const tile of data.tiles) categories.set(tile.category, (categories.get(tile.category) ?? 0) + tile.count);
  const entries = Array.from(categories.entries());
  entries.sort((a, b) => b[1] - a[1]);
  return entries.slice(0, 10).map(([category]) => category);
}

function pathPoints(months: AtlasMonth[]) {
  return months.map((month) => `${month.x},${month.y}`).join(" ");
}

function monthTicks(months: AtlasMonth[]) {
  const ticks: AtlasMonth[] = [];
  for (let index = 0; index < months.length; index += 8) {
    ticks.push(months[index]);
  }
  return ticks;
}

function categoryClass(category: string) {
  return `cat-${category.replace(/[^a-z0-9_-]/gi, "-").toLowerCase()}`;
}

function labelize(value: string) {
  return value.replace(/_/g, " ");
}

function truncate(value: string, maxLength: number) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function formatPct(value: number) {
  return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
}

function formatGeneratedAt(value: string) {
  if (value === "unknown") return "unknown";
  return `${value.slice(0, 19).replace("T", " ")} UTC`;
}
