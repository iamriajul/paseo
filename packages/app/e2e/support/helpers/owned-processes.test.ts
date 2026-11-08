import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, test } from "vitest";
import { ownedProcessRegistryDir, reapOrphanedProcessGroups } from "./owned-processes";

const spawnNodePath = path.resolve(__dirname, "spawn-node.ts");
const started: number[] = [];

function groupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface Owner {
  owner: ChildProcess;
  pgid: number;
  /** A descendant in a session of its own, the shape of the daemon's terminal worker. */
  sessionLeader: number;
}

/**
 * A harness process that starts one owned group: a shell leader with a forked `sleep` (Metro
 * and its workers) and a `setsid` child (the daemon's terminal worker). `afterStart` decides
 * how the owner ends.
 */
async function startOwner(afterStart: string): Promise<Owner> {
  const pidFile = path.join(mkdtempSync(path.join(tmpdir(), "owned-processes-test-")), "pid");
  const shell = `sleep 300 & setsid sleep 300 & echo $! > ${pidFile}; exec sleep 300`;
  const script = `
    const { spawnOwned } = require(${JSON.stringify(spawnNodePath)});
    const child = spawnOwned("sh", ["-c", ${JSON.stringify(shell)}], {
      label: "owned-processes test", stdio: "ignore",
    });
    console.log(child.pid);
    ${afterStart}
  `;
  const owner = spawn(process.execPath, ["--import", "tsx", "-e", script], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = once(owner, "exit").then(([code]) => {
    throw new Error(`Owner exited with ${String(code)} before starting its group`);
  });
  exited.catch(() => undefined);
  const firstLine = once(createInterface({ input: owner.stdout! }), "line");
  const [line] = (await Promise.race([firstLine, exited])) as [string];
  const pgid = Number(line);
  started.push(pgid);
  await waitFor(() => groupExists(pgid));
  await waitFor(() => /^\d+\n$/u.test(readFileSafe(pidFile)));
  const sessionLeader = Number(readFileSync(pidFile, "utf8"));
  started.push(sessionLeader);
  rmSync(path.dirname(pidFile), { recursive: true, force: true });
  return { owner, pgid, sessionLeader };
}

function readFileSafe(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

afterEach(() => {
  for (const pgid of started.splice(0)) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // Already gone, which is what the test asserted.
    }
  }
});

describe.skipIf(process.platform === "win32")("owned e2e process groups", () => {
  test("a run killed with SIGKILL leaves its group for the next run to stop", async () => {
    const { owner, pgid, sessionLeader } = await startOwner("setInterval(() => {}, 1000);");
    owner.kill("SIGKILL");
    await once(owner, "exit");
    expect(groupExists(pgid)).toBe(true);
    expect(processExists(sessionLeader)).toBe(true);

    const reaped = await reapOrphanedProcessGroups();

    expect(reaped.map((group) => group.pgid)).toContain(pgid);
    expect(groupExists(pgid)).toBe(false);
    expect(processExists(sessionLeader)).toBe(false);
  }, 30_000);

  test("a live run's group is left alone, and SIGTERM to that run stops it", async () => {
    const { owner, pgid, sessionLeader } = await startOwner("setInterval(() => {}, 1000);");

    const reaped = await reapOrphanedProcessGroups();
    expect(reaped.map((group) => group.pgid)).not.toContain(pgid);
    expect(groupExists(pgid)).toBe(true);

    owner.kill("SIGTERM");
    const [, signal] = await once(owner, "exit");
    expect(signal).toBe("SIGTERM");
    expect(groupExists(pgid)).toBe(false);
    expect(processExists(sessionLeader)).toBe(false);
  }, 30_000);

  test("a run that exits without teardown takes its group with it", async () => {
    const { owner, pgid } = await startOwner("setTimeout(() => process.exit(3), 100);");
    const [code] = await once(owner, "exit");
    expect(code).toBe(3);
    await waitFor(() => !groupExists(pgid));
  }, 30_000);

  test("a record whose pgid now names another process's group is not touched", async () => {
    const stranger = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
    const pgid = stranger.pid!;
    started.push(pgid);
    mkdirSync(ownedProcessRegistryDir(), { recursive: true });
    writeFileSync(
      path.join(ownedProcessRegistryDir(), `${pgid}.json`),
      JSON.stringify({
        pgid,
        leaderStartedAt: "Thu Jan 1 00:00:00 1970",
        owner: { pid: 999_999_999, startedAt: "Thu Jan 1 00:00:00 1970" },
        command: "sleep 300",
        label: "reused pid",
      }),
    );

    const reaped = await reapOrphanedProcessGroups();

    expect(reaped.map((group) => group.pgid)).not.toContain(pgid);
    expect(groupExists(pgid)).toBe(true);
  }, 30_000);
});
