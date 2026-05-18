import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";

const cwd = process.cwd();
const gzipPath = process.env.RUNTIME_DB_GZIP_PATH
  ? resolveFrom(cwd, process.env.RUNTIME_DB_GZIP_PATH)
  : join(cwd, "data/runtime/conversation.db.gz");
const destination = process.env.RUNTIME_DB_PUBLISH_URL;

if (!existsSync(gzipPath)) {
  throw new Error(`Packed runtime artifact not found: ${gzipPath}. Run pnpm runtime:pack first.`);
}
if (!destination) {
  throw new Error(
    "Set RUNTIME_DB_PUBLISH_URL to an s3:// destination or github://owner/repo/tag[/asset-name], then run pnpm runtime:publish.",
  );
}

if (destination.startsWith("github://")) {
  publishGitHubRelease({ gzipPath, destination });
} else {
  const result = spawnSync("aws", ["s3", "cp", gzipPath, destination], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const shaPath = `${gzipPath}.sha256`;
if (existsSync(shaPath)) {
  console.log(`[runtime:publish] checksum ${readFileSync(shaPath, "utf8").trim()}`);
}
console.log(`[runtime:publish] uploaded ${gzipPath} -> ${destination}`);

function resolveFrom(cwd, pathValue) {
  return pathValue.startsWith("/") ? pathValue : join(cwd, pathValue);
}

function publishGitHubRelease({ gzipPath, destination }) {
  const parsed = parseGitHubDestination(destination, basename(gzipPath));
  const view = spawnSync("gh", ["release", "view", parsed.tag, "--repo", parsed.repo], { stdio: "ignore" });
  if (view.status !== 0) {
    const create = spawnSync(
      "gh",
      ["release", "create", parsed.tag, "--repo", parsed.repo, "--title", parsed.tag, "--notes", "Private runtime database artifact."],
      { stdio: "inherit" },
    );
    if (create.error) throw create.error;
    if (create.status !== 0) process.exit(create.status ?? 1);
  }

  const upload = spawnSync(
    "gh",
    ["release", "upload", parsed.tag, `${gzipPath}#${parsed.assetName}`, "--repo", parsed.repo, "--clobber"],
    { stdio: "inherit" },
  );
  if (upload.error) throw upload.error;
  if (upload.status !== 0) process.exit(upload.status ?? 1);

  const api = spawnSync(
    "gh",
    [
      "api",
      `repos/${parsed.repo}/releases/tags/${parsed.tag}`,
      "--jq",
      `.assets[] | select(.name == "${escapeJqString(parsed.assetName)}") | .url`,
    ],
    { encoding: "utf8" },
  );
  if (api.error) throw api.error;
  if (api.status !== 0) process.exit(api.status ?? 1);
  const assetUrl = api.stdout.trim();
  if (assetUrl) {
    console.log(`[runtime:publish] github asset api url: ${assetUrl}`);
  }
}

function parseGitHubDestination(destination, defaultAssetName) {
  const url = new URL(destination);
  const owner = url.hostname;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw new Error("GitHub publish URL must be github://owner/repo/tag[/asset-name]");
  }
  const [repoName, tag, ...assetParts] = parts;
  return {
    repo: `${owner}/${repoName}`,
    tag,
    assetName: assetParts.join("/") || defaultAssetName,
  };
}

function escapeJqString(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
