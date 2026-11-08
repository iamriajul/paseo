import {
  execFile,
  fork,
  spawn,
  type ChildProcess,
  type ForkOptions,
  type SpawnOptions,
} from "node:child_process";
import { once } from "node:events";
import {
  isOwnedProcessGroup,
  registerOwnedProcessGroup,
  stopOwnedProcessGroup,
} from "./owned-processes";

const isWindows = process.platform === "win32";

function own(child: ChildProcess, label: string, command: string): ChildProcess {
  if (!isWindows && child.pid !== undefined) registerOwnedProcessGroup(child.pid, label, command);
  return child;
}

/**
 * Spawns a long-lived harness child (Metro, a daemon) as the leader of its own process
 * group and records the group, so `killProcessTree` stops everything it forked and a run
 * that dies before teardown is reaped by the next one. See `owned-processes.ts`.
 * Windows keeps the child in the console's job and relies on `taskkill /T`.
 */
export function spawnOwned(
  command: string,
  args: string[],
  options: SpawnOptions & { label: string },
): ChildProcess {
  const { label, ...spawnOptions } = options;
  const child = spawn(command, args, { ...spawnOptions, detached: !isWindows });
  return own(child, label, [command, ...args].join(" "));
}

/** `fork` counterpart of `spawnOwned`, for children that report readiness over IPC. */
export function forkOwned(
  modulePath: string,
  options: ForkOptions & { label: string },
): ChildProcess {
  const { label, ...forkOptions } = options;
  const child = fork(modulePath, { ...forkOptions, detached: !isWindows });
  return own(child, label, `${process.execPath} ${modulePath}`);
}

/**
 * Runs a repo-local TypeScript entrypoint through Node's own tsx loader instead
 * of the `node_modules/.bin/tsx` shim.
 *
 * The shim is a platform trap, not a convenience: on Windows it is `tsx.cmd`,
 * and Node refuses to spawn `.cmd`/`.bat` without `shell: true` (EINVAL, from
 * the CVE-2024-27980 mitigation). Opting into `shell: true` to get around that
 * trades one bug for three — argv is concatenated unescaped (DEP0190), a path
 * containing spaces splits, and the kill signal lands on `cmd.exe` while the
 * real child keeps the port. Spawning `process.execPath` has none of those
 * properties and is byte-identical on POSIX, so there is no platform branch.
 */
export function spawnTsx(
  entrypoint: string,
  args: string[],
  options: SpawnOptions & { label: string },
): ChildProcess {
  if (entrypoint.startsWith("-")) {
    throw new Error(`TypeScript entrypoint must be a path, received ${entrypoint}`);
  }
  return spawnOwned(process.execPath, ["--import", "tsx", "--", entrypoint, ...args], options);
}

/**
 * Terminates a child and everything it forked, then waits for the exit.
 *
 * `child.kill()` on Windows maps to `TerminateProcess` against the direct child
 * only. Metro and the daemon supervisor both fork workers, so the signal leaves
 * grandchildren holding the listening port and the next run fails to bind.
 * `taskkill /T` walks the tree. On POSIX a child from `spawnOwned` leads its own
 * process group, and the SIGTERM-then-SIGKILL ladder goes to the whole group, which also
 * runs after the leader has exited and left forked workers behind.
 */
export async function killProcessTree(child: ChildProcess | null): Promise<void> {
  if (!child) return;
  if (!isWindows && isOwnedProcessGroup(child.pid)) {
    await stopOwnedProcessGroup(child.pid as number);
    return;
  }
  if (hasExited(child)) return;
  const exited = once(child, "exit").then(() => undefined);

  if (isWindows) {
    const pid = child.pid;
    if (pid === undefined) {
      throw new Error("Cannot terminate a Windows process tree without a PID");
    }

    // Register the exit listener before taskkill to avoid missing a fast exit.
    // Bound taskkill itself so a stuck system utility cannot hang teardown.
    const completed = Promise.withResolvers<Error | null>();
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { timeout: 5_000 }, (error) =>
      completed.resolve(error),
    );
    const taskkillError = await completed.promise;
    if (taskkillError && !hasExited(child)) {
      try {
        child.kill("SIGKILL");
      } catch {
        // The child can exit between the state check and the direct kill.
      }
      await waitForExitOrTimeout(exited, 5_000);
      throw new Error(`Failed to terminate process tree for PID ${pid}`, { cause: taskkillError });
    }
    if (!hasExited(child) && !(await waitForExitOrTimeout(exited, 5_000))) {
      throw new Error(`Process tree for PID ${pid} did not exit after taskkill`);
    }
    return;
  }

  child.kill("SIGTERM");
  if (await waitForExitOrTimeout(exited, 5_000)) return;

  child.kill("SIGKILL");
  if (!(await waitForExitOrTimeout(exited, 5_000))) {
    throw new Error(`Process ${String(child.pid)} did not exit after SIGKILL`);
  }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForExitOrTimeout(exited: Promise<void>, timeoutMs: number): Promise<boolean> {
  const timedOut = Promise.withResolvers<boolean>();
  const timeout = setTimeout(() => timedOut.resolve(false), timeoutMs);
  try {
    return await Promise.race([exited.then(() => true), timedOut.promise]);
  } finally {
    clearTimeout(timeout);
  }
}
