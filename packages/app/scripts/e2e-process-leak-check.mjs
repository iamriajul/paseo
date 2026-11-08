#!/usr/bin/env node
// Proves the app e2e harness leaves no Metro or daemon behind when its runner dies.
//
// Starts the real harness (`playwright test` on one spec), waits until Metro and the worker
// daemon are up, then ends the runner one way per scenario and lists every process from
// that run that survived. Each run gets a token in its environment, which every process it
// starts inherits; the check finds survivors by that token in /proc, so it never looks at,
// or touches, processes from other runs or other agents. Linux only.
//
//   sigterm  SIGTERM to the runner          -> nothing survives
//   sigint   SIGINT to the runner           -> nothing survives
//   sigkill  SIGKILL to the runner and its  -> Metro and the daemon survive the run, and the
//            Playwright workers                next run (left to finish) stops them
//
// Usage: node scripts/e2e-process-leak-check.mjs [sigterm|sigint|sigkill ...]
// Needs `npm run build:server` and the Playwright headless shell, like `npm run test:e2e`.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const appDir = path.resolve(import.meta.dirname, "..");
const spec = "e2e/browser/startup-loading.spec.ts";
const playwrightCli = path.join(
  path.dirname(createRequire(path.join(appDir, "package.json")).resolve("playwright/package.json")),
  "cli.js",
);
const TOKEN_KEY = "PASEO_E2E_LEAK_CHECK_TOKEN";
const STARTUP_TIMEOUT_MS = 240_000;
const EXIT_TIMEOUT_MS = 60_000;

function readProc(pid, file) {
  try {
    return readFileSync(`/proc/${pid}/${file}`, "utf8");
  } catch {
    return null;
  }
}

function processesWithToken(token) {
  const marker = `${TOKEN_KEY}=${token}`;
  const found = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;
    const environ = readProc(entry, "environ");
    if (!environ?.split("\0").includes(marker)) continue;
    const stat = readProc(entry, "stat");
    const cmdline = readProc(entry, "cmdline");
    if (!stat || cmdline === null) continue;
    // Fields after the parenthesised comm: state ppid pgrp ...
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z") continue;
    found.push({
      pid: Number(entry),
      ppid: Number(fields[1]),
      pgid: Number(fields[2]),
      command: cmdline.split("\0").join(" ").trim().slice(0, 140),
    });
  }
  return found.sort((a, b) => a.pid - b.pid);
}

function kind(proc) {
  if (/expo\/bin\/cli|expo start/u.test(proc.command)) return "metro";
  if (/supervisor-entrypoint|Paseo Supervisor|Paseo Daemon|Paseo Voice/u.test(proc.command)) {
    return "daemon";
  }
  return "other";
}

function printTable(title, procs) {
  console.log(`\n${title} (${procs.length})`);
  for (const proc of procs) {
    console.log(
      `  ${String(proc.pid).padStart(7)} ppid ${String(proc.ppid).padStart(7)} pgid ${String(proc.pgid).padStart(7)}  ${kind(proc).padEnd(6)} ${proc.command}`,
    );
  }
}

function startRun(token) {
  const env = { ...process.env, [TOKEN_KEY]: token };
  // A leaked PASEO_PASSWORD makes the worker daemon reject the seed client.
  delete env.PASEO_PASSWORD;
  delete env.CI;
  const runner = spawn(process.execPath, [playwrightCli, "test", "--project=browser", spec], {
    cwd: appDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let output = "";
  const capture = (chunk) => {
    output += chunk.toString("utf8");
  };
  runner.stdout.on("data", capture);
  runner.stderr.on("data", capture);
  const exited = new Promise((resolve) =>
    runner.once("exit", (code, signal) => resolve({ code, signal })),
  );
  return { runner, exited, output: () => output };
}

async function waitForHarness(token, run) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (run.runner.exitCode !== null || run.runner.signalCode !== null) {
      throw new Error(`Runner exited before the harness was up:\n${run.output()}`);
    }
    const procs = processesWithToken(token);
    if (procs.some((p) => kind(p) === "metro") && procs.some((p) => kind(p) === "daemon")) {
      // Let the daemon finish starting so the worker is mid-test, not mid-setup.
      await delay(3_000);
      return processesWithToken(token);
    }
    await delay(500);
  }
  throw new Error("Metro and the worker daemon did not both start");
}

async function settle(exited) {
  const result = await Promise.race([exited, delay(EXIT_TIMEOUT_MS).then(() => null)]);
  if (!result) throw new Error("Runner did not exit");
  // Give orphans' own shutdown a moment, so only real survivors are listed.
  await delay(3_000);
  return result;
}

async function signalScenario(signal) {
  const token = randomUUID();
  console.log(`\n=== ${signal} to the runner (token ${token}) ===`);
  const run = startRun(token);
  const before = await waitForHarness(token, run);
  printTable("Processes from the run before the signal", before);
  run.runner.kill(signal);
  const exit = await settle(run.exited);
  console.log(`Runner exited: code ${exit.code}, signal ${exit.signal}`);
  const survivors = processesWithToken(token);
  printTable(`Survivors after ${signal}`, survivors);
  return survivors.length === 0;
}

async function sigkillScenario() {
  const token = randomUUID();
  console.log(`\n=== SIGKILL to the runner and its workers (token ${token}) ===`);
  const run = startRun(token);
  const before = await waitForHarness(token, run);
  printTable("Processes from the run before SIGKILL", before);
  // The runner and its Playwright workers, as a timeout or the OOM killer would end them.
  const playwright = before.filter(
    (p) => p.command.startsWith(process.execPath) && p.command.includes("playwright"),
  );
  for (const proc of playwright) process.kill(proc.pid, "SIGKILL");
  await settle(run.exited);
  const leftovers = processesWithToken(token);
  printTable("Left behind by the killed run", leftovers);

  const freshToken = randomUUID();
  console.log(`\n--- fresh run, left to finish (token ${freshToken}) ---`);
  const fresh = startRun(freshToken);
  const exit = await Promise.race([fresh.exited, delay(STARTUP_TIMEOUT_MS * 2).then(() => null)]);
  if (!exit) throw new Error("Fresh run did not finish");
  await delay(3_000);
  const reapLines = fresh
    .output()
    .split("\n")
    .filter((line) => line.includes("left by"));
  console.log(`Fresh run exited: code ${exit.code}, signal ${exit.signal}`);
  console.log(reapLines.join("\n") || "  (fresh run reported no reaped groups)");
  const oldSurvivors = processesWithToken(token);
  const freshSurvivors = processesWithToken(freshToken);
  printTable("Survivors of the killed run after the fresh run", oldSurvivors);
  printTable("Survivors of the fresh run", freshSurvivors);
  return leftovers.length > 0 && oldSurvivors.length === 0 && freshSurvivors.length === 0;
}

if (process.platform !== "linux") {
  console.error("This check reads /proc and runs on Linux only.");
  process.exit(1);
}

const scenarios = process.argv.slice(2);
const selected = scenarios.length > 0 ? scenarios : ["sigterm", "sigint", "sigkill"];
const results = [];
for (const scenario of selected) {
  let passed;
  if (scenario === "sigterm") passed = await signalScenario("SIGTERM");
  else if (scenario === "sigint") passed = await signalScenario("SIGINT");
  else if (scenario === "sigkill") passed = await sigkillScenario();
  else throw new Error(`Unknown scenario ${scenario}`);
  results.push({ scenario, passed });
}
console.log("\n=== Result ===");
for (const { scenario, passed } of results)
  console.log(`  ${scenario}: ${passed ? "PASS" : "FAIL"}`);
process.exit(results.every((r) => r.passed) ? 0 : 1);
