import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

import { getGitHubRelease, getReleaseLookupTag } from "./github-release.mjs";
import { isMainModule } from "./is-main-module.mjs";

// uploads.github.com returns HTTP 500 on large desktop binaries often enough that a
// release regularly loses a ~50 minute build to one failed asset. Upload each file on
// its own so a failure does not discard its siblings, and retry that file.
//
// `release` is resolved again for every attempt. While the release is a draft, `gh` knows it
// by its `untagged-…` slug, and npm Global Install Release can publish it during a desktop
// upload, after which the slug 404s. A retry then reaches the release by its tag.
const DEFAULT_ATTEMPTS = 5;
const DEFAULT_BACKOFF_MS = 15_000;

function uploadAsset({ release, file, repo }) {
  const command = process.platform === "win32" ? "gh.exe" : "gh";
  const result = spawnSync(
    command,
    ["release", "upload", release, file, "--clobber", "--repo", repo],
    { shell: process.platform === "win32", stdio: "inherit" },
  );

  if (result.error) {
    console.error(`Failed to start gh: ${result.error.message}`);
    return 1;
  }

  return result.status ?? 1;
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function collectAssets(releaseDir, { readDir = readdirSync, stat = statSync } = {}) {
  return readDir(releaseDir)
    .map((name) => path.join(releaseDir, name))
    .filter((file) => stat(file).isFile() && !file.endsWith(".yml"))
    .sort();
}

export async function uploadWithRetry(
  { release, files, repo },
  {
    attempts = DEFAULT_ATTEMPTS,
    backoffMs = DEFAULT_BACKOFF_MS,
    upload = uploadAsset,
    sleep = wait,
  } = {},
) {
  for (const file of files) {
    let exitCode = 1;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let target = release;
      if (typeof release === "function") {
        try {
          target = release();
        } catch (error) {
          console.warn(`Resolving the release failed: ${error.message}`);
          target = null;
        }
      }
      exitCode = target ? await upload({ release: target, file, repo }) : 1;
      if (exitCode === 0) break;

      if (attempt < attempts) {
        const delayMs = attempt * backoffMs;
        console.warn(
          `Uploading ${path.basename(file)} failed with exit code ${exitCode}; retrying in ${delayMs / 1000}s (${attempt + 1}/${attempts})`,
        );
        await sleep(delayMs);
      }
    }

    if (exitCode !== 0) {
      console.error(`::error::Giving up on ${path.basename(file)} after ${attempts} attempts`);
      return exitCode;
    }
  }

  return 0;
}

if (isMainModule(import.meta.url)) {
  const [tag, releaseDir, repo] = process.argv.slice(2);
  if (!tag || !releaseDir || !repo) {
    console.error("Usage: node scripts/upload-release-assets.mjs <tag> <dir> <repo>");
    process.exitCode = 2;
  } else {
    const files = collectAssets(releaseDir);
    if (files.length === 0) {
      console.error(`::error::No release artifacts found in ${releaseDir}`);
      process.exitCode = 1;
    } else {
      const release = () => {
        const found = getGitHubRelease(repo, tag);
        if (!found) throw new Error(`No release exists for ${tag}.`);
        return getReleaseLookupTag(found);
      };
      process.exitCode = await uploadWithRetry({ release, files, repo });
    }
  }
}
