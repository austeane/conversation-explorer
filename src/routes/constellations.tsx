import { createFileRoute } from "@tanstack/react-router";
import { PageTitleRow } from "~/components/PageTitleRow";
import { EvidenceLink } from "~/components/EvidenceLink";
import { MethodBadge } from "~/components/MethodBadge";
import { TopicStabilityBadge } from "~/components/TopicStabilityBadge";
import { bucket } from "~/lib/conversation/time";
import { fmtDate, fmtDuration, fmtInt } from "~/lib/format";
import {
  getConstellations,
  type ConstellationCommunity,
  type ConstellationCorridor,
  type ConstellationEdge,
  type ConstellationNode,
  type ConstellationSnippet,
} from "~/server/constellation-queries";

export const Route = createFileRoute("/constellations")({
  loader: async () => getConstellations(),
  component: ConstellationsPage,
});

function ConstellationsPage() {
  const data = Route.useLoaderData();
  const labeledNodes = topRankedNodes(data.nodes, 18);
  const maxCommunityTopics = Math.max(...data.communities.map((community) => community.topics), 1);

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">Topic graph</div>
        <PageTitleRow activePath="/constellations" />
        <p className="page-lede">
          A directed network of subjects: which topics pull into which others, which clusters
          behave like neighborhoods, and which topics act as bridges between worlds.
        </p>
        <MethodBadge
          meta={{
            kind: "heuristic",
            sample: data.overview.corridors,
            version: `constellations-${String(data.overview.generated_at ?? "unknown").slice(0, 10)}`,
            caveats: [
              "Full-archive topic graph; date and sender filters would rebuild the transition network.",
              "HDBSCAN outlier segments are excluded from the topic graph.",
              "Some corridor weights are small, so treat lift as a navigation cue.",
            ],
          }}
          confidence="low"
        />
      </div>

      <div className="stat-grid">
        <Stat label="Topics" value={fmtInt(data.overview.topics)} note={`${fmtInt(data.overview.visible_topics)} drawn`} />
        <Stat label="Corridors" value={fmtInt(data.overview.corridors)} note="visible directed transitions" />
        <Stat label="Central topic" value={data.overview.central_topic} note="PageRank over topic transitions" />
        <Stat label="Bridge topic" value={data.overview.bridge_topic} note="cross-community broker score" />
      </div>

      <section className="section">
        <h2><span className="num">01</span> Topic constellation</h2>
        <div className="panel constellation-map-panel">
          <div className="constellation-legend">
            {data.communities.map((community) => (
              <span key={community.id} className={`constellation-community-${community.id % 9}`}>
                {community.label}
              </span>
            ))}
          </div>
          <div className="constellation-map-frame">
            <svg viewBox="0 0 1000 660" className="constellation-map" role="img" aria-label="Topic transition network">
              <rect x="0" y="0" width="1000" height="660" className="constellation-map-bg" />
              {data.edges.map((edge) => (
                <EdgeLine key={edge.id} edge={edge} />
              ))}
              {data.nodes.map((node) => (
                <circle
                  key={node.topic_id}
                  className={`constellation-node constellation-community-${node.community % 9}`}
                  cx={node.x}
                  cy={node.y}
                  r={node.radius}
                  aria-label={`${node.label}: ${fmtInt(node.segments)} segments, PageRank ${formatDecimal(node.pagerank)}`}
                />
              ))}
              {labeledNodes.map((node) => (
                <text key={`label-${node.topic_id}`} className="constellation-label" x={node.x + node.radius + 4} y={node.y + 4}>
                  {shortLabel(node.label)}
                </text>
              ))}
            </svg>
          </div>
          <p className="hint constellation-map-note">
            Nodes are BERTopic subjects. Edges are adjacent segment transitions, scored by count
            and transition lift over the destination topic&apos;s base rate. Layout starts from UMAP
            centroids, then gently relaxes toward the graph.
          </p>
        </div>
      </section>

      <section className="section">
        <h2><span className="num">02</span> Communities</h2>
        <div className="constellation-community-grid">
          {data.communities.map((community) => (
            <CommunityCard key={community.id} community={community} maxTopics={maxCommunityTopics} />
          ))}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">03</span> Strong corridors</h2>
        <div className="constellation-corridor-grid">
          {data.corridors.map((corridor) => (
            <CorridorCard key={corridor.edge.id} corridor={corridor} />
          ))}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">04</span> Bridge topics</h2>
        <div className="constellation-broker-grid">
          {data.brokers.map((node) => (
            <BrokerCard key={node.topic_id} node={node} />
          ))}
        </div>
      </section>

      <p className="hint turn-generated">
        Generated {data.overview.generated_at.slice(0, 19).replace("T", " ")} UTC. Method:
        directed weighted topic-transition graph from `seg_links`, transition lift, PageRank,
        deterministic label propagation communities, cross-community broker score, and
        representative linked-segment snippets.
      </p>
    </div>
  );
}

function EdgeLine({ edge }: { edge: ConstellationEdge }) {
  const width = Math.min(4.8, 0.65 + Math.log1p(edge.weight) * 0.52);
  const opacity = Math.min(0.72, 0.16 + Math.log1p(edge.weight) * 0.08);
  return (
    <line
      className={edge.community_jump ? "constellation-edge jump" : "constellation-edge"}
      x1={edge.from_x}
      y1={edge.from_y}
      x2={edge.to_x}
      y2={edge.to_y}
      strokeWidth={width}
      opacity={opacity}
    />
  );
}

function CommunityCard({ community, maxTopics }: { community: ConstellationCommunity; maxTopics: number }) {
  const externalShare = community.external_weight / Math.max(1, community.internal_weight + community.external_weight);
  return (
    <article className={`panel constellation-community-card constellation-community-${community.id % 9}`}>
      <div className="constellation-card-head">
        <div>
          <div className="turn-block-title">{community.label}</div>
          <p>{community.dominant_category}</p>
        </div>
        <strong>{fmtInt(community.topics)}</strong>
      </div>
      <div className="constellation-community-meter">
        <i style={{ width: `${Math.max(3, (community.topics / maxTopics) * 100)}%` }} />
      </div>
      <div className="constellation-mini-meta">
        <span>{fmtInt(community.segments)} segments</span>
        <span>{fmtInt(community.messages)} messages</span>
        <span>{formatPct(externalShare)} outward</span>
      </div>
      <div className="constellation-topic-list">
        {community.top_nodes.map((node) => (
          <TopicMini key={node.topic_id} node={node} />
        ))}
      </div>
    </article>
  );
}

function CorridorCard({ corridor }: { corridor: ConstellationCorridor }) {
  const edge = corridor.edge;
  return (
    <article className={`panel constellation-corridor-card ${edge.community_jump ? "jump" : ""}`}>
      <div className="constellation-corridor-head">
        <div>
          <span>{edge.community_jump ? "community jump" : "local corridor"}</span>
          <strong>{edge.from_label}</strong>
        </div>
        <b>{edge.weight}</b>
        <div>
          <span>lands in</span>
          <strong>{edge.to_label}</strong>
        </div>
      </div>
      <div className="constellation-mini-meta">
        <span>{edge.lift.toFixed(2)}x lift</span>
        <span>{fmtDuration(edge.median_gap_seconds)} median</span>
        <span>{fmtDuration(corridor.sample_gap_seconds)} sample gap</span>
      </div>
      <div className="constellation-corridor-copy">
        <SnippetBlock label="source" snippets={corridor.from_snippets} />
        <SnippetBlock label="landing" snippets={corridor.to_snippets} />
      </div>
    </article>
  );
}

function BrokerCard({ node }: { node: ConstellationNode }) {
  return (
    <article className={`panel constellation-broker-card constellation-community-${node.community % 9}`}>
      <div className="constellation-card-head">
        <div>
          <div className="turn-block-title">{node.label}</div>
          <p>{node.category}</p>
        </div>
        <strong>{node.broker_score.toFixed(1)}</strong>
      </div>
      <TopicMetrics node={node} />
      <KeywordList node={node} />
      <SnippetBlock label="evidence" snippets={node.snippets} />
    </article>
  );
}

function TopicMini({ node }: { node: ConstellationNode }) {
  return (
    <div className="constellation-topic-mini">
      <div>
        <strong>{node.label}</strong>
        <span>{node.category}</span>
      </div>
      <TopicMetrics node={node} compact />
      <KeywordList node={node} />
    </div>
  );
}

function TopicMetrics({ node, compact = false }: { node: ConstellationNode; compact?: boolean }) {
  return (
    <div className={compact ? "constellation-metrics compact" : "constellation-metrics"}>
      <div><span>segments</span><strong>{fmtInt(node.segments)}</strong></div>
      <div><span>months</span><strong>{node.active_months}</strong></div>
      <div><span>rank</span><strong>{formatDecimal(node.pagerank)}</strong></div>
      <div><span>broker</span><strong>{node.broker_score.toFixed(1)}</strong></div>
      <div><span>Me</span><strong>{formatPct(node.me_share)}</strong></div>
      <div><span>stability</span><strong><TopicStabilityBadge value={node.topic_stability} /></strong></div>
    </div>
  );
}

function KeywordList({ node }: { node: ConstellationNode }) {
  return (
    <div className="constellation-keywords">
      {node.keywords.slice(0, 5).map((keyword) => (
        <span key={`${node.topic_id}-${keyword}`}>{keyword}</span>
      ))}
    </div>
  );
}

function SnippetBlock({ label, snippets }: { label: string; snippets: ConstellationSnippet[] }) {
  return (
    <div className="constellation-snippets">
      <strong>{label}</strong>
      {snippets.map((snippet) => (
        <div key={`${snippet.ts}-${snippet.text}`}>
          <span>{snippet.sender} · {fmtDate(snippet.ts, { withTime: true })}</span>
          <p>{snippet.text}</p>
          <EvidenceLink
            evidence={{
              label: "Open day in Browse",
              date: bucket(snippet.ts, "ymd"),
              note: `${label} constellation evidence`,
            }}
          />
        </div>
      ))}
    </div>
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

function shortLabel(value: string) {
  return value.length > 28 ? `${value.slice(0, 25)}...` : value;
}

function topRankedNodes(nodes: ConstellationNode[], limit: number) {
  const top: ConstellationNode[] = [];
  for (const node of nodes) {
    const score = node.pagerank * 100 + node.broker_score;
    const insertAt = top.findIndex((candidate) => score > candidate.pagerank * 100 + candidate.broker_score);
    if (insertAt === -1) top.push(node);
    else top.splice(insertAt, 0, node);
    if (top.length > limit) top.pop();
  }
  return top;
}

function formatPct(value: number) {
  return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
}

function formatDecimal(value: number) {
  return value.toFixed(value < 0.01 ? 3 : 2);
}
