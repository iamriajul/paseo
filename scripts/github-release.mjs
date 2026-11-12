import { execFileSync as nodeExecFileSync } from "node:child_process";
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

function gh(execFileSync, args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// A draft's tag_name can read as its `untagged-…` slug, so a draft also matches by title.
export function listTagReleases(repo, tag, execFileSync = nodeExecFileSync) {
  const releases = JSON.parse(gh(execFileSync, ["api", `repos/${repo}/releases?per_page=100`]));
  return releases.filter(
    (release) =>
      release.tag_name === tag || (release.draft === true && release.name === `Paseo ${tag}`),
  );
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
    gh(execFileSync, ["api", "--method", "DELETE", `repos/${repo}/releases/${release.id}`]);
    console.error(`Deleted duplicate release ${release.id} for ${tag}`);
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

function parseArgs(argv) {
  const args = {
    cleanupDuplicates: false,
    ensure: false,
    prerelease: false,
    publish: false,
    repo: "",
    tag: "",
    target: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo" || arg === "--tag" || arg === "--target") {
      args[arg.slice(2)] = argv[index + 1] ?? "";
      index += 1;
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
      "Usage: node scripts/github-release.mjs --repo <owner/repo> --tag <tag> [--ensure [--prerelease] [--target <ref>] | --publish [--prerelease] | --cleanup-duplicates]",
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
  const lookup = main(process.argv.slice(2));
  if (lookup) {
    process.stdout.write(`${lookup}\n`);
  } else {
    process.exitCode = 1;
  }
}
