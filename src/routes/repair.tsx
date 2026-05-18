import { createFileRoute } from "@tanstack/react-router";
import { PageTitleRow } from "~/components/PageTitleRow";
import { EvidenceLink } from "~/components/EvidenceLink";
import { MethodBadge } from "~/components/MethodBadge";
import { bucket } from "~/lib/conversation/time";
import { fmtDate, fmtDuration, fmtInt } from "~/lib/format";
import { globalSearchSchema } from "~/routes/_search";
import {
  getRepair,
  type MonthlyRepair,
  type RepairEpisode,
  type RepairMover,
} from "~/server/repair-queries";

export const Route = createFileRoute("/repair")({
  validateSearch: (search) => globalSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => getRepair({ data: deps }),
  component: RepairPage,
});

function RepairPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const hasFilters = Boolean(search.from || search.to || search.phase != null || (search.sender && search.sender !== "both"));
  const maxEpisodes = Math.max(...data.monthly.map((month) => month.episodes), 1);

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">Repair loops</div>
        <PageTitleRow activePath="/repair" />
        <p className="page-lede">
          Nearby strain messages are grouped into episodes, then followed for 24 hours to see
          whether the thread lands in repair, care, warmth, gratitude, humor, or no
          visible recovery inside the window.
        </p>
        <MethodBadge
          meta={{
            kind: "heuristic",
            sample: data.overview.strain_episodes,
            version: "repair-flow-lexicon-v1",
            caveats: [
              "Strain and repair are phrase-lexicon matches.",
              "A landing is visible supportive language within 24 hours, not proof of resolution.",
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
        <Stat label="Strain episodes" value={fmtInt(data.overview.strain_episodes)} note={`${fmtInt(data.overview.real_messages)} real messages`} />
        <Stat label="Affective landing" value={formatPct(data.overview.recovery_rate)} note={`${fmtInt(data.overview.recovered_within_24h)} within 24h`} />
        <Stat label="Fast landing" value={formatPct(data.overview.fast_recovery_rate)} note="within 6 hours" />
        <Stat label="Direct repair" value={formatPct(data.overview.direct_repair_rate)} note={`median ${fmtDuration(data.overview.median_recovery_seconds)}`} />
      </div>

      <section className="section">
        <h2><span className="num">01</span> Monthly repair rhythm</h2>
        <div className="panel">
          <div className="hint repair-note">
            Bar height is strain episode volume; red fill is the share with a 24-hour landing.
            Dark ticks mark direct repair language.
          </div>
          <div className="repair-strip-scroll">
            <div className="repair-strip-frame">
              <div className="repair-strip" style={{ gridTemplateColumns: `repeat(${data.monthly.length}, minmax(8px, 1fr))` }}>
                {data.monthly.map((month) => (
                  <RepairMonthColumn key={month.ym} month={month} maxEpisodes={maxEpisodes} />
                ))}
              </div>
              <div className="restart-axis">
                <span>{data.monthly[0]?.ym}</span>
                <span>{data.monthly[data.monthly.length - 1]?.ym}</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <h2><span className="num">02</span> First repair moves</h2>
        <div className="repair-mover-grid">
          {data.movers.map((mover) => (
            <MoverCard key={mover.sender} mover={mover} total={data.overview.recovered_within_24h} />
          ))}
        </div>
      </section>

      <EpisodeSection title="Fast mends" number="03" episodes={data.fast_loops} />
      <EpisodeSection title="Long arcs" number="04" episodes={data.long_loops} />
      <EpisodeSection title="Open after 24h" number="05" episodes={data.open_loops} />

      <p className="hint turn-generated">
        Generated {data.overview.generated_at.slice(0, 19).replace("T", " ")} UTC. Method:
        simple strain and recovery lexicons, 2-hour strain grouping, and a 24-hour recovery window.
      </p>
    </div>
  );
}

function RepairMonthColumn({ month, maxEpisodes }: { month: MonthlyRepair; maxEpisodes: number }) {
  const episodeHeight = Math.max(4, (month.episodes / maxEpisodes) * 100);
  const recoveryHeight = Math.max(2, month.recovery_rate * 100);
  const repairHeight = month.episodes ? Math.max(0, (month.direct_repairs / month.episodes) * 100) : 0;

  return (
    <div className="repair-column" title={`${month.ym}: ${month.episodes} episodes, ${formatPct(month.recovery_rate)} recovered`}>
      <div className="repair-volume" style={{ height: `${episodeHeight}%` }}>
        <div className="repair-recovered" style={{ height: `${recoveryHeight}%` }} />
      </div>
      <div className="repair-direct" style={{ height: `${repairHeight}%` }} />
    </div>
  );
}

function MoverCard({ mover, total }: { mover: RepairMover; total: number }) {
  return (
    <article className="panel repair-mover-card">
      <div className="repair-mover-head">
        <span>{mover.sender}</span>
        <strong>{formatPct(total ? mover.first_moves / total : 0)}</strong>
      </div>
      <div className="gravity-card-metrics">
        <span>{fmtInt(mover.first_moves)} first moves</span>
        <span>{fmtInt(mover.direct_repairs)} direct repairs</span>
        <span>{fmtInt(mover.care_or_warmth)} care/warmth</span>
        <span>{fmtInt(mover.humor_softenings)} humor</span>
      </div>
      <div className="repair-mover-meter">
        <div style={{ width: `${total ? (mover.first_moves / total) * 100 : 0}%` }} />
      </div>
      <p className="hint">Median first move: {mover.median_recovery_seconds == null ? "n/a" : fmtDuration(mover.median_recovery_seconds)}</p>
    </article>
  );
}

function EpisodeSection({ title, number, episodes }: { title: string; number: string; episodes: RepairEpisode[] }) {
  return (
    <section className="section">
      <h2><span className="num">{number}</span> {title}</h2>
      <div className="repair-episode-grid">
        {episodes.map((episode) => (
          <EpisodeCard key={`${number}-${episode.id}`} episode={episode} />
        ))}
      </div>
    </section>
  );
}

function EpisodeCard({ episode }: { episode: RepairEpisode }) {
  return (
    <article className="panel repair-episode-card">
      <div className="repair-episode-head">
        <div>
          <div className="turn-block-title">{fmtDate(episode.start_ts, { withTime: true })}</div>
          <div className="repair-kind">{episode.recovery_kind ? kindLabel(episode.recovery_kind) : "open loop"}</div>
        </div>
        <span>{episode.recovery_seconds == null ? "24h+" : fmtDuration(episode.recovery_seconds)}</span>
      </div>
      <div className="gravity-card-metrics">
        <span>{episode.strain_sender} strain</span>
        <span>{episode.strain_messages} strain msgs</span>
        {episode.recovery_sender && <span>{episode.recovery_sender} moved first</span>}
      </div>
      <div className="evidence-action-row">
        <EvidenceLink
          evidence={{
            label: "Open episode in Browse",
            from: bucket(episode.start_ts, "ymd"),
            to: bucket((episode.recovery_ts ?? episode.end_ts + 24 * 60 * 60), "ymd"),
            note: episode.recovery_kind ? kindLabel(episode.recovery_kind) : "24h window",
          }}
        />
      </div>
      <div className="repair-preview strain">
        <strong>strain</strong>
        <p>{episode.strain_preview}</p>
      </div>
      <div className="repair-preview recovery">
        <strong>{episode.recovery_kind ? "landing" : "next visible message"}</strong>
        <p>{episode.recovery_preview ?? episode.next_preview ?? "No visible recovery message inside the 24-hour window."}</p>
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

function formatPct(value: number) {
  return `${Math.round(value * 100)}%`;
}

function kindLabel(kind: string) {
  return kind.replace(/_/g, " ");
}
