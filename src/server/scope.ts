import { phaseOptionFromSeason } from "~/lib/conversation/phases";
import type { MessageScope } from "~/lib/conversation/scope";
import { db } from "~/lib/server-db";

type SeasonRangeRow = {
  id: number;
  label: string;
  start_ym: string;
  end_ym: string;
  method: string;
};

export function resolveMessageScope<T extends MessageScope>(scope: T): T {
  if (scope.phase == null) return scope;

  const row = db()
    .prepare(
      `
      SELECT id, label, start_ym, end_ym, method
      FROM seg_seasons
      WHERE id = ?
      `,
    )
    .get(scope.phase) as SeasonRangeRow | undefined;

  if (!row) return scope;

  const phase = phaseOptionFromSeason(row);
  return {
    ...scope,
    from: scope.from ?? phase.from,
    to: scope.to ?? phase.to,
  } as T;
}
