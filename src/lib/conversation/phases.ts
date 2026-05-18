import { bucket, monthBounds } from "./time";

export type PhaseOption = {
  id: string;
  label: string;
  start_ym: string;
  end_ym: string;
  from: string;
  to: string;
  method: string;
};

export function phaseFor(epochSec: number, phases: Pick<PhaseOption, "id" | "start_ym" | "end_ym">[]) {
  const ym = bucket(epochSec, "ym");
  return phases.find((phase) => phase.start_ym <= ym && ym <= phase.end_ym)?.id ?? null;
}

export function phaseOptionFromSeason(row: {
  id: number | string;
  label: string;
  start_ym: string;
  end_ym: string;
  method: string;
}): PhaseOption {
  return {
    id: String(row.id),
    label: row.label,
    start_ym: row.start_ym,
    end_ym: row.end_ym,
    from: `${row.start_ym}-01`,
    to: localDateFromMonthEnd(row.end_ym),
    method: row.method,
  };
}

function localDateFromMonthEnd(ym: string) {
  const end = monthBounds(ym).end - 1;
  return bucket(end, "ymd");
}

