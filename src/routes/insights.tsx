import { Link, createFileRoute } from "@tanstack/react-router";
import { PageTitleRow } from "~/components/PageTitleRow";
import { useState } from "react";
import { EvidenceDrawer } from "~/components/EvidenceDrawer";
import { EvidenceLink } from "~/components/EvidenceLink";
import type { EvidenceRef } from "~/components/EvidenceLink";
import { MethodBadge } from "~/components/MethodBadge";
import { globalSearchSchema } from "~/routes/_search";
import { getInsights, type InsightCard } from "~/server/insight-queries";

const FRAMING_LABELS = {
  changed: "What changed?",
  repeats: "What repeats?",
  helps: "What helps?",
  missed: "What gets missed?",
  discuss: "What should we discuss?",
} as const;

export const Route = createFileRoute("/insights")({
  validateSearch: (search) => globalSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => getInsights({ data: deps }),
  component: InsightsPage,
});

function InsightsPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const hasFilters = Boolean(search.from || search.to || search.phase != null || (search.sender && search.sender !== "both") || search.evidenceOnly);
  const [selectedEvidence, setSelectedEvidence] = useState<EvidenceRef | null>(null);
  const groups = (Object.keys(FRAMING_LABELS) as Array<InsightCard["framing"]>).map((framing) => ({
    framing,
    label: FRAMING_LABELS[framing],
    cards: data.cards.filter((card) => card.framing === framing),
  }));

  return (
    <div>
      <div className="page-head insights-head">
        <div className="page-eyebrow">Reflective overview</div>
        <PageTitleRow activePath="/insights" />
        <p className="page-lede">
          A first pass at the missing "so what" layer: each claim names its method, confidence, sample, and route back to evidence.
        </p>
        {hasFilters && (
          <p className="browse-filter-note">
            Cards filtered{search.from ? ` from ${search.from}` : ""}{search.to ? ` to ${search.to}` : ""}{search.phase != null ? `, phase ${search.phase}` : ""}{search.sender && search.sender !== "both" ? `, ${search.sender} only` : ""}{search.evidenceOnly ? ", evidence-backed only" : ""}.
          </p>
        )}
      </div>

      <div className="insight-framing-strip" aria-label="Insight sections">
        {groups.map((group) => (
          <a key={group.framing} href={`#${group.framing}`}>
            <span>{group.label}</span>
            <strong>{group.cards.length}</strong>
          </a>
        ))}
      </div>

      {groups.map((group, index) => (
        <section key={group.framing} id={group.framing} className="section">
          <h2>
            <span className="num">{String(index + 1).padStart(2, "0")}</span>
            {group.label}
          </h2>
          <div className="insight-card-grid">
            {group.cards.map((card) => (
              <InsightCardView key={`${card.framing}-${card.headline}`} card={card} onEvidenceSelect={setSelectedEvidence} />
            ))}
          </div>
        </section>
      ))}

      <p className="hint" style={{ marginTop: "2.5rem", textAlign: "center" }}>
        Insight feed generated {data.generated_at.slice(0, 19).replace("T", " ")} from messages through {data.last_ymd}.
      </p>
      <EvidenceDrawer evidence={selectedEvidence} onClose={() => setSelectedEvidence(null)} />
    </div>
  );
}

function InsightCardView({ card, onEvidenceSelect }: { card: InsightCard; onEvidenceSelect: (evidence: EvidenceRef) => void }) {
  return (
    <article className="insight-card">
      <div className="insight-card-topline">
        <MethodBadge meta={card.method} confidence={card.confidence} />
        {card.metric && <span className="insight-metric">{card.metric}</span>}
      </div>
      <h3>{card.headline}</h3>
      <p className="insight-subhead">{card.subhead}</p>
      <p>{card.body}</p>
      <div className="evidence-list" aria-label="Evidence links">
        {card.evidence.map((evidence) => (
          <EvidenceLink key={`${evidence.date}-${evidence.note}`} evidence={evidence} onSelect={onEvidenceSelect} />
        ))}
      </div>
      <Link to={card.sourceRoute as any} className="source-route-link">
        See the full route
      </Link>
    </article>
  );
}
