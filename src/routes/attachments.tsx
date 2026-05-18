import { createFileRoute } from "@tanstack/react-router";
import { PageTitleRow } from "~/components/PageTitleRow";
import { EvidenceLink } from "~/components/EvidenceLink";
import { MethodBadge } from "~/components/MethodBadge";
import { bucket } from "~/lib/conversation/time";
import { listAttachments } from "~/server/queries";
import { fmtBytes, fmtDate, fmtInt } from "~/lib/format";
import { globalSearchSchema } from "~/routes/_search";
import { useEffect, useState } from "react";

type SimilarAttachment = {
  id: number;
  message_id: number;
  thumb_path: string;
  total_bytes: number | null;
  ts: number;
  is_from_me: number;
  text: string | null;
};

type AttachmentRow = SimilarAttachment & {
  mime_type: string | null;
  filename: string | null;
  date_iso: string;
  segment_id: number | null;
  cluster_id: number | null;
  cluster_label: string | null;
  cluster_size: number | null;
  cluster_caption: string | null;
  similar_attachment_ids: string | null;
  embedding_method: string | null;
  similar: SimilarAttachment[];
};

type AttachmentCluster = {
  cluster_id: number;
  cluster_label: string;
  cluster_size: number;
  embedding_method: string;
};

type AttachmentSummary = {
  categories: Array<{ label: string; n: number; with_thumb: number }>;
  mime_types: Array<{
    label: string;
    n: number;
    total_bytes: number;
    me: number;
    them: number;
    with_thumb: number;
    images: number;
    videos: number;
  }>;
  top_months: Array<{ ym: string; n: number; images: number; videos: number; with_thumb: number }>;
  sender: { me: number; them: number };
};

export const Route = createFileRoute("/attachments")({
  validateSearch: (search) => globalSearchSchema.parse(search),
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) => listAttachments({ data: { ...deps, limit: 240, offset: 0 } }),
  component: AttachmentsPage,
});

function AttachmentsPage() {
  const initial = Route.useLoaderData();
  const search = Route.useSearch();
  const [rows, setRows] = useState(initial.rows);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState<AttachmentRow | null>(null);
  const [clusterFilter, setClusterFilter] = useState<number | null>(null);
  const hasFilters = Boolean(search.from || search.to || search.phase != null || (search.sender && search.sender !== "both"));

  useEffect(() => {
    setRows(initial.rows);
    setActive(null);
    setClusterFilter(null);
  }, [initial]);

  async function loadMore() {
    if (!canLoadMore) return;
    setLoading(true);
    const more = await listAttachments({ data: { ...search, limit: 240, offset: rows.length } });
    setRows((cur) => [...cur, ...more.rows]);
    setLoading(false);
  }

  const t = initial.total;
  const cloudOnly = (t.images ?? 0) - (t.with_thumb ?? 0);
  const clusters = initial.clusters as AttachmentCluster[];
  const summary = initial.summary as AttachmentSummary;
  const visibleRows = clusterFilter == null
    ? rows
    : rows.filter((row) => row.cluster_id === clusterFilter);
  const activeCluster = clusters.find((cluster) => cluster.cluster_id === clusterFilter);
  const canLoadMore = rows.length < (t.with_thumb ?? 0);

  return (
    <div>
      <div className="page-head">
        <div className="page-eyebrow">Photos &amp; media shared</div>
        <PageTitleRow activePath="/attachments" />
        <p className="page-lede">
          {fmtInt(t.images)} images, {fmtInt(t.videos)} videos, and {fmtInt(t.other ?? 0)} other files.{" "}
          {fmtInt(t.with_thumb)} have local thumbnails.
          {clusters.length ? ` ${fmtInt(clusters.length)} local visual clusters are available.` : ""}
        </p>
        <MethodBadge
          meta={{
            kind: "descriptive",
            sample: t.total ?? 0,
            version: "attachment-browser-v1",
            caveats: [
              "Only locally thumbnailed images can be visually clustered.",
              "iCloud-only attachments remain counted but not previewable.",
            ],
          }}
        />
        {hasFilters && (
          <p className="browse-filter-note">
            Filtered{search.from ? ` from ${search.from}` : ""}{search.to ? ` to ${search.to}` : ""}{search.phase != null ? `, phase ${search.phase}` : ""}{search.sender && search.sender !== "both" ? `, ${search.sender} only` : ""}.
          </p>
        )}
      </div>

      {cloudOnly > 0 && (
        <div className="panel attach-warning">
          <div className="hint attach-warning-label">HEADS UP</div>
          <div className="attach-warning-copy">
            <strong>{fmtInt(cloudOnly)}</strong> images are referenced in chat.db but their files are still in iCloud (Messages downloads attachments lazily). To pull
            them down, open the Messages app, scroll back through the conversation, and they'll fetch in the background. Then re-run <code>pnpm thumbs</code>.
          </div>
        </div>
      )}

      <AttachmentInsights summary={summary} total={t} />

      {clusters.length ? (
        <section className="panel attach-clusters" aria-label="Attachment clusters">
          <div>
            <div className="section-kicker">Local visual clusters</div>
            <p className="section-copy">
              Clusters are built from local thumbnail embeddings and coarse image descriptors. No attachment pixels leave this machine.
            </p>
          </div>
          <div className="attach-cluster-pills">
            <button
              className={`cluster-pill ${clusterFilter == null ? "active" : ""}`}
              type="button"
              onClick={() => setClusterFilter(null)}
            >
              All
              <span>{fmtInt(rows.length)}</span>
            </button>
            {clusters.map((cluster) => (
              <button
                key={cluster.cluster_id}
                className={`cluster-pill ${clusterFilter === cluster.cluster_id ? "active" : ""}`}
                type="button"
                onClick={() => setClusterFilter(cluster.cluster_id)}
              >
                {cluster.cluster_label}
                <span>{fmtInt(cluster.cluster_size)}</span>
              </button>
            ))}
          </div>
          {activeCluster ? (
            <div className="attach-cluster-note">
              Showing {fmtInt(visibleRows.length)} loaded images from {activeCluster.cluster_label}.
            </div>
          ) : null}
        </section>
      ) : null}

      {visibleRows.length ? (
        <div className="attach-grid">
          {visibleRows.map((r) => (
            <button
              key={r.id}
              type="button"
              className="attach-card"
              onClick={() => setActive(r)}
            >
              <img src={r.thumb_path} alt="" loading="lazy" />
              <div className="attach-meta">
                {fmtDate(r.ts)} · {r.is_from_me ? "you" : "her"}
                {r.cluster_label ? <span>{r.cluster_label}</span> : null}
              </div>
            </button>
          ))}
        </div>
      ) : (
        <div className="panel attach-empty">
          <div className="hint">
            {hasFilters ? "No local thumbnails match the current filters." : "No local thumbnails are available yet."}
          </div>
        </div>
      )}

      {canLoadMore ? (
        <div className="attach-load-more">
          <button className="btn" disabled={loading} onClick={loadMore}>{loading ? "…" : "Load more"}</button>
        </div>
      ) : null}

      {active && (
        <div className="attach-lightbox" role="dialog" aria-modal="true" aria-label="Attachment preview">
          <button
            type="button"
            className="attach-lightbox-backdrop"
            aria-label="Close attachment preview"
            onClick={() => setActive(null)}
          />
          <div className="attach-lightbox-inner">
            <button
              type="button"
              className="attach-lightbox-close"
              aria-label="Close attachment preview"
              onClick={() => setActive(null)}
            >
              Close
            </button>
            <img src={active.thumb_path} alt="" className="attach-lightbox-img" />
            <div className="attach-lightbox-meta">
              {fmtDate(active.ts, { withTime: true })} · {active.is_from_me ? "Me" : "Them"} · {fmtBytes(active.total_bytes)}
              {active.cluster_label ? <div>{active.cluster_label} · {active.cluster_caption}</div> : null}
              {active.segment_id ? <div>Segment #{active.segment_id}</div> : null}
              {active.text ? <div className="attach-lightbox-text">"{active.text}"</div> : null}
            </div>
            <div className="evidence-action-row">
              <EvidenceLink
                evidence={{
                  label: "Open attachment day in Browse",
                  date: bucket(active.ts, "ymd"),
                  sender: active.is_from_me ? "me" : "them",
                  note: active.cluster_label ?? "attachment context",
                }}
              />
            </div>
            {active.similar.length ? (
              <div className="attach-similar">
                <div className="attach-similar-title">Similar to this</div>
                <div className="attach-similar-grid">
                  {active.similar.map((similar) => (
                    <button
                      key={similar.id}
                      type="button"
                      className="attach-similar-card"
                      onClick={() => {
                        const full = rows.find((row) => row.id === similar.id);
                        if (full) setActive(full);
                      }}
                    >
                      <img src={similar.thumb_path} alt="" loading="lazy" />
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

function AttachmentInsights({ summary, total }: { summary: AttachmentSummary; total: Record<string, number> }) {
  const totalAttachments = total.total ?? 0;
  const senderTotal = summary.sender.me + summary.sender.them;
  return (
    <section className="attach-insights" aria-label="Attachment summary">
      <article className="panel attach-insight-card attach-total-card">
        <div>
          <div className="section-kicker">Archive shape</div>
          <p className="section-copy">
            {fmtInt(totalAttachments)} attachment rows, {fmtBytes(total.total_bytes ?? null)} referenced locally.
          </p>
        </div>
        <div className="attach-sender-bars" aria-label="Sender split">
          <div>
            <span>Me</span>
            <strong>{formatPct(summary.sender.me, senderTotal)}</strong>
            <i style={{ width: `${barPct(summary.sender.me, senderTotal)}%` }} />
          </div>
          <div>
            <span>Them</span>
            <strong>{formatPct(summary.sender.them, senderTotal)}</strong>
            <i style={{ width: `${barPct(summary.sender.them, senderTotal)}%` }} />
          </div>
        </div>
      </article>

      <InsightList
        title="Image contexts"
        subtitle="Top segment categories for image attachments."
        rows={summary.categories.map((row) => ({
          key: row.label,
          label: row.label,
          value: fmtInt(row.n),
          note: `${formatPct(row.n, total.images ?? 0)} of images · ${fmtInt(row.with_thumb)} thumbed`,
        }))}
      />

      <InsightList
        title="File types"
        subtitle="Mime mix, including non-image objects."
        rows={summary.mime_types.map((row) => ({
          key: row.label,
          label: row.label,
          value: fmtInt(row.n),
          note: `${fmtBytes(row.total_bytes)} · Me ${formatPct(row.me, row.n)}`,
        }))}
      />

      <InsightList
        title="Peak months"
        subtitle="Attachment-heavy months inside the current scope."
        rows={summary.top_months.map((row) => ({
          key: row.ym,
          label: row.ym,
          value: fmtInt(row.n),
          note: `${fmtInt(row.images)} images · ${fmtInt(row.videos)} videos · ${fmtInt(row.with_thumb)} thumbed`,
        }))}
      />
    </section>
  );
}

function InsightList({
  title,
  subtitle,
  rows,
}: {
  title: string;
  subtitle: string;
  rows: Array<{ key: string; label: string; value: string; note: string }>;
}) {
  return (
    <article className="panel attach-insight-card">
      <div>
        <div className="section-kicker">{title}</div>
        <p className="section-copy">{subtitle}</p>
      </div>
      <div className="attach-insight-list">
        {rows.length ? (
          rows.map((row) => (
            <div key={row.key} className="attach-insight-row">
              <span>{row.label}</span>
              <strong>{row.value}</strong>
              <small>{row.note}</small>
            </div>
          ))
        ) : (
          <p className="hint">No rows in this scope.</p>
        )}
      </div>
    </article>
  );
}

function formatPct(part: number, whole: number) {
  if (!whole) return "0%";
  return `${Math.round((part / whole) * 100)}%`;
}

function barPct(part: number, whole: number) {
  if (!whole) return 0;
  return Math.max(4, Math.round((part / whole) * 100));
}
