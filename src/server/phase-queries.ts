import { createServerFn } from "@tanstack/react-start";
import { phaseOptionFromSeason, type PhaseOption } from "~/lib/conversation/phases";
import { db, withDbCache } from "~/lib/server-db";

type SeasonRow = {
  id: number;
  label: string;
  start_ym: string;
  end_ym: string;
  method: string;
};

export const getPhaseOptions = createServerFn({ method: "GET" }).handler(async (): Promise<PhaseOption[]> => {
  return withDbCache("phase-options", () => {
    const d = db();
    const table = d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'seg_seasons'").get();
    if (!table) return [];

    const rows = d
      .prepare(
        `
        SELECT id, label, start_ym, end_ym, method
        FROM seg_seasons
        ORDER BY id ASC
      `,
      )
      .all() as SeasonRow[];

    return rows.map(phaseOptionFromSeason);
  });
});

