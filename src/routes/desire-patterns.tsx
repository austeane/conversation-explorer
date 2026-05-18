import { createFileRoute } from "@tanstack/react-router";
import { EvidenceLink } from "~/components/EvidenceLink";
import { MethodBadge } from "~/components/MethodBadge";
import { PageTitleRow } from "~/components/PageTitleRow";
import { bucket } from "~/lib/conversation/time";
import { fmtDate, fmtInt } from "~/lib/format";
import { globalSearchSchema } from "~/routes/_search";
import {
  getDesirePatterns,
  type DesireKinkMotif,
  type DesirePatternBucket,
  type DesireSnippet,
} from "~/server/desire-queries";

export const Route = createFileRoute("/desire-patterns")({
  validateSearch: (search) => globalSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => getDesirePatterns({ data: deps }),
  component: DesirePatternsPage,
});

function DesirePatternsPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const hasFilters = Boolean(search.from || search.to || search.phase != null || (search.sender && search.sender !== "both"));

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">Intimacy channel</div>
        <PageTitleRow activePath="/desire-patterns" />
        <p className="page-lede">
          A field guide to the forms of sexual texting in the archive: direct wanting, explicit talk,
          kink signals, visual play, teasing, and care around boundaries.
        </p>
        <MethodBadge
          meta={{
            kind: "heuristic",
            sample: data.overview.sexual_messages,
            version: "intimacy-patterns-v1",
            caveats: [
              "Types and motifs are lexical overlays on the message-level intimacy score.",
              "A single message can count in more than one type.",
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
        <Stat label="Sexual messages" value={fmtInt(data.overview.sexual_messages)} note={`${fmtInt(data.overview.sexual_sessions)} sessions`} />
        <Stat label="Active types" value={fmtInt(data.overview.active_buckets)} note="sexting modes detected" />
        <Stat label="Active motifs" value={fmtInt(data.overview.active_motifs)} note="kink and scene motifs" />
        <Stat label="Excerpts" value="visible" note="after passphrase login" />
      </div>

      <section className="section">
        <h2><span className="num">01</span> Types of sexting</h2>
        <div className="desire-pattern-grid">
          {data.buckets.map((item) => (
            <PatternCard key={item.key} item={item} />
          ))}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">02</span> Kink and scene motifs</h2>
        <div className="desire-pattern-grid motif-grid">
          {data.motifs.map((item) => (
            <MotifCard key={item.key} item={item} />
          ))}
        </div>
      </section>

      <p className="hint turn-generated">
        Generated {data.overview.generated_at.slice(0, 19).replace("T", " ")} UTC from{" "}
        <code>seg_message_intimacy_scores</code> and message text.
      </p>
    </div>
  );
}

function PatternCard({ item }: { item: DesirePatternBucket }) {
  return (
    <article className="desire-pattern-card">
      <div className="desire-pattern-head">
        <div>
          <div className="capsule-kicker">{formatPct(item.share)} of sexual messages</div>
          <h3>{item.label}</h3>
        </div>
        <strong>{fmtInt(item.sexual_messages)}</strong>
      </div>
      <p>{item.description}</p>
      <div className="desire-meter" aria-label={`${item.label} share ${formatPct(item.share)}`}>
        <span style={{ width: `${Math.max(2, item.share * 100)}%` }} />
      </div>
      <div className="desire-pattern-facts">
        <span>{fmtInt(item.sessions)} sessions</span>
        <span>Peak {item.peak_ym}</span>
        <span>Me {formatPct(item.me_share)}</span>
        <span>Avg score {item.average_score.toFixed(1)}</span>
      </div>
      <SnippetList snippets={item.examples} />
    </article>
  );
}

function MotifCard({ item }: { item: DesireKinkMotif }) {
  return (
    <article className="desire-pattern-card motif-card">
      <div className="desire-pattern-head">
        <div>
          <div className="capsule-kicker">{formatPct(item.share)} of sexual messages</div>
          <h3>{item.label}</h3>
        </div>
        <strong>{fmtInt(item.messages)}</strong>
      </div>
      <p>{item.description}</p>
      <div className="desire-pattern-facts">
        <span>{fmtInt(item.sessions)} sessions</span>
        <span>First {item.first_ym}</span>
        <span>Peak {item.peak_ym}</span>
        <span>Me {formatPct(item.me_share)}</span>
      </div>
      <SnippetList snippets={item.examples} />
    </article>
  );
}

function SnippetList({ snippets }: { snippets: DesireSnippet[] }) {
  if (!snippets.length) return null;
  return (
    <div className="capsule-excerpts compact-excerpts">
      {snippets.map((snippet) => (
        <SnippetLine key={snippet.msg_id} snippet={snippet} />
      ))}
    </div>
  );
}

function SnippetLine({ snippet }: { snippet: DesireSnippet }) {
  return (
    <div className={snippet.sender === "Me" ? "capsule-excerpt me" : "capsule-excerpt them"}>
      <div>
        <strong>{snippet.sender}</strong>
        <span>{fmtDate(snippet.ts, { withTime: true })}</span>
      </div>
      <p>{snippet.text}</p>
      <EvidenceLink
        evidence={{
          label: "Open day in Browse",
          date: bucket(snippet.ts, "ymd"),
          note: `score ${snippet.sexual_score.toFixed(1)}`,
        }}
      />
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

function formatPct(value: number) {
  return `${Math.round(value * 100)}%`;
}
