#!/usr/bin/env node
/**
 * Runs the proof command for every fork decision in docs/fork-decisions.md.
 *
 * The fork is a rebase queue. After rebasing onto a new upstream release, a decision
 * can survive as code but stop working, or be silently absorbed by upstream. Neither
 * shows up in the diff. This runs each decision's own test and names the ones that fail.
 *
 * docs/fork-decisions.md is the only source: headings are decision ids, the bash block
 * under each is its proof. Nothing to keep in sync.
 *
 * Usage:
 *   node scripts/fork-verify.mjs           run every decision
 *   node scripts/fork-verify.mjs <id>...   run only the named decisions
 *   node scripts/fork-verify.mjs --list    print ids and exit
 */
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DECISIONS_PATH = join(repoRoot, "docs", "fork-decisions.md");

/** Parse `## id` headings and the first fenced bash block under each. */
export function parseDecisions(markdown) {
  const decisions = [];
  let current = null;
  let fence = null;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(\S+)\s*$/.exec(line);
    if (heading && fence === null) {
      current = { id: heading[1], commands: [] };
      decisions.push(current);
      continue;
    }
    if (!current) continue;
    if (fence === null && /^```bash\s*$/.test(line)) {
      fence = [];
      continue;
    }
    if (fence !== null) {
      if (/^```\s*$/.test(line)) {
        if (current.commands.length === 0) current.commands = fence.filter((l) => l.trim());
        fence = null;
        continue;
      }
      fence.push(line);
    }
  }
  return decisions;
}

function loadDecisions() {
  if (!existsSync(DECISIONS_PATH)) {
    throw new Error(`missing ${DECISIONS_PATH}`);
  }
  return parseDecisions(readFileSync(DECISIONS_PATH, "utf8"));
}

function run() {
  const args = process.argv.slice(2);
  const all = loadDecisions();

  if (args.includes("--list")) {
    for (const d of all) console.log(d.id);
    return 0;
  }

  const wanted = args.filter((a) => !a.startsWith("-"));
  const selected = wanted.length ? all.filter((d) => wanted.includes(d.id)) : all;

  if (wanted.length) {
    const unknown = wanted.filter((w) => !all.some((d) => d.id === w));
    if (unknown.length) {
      console.error(`unknown decision(s): ${unknown.join(", ")}`);
      console.error(`run with --list to see all ${all.length}`);
      return 2;
    }
  }

  const unprotected = selected.filter((d) => d.commands.length === 0);
  const failed = [];

  for (const [i, d] of selected.entries()) {
    if (d.commands.length === 0) {
      console.log(`skip ${i + 1}/${selected.length} ${d.id}  (no proof command)`);
      continue;
    }
    process.stdout.write(`run  ${i + 1}/${selected.length} ${d.id} ... `);
    const failing = d.commands.find(
      (cmd) => spawnSync(cmd, { cwd: repoRoot, shell: true, stdio: "pipe" }).status !== 0,
    );
    if (failing === undefined) {
      console.log("ok");
      continue;
    }
    console.log("FAIL");
    failed.push({ id: d.id, command: failing });
  }

  console.log();
  if (unprotected.length) {
    console.log(`${unprotected.length} decision(s) have no proof command:`);
    for (const d of unprotected) console.log(`  ${d.id}`);
    console.log();
  }
  if (failed.length === 0) {
    console.log(`fork-verify: ${selected.length - unprotected.length} decision(s) verified`);
    return 0;
  }
  console.error(`fork-verify: ${failed.length} decision(s) FAILED`);
  for (const f of failed) {
    console.error(`  ${f.id}`);
    console.error(`    ${f.command}`);
  }
  console.error(
    "\nEach failure is a fork behaviour that no longer works. Either upstream absorbed it" +
      "\n(drop the commit and its section) or the rebase broke it (fix the commit).",
  );
  return 1;
}

const invokedDirectly =
  Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) process.exit(run());
