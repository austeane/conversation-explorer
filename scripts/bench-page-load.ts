import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { cpus, platform, release, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const PROJECT_ROOT = new URL("..", import.meta.url).pathname;
const SESSION_COOKIE = "conversation_session";
const DEFAULT_TARGET_URL = "http://localhost:3000/";
const DEFAULT_OUTPUT_JSON = join(PROJECT_ROOT, "prompt-exports/bench-runs.json");
const PASS_THRESHOLD_MS = 300;
const CANONICAL_ROUTES = [
  "/",
  "/insights",
  "/timeline",
  "/turning-points",
  "/seasons",
  "/outliers",
  "/comparisons",
  "/methods",
  "/browse",
  "/ask?q=hello",
  "/attachments",
  "/conversations",
  "/capsules",
  "/vocabulary",
  "/phrases",
  "/entrainment",
  "/echoes",
  "/dynamics",
  "/bids",
  "/mirrors",
  "/resonance",
  "/choreography",
  "/information",
  "/gestures",
  "/repair",
  "/open-loops",
  "/ignition",
  "/counterfactuals",
  "/forecasts",
  "/weather",
  "/rituals",
  "/omens",
  "/atlas",
  "/lifecycles",
  "/constellations",
  "/gravity",
  "/recurrence",
  "/attractors",
  "/arcs",
  "/rhythms",
  "/desire",
] as const;

type Sample = {
  index: number;
  status: number;
  ok: boolean;
  header_ms: number;
  total_ms: number;
  response_bytes: number;
  final_url: string;
  final_path: string;
  redirected: boolean;
};

type Summary = {
  sample_count: number;
  discarded_count: number;
  min_ms: number;
  p50_ms: number;
  p95_ms: number;
  max_ms: number;
  mean_ms: number;
  mean_response_bytes: number;
  status_counts: Record<string, number>;
  final_url_counts: Record<string, number>;
  redirected_count: number;
};

type RouteBenchRecord = {
  path: string;
  url: string;
  summary: Summary;
  samples: Sample[];
  discarded_samples: Sample[];
};

type BenchRecord = {
  generated_at: string;
  target_url: string;
  warmup_count: number;
  measured_count: number;
  discarded_outliers: number;
  summary: Summary;
  response_bytes: {
    min: number;
    mean: number;
    max: number;
  };
  js_bundle_bytes: number;
  js_bundle_file_count: number;
  db: {
    path: string;
    exists: boolean;
    bytes: number | null;
  };
  environment: {
    node: string;
    platform: string;
    release: string;
    cpu: string;
    cpu_count: number;
    total_memory_bytes: number;
  };
  git_commit: string | null;
  samples: Sample[];
  discarded_samples: Sample[];
  routes: RouteBenchRecord[];
  pass_threshold_ms: number;
  passed: boolean;
  failing_routes: string[];
};

async function main() {
  const baseUrl = normalizeUrl(process.env.TARGET_URL ?? DEFAULT_TARGET_URL);
  const routePaths = benchRoutes();
  const passphrase = requireEnv("SITE_PASSPHRASE");
  const secret = requireEnv("SITE_SECRET");
  const warmupCount = readPositiveInt("BENCH_WARMUP", 5);
  const sampleCount = readPositiveInt("BENCH_SAMPLES", 30);
  const outputJson = resolve(PROJECT_ROOT, process.env.OUTPUT_JSON ?? DEFAULT_OUTPUT_JSON);
  const cookie = authCookie(secret, passphrase);

  console.log(`[bench:page] base target: ${baseUrl}`);
  console.log(`[bench:page] routes (${routePaths.length}): ${routePaths.join(", ")}`);
  console.log(`[bench:page] warmup: ${warmupCount}, samples: ${sampleCount}, discard: top 1`);

  const routes: RouteBenchRecord[] = [];
  for (const routePath of routePaths) {
    routes.push(await benchRoute(baseUrl, routePath, cookie, warmupCount, sampleCount));
  }

  const firstRoute = routes[0];
  if (!firstRoute) {
    throw new Error("No routes configured for benchmark");
  }

  const failingRoutes = routes.filter((route) => routeFailed(route)).map((route) => route.path);
  const responseSizes = firstRoute.samples.map((sample) => sample.response_bytes);
  const bundle = collectJsBundleBytes(join(PROJECT_ROOT, ".output/public"));
  const dbPath = resolve(PROJECT_ROOT, process.env.RUNTIME_DB_PATH ?? join(PROJECT_ROOT, "data/runtime/conversation.db"));

  const record: BenchRecord = {
    generated_at: new Date().toISOString(),
    target_url: baseUrl,
    warmup_count: warmupCount,
    measured_count: sampleCount,
    discarded_outliers: firstRoute.discarded_samples.length,
    summary: firstRoute.summary,
    response_bytes: {
      min: Math.min(...responseSizes),
      mean: mean(responseSizes),
      max: Math.max(...responseSizes),
    },
    js_bundle_bytes: bundle.bytes,
    js_bundle_file_count: bundle.files,
    db: {
      path: dbPath,
      exists: existsSync(dbPath),
      bytes: existsSync(dbPath) ? statSync(dbPath).size : null,
    },
    environment: environmentInfo(),
    git_commit: currentGitCommit(),
    samples: firstRoute.samples,
    discarded_samples: firstRoute.discarded_samples,
    routes,
    pass_threshold_ms: PASS_THRESHOLD_MS,
    passed: failingRoutes.length === 0,
    failing_routes: failingRoutes,
  };

  appendRecord(outputJson, record);
  printAllRoutesSummary(record, outputJson);
}

function benchRoutes(): string[] {
  const rawRoutes = process.env.BENCH_ROUTES;
  const routes = rawRoutes ? rawRoutes.split(",").map((route) => route.trim()).filter(Boolean) : [...CANONICAL_ROUTES];
  if (routes.length === 0) {
    throw new Error("BENCH_ROUTES did not contain any routes");
  }
  return routes;
}

async function benchRoute(
  baseUrl: string,
  path: string,
  cookie: string,
  warmupCount: number,
  sampleCount: number,
): Promise<RouteBenchRecord> {
  const url = new URL(path, baseUrl).toString();
  console.log("");
  console.log(`[bench:page] benchmarking ${path} (url: ${url})`);

  for (let i = 0; i < warmupCount; i += 1) {
    await measureOnce(url, cookie, i + 1);
  }

  const samples: Sample[] = [];
  for (let i = 0; i < sampleCount; i += 1) {
    const sample = await measureOnce(url, cookie, i + 1);
    samples.push(sample);
    console.log(
      `[bench:page] ${path} sample ${String(i + 1).padStart(2, "0")}: ${sample.total_ms.toFixed(1)} ms, ${sample.response_bytes} bytes, status ${sample.status}, final ${formatAuditUrl(sample.final_url)}${sample.redirected ? " (redirected)" : ""}`,
    );
  }

  const sorted = [...samples].sort((a, b) => a.total_ms - b.total_ms);
  const discardedSamples = sorted.length >= 3 ? sorted.slice(-1) : [];
  const keptSamples = discardedSamples.length > 0 ? sorted.slice(0, -1) : sorted;
  const summary = summarize(keptSamples, discardedSamples.length);

  return {
    path,
    url,
    summary,
    samples,
    discarded_samples: discardedSamples,
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function normalizeUrl(raw: string): string {
  const url = new URL(raw);
  if (!url.pathname) url.pathname = "/";
  return url.toString();
}

function authCookie(secret: string, passphrase: string): string {
  const token = createHmac("sha256", secret).update(passphrase).digest("hex");
  return `${SESSION_COOKIE}=${token}`;
}

async function measureOnce(url: string, cookie: string, index: number): Promise<Sample> {
  const start = performance.now();
  const response = await fetch(url, {
    headers: {
      cookie,
      accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
  });
  const headerAt = performance.now();
  const body = await response.text();
  const end = performance.now();
  const finalUrl = response.url || url;

  return {
    index,
    status: response.status,
    ok: response.ok,
    header_ms: round(headerAt - start),
    total_ms: round(end - start),
    response_bytes: Buffer.byteLength(body, "utf8"),
    final_url: finalUrl,
    final_path: finalPath(finalUrl),
    redirected: response.redirected,
  };
}

function summarize(samples: Sample[], discardedCount: number): Summary {
  if (samples.length === 0) {
    throw new Error("No samples collected");
  }

  const totals = samples.map((sample) => sample.total_ms).sort((a, b) => a - b);
  const responseBytes = samples.map((sample) => sample.response_bytes);
  const statusCounts: Record<string, number> = {};
  const finalUrlCounts: Record<string, number> = {};
  let redirectedCount = 0;
  for (const sample of samples) {
    statusCounts[String(sample.status)] = (statusCounts[String(sample.status)] ?? 0) + 1;
    finalUrlCounts[sample.final_url] = (finalUrlCounts[sample.final_url] ?? 0) + 1;
    if (sample.redirected) redirectedCount += 1;
  }

  return {
    sample_count: samples.length,
    discarded_count: discardedCount,
    min_ms: totals[0],
    p50_ms: percentileNearestRank(totals, 0.5),
    p95_ms: percentileNearestRank(totals, 0.95),
    max_ms: totals[totals.length - 1],
    mean_ms: round(mean(totals)),
    mean_response_bytes: Math.round(mean(responseBytes)),
    status_counts: statusCounts,
    final_url_counts: finalUrlCounts,
    redirected_count: redirectedCount,
  };
}

function percentileNearestRank(sortedValues: number[], percentile: number): number {
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(percentile * sortedValues.length) - 1));
  return sortedValues[index];
}

function mean(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function collectJsBundleBytes(root: string): { bytes: number; files: number } {
  if (!existsSync(root)) return { bytes: 0, files: 0 };

  let bytes = 0;
  let files = 0;
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() && path.endsWith(".js")) {
        bytes += statSync(path).size;
        files += 1;
      }
    }
  };

  visit(root);
  return { bytes, files };
}

function appendRecord(path: string, record: BenchRecord): void {
  mkdirSync(dirname(path), { recursive: true });

  let records: BenchRecord[] = [];
  if (existsSync(path)) {
    const current = readFileSync(path, "utf8").trim();
    if (current) {
      const parsed = JSON.parse(current) as unknown;
      records = Array.isArray(parsed) ? (parsed as BenchRecord[]) : [parsed as BenchRecord];
    }
  }

  records.push(record);
  writeFileSync(path, `${JSON.stringify(records, null, 2)}\n`);
}

function environmentInfo(): BenchRecord["environment"] {
  const cpu = cpus()[0];
  return {
    node: process.version,
    platform: platform(),
    release: release(),
    cpu: cpu?.model ?? "unknown",
    cpu_count: cpus().length,
    total_memory_bytes: totalmem(),
  };
}

function currentGitCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function routeFailed(route: RouteBenchRecord): boolean {
  // Timing uses kept samples after top-1 discard; auth/status failures inspect all measured samples
  // so a final `/auth` or non-200 response cannot be hidden as the discarded timing outlier.
  return route.summary.p50_ms >= PASS_THRESHOLD_MS || route.samples.some(sampleFailed);
}

function sampleFailed(sample: Sample): boolean {
  // Final status catches server errors; final URL catches auth redirects because `/auth` itself returns 200.
  return sample.status !== 200 || finalPath(sample.final_url) === "/auth";
}

function finalPath(rawUrl: string): string {
  try {
    return new URL(rawUrl).pathname;
  } catch {
    return rawUrl;
  }
}

function formatAuditUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.pathname}${url.search}`;
  } catch {
    return rawUrl;
  }
}

function formatStatusCounts(statusCounts: Record<string, number>): string {
  return Object.entries(statusCounts)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([status, count]) => `${status}x${count}`)
    .join(", ");
}

function formatUrlCounts(urlCounts: Record<string, number>): string {
  return Object.entries(urlCounts)
    .sort(([a], [b]) => formatAuditUrl(a).localeCompare(formatAuditUrl(b)))
    .map(([url, count]) => `${formatAuditUrl(url)} x${count}`)
    .join(", ");
}

function printAllRoutesSummary(record: BenchRecord, outputJson: string) {
  console.log("");
  console.log(`[bench:page] results (${record.routes.length} routes, threshold: ${record.pass_threshold_ms} ms)`);
  console.log(`  ${"path".padEnd(22)} ${"kept".padStart(4)} ${"p50".padStart(8)} ${"p95".padStart(8)} ${"mean".padStart(8)} ${"bytes".padStart(8)} ${"statuses".padEnd(12)} ${"redirects".padStart(9)} ${"final URLs".padEnd(24)} result`);
  for (const route of record.routes) {
    const result = routeFailed(route) ? "FAIL" : "PASS";
    console.log(
      `  ${route.path.padEnd(22)} ${String(route.summary.sample_count).padStart(4)} ${route.summary.p50_ms.toFixed(1).padStart(8)} ${route.summary.p95_ms.toFixed(1).padStart(8)} ${route.summary.mean_ms.toFixed(1).padStart(8)} ${String(route.summary.mean_response_bytes).padStart(8)} ${formatStatusCounts(route.summary.status_counts).padEnd(12)} ${String(route.summary.redirected_count).padStart(9)} ${formatUrlCounts(route.summary.final_url_counts).padEnd(24)} ${result}`,
    );
  }

  console.log("");
  if (record.passed) {
    console.log(`[bench:page] PASS — all ${record.routes.length} routes p50 < ${record.pass_threshold_ms} ms with final HTTP 200, non-auth measured samples`);
  } else {
    console.log(`[bench:page] FAIL — ${record.failing_routes.length} routes did not pass:`);
    for (const route of record.routes.filter((candidate) => record.failing_routes.includes(candidate.path))) {
      const reasons = [];
      if (route.summary.p50_ms >= record.pass_threshold_ms) {
        reasons.push(`p50=${route.summary.p50_ms.toFixed(1)} ms (>= ${record.pass_threshold_ms} ms threshold)`);
      }
      const nonOkStatuses = [...new Set(route.samples.map((sample) => sample.status).filter((status) => status !== 200))];
      if (nonOkStatuses.length > 0) {
        reasons.push(`non-200 measured final statuses: ${nonOkStatuses.join(", ")}`);
      }
      const authFinalUrls = [...new Set(route.samples.map((sample) => sample.final_url).filter((url) => finalPath(url) === "/auth"))];
      if (authFinalUrls.length > 0) {
        reasons.push(`auth final URLs: ${authFinalUrls.map(formatAuditUrl).join(", ")}`);
      }
      console.log(`  ${route.path} — ${reasons.join("; ")}`);
    }
  }

  console.log(`  js bundle: ${record.js_bundle_bytes} bytes across ${record.js_bundle_file_count} files`);
  console.log(`  db: ${record.db.exists ? `${record.db.bytes} bytes` : "missing"} at ${record.db.path}`);
  console.log(`  git: ${record.git_commit ?? "unknown"}`);
  console.log(`  wrote: ${outputJson}`);
}

function printSummary(record: BenchRecord, outputJson: string) {
  console.log("");
  console.log("[bench:page] summary");
  console.log(`  kept samples: ${record.summary.sample_count} (discarded ${record.summary.discarded_count})`);
  console.log(`  total_ms: min ${record.summary.min_ms.toFixed(1)} | p50 ${record.summary.p50_ms.toFixed(1)} | p95 ${record.summary.p95_ms.toFixed(1)} | max ${record.summary.max_ms.toFixed(1)} | mean ${record.summary.mean_ms.toFixed(1)}`);
  console.log(`  response bytes: mean ${record.summary.mean_response_bytes} (range ${record.response_bytes.min}-${record.response_bytes.max})`);
  console.log(`  status counts: ${JSON.stringify(record.summary.status_counts)}`);
  console.log(`  js bundle: ${record.js_bundle_bytes} bytes across ${record.js_bundle_file_count} files`);
  console.log(`  db: ${record.db.exists ? `${record.db.bytes} bytes` : "missing"} at ${record.db.path}`);
  console.log(`  git: ${record.git_commit ?? "unknown"}`);
  console.log(`  wrote: ${outputJson}`);
}

main().catch((error: unknown) => {
  console.error(`[bench:page] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
