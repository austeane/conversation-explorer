import { Link, createFileRoute } from "@tanstack/react-router";
import { PageTitleRow } from "~/components/PageTitleRow";
import { MethodBadge } from "~/components/MethodBadge";
import { STATUS_GROUPS, categoryStatusLabel } from "~/lib/categories";
import { fmtInt } from "~/lib/format";
import { getMethodOverview } from "~/server/method-queries";
import { MODES, ROUTES, routesForMode } from "./_meta";

export const Route = createFileRoute("/methods")({
  loader: async () => getMethodOverview(),
  component: MethodsPage,
});

function MethodsPage() {
  const overview = Route.useLoaderData();
  const classifiedStatus = overview.category_status_available ? "available" : "legacy only";
  const evalLabels = overview.eval_labels;
  const topicStability = overview.topic_stability ?? {
    exists: false,
    topics: 0,
    mean: null,
    min: null,
    low_count: 0,
    method: null,
  };

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">Trust layer</div>
        <PageTitleRow activePath="/methods" />
        <p className="page-lede">
          A route-by-route map of what each surface can claim today, where the data comes from, and which planned trust gates are still missing.
        </p>
      </div>

      <div className="stat-grid">
        <Stat label="Last ETL" value={overview.generated_at ?? "unknown"} note="meta.generated_at" />
        <Stat label="Routes mapped" value={fmtInt(ROUTES.length)} note="single registry" />
        <Stat label="Segments" value={fmtInt(overview.segment_count)} note={`${fmtInt(overview.topic_outlier_count)} topic outliers`} />
        <Stat label="Phases" value={fmtInt(overview.phase_count)} note={overview.phase_method ?? "seg_seasons missing"} />
        <Stat label="Category status" value={classifiedStatus} note="planned taxonomy check" />
        <Stat
          label="Topic stability"
          value={topicStability.mean == null ? "missing" : topicStability.mean.toFixed(3)}
          note={topicStability.exists ? `${fmtInt(topicStability.low_count)} low-stability topics` : "seg_topic_stability missing"}
        />
        <Stat
          label="Eval report"
          value={overview.eval_report.overall ? overview.eval_report.overall.macro_f1.toFixed(3) : overview.eval_report.exists ? "present" : "missing"}
          note={
            overview.eval_report.summary
              ? `${overview.eval_report.summary}; ${fmtInt(evalLabels.current_total)} / ${fmtInt(evalLabels.target_total)} target rows`
              : "data/eval/report.json"
          }
        />
        <Stat label="Migration report" value={overview.migration_report.exists ? "present" : "missing"} note={overview.migration_report.summary ?? "data/migration/report*.json"} />
      </div>

      <section className="section">
        <h2>
          <span className="num">01</span>
          Method coverage
        </h2>
        <div className="method-route-groups">
          {MODES.map((mode) => (
            <section key={mode.id} className="method-route-group">
              <div>
                <h3>{mode.label}</h3>
                <p>{mode.description}</p>
              </div>
              <div className="method-route-list">
                {routesForMode(mode.id).map((route) => (
                  <Link key={route.path} to={route.path as any} className="method-route-row">
                    <span>
                      <strong>{route.label}</strong>
                      <small>{route.description}</small>
                    </span>
                    <MethodBadge meta={{ kind: route.method, version: "route-meta-v1" }} showConfidence={false} />
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>
      </section>

      <section className="section">
        <h2>
          <span className="num">02</span>
          Category health
        </h2>
        <div className="panel">
          <table className="kv-list">
            <tbody>
              {overview.category_status_counts.map((row) => (
                <tr key={row.status}>
                  <td>{categoryStatusLabel(row.status)}</td>
                  <td>{fmtInt(row.n)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!overview.category_status_available && (
            <p className="method-warning">
              The planned category-status taxonomy is not in this DB yet. Current category rows still use the legacy category/confidence shape.
            </p>
          )}
          {overview.category_status_available && (
            <p className="method-warning">
              {STATUS_GROUPS.topic_outlier.description}
            </p>
          )}
        </div>
      </section>

      <section className="section">
        <h2>
          <span className="num">03</span>
          Topic stability
        </h2>
        <div className="panel">
          {topicStability.exists ? (
            <table className="kv-list">
              <tbody>
                <tr>
                  <td>Topics scored</td>
                  <td>{fmtInt(topicStability.topics)}</td>
                </tr>
                <tr>
                  <td>Mean Jaccard</td>
                  <td>{topicStability.mean?.toFixed(3) ?? "n/a"}</td>
                </tr>
                <tr>
                  <td>Minimum Jaccard</td>
                  <td>{topicStability.min?.toFixed(3) ?? "n/a"}</td>
                </tr>
                <tr>
                  <td>Low-stability topics</td>
                  <td>{fmtInt(topicStability.low_count)}</td>
                </tr>
                <tr>
                  <td>Method</td>
                  <td>{topicStability.method ?? "unknown"}</td>
                </tr>
              </tbody>
            </table>
          ) : (
            <p className="method-empty-state">
              No topic-stability table is present. Run <code>pnpm topic:stability</code> to populate <code>seg_topic_stability</code>.
            </p>
          )}
        </div>
      </section>

      <section className="section">
        <h2>
          <span className="num">04</span>
          Eval report
        </h2>
        <div className="panel">
          {overview.eval_report.exists ? (
            <>
              <p className="method-report-summary">
                {overview.eval_report.summary}. Latest file: <code>{overview.eval_report.path}</code>.
              </p>
              <table className="method-delta-table">
                <thead>
                  <tr>
                    <th>Gold set</th>
                    <th>Rows</th>
                    <th>Target</th>
                    <th>Remaining</th>
                  </tr>
                </thead>
                <tbody>
                  {evalLabels.suites.map((suite) => (
                    <tr key={suite.name}>
                      <td>{suite.name}</td>
                      <td>{fmtInt(suite.current)}</td>
                      <td>{fmtInt(suite.target)}</td>
                      <td>{fmtInt(suite.remaining)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {evalLabels.current_total < evalLabels.target_total && (
                <p className="method-warning">
                  The eval score is useful as a regression signal, but the committed ID-only labels cover {fmtInt(evalLabels.current_total)} of the planned {fmtInt(evalLabels.target_total)} rows. Treat broad accuracy claims as provisional.
                </p>
              )}
              {overview.eval_report.suites.length > 0 ? (
                <table className="method-delta-table">
                  <thead>
                    <tr>
                      <th>Suite</th>
                      <th>Labels</th>
                      <th>Accuracy</th>
                      <th>Macro F1</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.eval_report.suites.map((suite) => (
                      <tr key={suite.name}>
                        <td>{suite.name}</td>
                        <td>{fmtInt(suite.total)}</td>
                        <td>{formatScore(suite.accuracy)}</td>
                        <td>{formatScore(suite.macro_f1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="method-empty-state">The eval report exists, but no suite rows were found.</p>
              )}
            </>
          ) : (
            <p className="method-empty-state">
              No eval report is present. Run <code>pnpm eval</code> to create the CI-safe fixture report.
            </p>
          )}
        </div>
      </section>

      <section className="section">
        <h2>
          <span className="num">05</span>
          Migration report
        </h2>
        <div className="panel">
          {overview.migration_report.exists ? (
            <>
              <p className="method-report-summary">
                {overview.migration_report.summary}. Latest file: <code>{overview.migration_report.path}</code>.
              </p>
              {overview.migration_report.top_deltas.length > 0 ? (
                <table className="method-delta-table">
                  <thead>
                    <tr>
                      <th>Metric</th>
                      <th>Old</th>
                      <th>New</th>
                      <th>Delta</th>
                      <th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.migration_report.top_deltas.map((row) => (
                      <tr key={row.key}>
                        <td>{row.label}</td>
                        <td>{formatMaybeNumber(row.old)}</td>
                        <td>{formatMaybeNumber(row.new)}</td>
                        <td>{row.delta_pct == null ? "n/a" : `${row.delta_pct.toFixed(1)}%`}</td>
                        <td>{row.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="method-empty-state">
                  {overview.migration_report.baseline_initialized
                    ? "No metric deltas yet. This report was seeded from the current DB, so future compare runs will show changes against this baseline."
                    : "No metric deltas in the latest compare run."}
                </p>
              )}
            </>
          ) : (
            <p className="method-empty-state">
              No migration report is present. Run <code>pnpm compare:before-after</code> to create <code>data/migration/report-latest.json</code>.
            </p>
          )}
        </div>
      </section>

      <section className="section">
        <h2>
          <span className="num">06</span>
          Current trust gaps
        </h2>
        <div className="method-gap-grid">
          <Gap title="Forecast calibration" body="Forecasts now use training-only thresholds, bootstrap AUC intervals, decile calibration bins, and a volume-only baseline comparison. The next gate is stronger model comparison against a larger labeled outcome set." />
          <Gap title="Counterfactual diagnostics" body="Matched analyses now show balance, control reuse, bootstrap intervals, and sender/era cuts. The remaining caveat is unobserved confounding." />
          <Gap title="Topic stability" body={topicStability.exists ? "Atlas, lifecycles, and constellations now surface bootstrap-centroid stability badges. Low-stability topics should not dominate insight claims." : "Topic stability badges are wired, but the DB table has not been generated yet."} />
          <Gap title="Labeled eval" body={overview.eval_report.exists ? "The CI-safe fixture eval exists. The next step is expanding the ID-only real archive labels and feeding false positives back into lexicon examples." : "Shared lexicons and negation handling exist, but they still need the planned labeled eval set and false-positive feedback loop."} />
          <Gap title="Migration deltas" body={overview.migration_report.exists ? "The report artifact exists; future migrations need a pre-change baseline to make the deltas meaningful." : "The UI has a place for migration reports, but no generated report is present yet."} />
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string | null }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value stat-value-compact">{value}</div>
      {note && <div className="stat-note">{note}</div>}
    </div>
  );
}

function formatMaybeNumber(value: number | null) {
  return value == null ? "n/a" : fmtInt(value);
}

function formatScore(value: number) {
  return value.toFixed(3);
}

function Gap({ title, body }: { title: string; body: string }) {
  return (
    <article className="method-gap">
      <h3>{title}</h3>
      <p>{body}</p>
    </article>
  );
}
