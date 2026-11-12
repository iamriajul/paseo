import { execFileSync as nodeExecFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { isMainModule } from "./is-main-module.mjs";

// Several release workflows start on the same tag push and each needs the release to
// exist. GitHub lets any number of releases share one tag, so concurrent check-then-create
// calls all succeed: v0.15.913 got three. Every workflow therefore creates through
// `ensureGitHubRelease`, which always creates a draft, waits for concurrent creators to
// become visible, then keeps one canonical release and deletes the empty others. Every
// uploader resolves the same canonical release with `getGitHubRelease`, and only
// `publishGitHubRelease` turns it from a draft into a published release.
const SETTLE_MS = 5_000;

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

// A page of 100 releases with their assets is several MB, well past execFileSync's 1 MB
// default: v0.15.914's first lookup failed with `spawnSync gh ENOBUFS`.
export const GH_MAX_BUFFER_BYTES = 256 * 1024 * 1024;

function gh(execFileSync, args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: GH_MAX_BUFFER_BYTES,
  });
}

function isNotFound(error) {
  return String(error?.stderr ?? "").includes("HTTP 404");
}

// A draft's tag_name can read as its `untagged-…` slug, so a draft also matches by title.
function forTag(releases, tag) {
  return releases.filter(
    (release) =>
      release.tag_name === tag || (release.draft === true && release.name === `Paseo ${tag}`),
  );
}

// The newest page answers the tag being released. A rebuild of an older tag misses it, and
// the repository has more than 100 releases, so a miss reads every page before it decides
// the tag has none: deciding wrongly would create a second release for that tag.
export function listTagReleases(repo, tag, execFileSync = nodeExecFileSync) {
  const firstPage = JSON.parse(gh(execFileSync, ["api", `repos/${repo}/releases?per_page=100`]));
  const found = forTag(firstPage, tag);
  if (found.length > 0 || firstPage.length < 100) {
    return found;
  }
  const everyRelease = gh(execFileSync, [
    "api",
    "--paginate",
    `repos/${repo}/releases?per_page=100`,
    "--jq",
    ".[]",
  ])
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  return forTag(everyRelease, tag);
}

// Concurrent creators run the same cleanup, so another one may already have deleted it.
function deleteIgnoringMissing(execFileSync, endpoint) {
  try {
    gh(execFileSync, ["api", "--method", "DELETE", endpoint]);
    return true;
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return false;
  }
}

// A published release already owns the tag, and publishing a second one fails with
// "tag_name already exists", so it wins. Otherwise the oldest draft wins. Both rules only
// look at ids and states, so every workflow picks the same release.
export function pickCanonicalRelease(releases) {
  const byId = [...releases].sort((a, b) => a.id - b.id);
  return byId.find((release) => release.draft !== true) ?? byId[0] ?? null;
}

export function getGitHubRelease(repo, tag, execFileSync = nodeExecFileSync) {
  return pickCanonicalRelease(listTagReleases(repo, tag, execFileSync));
}

export function getReleaseLookupTag(release) {
  if (release.draft === true && release.html_url) {
    return new URL(release.html_url).pathname.split("/").at(-1);
  }
  return release.tag_name;
}

// Deletes the releases for the tag that are neither canonical nor carry assets. A
// duplicate with assets is left for a person, because deleting it would lose a build.
export function removeDuplicateReleases(repo, tag, execFileSync = nodeExecFileSync) {
  const releases = listTagReleases(repo, tag, execFileSync);
  const canonical = pickCanonicalRelease(releases);
  if (!canonical) {
    return null;
  }
  for (const release of releases) {
    if (release.id === canonical.id) continue;
    if ((release.assets ?? []).length > 0) {
      console.warn(
        `::warning::Release ${release.id} duplicates ${tag} and has assets; leaving it for manual cleanup`,
      );
      continue;
    }
    if (deleteIgnoringMissing(execFileSync, `repos/${repo}/releases/${release.id}`)) {
      console.error(`Deleted duplicate release ${release.id} for ${tag}`);
    }
  }
  return canonical;
}

export function ensureGitHubRelease(
  { repo, tag, prerelease = false, target = "", verifyTag = false },
  { execFileSync = nodeExecFileSync, sleep = sleepSync, settleMs = SETTLE_MS } = {},
) {
  const existing = getGitHubRelease(repo, tag, execFileSync);
  if (existing) {
    return existing;
  }
  if (verifyTag) {
    gh(execFileSync, ["api", `repos/${repo}/git/ref/tags/${tag}`]);
  }
  const createArgs = [
    "api",
    "--method",
    "POST",
    `repos/${repo}/releases`,
    "-f",
    `tag_name=${tag}`,
    "-f",
    `name=Paseo ${tag}`,
    "-f",
    "body=",
    "-F",
    "draft=true",
    "-F",
    `prerelease=${prerelease}`,
  ];
  if (target) {
    createArgs.push("-f", `target_commitish=${target}`);
  }
  gh(execFileSync, createArgs);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    sleep(attempt === 0 ? settleMs : 1_000);
    const canonical = removeDuplicateReleases(repo, tag, execFileSync);
    if (canonical) {
      return canonical;
    }
  }
  throw new Error(`Created a release for ${tag} but cannot list it.`);
}

// Publishes the canonical release unless it already is. npm Global Install Release calls
// this once its tarballs are up, so a failed desktop build cannot keep the daemon packages
// on a draft; finalize-rollout calls it after the updater manifests. Duplicates go first so
// that no second release for the tag is left beside the published one.
export function publishGitHubRelease(
  { repo, tag, prerelease = false },
  { execFileSync = nodeExecFileSync } = {},
) {
  const release = removeDuplicateReleases(repo, tag, execFileSync);
  if (!release) {
    throw new Error(`No release exists for ${tag}.`);
  }
  if (release.draft !== true) {
    return release;
  }
  const patchArgs = [
    "api",
    "--method",
    "PATCH",
    `repos/${repo}/releases/${release.id}`,
    "-f",
    `tag_name=${tag}`,
    "-F",
    "draft=false",
  ];
  if (prerelease) {
    patchArgs.push("-F", "prerelease=true");
  }
  gh(execFileSync, patchArgs);
  console.error(`Published release ${release.id} for ${tag}`);
  return { ...release, draft: false, tag_name: tag };
}

// Asset operations go by release id. A draft's `untagged-…` slug stops resolving the moment
// npm Global Install Release publishes it, so a slug captured before that 404s after it.
function requireRelease(repo, tag, execFileSync) {
  const release = getGitHubRelease(repo, tag, execFileSync);
  if (!release) {
    throw new Error(`No release exists for ${tag}.`);
  }
  return release;
}

export function listReleaseAssetNames({ repo, tag }, { execFileSync = nodeExecFileSync } = {}) {
  return (requireRelease(repo, tag, execFileSync).assets ?? []).map((asset) => asset.name);
}

export function downloadReleaseAsset(
  { repo, tag, name, dir },
  { execFileSync = nodeExecFileSync } = {},
) {
  const asset = (requireRelease(repo, tag, execFileSync).assets ?? []).find(
    (candidate) => candidate.name === name,
  );
  if (!asset) {
    throw new Error(`Release for ${tag} has no asset ${name}.`);
  }
  const body = execFileSync(
    "gh",
    ["api", "-H", "Accept: application/octet-stream", `repos/${repo}/releases/assets/${asset.id}`],
    { stdio: ["ignore", "pipe", "pipe"], maxBuffer: GH_MAX_BUFFER_BYTES },
  );
  writeFileSync(path.join(dir, name), body);
}

export function deleteReleaseAsset({ repo, tag, name }, { execFileSync = nodeExecFileSync } = {}) {
  for (const asset of requireRelease(repo, tag, execFileSync).assets ?? []) {
    if (asset.name === name) {
      deleteIgnoringMissing(execFileSync, `repos/${repo}/releases/assets/${asset.id}`);
    }
  }
}

// Replaces same-named assets, like `gh release upload --clobber`.
export function uploadReleaseAssets(
  { repo, tag, files },
  { execFileSync = nodeExecFileSync } = {},
) {
  const release = requireRelease(repo, tag, execFileSync);
  for (const file of files) {
    const name = path.basename(file);
    for (const asset of release.assets ?? []) {
      if (asset.name === name) {
        deleteIgnoringMissing(execFileSync, `repos/${repo}/releases/assets/${asset.id}`);
      }
    }
    gh(execFileSync, [
      "api",
      "--method",
      "POST",
      `https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
      "-H",
      "Content-Type: application/octet-stream",
      "--input",
      file,
    ]);
  }
}

function parseArgs(argv) {
  const args = {
    cleanupDuplicates: false,
    ensure: false,
    prerelease: false,
    publish: false,
    assetNames: false,
    deleteAsset: "",
    downloadAsset: "",
    dir: ".",
    upload: [],
    repo: "",
    tag: "",
    target: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo" || arg === "--tag" || arg === "--target" || arg === "--dir") {
      args[arg.slice(2)] = argv[index + 1] ?? "";
      index += 1;
    } else if (arg === "--download-asset" || arg === "--delete-asset") {
      args[arg === "--download-asset" ? "downloadAsset" : "deleteAsset"] = argv[index + 1] ?? "";
      index += 1;
    } else if (arg === "--asset-names") {
      args.assetNames = true;
    } else if (arg === "--upload") {
      args.upload = argv.slice(index + 1);
      index = argv.length;
    } else if (arg === "--cleanup-duplicates") {
      args.cleanupDuplicates = true;
    } else if (arg === "--ensure") {
      args.ensure = true;
    } else if (arg === "--publish") {
      args.publish = true;
    } else if (arg === "--prerelease") {
      args.prerelease = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.repo || !args.tag) {
    throw new Error(
      "Usage: node scripts/github-release.mjs --repo <owner/repo> --tag <tag> [--ensure [--prerelease] [--target <ref>] | --publish [--prerelease] | --cleanup-duplicates | --asset-names | --download-asset <name> [--dir <dir>] | --delete-asset <name> | --upload <file>...]",
    );
  }
  return args;
}

// Prints the canonical release's `gh release` lookup tag: the tag once published, the
// draft's `untagged-…` slug before.
export function main(argv, deps = {}) {
  const execFileSync = deps.execFileSync ?? nodeExecFileSync;
  const sleep = deps.sleep ?? sleepSync;
  const args = parseArgs(argv);
  if (args.assetNames) {
    return listReleaseAssetNames(args, { execFileSync }).join("\n");
  }
  if (args.downloadAsset) {
    downloadReleaseAsset({ ...args, name: args.downloadAsset }, { execFileSync });
    return "";
  }
  if (args.deleteAsset) {
    deleteReleaseAsset({ ...args, name: args.deleteAsset }, { execFileSync });
    return "";
  }
  if (args.upload.length > 0) {
    uploadReleaseAssets({ ...args, files: args.upload }, { execFileSync });
    return "";
  }
  let release = null;
  if (args.ensure) {
    release = ensureGitHubRelease(args, { execFileSync, sleep, settleMs: deps.settleMs });
  } else if (args.publish) {
    release = publishGitHubRelease(args, { execFileSync });
  } else {
    for (let attempt = 0; attempt < 5 && !release; attempt += 1) {
      release = getGitHubRelease(args.repo, args.tag, execFileSync);
      if (!release && attempt < 4) {
        sleep(1_000);
      }
    }
    if (release && args.cleanupDuplicates) {
      release = removeDuplicateReleases(args.repo, args.tag, execFileSync);
    }
  }
  if (!release) {
    return null;
  }
  return getReleaseLookupTag(release);
}

if (isMainModule(import.meta.url)) {
  const output = main(process.argv.slice(2));
  if (output === null) {
    process.exitCode = 1;
  } else if (output) {
    process.stdout.write(`${output}\n`);
  }
}
