import { createFileRoute } from "@tanstack/react-router";
import { PageTitleRow } from "~/components/PageTitleRow";
import { EvidenceLink } from "~/components/EvidenceLink";
import { MethodBadge } from "~/components/MethodBadge";
import { fmtDate, fmtDuration, fmtInt } from "~/lib/format";
import { globalSearchSchema } from "~/routes/_search";
import {
  getCounterfactuals,
  type CounterfactualBreakdown,
  type CounterfactualDiagnostic,
  type CounterfactualEffect,
  type CounterfactualExample,
  type CounterfactualProfile,
} from "~/server/counterfactual-queries";

export const Route = createFileRoute("/counterfactuals")({
  validateSearch: (search) => globalSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => getCounterfactuals({ data: deps }),
  component: CounterfactualsPage,
});

function CounterfactualsPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const hasFilters = Boolean(search.from || search.to || search.phase != null || (search.sender && search.sender !== "both"));

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">Matched observational analysis</div>
        <PageTitleRow activePath="/counterfactuals" />
        <p className="page-lede">
          First messages after 6+ hours of silence, compared with similar reopeners from the
          same sender, silence length, era, prior tone, and opener size. This does not claim
          causality; it asks what tended to happen next when the opener took a different shape.
        </p>
        <MethodBadge
          meta={{
            kind: "observational",
            sample: data.overview.matched_attempts,
            version: "counterfactual-reopeners-v1",
            caveats: [
              "Matched controls are nearest neighbors, not randomized controls.",
              "Sender filters apply to silence-breaking openers and same-sender controls.",
            ],
          }}
          confidence="medium"
        />
        {hasFilters && (
          <p className="browse-filter-note">
            Filtered{search.from ? ` from ${search.from}` : ""}{search.to ? ` to ${search.to}` : ""}{search.phase != null ? `, phase ${search.phase}` : ""}{search.sender && search.sender !== "both" ? `, ${search.sender} openers only` : ""}.
          </p>
        )}
      </div>

      <div className="stat-grid">
        <Stat label="Restart attempts" value={fmtInt(data.overview.attempts)} note="after 6h+ silence" />
        <Stat label="Matched attempts" value={fmtInt(data.overview.matched_attempts)} note={`${fmtInt(data.overview.matched_controls)} controls`} />
        <Stat label="Unique controls" value={fmtInt(data.overview.unique_controls)} note={`${fmtInt(data.overview.reused_controls)} reused matches`} />
        <Stat label="Worst balance" value={data.overview.weakest_balance_feature} note={`max SMD ${data.overview.max_abs_smd.toFixed(2)}`} />
        <Stat label="Strongest lift" value={data.overview.strongest_lift} note={formatDelta(data.overview.strongest_lift_delta)} />
        <Stat label="Watchout" value={data.overview.strongest_watchout} note={formatDelta(data.overview.strongest_watchout_delta)} />
      </div>

      <section className="section">
        <h2><span className="num">01</span> Lifted outcomes</h2>
        <div className="counter-effect-grid">
          {data.effects.map((effect) => (
            <EffectCard key={effect.key} effect={effect} />
          ))}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">02</span> Opener profiles</h2>
        <div className="counter-profile-grid">
          {data.profiles.map((profile) => (
            <ProfileCard key={profile.kind} profile={profile} />
          ))}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">03</span> Match diagnostics</h2>
        <div className="panel counter-diagnostic-panel">
          <table className="kv-list counter-diagnostic-table">
            <thead>
              <tr>
                <th>Opener</th>
                <th>Quality</th>
                <th>Worst balance</th>
                <th>Attempts</th>
                <th>Controls</th>
                <th>Reuse</th>
              </tr>
            </thead>
            <tbody>
              {data.diagnostics.map((diagnostic) => (
                <DiagnosticRow key={diagnostic.kind} diagnostic={diagnostic} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section">
        <h2><span className="num">04</span> Matched evidence pairs</h2>
        <div className="counter-example-grid">
          {data.effects.slice(0, 6).flatMap((effect) =>
            effect.examples.slice(0, 1).map((example) => (
              <ExamplePair key={`${effect.key}-${example.id}`} effect={effect} example={example} />
            )),
          )}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">05</span> Watchouts</h2>
        <div className="counter-risk-grid">
          {data.risks.map((effect) => (
            <EffectCard key={effect.key} effect={effect} risk />
          ))}
        </div>
      </section>

      <p className="hint turn-generated">
        Generated {formatGeneratedAt(data.overview.generated_at)} from {fmtInt(data.overview.real_messages)} real
        messages. Method: first post-silence opener, regex opener taxonomy, exact sender and
        silence-bucket matching where possible, nearest-neighbor controls over era, daypart,
        prior 30-day tone, attachment status, and opener word count. Effects use paired
        treated-vs-control deltas with deterministic bootstrap intervals and must clear zero
        on the interval before being surfaced.
      </p>
    </div>
  );
}

function EffectCard({ effect, risk = false }: { effect: CounterfactualEffect; risk?: boolean }) {
  return (
    <article className={risk ? "panel counter-effect-card risk" : "panel counter-effect-card"}>
      <div className="counter-effect-head">
        <div>
          <div className="turn-block-title">{effect.kind_label}</div>
          <p>{effect.outcome_label}</p>
        </div>
        <div className={risk ? "counter-delta risk" : "counter-delta"}>{formatDelta(effect.delta)}</div>
      </div>
      <p className="counter-description">{effect.description}</p>
      <div className="counter-bars">
        <RateBar label="Observed" value={effect.observed_rate} />
        <RateBar label="Matched" value={effect.matched_rate} muted />
      </div>
      <div className="counter-meta">
        <span>{fmtInt(effect.treated)} attempts</span>
        <span>{fmtInt(effect.controls)} controls</span>
        <span>CI {formatDelta(effect.ci_low)} to {formatDelta(effect.ci_high)}</span>
        <span>SMD {effect.max_abs_smd.toFixed(2)}</span>
        <QualityBadge quality={effect.match_quality} />
        <span>{formatMessageDelta(effect.avg_messages_delta)}</span>
      </div>
      <BreakdownGrid breakdowns={effect.breakdowns} />
    </article>
  );
}

function BreakdownGrid({ breakdowns }: { breakdowns: CounterfactualBreakdown[] }) {
  if (breakdowns.length === 0) return null;
  return (
    <div className="counter-breakdown-grid">
      {breakdowns.map((breakdown) => (
        <div key={`${breakdown.group}-${breakdown.label}`}>
          <span>{breakdown.label}</span>
          <strong>{formatDelta(breakdown.delta)}</strong>
          <small>
            {formatPct(breakdown.observed_rate)} / {formatPct(breakdown.matched_rate)} · {fmtInt(breakdown.treated)}
          </small>
        </div>
      ))}
    </div>
  );
}

function ProfileCard({ profile }: { profile: CounterfactualProfile }) {
  return (
    <article className="panel counter-profile-card">
      <div className="counter-effect-head">
        <div>
          <div className="turn-block-title">{profile.label}</div>
          <p>{fmtInt(profile.attempts)} attempts · {fmtInt(profile.matched_controls)} controls</p>
        </div>
        <div className="counter-delta">{formatDelta(profile.best_delta)}</div>
      </div>
      <p className="counter-description">{profile.description}</p>
      <div className="counter-mini-matrix">
        <ProfileMetric label="Reply" observed={profile.reply_rate} matched={profile.matched_reply_rate} />
        <ProfileMetric label="Live" observed={profile.live_rate} matched={profile.matched_live_rate} />
        <ProfileMetric label="Warm" observed={profile.warm_rate} matched={profile.matched_warm_rate} />
        <ProfileMetric label="Quiet" observed={profile.quiet_rate} matched={profile.matched_quiet_rate} inverted />
      </div>
      <div className="counter-meta">
        <span>best: {profile.best_outcome}</span>
        <span>{fmtInt(profile.unique_controls)} unique controls</span>
        <span>SMD {profile.max_abs_smd.toFixed(2)}</span>
        <QualityBadge quality={profile.match_quality} />
      </div>
    </article>
  );
}

function DiagnosticRow({ diagnostic }: { diagnostic: CounterfactualDiagnostic }) {
  return (
    <tr>
      <td>{diagnostic.label}</td>
      <td><QualityBadge quality={diagnostic.quality} /></td>
      <td>{diagnostic.worst_feature} · SMD {diagnostic.max_abs_smd.toFixed(2)}</td>
      <td>{fmtInt(diagnostic.attempts)}</td>
      <td>{fmtInt(diagnostic.unique_controls)} / {fmtInt(diagnostic.controls)}</td>
      <td>{fmtInt(diagnostic.reused_controls)} reused · max {fmtInt(diagnostic.max_control_reuse)}x</td>
    </tr>
  );
}

function QualityBadge({ quality }: { quality: "good" | "watch" | "weak" }) {
  return <span className={`counter-quality ${quality}`}>{quality}</span>;
}

function ExamplePair({ effect, example }: { effect: CounterfactualEffect; example: CounterfactualExample }) {
  return (
    <article className="panel counter-example-card">
      <div className="counter-example-label">
        <span>{effect.kind_label}{" -> "}{effect.outcome_label}</span>
        <strong>{formatDelta(effect.delta)}</strong>
      </div>
      <div className="counter-pair">
        <div>
          <strong>{example.sender} · {fmtDate(example.ts, { withTime: true })}</strong>
          <p>{example.preview}</p>
          <EvidenceLink
            evidence={{
              label: "Browse opener",
              date: example.ymd,
              sender: senderParam(example.sender),
              note: example.kind_label,
            }}
          />
          <span>{fmtInt(example.messages_24h)} msgs next day · reply {formatDuration(example.reply_seconds)}</span>
        </div>
        <div>
          <strong>Matched {example.matched_kind_label} · {fmtDate(example.matched_ts, { withTime: true })}</strong>
          <p>{example.matched_preview}</p>
          <EvidenceLink
            evidence={{
              label: "Browse matched",
              date: example.matched_ymd,
              sender: senderParam(example.sender),
              note: example.matched_kind_label,
            }}
          />
          <span>{fmtInt(example.matched_messages_24h)} msgs next day · reply {formatDuration(example.matched_reply_seconds)}</span>
        </div>
      </div>
    </article>
  );
}

function RateBar({ label, value, muted = false }: { label: string; value: number; muted?: boolean }) {
  return (
    <div className={muted ? "counter-rate muted" : "counter-rate"}>
      <span>{label}</span>
      <div><i style={{ width: `${Math.max(3, value * 100)}%` }} /></div>
      <strong>{formatPct(value)}</strong>
    </div>
  );
}

function ProfileMetric({ label, observed, matched, inverted = false }: { label: string; observed: number; matched: number; inverted?: boolean }) {
  const delta = inverted ? matched - observed : observed - matched;
  return (
    <div className="counter-profile-metric">
      <span>{label}</span>
      <strong>{formatPct(observed)}</strong>
      <small>{formatDelta(delta)}</small>
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

function formatDelta(value: number) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${Math.round(value * 100)}pt`;
}

function formatMessageDelta(value: number) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)} msgs`;
}

function formatDuration(value: number | null) {
  return value == null ? "n/a" : fmtDuration(value);
}

function senderParam(sender: "Me" | "Them") {
  return sender === "Me" ? "me" : "them";
}

function formatGeneratedAt(value: string) {
  if (value === "unknown") return "unknown";
  return `${value.slice(0, 19).replace("T", " ")} UTC`;
}
