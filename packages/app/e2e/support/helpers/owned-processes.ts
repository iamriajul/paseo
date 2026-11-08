import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Process groups the e2e harness started, so no run leaves Metro or a daemon behind.
 *
 * Each long-lived child (Metro, every daemon) leads its own process group, so stopping it
 * also stops the workers it forked. Each group is recorded in a per-checkout directory
 * under the OS temp dir, one file per group so concurrent Playwright workers never
 * rewrite each other's records. A record names the process that started the group.
 *
 * A run that dies without its teardown (SIGKILL, OOM, a crashed worker) leaves records
 * whose owner is gone. `reapOrphanedProcessGroups` stops those groups, at the start and
 * end of every run. It never matches by name: other agents run Metro and dev daemons on
 * the same box, so a group is stopped only when its leader still has the recorded
 * start time, or, with the leader gone, when the group still exists (the kernel keeps
 * a pgid from being reused while any member lives). The command line is not compared:
 * the daemon supervisor rewrites it with `process.title`.
 *
 * POSIX only. On Windows the harness keeps `taskkill /T` and records nothing.
 */

interface ProcessIdentity {
  pid: number;
  startedAt: string;
}

interface OwnedGroupRecord {
  pgid: number;
  leaderStartedAt: string;
  owner: ProcessIdentity;
  command: string;
  label: string;
}

export interface ReapedGroup {
  pgid: number;
  label: string;
  command: string;
}

const STOP_GRACE_MS = 5_000;
const KILL_GRACE_MS = 5_000;
const POLL_MS = 50;

const checkoutRoot = path.resolve(__dirname, "../../../../..");

export function ownedProcessRegistryDir(): string {
  const checkoutKey = createHash("sha256").update(checkoutRoot).digest("hex").slice(0, 16);
  return path.join(tmpdir(), "paseo-e2e-process-groups", checkoutKey);
}

const liveGroups = new Map<number, OwnedGroupRecord>();
let ownIdentity: ProcessIdentity | null = null;
let hooksInstalled = false;

function readStartTime(pid: number): string | null {
  try {
    const output = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const startedAt = output.trim().replace(/\s+/gu, " ");
    return startedAt || null;
  } catch {
    return null;
  }
}

function readPgid(pid: number): number | null {
  try {
    const output = execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const pgid = Number(output.trim());
    return Number.isInteger(pgid) && pgid > 0 ? pgid : null;
  } catch {
    return null;
  }
}

function currentIdentity(): ProcessIdentity {
  if (!ownIdentity) {
    const startedAt = readStartTime(process.pid);
    if (!startedAt) throw new Error(`Cannot read the start time of e2e process ${process.pid}`);
    ownIdentity = { pid: process.pid, startedAt };
  }
  return ownIdentity;
}

function isAlive(identity: ProcessIdentity): boolean {
  return readStartTime(identity.pid) === identity.startedAt;
}

function groupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    // EPERM means a member exists that we may not signal; it is not ours to stop.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether `record.pgid` still names the group this harness started. A leader with another
 * start time means the pid was reused, so the group is someone else's.
 */
function isRecordedGroup(record: OwnedGroupRecord): boolean {
  const leaderStartedAt = readStartTime(record.pgid);
  if (leaderStartedAt !== null) {
    return leaderStartedAt === record.leaderStartedAt && readPgid(record.pgid) === record.pgid;
  }
  return groupExists(record.pgid);
}

interface StopTargets {
  groups: number[];
  /** Descendants that joined a group they do not lead and the harness did not start. */
  processes: number[];
}

/**
 * The recorded group, plus every process its members started in a group of their own. The
 * daemon starts its terminal worker as a session leader so terminals outlive a daemon
 * restart; stopping only the daemon's group would orphan it. Collected before any signal,
 * while the parent links still lead back to the group.
 */
function collectStopTargets(pgid: number): StopTargets {
  let output: string;
  try {
    output = execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return { groups: [pgid], processes: [] };
  }
  const rows = output
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/u).map(Number))
    .map(([pid, ppid, group]) => ({ pid, ppid, pgid: group }));
  const childrenOf = new Map<number, typeof rows>();
  for (const row of rows) {
    const siblings = childrenOf.get(row.ppid) ?? [];
    siblings.push(row);
    childrenOf.set(row.ppid, siblings);
  }
  const owned = new Map<number, (typeof rows)[number]>();
  const queue = rows.filter((row) => row.pgid === pgid);
  while (queue.length > 0) {
    const row = queue.pop()!;
    if (owned.has(row.pid)) continue;
    owned.set(row.pid, row);
    queue.push(...(childrenOf.get(row.pid) ?? []));
  }
  const groups = new Set([pgid]);
  const processes: number[] = [];
  for (const row of owned.values()) {
    if (row.pgid === pgid) continue;
    if (owned.has(row.pgid)) groups.add(row.pgid);
    else processes.push(row.pid);
  }
  return { groups: [...groups], processes };
}

function signalTargets(targets: StopTargets, signal: NodeJS.Signals): void {
  for (const id of [...targets.groups.map((pgid) => -pgid), ...targets.processes]) {
    try {
      process.kill(id, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

function targetsExist(targets: StopTargets): boolean {
  return (
    targets.groups.some(groupExists) ||
    targets.processes.some((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    })
  );
}

async function waitForTargetsExit(targets: StopTargets, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (targetsExist(targets)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return true;
}

function recordPath(pgid: number): string {
  return path.join(ownedProcessRegistryDir(), `${pgid}.json`);
}

function forgetRecord(pgid: number): void {
  liveGroups.delete(pgid);
  try {
    unlinkSync(recordPath(pgid));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function stopRecordedGroup(record: OwnedGroupRecord): Promise<void> {
  if (!isRecordedGroup(record)) return;
  const targets = collectStopTargets(record.pgid);
  signalTargets(targets, "SIGTERM");
  if (await waitForTargetsExit(targets, STOP_GRACE_MS)) return;
  signalTargets(targets, "SIGKILL");
  if (!(await waitForTargetsExit(targets, KILL_GRACE_MS))) {
    throw new Error(`Process group ${record.pgid} (${record.label}) survived SIGKILL`);
  }
}

/** Records a child spawned with `detached: true` as an owned process group. */
export function registerOwnedProcessGroup(pid: number, label: string, command: string): void {
  const leaderStartedAt = readStartTime(pid);
  // A child that already exited leaves nothing to own.
  if (!leaderStartedAt) return;
  const record: OwnedGroupRecord = {
    pgid: pid,
    leaderStartedAt,
    owner: currentIdentity(),
    command,
    label,
  };
  mkdirSync(ownedProcessRegistryDir(), { recursive: true });
  writeFileSync(recordPath(pid), `${JSON.stringify(record)}\n`);
  liveGroups.set(pid, record);
  installExitHooks();
}

export function isOwnedProcessGroup(pid: number | undefined): boolean {
  return pid !== undefined && liveGroups.has(pid);
}

/** SIGTERM the whole group, SIGKILL it after a grace period, then drop its record. */
export async function stopOwnedProcessGroup(pgid: number): Promise<void> {
  const record = liveGroups.get(pgid);
  if (!record) return;
  await stopRecordedGroup(record);
  forgetRecord(pgid);
}

function readRecords(): OwnedGroupRecord[] {
  let entries: string[];
  try {
    entries = readdirSync(ownedProcessRegistryDir());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: OwnedGroupRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      records.push(JSON.parse(readFileSync(path.join(ownedProcessRegistryDir(), entry), "utf8")));
    } catch {
      // A record mid-write by a live run; the next reap sees it whole.
    }
  }
  return records;
}

/**
 * Stops every recorded group whose owner has exited, in this checkout only. Groups owned by
 * a live process (this run, or a concurrent run in the same checkout) are left alone.
 */
export async function reapOrphanedProcessGroups(): Promise<ReapedGroup[]> {
  if (process.platform === "win32") return [];
  const reaped: ReapedGroup[] = [];
  for (const record of readRecords()) {
    if (isAlive(record.owner)) continue;
    if (isRecordedGroup(record)) {
      await stopRecordedGroup(record);
      reaped.push({ pgid: record.pgid, label: record.label, command: record.command });
    }
    forgetRecord(record.pgid);
  }
  return reaped;
}

function killLiveGroupsNow(): void {
  for (const record of liveGroups.values()) {
    try {
      if (isRecordedGroup(record)) signalTargets(collectStopTargets(record.pgid), "SIGKILL");
      forgetRecord(record.pgid);
    } catch {
      // Exit must not throw; the next run reaps whatever is left.
    }
  }
}

async function stopLiveGroups(): Promise<void> {
  await Promise.allSettled([...liveGroups.keys()].map((pgid) => stopOwnedProcessGroup(pgid)));
}

/**
 * `exit` covers a normal end, an uncaught error and Playwright's forced exit after a
 * second Ctrl-C. SIGTERM and SIGHUP kill Node without an `exit` event, so they are handled
 * too, but only where nothing else handles them: Playwright workers deliberately ignore
 * both and wait for the runner, and the runner handles SIGINT by running teardown.
 */
function installExitHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  process.on("exit", killLiveGroupsNow);
  for (const signal of ["SIGTERM", "SIGHUP"] as const) {
    if (process.listenerCount(signal) > 0) continue;
    const onSignal = () => {
      void stopLiveGroups().finally(() => {
        process.off(signal, onSignal);
        process.kill(process.pid, signal);
      });
    };
    process.on(signal, onSignal);
  }
}
