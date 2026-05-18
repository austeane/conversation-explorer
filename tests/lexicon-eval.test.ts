import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixtureDb = join(root, "data/fixtures/tiny.db");
const baselineReport = join(root, "data/eval/report.json");

type EvalReport = {
  overall: { macro_f1: number };
  suites: Array<{ name: string; macro_f1: number; total: number }>;
};

describe("eval regression gate", () => {
  it("keeps fixture macro F1 within 0.02 of the committed report", () => {
    const current = runEval();
    const baseline = JSON.parse(readFileSync(baselineReport, "utf8")) as EvalReport;
    const allowedDrop = 0.02;

    expect(current.overall.macro_f1).toBeGreaterThanOrEqual(baseline.overall.macro_f1 - allowedDrop);
    expect(suite(current, "segment_categories").macro_f1).toBeGreaterThanOrEqual(
      suite(baseline, "segment_categories").macro_f1 - allowedDrop,
    );
  });
});

function runEval() {
  const dir = mkdtempSync(join(tmpdir(), "them-eval-"));
  const reportPath = join(dir, "report.json");
  const confusionPath = join(dir, "confusion.png");

  try {
    execFileSync(
      "python3",
      ["scripts/eval/run.py", "--db", fixtureDb, "--report", reportPath, "--confusion", confusionPath],
      { cwd: root, encoding: "utf8" },
    );
    return JSON.parse(readFileSync(reportPath, "utf8")) as EvalReport;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function suite(report: EvalReport, name: string) {
  const found = report.suites.find((item) => item.name === name);
  if (!found) throw new Error(`Missing eval suite ${name}`);
  return found;
}
