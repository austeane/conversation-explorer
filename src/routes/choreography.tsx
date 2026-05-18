import { createFileRoute } from "@tanstack/react-router";
import { PageTitleRow } from "~/components/PageTitleRow";
import { EvidenceLink } from "~/components/EvidenceLink";
import { MethodBadge } from "~/components/MethodBadge";
import { fmtDate, fmtInt } from "~/lib/format";
import { globalSearchSchema } from "~/routes/_search";
import {
  getChoreography,
  type ChoreographyExample,
  type ChoreographyMonth,
  type ChoreographyPath,
  type ChoreographyPrediction,
  type ChoreographyStep,
  type ChoreographyTransition,
  type MoveKind,
} from "~/server/choreography-queries";

export const Route = createFileRoute("/choreography")({
  validateSearch: (search) => globalSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => getChoreography({ data: deps }),
  component: ChoreographyPage,
});

type DisplayMoveKind = Extract<MoveKind, "affection" | "care" | "question" | "logistics" | "play" | "repair" | "strain" | "status">;

const DISPLAY_KINDS: DisplayMoveKind[] = ["affection", "care", "question", "logistics", "play", "repair", "strain", "status"];

function ChoreographyPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const hasFilters = Boolean(search.from || search.to || search.phase != null || (search.sender && search.sender !== "both"));
  const maxMoveSlice = Math.max(...data.months.flatMap((month) => DISPLAY_KINDS.map((kind) => month[kind])), 1);

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">Sequence mining</div>
        <PageTitleRow activePath="/choreography" />
        <p className="page-lede">
          A move-by-move reading of the thread: each message becomes a conversational
          move, long silences split episodes, repeated moves collapse, and recurring
          three-step paths reveal the small choreographies you fall into together.
        </p>
        <MethodBadge
          meta={{
            kind: "heuristic",
            sample: data.overview.collapsed_moves,
            version: "choreography-sequences-v1",
            caveats: [
              "Move labels use the shared soft classifier with regex fallback.",
              "Sender filters keep duet episodes started by that sender.",
            ],
          }}
        />
        {hasFilters && (
          <p className="browse-filter-note">
            Filtered{search.from ? ` from ${search.from}` : ""}{search.to ? ` to ${search.to}` : ""}{search.phase != null ? `, phase ${search.phase}` : ""}{search.sender && search.sender !== "both" ? `, ${search.sender}-started episodes only` : ""}.
          </p>
        )}
      </div>

      <div className="stat-grid">
        <Stat label="Duet episodes" value={fmtInt(data.overview.duet_episodes)} note={`${fmtInt(data.overview.episodes)} usable episodes`} />
        <Stat label="Collapsed moves" value={fmtInt(data.overview.collapsed_moves)} note={`${fmtInt(data.overview.real_messages)} real messages`} />
        <Stat label="Recurring paths" value={fmtInt(data.overview.recurring_paths)} note="lifted three-move sequences" />
        <Stat label="Strongest path" value={data.overview.strongest_path} note={data.overview.top_transition} />
      </div>

      <section className="section">
        <h2><span className="num">01</span> Monthly movement score</h2>
        <div className="panel">
          <div className="hint choreography-note">
            Stacks show the mix of classified moves inside two-person episodes. The
            horizontal pin marks months where a high-scoring repeated path appears.
          </div>
          <div className="choreography-strip-scroll">
            <div className="choreography-strip-frame">
              <div className="choreography-strip" style={{ gridTemplateColumns: `repeat(${data.months.length}, minmax(9px, 1fr))` }}>
                {data.months.map((month) => (
                  <MonthColumn key={month.ym} month={month} maxMoveSlice={maxMoveSlice} />
                ))}
              </div>
              <div className="restart-axis">
                <span>{data.months[0]?.ym}</span>
                <span>{data.months[data.months.length - 1]?.ym}</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <h2><span className="num">02</span> Recurrent three-move paths</h2>
        <div className="choreography-path-grid">
          {data.paths.map((path) => (
            <PathCard key={path.key} path={path} />
          ))}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">03</span> Strong transitions</h2>
        <div className="choreography-transition-grid">
          {data.transitions.map((transition) => (
            <TransitionCard key={`${transition.from}-${transition.to}`} transition={transition} />
          ))}
        </div>
      </section>

      {data.predictions.length ? (
        <section className="section">
          <h2><span className="num">04</span> Next-move predictions</h2>
          <div className="hint choreography-note">
            A backoff sequence model looks at up to eight prior collapsed moves and
            asks which move historically came next from similar contexts.
          </div>
          <div className="choreography-prediction-grid">
            {data.predictions.map((prediction) => (
              <PredictionCard key={prediction.key} prediction={prediction} />
            ))}
          </div>
        </section>
      ) : null}

      <p className="hint turn-generated">
        Generated {formatGeneratedAt(data.overview.generated_at)} from {fmtInt(data.overview.real_messages)} real
        messages. Method: shared soft move classifier with regex fallback, two-hour
        episode gaps, consecutive same-sender move collapse, three-step sequence lift,
        transition lift against move base rates, and backoff next-move prediction.
      </p>
    </div>
  );
}

function MonthColumn({ month, maxMoveSlice }: { month: ChoreographyMonth; maxMoveSlice: number }) {
  const score = Math.max(0, Math.min(month.max_path_score, 18));
  return (
    <div className="choreography-column" title={`${month.ym}: ${month.moves} moves, ${month.episodes} episodes`}>
      <div className="choreography-stack">
        {DISPLAY_KINDS.map((kind) => (
          <span key={kind} className={`choreography-bar ${kind}`} style={{ height: `${barHeight(month[kind], maxMoveSlice)}%` }} />
        ))}
      </div>
      <span className="choreography-score-pin" style={{ bottom: `${Math.max(4, (score / 18) * 84)}%` }} />
    </div>
  );
}

function PathCard({ path }: { path: ChoreographyPath }) {
  return (
    <article className="panel choreography-path-card">
      <div className="choreography-card-head">
        <div className="choreography-steps">
          {keyedSteps(path.steps, path.key).map(({ key, step }) => (
            <StepPill key={key} step={step} />
          ))}
        </div>
        <div className="choreography-score">{path.score.toFixed(2)}</div>
      </div>
      <div className="choreography-metrics">
        <span>{fmtInt(path.count)} repeats</span>
        <span>{path.lift.toFixed(1)}x lift</span>
        <span>{fmtInt(path.episode_months)} months</span>
      </div>
      <div className="choreography-examples">
        {path.examples.slice(0, 1).map((examples) => (
          <ExampleSequence key={`${path.key}-example-${sequenceKey(examples)}`} examples={examples} />
        ))}
      </div>
    </article>
  );
}

function TransitionCard({ transition }: { transition: ChoreographyTransition }) {
  return (
    <article className="panel choreography-transition-card">
      <div className="choreography-transition-head">
        <StepToken kind={transition.from} label={transition.from_label} />
        <span className="choreography-arrow">-&gt;</span>
        <StepToken kind={transition.to} label={transition.to_label} />
      </div>
      <div className="choreography-metrics">
        <span>{fmtInt(transition.count)} transitions</span>
        <span>{transition.lift.toFixed(1)}x lift</span>
      </div>
      {transition.examples.slice(0, 1).map((examples) => (
        <ExampleSequence key={`${transition.from}-${transition.to}-${sequenceKey(examples)}`} examples={examples} compact />
      ))}
    </article>
  );
}

function PredictionCard({ prediction }: { prediction: ChoreographyPrediction }) {
  return (
    <article className="panel choreography-prediction-card">
      <div className="choreography-card-head">
        <div className="choreography-steps">
          {keyedSteps(prediction.context, `${prediction.key}-context`).map(({ key, step }) => (
            <StepPill key={key} step={step} />
          ))}
        </div>
        <div className="choreography-score">{fmtInt(prediction.support)}</div>
      </div>
      <div className="choreography-next-list">
        {prediction.next.map((option) => (
          <div className="choreography-next-row" key={`${prediction.key}-${option.kind}`}>
            <StepToken kind={option.kind} label={option.label} />
            <span>{Math.round(option.probability * 100)}%</span>
            <span>{option.lift.toFixed(1)}x</span>
          </div>
        ))}
      </div>
      {prediction.examples.slice(0, 1).map((examples) => (
        <ExampleSequence key={`${prediction.key}-prediction-${sequenceKey(examples)}`} examples={examples} compact />
      ))}
    </article>
  );
}

function StepPill({ step }: { step: ChoreographyStep }) {
  return (
    <div className={`choreography-step ${step.kind}`}>
      <span>{step.sender === "Me" ? "A" : "S"}</span>
      <strong>{step.label}</strong>
    </div>
  );
}

function StepToken({ kind, label }: { kind: MoveKind; label: string }) {
  return <span className={`choreography-token ${kind}`}>{label}</span>;
}

function ExampleSequence({ examples, compact = false }: { examples: ChoreographyExample[]; compact?: boolean }) {
  return (
    <div className={`choreography-sequence ${compact ? "compact" : ""}`}>
      {examples.map((example) => (
        <div className="choreography-example" key={exampleKey(example)}>
          <span>{example.sender} · {example.label} · {fmtDate(example.ts, { withTime: true })}</span>
          <p>{example.text}</p>
          <EvidenceLink
            evidence={{
              label: "Browse move",
              date: example.ymd,
              sender: senderParam(example.sender),
              note: example.label,
            }}
          />
        </div>
      ))}
    </div>
  );
}

function keyedSteps(steps: ChoreographyStep[], prefix: string) {
  const seen = new Map<string, number>();
  return steps.map((step) => {
    const base = `${prefix}-${step.sender}-${step.kind}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return { key: count ? `${base}-${count}` : base, step };
  });
}

function sequenceKey(examples: ChoreographyExample[]) {
  return examples.map(exampleKey).join(">");
}

function exampleKey(example: ChoreographyExample) {
  return `${example.ts}-${example.sender}-${example.kind}-${example.text.slice(0, 24)}`;
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

function barHeight(count: number, maxMoveSlice: number) {
  return count === 0 ? 0 : Math.max(5, (count / maxMoveSlice) * 100);
}

function senderParam(sender: ChoreographyExample["sender"]) {
  return sender === "Me" ? "me" as const : "them" as const;
}

function formatGeneratedAt(value: string) {
  return value.slice(0, 19).replace("T", " ");
}
