import { createFileRoute } from "@tanstack/react-router";
import { PageTitleRow } from "~/components/PageTitleRow";
import { EvidenceLink } from "~/components/EvidenceLink";
import { MethodBadge } from "~/components/MethodBadge";
import { fmtDate, fmtInt } from "~/lib/format";
import { globalSearchSchema } from "~/routes/_search";
import {
  getForecasts,
  type ForecastDriver,
  type ForecastExample,
  type ForecastCalibrationBin,
  type ForecastKey,
  type ForecastMonth,
  type ForecastTarget,
} from "~/server/forecast-queries";

export const Route = createFileRoute("/forecasts")({
  validateSearch: (search) => globalSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => getForecasts({ data: deps }),
  component: ForecastsPage,
});

const FORECAST_KEYS: ForecastKey[] = ["warm", "strain", "repair", "quiet", "surge"];

function ForecastsPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const hasFilters = Boolean(search.from || search.to || search.phase != null || (search.sender && search.sender !== "both"));
  const maxMonthValue = Math.max(
    ...data.months.flatMap((month) => FORECAST_KEYS.map((key) => month[key])),
    0.01,
  );

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">Time-split prediction</div>
        <PageTitleRow activePath="/forecasts" />
        <p className="page-lede">
          A small interpretable model asks what the last three days of volume,
          balance, warmth, strain, care, questions, planning, objects, and late-night
          activity tend to predict about the next 48 hours. It is a holdout-scored
          forecast, not a claim that the signals cause the outcome.
        </p>
        <MethodBadge
          meta={{
            kind: "predictive",
            sample: data.overview.holdout_windows,
            version: "forecast-logistic-v1",
            caveats: [
              "Chronological holdout evaluates later windows only.",
              "Lexicon features are approximate and autocorrelated across adjacent days.",
            ],
          }}
          confidence="medium"
        />
        {hasFilters && (
          <p className="browse-filter-note">
            Filtered{search.from ? ` from ${search.from}` : ""}{search.to ? ` to ${search.to}` : ""}{search.phase != null ? `, phase ${search.phase}` : ""}{search.sender && search.sender !== "both" ? `, ${search.sender} messages only` : ""}.
          </p>
        )}
      </div>

      <div className="stat-grid">
        <Stat label="Training windows" value={fmtInt(data.overview.training_windows)} note={`${fmtInt(data.overview.holdout_windows)} later holdout windows`} />
        <Stat label="Best holdout model" value={data.overview.best_forecast} note={`AUC ${data.overview.best_auc.toFixed(2)}`} />
        <Stat label="Current top" value={data.overview.current_top} note={`as of ${data.overview.current_ymd}`} />
        <Stat label="Strongest driver" value={data.overview.strongest_driver} note="largest standardized weight" />
      </div>

      <div className="forecast-threshold-strip" aria-label="Training-only outcome thresholds">
        {data.thresholds.map((threshold) => (
          <div key={threshold.label}>
            <span>{threshold.label}</span>
            <strong>{threshold.value}</strong>
          </div>
        ))}
      </div>

      <section className="section">
        <h2><span className="num">01</span> Current 48-hour forecast</h2>
        <div className="forecast-current-grid">
          {rankedTargets(data.targets).map((target) => (
            <CurrentCard key={target.key} target={target} />
          ))}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">02</span> Model scorecards</h2>
        <div className="forecast-model-grid">
          {data.targets.map((target) => (
            <ModelCard key={target.key} target={target} />
          ))}
        </div>
      </section>

      <section className="section">
        <h2><span className="num">03</span> Forecast pulse</h2>
        <div className="panel forecast-strip-panel">
          <div className="hint">
            Each column is a month. Bar height is the model's average probability for each
            outcome in windows ending that month.
          </div>
          <div className="forecast-strip-scroll">
            <div className="forecast-strip-frame">
              <div className="forecast-strip" style={{ gridTemplateColumns: `repeat(${data.months.length}, minmax(10px, 1fr))` }}>
                {data.months.map((month) => (
                  <ForecastMonthColumn key={month.ym} month={month} maxValue={maxMonthValue} />
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
        <h2><span className="num">04</span> Held-out receipts</h2>
        <div className="forecast-example-grid">
          {data.targets.flatMap((target) =>
            target.examples.slice(0, 3).map((example) => (
              <ExampleCard key={`${target.key}-${example.ymd}-${example.probability}`} target={target} example={example} />
            )),
          )}
        </div>
      </section>

      <p className="hint turn-generated">
        Generated {formatGeneratedAt(data.overview.generated_at)} from {fmtInt(data.overview.real_messages)} real
        messages. Method: daily three-day feature windows, next-48-hour labels, chronological
        train/holdout split, training-only outcome thresholds, standardized logistic regression
        with light L2 regularization, block-bootstrap AUC CI, volume-only baseline AUC, and
        top-quintile lift measured only on later windows.
      </p>
    </div>
  );
}

function CurrentCard({ target }: { target: ForecastTarget }) {
  return (
    <article className={`panel forecast-current-card ${target.key}`}>
      <div className="forecast-current-rank">#{target.current_rank}</div>
      <div className="turn-block-title">{target.label}</div>
      <div className="forecast-probability">{formatPct(target.current_probability)}</div>
      <div className="forecast-meter">
        <i style={{ width: `${Math.max(2, target.current_probability * 100)}%` }} />
      </div>
      <p>{target.description}</p>
    </article>
  );
}

function rankedTargets(targets: ForecastTarget[]) {
  return targets.slice().sort((a, b) => a.current_rank - b.current_rank);
}

function ModelCard({ target }: { target: ForecastTarget }) {
  const strongest = Math.max(...target.drivers.map((driver) => Math.abs(driver.weight)), 0.01);
  return (
    <article className={`panel forecast-model-card ${target.key}`}>
      <div className="forecast-model-head">
        <div>
          <div className="turn-block-title">{target.label}</div>
          <p>{target.positive_label} / CI {target.holdout_auc_ci.low.toFixed(2)}-{target.holdout_auc_ci.high.toFixed(2)}</p>
        </div>
        <div className="forecast-auc">{target.holdout_auc.toFixed(2)}</div>
      </div>
      <div className="forecast-model-metrics">
        <Metric label="baseline" value={formatPct(target.baseline_rate)} />
        <Metric label="base AUC" value={target.baseline_auc.toFixed(2)} />
        <Metric label="AUC delta" value={formatSigned(target.auc_delta)} />
        <Metric label="top lift" value={`${target.lift_top_quintile.toFixed(1)}x`} />
        <Metric label="positives" value={fmtInt(target.positives)} />
      </div>
      <CalibrationBins bins={target.calibration} />
      <div className="forecast-driver-list">
        {target.drivers.map((driver) => (
          <DriverRow key={`${target.key}-${driver.feature}`} driver={driver} strongest={strongest} />
        ))}
      </div>
    </article>
  );
}

function CalibrationBins({ bins }: { bins: ForecastCalibrationBin[] }) {
  if (bins.length === 0) return null;
  return (
    <div className="forecast-calibration" aria-label="Holdout calibration by probability bin">
      {bins.map((bin) => (
        <div
          key={bin.bin}
          className="forecast-calibration-bin"
          title={`${bin.range}: predicted ${formatPct(bin.predicted)}, observed ${formatPct(bin.observed)} (${bin.positives}/${bin.windows})`}
        >
          <span className="forecast-calibration-predicted" style={{ height: `${barHeight(bin.predicted, 1)}%` }} />
          <span className="forecast-calibration-observed" style={{ height: `${barHeight(bin.observed, 1)}%` }} />
        </div>
      ))}
    </div>
  );
}

function DriverRow({ driver, strongest }: { driver: ForecastDriver; strongest: number }) {
  return (
    <div className={`forecast-driver-row ${driver.direction}`}>
      <span>{driver.label}</span>
      <div><i style={{ width: `${Math.max(6, (Math.abs(driver.weight) / strongest) * 100)}%` }} /></div>
      <strong>{driver.direction === "raises" ? "up" : "down"} {driver.odds_multiplier.toFixed(1)}x</strong>
    </div>
  );
}

function ForecastMonthColumn({ month, maxValue }: { month: ForecastMonth; maxValue: number }) {
  return (
    <div className="forecast-month-column" title={`${month.ym}: warm ${formatPct(month.warm)}, strain ${formatPct(month.strain)}, repair ${formatPct(month.repair)}, quiet ${formatPct(month.quiet)}, surge ${formatPct(month.surge)}`}>
      {FORECAST_KEYS.map((key) => (
        <span
          key={`${month.ym}-${key}`}
          className={`forecast-month-bar ${key}`}
          style={{ height: `${barHeight(month[key], maxValue)}%` }}
        />
      ))}
    </div>
  );
}

function ExampleCard({ target, example }: { target: ForecastTarget; example: ForecastExample }) {
  return (
    <article className={`panel forecast-example-card ${target.key}`}>
      <div className="forecast-example-head">
        <div>
          <span>{target.label}</span>
          <strong>{example.ymd}</strong>
        </div>
        <div className={example.actual ? "forecast-hit" : "forecast-miss"}>
          {formatPct(example.probability)}
        </div>
      </div>
      <div className="forecast-example-meta">
        <span>{example.actual ? "hit" : "miss"}</span>
        <span>{example.future_summary}</span>
        <span>{fmtInt(example.prior_messages)}{" -> "}{fmtInt(example.future_messages)} msgs</span>
      </div>
      <div className="forecast-example-columns">
        <ExampleColumn title="Prior three days" examples={example.prior_examples} />
        <ExampleColumn title="Next 48h" examples={example.future_examples} />
      </div>
    </article>
  );
}

function ExampleColumn({ title, examples }: { title: string; examples: ForecastExample["prior_examples"] }) {
  return (
    <div className="forecast-example-column">
      <strong>{title}</strong>
      {examples.map((example) => (
        <div className="forecast-message" key={`${title}-${example.ts}-${example.sender}-${example.text.slice(0, 24)}`}>
          <span>{example.sender} · {fmtDate(example.ts, { withTime: true })}</span>
          <p>{example.text}</p>
          <EvidenceLink
            evidence={{
              label: "Browse message",
              date: example.ymd,
              sender: senderParam(example.sender),
              note: `${example.sender} receipt`,
            }}
          />
        </div>
      ))}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
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

function formatSigned(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

function barHeight(value: number, maxValue: number) {
  return value === 0 ? 2 : Math.max(8, (value / maxValue) * 100);
}

function senderParam(sender: "Me" | "Them") {
  return sender === "Me" ? "me" : "them";
}

function formatGeneratedAt(value: string) {
  if (value === "unknown") return "unknown";
  return `${value.slice(0, 19).replace("T", " ")} UTC`;
}
