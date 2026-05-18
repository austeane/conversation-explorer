import { z } from "zod";
import { dayBounds } from "./time";

const phaseId = z.preprocess((value) => {
  if (value == null || value === "") return undefined;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string") {
    const normalized = value.match(/^"(\d+)"$/)?.[1] ?? value;
    if (/^\d+$/.test(normalized)) return Number(normalized);
  }
  return undefined;
}, z.number().int().nonnegative().optional()).catch(undefined);

export const messageScopeInput = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sender: z.enum(["me", "them", "both"]).optional().default("both"),
  phase: phaseId,
});

export type MessageScope = z.infer<typeof messageScopeInput>;

export function addMessageScopeFilters(
  where: string[],
  args: Array<string | number>,
  scope: MessageScope,
  alias = "m",
) {
  if (scope.from) {
    where.push(`${alias}.ts >= ?`);
    args.push(dayBounds(scope.from).start);
  }
  if (scope.to) {
    where.push(`${alias}.ts < ?`);
    args.push(dayBounds(scope.to).end);
  }
  if (scope.sender === "me") where.push(`${alias}.is_from_me = 1`);
  if (scope.sender === "them") where.push(`${alias}.is_from_me = 0`);
}

export function messageScopeWhere(scope: MessageScope, alias = "m", extraWhere: string[] = []) {
  const where = [...extraWhere];
  const args: Array<string | number> = [];
  addMessageScopeFilters(where, args, scope, alias);
  return {
    sql: where.length ? `WHERE ${where.join(" AND ")}` : "",
    args,
  };
}
