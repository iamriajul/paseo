#!/usr/bin/env node
/**
 * Quilt/Electron-style checker for fork decisions that live inside official files.
 *
 * After a merge of official, every series entry must still reverse-apply
 * (`git apply -R --check`). If it does not, the decision was dropped or official
 * rewrote the site — the sync agent reseats the hunk, refreshes the patch, and
 * re-runs the Verify command in the patch header.
 *
 * Usage:
 *   node scripts/fork-patches.mjs check
 *   node scripts/fork-patches.mjs apply
 */
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const FORK_PATCH_DIR = join(repoRoot, "patches", "fork");
export const FORK_SERIES_PATH = join(FORK_PATCH_DIR, "series");

export function parseSeries(contents) {
  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

export function parsePatchHeader(contents) {
  const header = {};
  const lines = contents.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      break;
    }
    const match = /^(Subject|Decision|Verify|Files):\s*(.*)$/.exec(line);
    if (match) {
      const key = match[1].toLowerCase();
      const value = match[2].trim();
      if (key === "verify" || key === "files") {
        header[key] = [...(header[key] ?? []), value];
      } else {
        header[key] = value;
      }
    }
  }
  return header;
}

function gitApply(args, patchPath) {
  return spawnSync("git", ["apply", ...args, "--", patchPath], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

function loadSeries() {
  if (!existsSync(FORK_SERIES_PATH)) {
    throw new Error(`missing ${FORK_SERIES_PATH}`);
  }
  const names = parseSeries(readFileSync(FORK_SERIES_PATH, "utf8"));
  return names.map((name) => {
    const path = join(FORK_PATCH_DIR, name);
    if (!existsSync(path)) {
      throw new Error(`series lists ${name} but ${path} does not exist`);
    }
    const contents = readFileSync(path, "utf8");
    return { name, path, header: parsePatchHeader(contents) };
  });
}

function check() {
  const entries = loadSeries();
  if (entries.length === 0) {
    console.log("fork-patches: empty series");
    return 0;
  }
  let failed = 0;
  for (const entry of entries) {
    const result = gitApply(["-R", "--check"], entry.path);
    if (result.status === 0) {
      const verify = (entry.header.verify ?? []).join(" ; ");
      console.log(`ok  ${entry.name}${verify ? `  verify: ${verify}` : ""}`);
      continue;
    }
    failed += 1;
    console.error(`FAIL ${entry.name}`);
    if (entry.header.subject) {
      console.error(`  Subject: ${entry.header.subject}`);
    }
    if (entry.header.decision) {
      console.error(`  Decision: ${entry.header.decision}`);
    }
    if (entry.header.verify) {
      for (const cmd of entry.header.verify) {
        console.error(`  Verify: ${cmd}`);
      }
    }
    const err = (result.stderr || result.stdout || "").trim();
    if (err) {
      console.error(err);
    }
  }
  if (failed > 0) {
    console.error(
      `\nfork-patches: ${failed} decision(s) no longer reverse-apply. Official rewrote the site or the hunk was dropped. Re-seat using the Decision/Verify header, refresh the patch file, then re-run check.`,
    );
    return 1;
  }
  return 0;
}

function apply() {
  const entries = loadSeries();
  for (const entry of entries) {
    const reverse = gitApply(["-R", "--check"], entry.path);
    if (reverse.status === 0) {
      console.log(`present  ${entry.name}`);
      continue;
    }
    const forward = gitApply(["--3way"], entry.path);
    if (forward.status === 0) {
      console.log(`applied  ${entry.name}`);
      continue;
    }
    console.error(`conflict ${entry.name}`);
    if (entry.header.decision) {
      console.error(`  Decision: ${entry.header.decision}`);
    }
    console.error((forward.stderr || forward.stdout || "").trim());
    return 1;
  }
  return 0;
}

const invokedDirectly =
  Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  const command = process.argv[2];
  if (command !== "check" && command !== "apply") {
    console.error("usage: node scripts/fork-patches.mjs check|apply");
    process.exit(2);
  }
  process.exit(command === "check" ? check() : apply());
}
