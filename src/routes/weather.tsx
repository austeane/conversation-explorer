import { createFileRoute } from "@tanstack/react-router";
import { PageTitleRow } from "~/components/PageTitleRow";
import { EvidenceLink } from "~/components/EvidenceLink";
import { MethodBadge } from "~/components/MethodBadge";
import { bucket } from "~/lib/conversation/time";
import { fmtDate, fmtInt } from "~/lib/format";
import { globalSearchSchema } from "~/routes/_search";
import {
  getWeather,
  type MonthlyWeather,
  type WeatherExample,
  type WeatherMonth,
} from "~/server/weather-queries";

type WeatherKind = "warmth" | "strain" | "repair" | "gratitude" | "care" | "humor";

export const Route = createFileRoute("/weather")({
  validateSearch: (search) => globalSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => getWeather({ data: deps }),
  component: WeatherPage,
});

function WeatherPage() {
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const hasFilters = Boolean(search.from || search.to || search.phase != null || (search.sender && search.sender !== "both"));
  const maxWarmth = Math.max(...data.monthly.map((m) => m.warmth_rate), 1);
  const maxStrain = Math.max(...data.monthly.map((m) => m.strain_rate), 1);

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">Affective climate</div>
        <PageTitleRow activePath="/weather" />
        <p className="page-lede">
          A lexicon-based emotional weather map: warmth, strain, repair, gratitude, care,
          and humor by month. It also estimates how often strain is followed within six hours
          by a supportive reply from the other person.
        </p>
        <MethodBadge
          meta={{
            kind: "heuristic",
            sample: data.overview.real_messages,
            version: "lexicon-1.0.0",
            caveats: ["Lexicon matches are approximate and context-sensitive."],
          }}
        />
        {hasFilters && (
          <p className="browse-filter-note">
            Filtered{search.from ? ` from ${search.from}` : ""}{search.to ? ` to ${search.to}` : ""}{search.phase != null ? `, phase ${search.phase}` : ""}{search.sender && search.sender !== "both" ? `, ${search.sender} only` : ""}.
          </p>
        )}
      </div>

      <div className="stat-grid">
        <Stat label="Affect messages" value={fmtInt(data.overview.affect_messages)} note={`${fmtInt(data.overview.real_messages)} real messages`} />
        <Stat label="Support after strain" value={formatPct(data.overview.support_rate)} note="within 6 hours" />
        <Stat label="Warmest month" value={data.overview.warmest_month} note="highest warmth rate" />
        <Stat label="Stormiest month" value={data.overview.stormiest_month} note="highest strain rate" />
      </div>

      <section className="section">
        <h2><span className="num">01</span> Monthly climate strip</h2>
        <div className="panel">
          <div className="hint weather-note">
            Each month shows warmth above the midline and strain below it, both normalized per
            100 messages. Darker repair ticks mark months where apology/repair language is frequent.
          </div>
          <div className="weather-strip-scroll">
            <div className="weather-strip-frame">
              <div className="weather-strip" style={{ gridTemplateColumns: `repeat(${data.monthly.length}, minmax(7px, 1fr))` }}>
                {data.monthly.map((month) => (
                  <WeatherColumn key={month.ym} month={month} maxWarmth={maxWarmth} maxStrain={maxStrain} />
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
        <h2><span className="num">02</span> Warm fronts</h2>
        <MonthGrid months={data.warm_months} kind="warmth" />
      </section>

      <section className="section">
        <h2><span className="num">03</span> Storm systems</h2>
        <MonthGrid months={data.storm_months} kind="strain" />
      </section>

      <section className="section">
        <h2><span className="num">04</span> Repair weather</h2>
        <MonthGrid months={data.repair_months} kind="repair" />
      </section>

      <section className="section">
        <h2><span className="num">05</span> Gratitude fronts</h2>
        <MonthGrid months={data.gratitude_months} kind="gratitude" />
      </section>

      <section className="section">
        <h2><span className="num">06</span> Care signals</h2>
        <MonthGrid months={data.care_months} kind="care" />
      </section>

      <section className="section">
        <h2><span className="num">07</span> Humor lift</h2>
        <MonthGrid months={data.humor_months} kind="humor" />
      </section>

      <p className="hint turn-generated">
        Data generated {formatGeneratedAt(data.overview.generated_at)} from real
        messages. Method: simple phrase lexicons, rates per 100 messages, and next-other-person
        support detection within six hours.
      </p>
    </div>
  );
}

function WeatherColumn({ month, maxWarmth, maxStrain }: { month: MonthlyWeather; maxWarmth: number; maxStrain: number }) {
  const warmHeight = Math.max(2, (month.warmth_rate / maxWarmth) * 44);
  const strainHeight = Math.max(2, (month.strain_rate / maxStrain) * 44);
  const repairHeight = Math.min(100, Math.max(0, month.repair_rate * 8));
  return (
    <div className="weather-column" title={`${month.ym}: warmth ${month.warmth_rate.toFixed(1)}, strain ${month.strain_rate.toFixed(1)}, repair ${month.repair_rate.toFixed(1)} per 100`}>
      <div className="weather-warm" style={{ height: `${warmHeight}%` }} />
      <div className="weather-midline" />
      <div className="weather-strain" style={{ height: `${strainHeight}%` }} />
      <div className="weather-repair" style={{ height: `${repairHeight}%` }} />
    </div>
  );
}

function MonthGrid({ months, kind }: { months: WeatherMonth[]; kind: WeatherKind }) {
  return (
    <div className="weather-month-grid">
      {months.map((month) => (
        <WeatherMonthCard key={`${kind}-${month.ym}`} month={month} kind={kind} />
      ))}
    </div>
  );
}

function WeatherMonthCard({ month, kind }: { month: WeatherMonth; kind: WeatherKind }) {
  const rate = rateFor(month, kind);
  return (
    <article className="panel weather-month-card">
      <div className="weather-card-head">
        <div>
          <div className="turn-block-title">{month.ym}</div>
          <div className="weather-rate">{rate.toFixed(1)}</div>
        </div>
        <div className={`weather-token ${kind}`}>{kind}</div>
      </div>
      <div className="weather-card-metrics">
        <span>{fmtInt(month.total)} messages</span>
        <span>warmth {month.warmth_rate.toFixed(1)}</span>
        <span>strain {month.strain_rate.toFixed(1)}</span>
        <span>repair {month.repair_rate.toFixed(1)}</span>
        <span>gratitude {month.gratitude_rate.toFixed(1)}</span>
        <span>care {month.care_rate.toFixed(1)}</span>
        <span>humor {month.humor_rate.toFixed(1)}</span>
        <span>support {month.support_rate == null ? "n/a" : formatPct(month.support_rate)}</span>
      </div>
      <div className="weather-examples">
        {month.examples.map((example) => (
          <WeatherExampleLine key={`${month.ym}-${example.ts}-${example.kind}`} example={example} />
        ))}
      </div>
    </article>
  );
}

function rateFor(month: WeatherMonth, kind: WeatherKind) {
  if (kind === "warmth") return month.warmth_rate;
  if (kind === "strain") return month.strain_rate;
  if (kind === "repair") return month.repair_rate;
  if (kind === "gratitude") return month.gratitude_rate;
  if (kind === "care") return month.care_rate;
  return month.humor_rate;
}

function WeatherExampleLine({ example }: { example: WeatherExample }) {
  return (
    <div className="weather-example">
      <span>{example.sender} · {fmtDate(example.ts, { withTime: true })}</span>
      <p>{example.text}</p>
      <EvidenceLink
        evidence={{
          label: "Open day in Browse",
          date: bucket(example.ts, "ymd"),
          note: example.kind,
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
  return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
}

function formatGeneratedAt(value: string) {
  if (value === "unknown") return "unknown";
  return `${value.slice(0, 19).replace("T", " ")} UTC`;
}
