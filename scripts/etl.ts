import { spawnSync } from "node:child_process";
import { configPathFromArgs } from "./config";

const configPath = configPathFromArgs();
const extraArgs = process.argv.slice(2).filter((arg, index, args) => {
  if (arg === "--config") return false;
  if (index > 0 && args[index - 1] === "--config") return false;
  return !arg.startsWith("--config=");
});

run("extract", ["scripts/extract.ts", "--config", configPath, ...extraArgs]);
run("extract:comparisons", ["scripts/extract-comparisons.ts", "--config", configPath]);
run("thumbs", ["scripts/thumbs.ts", "--config", configPath]);

function run(label: string, args: string[]) {
  console.log(`[etl] ${label}`);
  const result = spawnSync("tsx", args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
