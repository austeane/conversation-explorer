import { z } from "zod";

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const booleanFlag = z.preprocess((value) => {
  if (value === true || value === "true" || value === "1" || value === 1) return true;
  if (value === false || value === "false" || value === "0" || value === 0) return false;
  return undefined;
}, z.boolean().optional());

export const phaseId = z.preprocess((value) => {
  if (value == null || value === "") return undefined;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string") {
    const normalized = value.match(/^"(\d+)"$/)?.[1] ?? value;
    if (/^\d+$/.test(normalized)) return Number(normalized);
  }
  return undefined;
}, z.number().int().nonnegative().optional()).catch(undefined);

export const globalSearchSchema = z.object({
  from: ymd.optional().catch(undefined),
  to: ymd.optional().catch(undefined),
  sender: z.enum(["me", "them", "both"]).optional().catch("both"),
  phase: phaseId,
  sensitive: booleanFlag.catch(undefined),
  evidenceOnly: booleanFlag.catch(undefined),
});

export type GlobalSearch = z.infer<typeof globalSearchSchema>;
