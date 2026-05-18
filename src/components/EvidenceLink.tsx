export type EvidenceRef = {
  label: string;
  date?: string;
  from?: string;
  to?: string;
  sender?: "me" | "them" | "both";
  q?: string;
  note?: string;
  ids?: number[];
};

export function evidenceHref(ref: EvidenceRef) {
  const params = new URLSearchParams();
  if (ref.date) params.set("date", ref.date);
  if (ref.from) params.set("from", ref.from);
  if (ref.to) params.set("to", ref.to);
  if (ref.sender && ref.sender !== "both") params.set("sender", ref.sender);
  if (ref.q) params.set("q", ref.q);
  const query = params.toString();
  return query ? `/browse?${query}` : "/browse";
}

export function EvidenceLink({ evidence, onSelect }: { evidence: EvidenceRef; onSelect?: (evidence: EvidenceRef) => void }) {
  if (onSelect) {
    return (
      <button className="evidence-link evidence-link-button" type="button" onClick={() => onSelect(evidence)}>
        <span>{evidence.label}</span>
        {evidence.note && <small>{evidence.note}</small>}
      </button>
    );
  }

  return (
    <a className="evidence-link" href={evidenceHref(evidence)}>
      <span>{evidence.label}</span>
      {evidence.note && <small>{evidence.note}</small>}
    </a>
  );
}
