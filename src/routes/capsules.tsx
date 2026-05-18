import { createFileRoute } from "@tanstack/react-router";
import { PageTitleRow } from "~/components/PageTitleRow";
import { EvidenceLink } from "~/components/EvidenceLink";
import { MethodBadge } from "~/components/MethodBadge";
import { bucket } from "~/lib/conversation/time";
import { fmtDate, fmtDuration, fmtInt } from "~/lib/format";
import { globalSearchSchema } from "~/routes/_search";
import {
  getCapsules,
  type CapsuleCoverage,
  type CapsuleExcerpt,
  type MemoryCapsule,
} from "~/server/capsule-queries";

export const Route = createFileRoute("/capsules")({
  validateSearch: (search) => globalSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => getCapsules({ data: deps }),
  component: CapsulesPage,
});

function CapsulesPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const hasFilters = Boolean(search.from || search.to || search.phase != null || (search.sender && search.sender !== "both"));

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">Guided reading path</div>
        <PageTitleRow activePath="/capsules" />
        <p className="page-lede">
          A curated set of readable episodes selected from the segmented archive. Capsules favor
          sustained back-and-forth, semantic novelty, category variety, and coverage across the
          relationship timeline, then show enough excerpted texture to decide what to revisit.
        </p>
        <MethodBadge
          meta={{
            kind: "heuristic",
            sample: data.overview.segments_scored,
            version: "capsule-mmr-v1",
            caveats: [
              "Selection is an editorial scoring rule over segment metadata.",
              "Novelty uses UMAP neighborhood distance, not a semantic ground truth.",
            ],
          }}
        />
        {hasFilters && (
          <p className="browse-filter-note">
            Filtered{search.from ? ` from ${search.from}` : ""}{search.to ? ` to ${search.to}` : ""}{search.phase != null ? `, phase ${search.phase}` : ""}{search.sender && search.sender !== "both" ? `, ${search.sender} only` : ""}.
            Counts and scores stay segment-level; excerpts follow the active scope.
          </p>
        )}
      </div>

      <div className="stat-grid">
        <Stat label="Capsules" value={fmtInt(data.overview.capsules_selected)} note={`${fmtInt(data.overview.segments_scored)} segments scored`} />
        <Stat label="Months covered" value={fmtInt(data.overview.months_covered)} note="chronological reading path" />
        <Stat label="Categories" value={fmtInt(data.overview.categories_covered)} note={`top: ${data.overview.top_category}`} />
        <Stat label="Avg novelty" value={scoreLabel(data.overview.avg_novelty)} note="vs rolling local context" />
      </div>

      <section className="section">
        <h2><span className="num">01</span> Selection coverage</h2>
        <div className="panel">
          <div className="hint capsule-note">
            Selection uses a salience score plus diversity penalty, similar to maximal marginal
            relevance: high-value segments are chosen while avoiding too many near-duplicates by
            category, topic, month, or UMAP neighborhood.
          </div>
          <div className="capsule-coverage-grid">
            {data.coverage.map((coverage) => (
              <CoverageRow key={coverage.category} coverage={coverage} max={data.overview.capsules_selected} />
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <h2><span className="num">02</span> Reading path</h2>
        <div className="capsule-path">
          {data.capsules.map((capsule) => (
            <CapsuleCard key={capsule.id} capsule={capsule} sender={activeSender(search.sender)} />
          ))}
        </div>
      </section>

      <p className="hint turn-generated">
        Data generated {formatGeneratedAt(data.overview.generated_at)} from{" "}
        <code>seg_segments</code>, <code>seg_msg_segment</code>, <code>seg_topics</code>, and{" "}
        <code>messages</code>.
      </p>
    </div>
  );
}

function CoverageRow({ coverage, max }: { coverage: CapsuleCoverage; max: number }) {
  return (
    <div className="capsule-coverage-row">
      <div>
        <strong>{formatCategory(coverage.category)}</strong>
        <span>{fmtInt(coverage.count)} capsules · {fmtInt(coverage.messages)} messages</span>
      </div>
      <div className="capsule-coverage-track">
        <div style={{ width: `${Math.max(4, (coverage.count / Math.max(max, 1)) * 100)}%` }} />
      </div>
    </div>
  );
}

function CapsuleCard({ capsule, sender }: { capsule: MemoryCapsule; sender?: "me" | "them" }) {
  const meShare = capsule.n_msgs ? capsule.n_me / capsule.n_msgs : 0;
  return (
    <article className="panel capsule-card">
      <div className="capsule-index">
        <span>{String(capsule.rank).padStart(2, "0")}</span>
      </div>
      <div className="capsule-body">
        <div className="capsule-head">
          <div>
            <div className="capsule-kicker">{capsule.ym} · {formatCategory(capsule.category)}</div>
            <h3>{capsule.local_label}</h3>
            <div className="hint">
              {fmtDate(capsule.start_ts, { withTime: true })} · {fmtDuration(capsule.end_ts - capsule.start_ts)}
            </div>
          </div>
          <div className="capsule-score">
            {scoreLabel(capsule.score)}
            <span>score</span>
          </div>
        </div>

        <div className="evidence-action-row">
          <EvidenceLink
            evidence={{
              label: "Open capsule in Browse",
              from: bucket(capsule.start_ts, "ymd"),
              to: bucket(capsule.end_ts, "ymd"),
              sender,
              note: `${fmtInt(capsule.n_msgs)} messages in ${capsule.local_label}`,
            }}
          />
        </div>

        <div className="capsule-metrics">
          <span>{fmtInt(capsule.n_msgs)} messages</span>
          <span>fit {scoreLabel(capsule.category_confidence)}</span>
          <span>novelty {scoreLabel(capsule.novelty)}</span>
          <span>balance {scoreLabel(capsule.balance)}</span>
          <span>rarity {scoreLabel(capsule.rarity)}</span>
        </div>

        <div className="sender-split">
          <div className="sender-split-me" style={{ width: `${meShare * 100}%` }} />
        </div>
        <div className="ritual-card-meta">
          <span>Me {fmtInt(capsule.n_me)}</span>
          <span>Them {fmtInt(capsule.n_them)}</span>
          {capsule.secondary_category ? <span>also {formatCategory(capsule.secondary_category)}</span> : null}
          {capsule.topic_words.length ? <span>{capsule.topic_words.join(" / ")}</span> : null}
        </div>

        <div className="capsule-why">
          {capsule.why.map((reason) => (
            <span key={reason}>{reason}</span>
          ))}
        </div>

        <div className="capsule-excerpts">
          {capsule.excerpts.map((excerpt) => (
            <ExcerptLine key={excerpt.msg_id} excerpt={excerpt} />
          ))}
        </div>
      </div>
    </article>
  );
}

function ExcerptLine({ excerpt }: { excerpt: CapsuleExcerpt }) {
  return (
    <div className={excerpt.sender === "Me" ? "capsule-excerpt me" : "capsule-excerpt them"}>
      <div>
        <strong>{excerpt.sender}</strong>
        <span>{fmtDate(excerpt.ts, { withTime: true })}</span>
      </div>
      <p>{excerpt.text}</p>
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

function formatCategory(category: string) {
  return category.replace(/_/g, " ");
}

function scoreLabel(value: number) {
  return value.toFixed(2);
}

function activeSender(value: unknown) {
  return value === "me" || value === "them" ? value : undefined;
}

function formatGeneratedAt(value: string) {
  if (value === "unknown") return "unknown";
  return `${value.slice(0, 19).replace("T", " ")} UTC`;
}
