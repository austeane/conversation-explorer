import { createFileRoute } from "@tanstack/react-router";
import { PageTitleRow } from "~/components/PageTitleRow";
import { EvidenceLink } from "~/components/EvidenceLink";
import { MethodBadge } from "~/components/MethodBadge";
import { bucket } from "~/lib/conversation/time";
import { fmtDate, fmtDuration, fmtInt } from "~/lib/format";
import {
  getGravity,
  type GravityCategory,
  type GravityExample,
  type GravityTransition,
} from "~/server/gravity-queries";

export const Route = createFileRoute("/gravity")({
  loader: async () => getGravity(),
  component: GravityPage,
});

function GravityPage() {
  const data = Route.useLoaderData();

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">Conversation gravity</div>
        <PageTitleRow activePath="/gravity" />
        <p className="page-lede">
          A segment-level map of subject ownership: who starts each category, who supplies more
          of its messages, which fields stay mutual, and how topic changes get handed from one
          person to the other.
        </p>
        <MethodBadge
          meta={{
            kind: "heuristic",
            sample: data.overview.segments,
            version: `gravity-${String(data.overview.generated_at ?? "unknown").slice(0, 10)}`,
            caveats: [
              "Full-archive segment-category view; date filters would change category baselines.",
              "Gravity score weights category starts more than within-segment message share.",
              "Small categories can move sharply from a handful of segment starts.",
            ],
          }}
          confidence="medium"
        />
      </div>

      <div className="stat-grid">
        <Stat label="Segments mapped" value={fmtInt(data.overview.segments)} note={`${fmtInt(data.overview.messages)} real messages`} />
        <Stat label="Me starts" value={formatPct(data.overview.me_start_share)} note={`${formatPct(data.overview.me_message_share)} of messages`} />
        <Stat label="Shared segments" value={formatPct(data.overview.shared_segment_share)} note="both people contribute" />
        <Stat label="Me pull" value={label(data.overview.strongest_me_pull)} note={`Them: ${label(data.overview.strongest_them_pull)}`} />
      </div>

      <section className="section">
        <h2><span className="num">01</span> Gravity wells</h2>
        <div className="gravity-pull-grid">
          <PullList title="Me pulls toward" categories={data.me_pulls} side="me" />
          <PullList title="Them pulls toward" categories={data.them_pulls} side="them" />
        </div>
      </section>

      <section className="section">
        <h2><span className="num">02</span> Category pull map</h2>
        <div className="gravity-grid">
          {data.categories.map((category) => (
            <GravityCard key={category.category} category={category} />
          ))}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">03</span> Subject handoffs</h2>
        <div className="gravity-transition-grid">
          {data.transitions.map((transition) => (
            <TransitionCard
              key={`${transition.from_category}-${transition.to_category}-${transition.starter}`}
              transition={transition}
            />
          ))}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">04</span> Field notes</h2>
        <div className="gravity-example-grid">
          {data.categories
            .filter((category) => category.examples.length > 0)
            .slice(0, 8)
            .map((category) => (
              <div key={`examples-${category.category}`} className="panel gravity-examples">
                <div className="gravity-example-head">
                  <span>{label(category.category)}</span>
                  <strong>{category.role}</strong>
                </div>
                {category.examples.map((example) => (
                  <ExampleLine key={example.segment_id} example={example} />
                ))}
              </div>
            ))}
        </div>
      </section>

      <p className="hint turn-generated">
        Generated {data.overview.generated_at.slice(0, 19).replace("T", " ")} UTC from segment
        categories and linked real messages. Gravity score weights who starts a category more than
        who writes the larger share inside it.
      </p>
    </div>
  );
}

function PullList({ title, categories, side }: { title: string; categories: GravityCategory[]; side: "me" | "them" }) {
  return (
    <div className="panel gravity-pull-list">
      <div className={`gravity-pull-title ${side}`}>{title}</div>
      {categories.map((category) => (
        <div key={`${side}-${category.category}`} className="gravity-pull-row">
          <div>
            <strong>{label(category.category)}</strong>
            <span>{fmtInt(category.segments)} segments</span>
          </div>
          <b>{pullPoints(category.gravity_score, side)}</b>
        </div>
      ))}
    </div>
  );
}

function GravityCard({ category }: { category: GravityCategory }) {
  return (
    <article className="panel gravity-card">
      <div className="gravity-card-head">
        <div>
          <div className="turn-block-title">{label(category.category)}</div>
          <div className="gravity-role">{category.role}</div>
        </div>
        <div className={`gravity-score ${category.gravity_score >= 0 ? "me" : "them"}`}>
          {signedPoints(category.gravity_score)}
        </div>
      </div>
      <div className="gravity-card-metrics">
        <span>{fmtInt(category.segments)} segments</span>
        <span>{fmtInt(category.messages)} messages</span>
        <span>{formatPct(category.mutual_share)} mutual</span>
      </div>
      <Meter label="Me starts" value={category.me_start_share} />
      <Meter label="Me messages" value={category.me_message_share} />
      <div className="gravity-lifts">
        <span>start lift {signedPoints(category.start_lift)}</span>
        <span>message lift {signedPoints(category.message_lift)}</span>
      </div>
    </article>
  );
}

function Meter({ label: labelText, value }: { label: string; value: number }) {
  return (
    <div className="gravity-meter-row">
      <span>{labelText}</span>
      <div className="gravity-meter">
        <div className="gravity-meter-fill" style={{ width: `${Math.max(2, value * 100)}%` }} />
      </div>
      <strong>{formatPct(value)}</strong>
    </div>
  );
}

function TransitionCard({ transition }: { transition: GravityTransition }) {
  return (
    <article className="panel gravity-transition">
      <div className="gravity-transition-path">
        <span>{label(transition.from_category)}</span>
        <b>-&gt;</b>
        <span>{label(transition.to_category)}</span>
      </div>
      <div className="gravity-card-metrics">
        <span>{transition.starter} starts</span>
        <span>{fmtInt(transition.n)} handoffs</span>
        <span>avg gap {fmtDuration(transition.avg_gap_seconds)}</span>
      </div>
      <div className="gravity-transition-example">
        <span>{fmtDate(transition.example_start_ts, { withTime: true })}</span>
        <p>{transition.example_preview}</p>
        <EvidenceLink
          evidence={{
            label: "Open example day",
            date: bucket(transition.example_start_ts, "ymd"),
            note: `${label(transition.from_category)} to ${label(transition.to_category)}`,
          }}
        />
      </div>
    </article>
  );
}

function ExampleLine({ example }: { example: GravityExample }) {
  return (
    <div className="gravity-example">
      <div>
        <span>{example.starter} started · {fmtDate(example.start_ts, { withTime: true })}</span>
        <span>{example.n_messages} msgs · {example.me_messages} Me / {example.them_messages} Them</span>
      </div>
      {example.topic_label && <strong>{example.topic_label}</strong>}
      <p>{example.preview}</p>
      <EvidenceLink
        evidence={{
          label: "Open segment day",
          date: bucket(example.start_ts, "ymd"),
          note: `${example.starter} started this field note`,
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

function label(value: string) {
  return value.replace(/_/g, " ");
}

function formatPct(value: number) {
  return `${Math.round(value * 100)}%`;
}

function signedPoints(value: number) {
  const points = value * 100;
  const sign = points > 0 ? "+" : "";
  return `${sign}${points.toFixed(Math.abs(points) < 10 ? 1 : 0)} pts`;
}

function pullPoints(value: number, side: "me" | "them") {
  const points = side === "them" ? Math.abs(value * 100) : value * 100;
  const sign = side === "me" && points > 0 ? "+" : "";
  return `${sign}${points.toFixed(Math.abs(points) < 10 ? 1 : 0)} pts`;
}
