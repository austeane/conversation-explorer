import { useLocation } from "@tanstack/react-router";
import type { FormEvent } from "react";
import type { PhaseOption } from "~/lib/conversation/phases";
import { senderLabel, useRuntimeIdentity } from "~/lib/conversation/runtime-identity";

const EMPTY_PHASES: PhaseOption[] = [];

export function GlobalFilters({ phases = EMPTY_PHASES }: { phases?: PhaseOption[] }) {
  const location = useLocation();
  const identity = useRuntimeIdentity();
  const search = location.search as Record<string, unknown>;
  const sender = senderValue(search.sender);
  const phase = stringValue(search.phase);
  const showInsightToggles = location.pathname === "/insights";
  const showSensitiveToggle = showInsightToggles;
  const showSenderFilter = location.pathname !== "/vocabulary" && location.pathname !== "/entrainment";

  if (location.pathname.startsWith("/auth")) return null;
  if (!supportsGlobalFilters(location.pathname)) return null;

  return (
    <form key={location.href} className="global-filters" action={location.pathname} method="get" onSubmit={applyFilters}>
      <label>
        <span>From</span>
        <input name="from" type="date" defaultValue={stringValue(search.from)} />
      </label>
      <label>
        <span>To</span>
        <input name="to" type="date" defaultValue={stringValue(search.to)} />
      </label>
      {showSenderFilter && (
        <label>
          <span>Sender</span>
          <select name="sender" defaultValue={sender}>
            <option value="both">Both</option>
            <option value="me">{senderLabel(identity, "me")}</option>
            <option value="them">{senderLabel(identity, "them")}</option>
          </select>
        </label>
      )}
      {phases.length > 0 && (
        <label>
          <span>Phase</span>
          <select name="phase" defaultValue={phase}>
            <option value="">Whole archive</option>
            {phases.map((item) => (
              <option key={item.id} value={item.id} data-from={item.from} data-to={item.to}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {showSensitiveToggle && (
        <label className="global-filter-check">
          <input name="sensitive" type="checkbox" value="1" defaultChecked={isChecked(search.sensitive)} />
          <span>Include sensitive</span>
        </label>
      )}
      {showInsightToggles && (
        <>
          <label className="global-filter-check">
            <input name="evidenceOnly" type="checkbox" value="1" defaultChecked={isChecked(search.evidenceOnly)} />
            <span>Evidence only</span>
          </label>
        </>
      )}
      <div className="global-filter-actions">
        <button type="submit">Apply</button>
        <a href={location.pathname}>Reset</a>
      </div>
    </form>
  );
}

function supportsGlobalFilters(pathname: string) {
  return (
    pathname === "/" ||
    pathname === "/insights" ||
    pathname === "/browse" ||
    pathname === "/attachments" ||
    pathname === "/capsules" ||
    pathname === "/weather" ||
    pathname === "/repair" ||
    pathname === "/forecasts" ||
    pathname === "/omens" ||
    pathname === "/ignition" ||
    pathname === "/counterfactuals" ||
    pathname === "/open-loops" ||
    pathname === "/rituals" ||
    pathname === "/dynamics" ||
    pathname === "/bids" ||
    pathname === "/gestures" ||
    pathname === "/resonance" ||
    pathname === "/mirrors" ||
    pathname === "/information" ||
    pathname === "/choreography" ||
    pathname === "/turning-points" ||
    pathname === "/outliers" ||
    pathname === "/vocabulary" ||
    pathname === "/entrainment" ||
    pathname === "/echoes" ||
    pathname === "/attractors" ||
    pathname === "/arcs" ||
    pathname === "/rhythms" ||
    pathname === "/desire" ||
    pathname === "/desire-patterns" ||
    pathname === "/desire-evolution" ||
    pathname === "/desire-sessions"
  );
}

function stringValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" ? value : "";
}

function senderValue(value: unknown) {
  return value === "me" || value === "them" || value === "both" ? value : "both";
}

function isChecked(value: unknown) {
  return value === true || value === "1" || value === "true";
}

function applyFilters(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const next = new URLSearchParams();

  for (const key of ["from", "to", "sender", "sensitive", "evidenceOnly"]) {
    const value = data.get(key);
    if (!value || value === "both") continue;
    next.set(key, String(value));
  }

  const phaseSelect = form.elements.namedItem("phase");
  if (phaseSelect instanceof HTMLSelectElement && phaseSelect.value) {
    const selected = phaseSelect.selectedOptions[0];
    next.set("phase", phaseSelect.value);
    if (!data.get("from") && selected.dataset.from) next.set("from", selected.dataset.from);
    if (!data.get("to") && selected.dataset.to) next.set("to", selected.dataset.to);
  }

  const query = next.toString();
  window.location.assign(query ? `${form.action}?${query}` : form.action);
}
