import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixtureDb = join(root, "data/fixtures/tiny.db");

if (!existsSync(fixtureDb)) {
  execFileSync("python3", ["scripts/eval/build-fixtures.py"], { cwd: root, stdio: "inherit" });
}

process.env.RUNTIME_DB_PATH = fixtureDb;
