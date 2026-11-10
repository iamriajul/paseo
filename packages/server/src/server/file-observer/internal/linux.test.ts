import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { closeSync, constants, openSync, read, writeSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { expect, test } from "vitest";
import {
  createFileObserver,
  FILE_OBSERVER_START_CONCURRENCY,
  FileObserverStartTimeoutError,
} from "../index.js";
import { createLinuxBackend, type ReadDirectory } from "./linux.js";
import { createObserverPaths } from "./paths.js";

// This backend keeps no file-level inventory and runs no periodic full-tree
// safety audit (see the comment on MAX_QUEUED_CLASSIFICATIONS in linux.ts), so
// a shed classification could never be recovered later the way the native
// backend's directory audit recovers one. Overflow must fail the observation
// loudly instead of silently dropping a create or delete.
test("the linux backend fails the observation when the classification queue overflows", async () => {
  const root = await mkdtemp(join(tmpdir(), "linux-classify-"));
  const paths = createObserverPaths(process.platform);
  const notifications = new EventEmitter();
  const observer = createFileObserver();
  let active = true;
  let failure: Error | null = null;
  const backend = createLinuxBackend(
    {
      root,
      metrics: observer.getDiagnostics(),
      isActive: () => active,
      isIgnored: () => false,
      isPathInside: paths.isInside,
      queueEvent: () => {},
      fail: (error) => {
        // Mirror the real Observation host: a failure ends the subscription,
        // so isActive() must flip immediately and further events must not be
        // processed.
        active = false;
        failure = error;
      },
    },
    paths,
    (_directory, listener) => {
      notifications.on("change", listener);
      return {
        close: () => notifications.removeAllListeners(),
        on: (event: string, onError: (error: Error) => void) => notifications.on(event, onError),
      } as never;
    },
  );
  try {
    await backend.start();
    // Emitted synchronously: no stat can settle before the last event lands,
    // so the queue grows monotonically until it overflows. Once it does,
    // isActive() flips false and the backend's own listener guard skips the
    // rest of the burst, so it's safe to keep emitting unconditionally.
    for (let index = 0; index < 20_000; index += 1) {
      notifications.emit("change", "rename", `module-${index}.js`);
    }
    expect(active).toBe(false);
    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toMatch(/exceeded \d+ queued classifications/);
  } finally {
    active = false;
    await backend.close();
    await observer.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an ignore update drains classifications queued below the new excluded root", async () => {
  const root = await mkdtemp(join(tmpdir(), "linux-ignore-queue-"));
  const ignored = join(root, "generated");
  await mkdir(ignored);
  const tracked = join(root, "tracked.txt");
  await writeFile(tracked, "tracked");
  // The backend is injected for deterministic queue admission, but its real
  // temporary root uses the host filesystem's path format.
  const paths = createObserverPaths(process.platform);
  let onRootChange: ((eventType: string, filename: string | null) => void) | null = null;
  const observer = createFileObserver();
  let active = true;
  let ignoreGenerated = false;
  const delivered: string[] = [];
  const backend = createLinuxBackend(
    {
      root,
      metrics: observer.getDiagnostics(),
      isActive: () => active,
      isIgnored: (path) => ignoreGenerated && paths.isInside(ignored, path),
      isPathInside: paths.isInside,
      queueEvent: (type, path) => {
        if (type === "create") delivered.push(path);
      },
      fail: (error) => {
        throw error;
      },
    },
    paths,
    (directory, listener) => {
      if (directory === root) onRootChange = listener;
      return {
        close: () => {},
        on: () => {},
      } as never;
    },
  );
  try {
    await backend.start();
    delivered.length = 0;
    for (let index = 0; index < 6_000; index += 1) {
      onRootChange?.("rename", `generated/file-${index}.js`);
    }
    onRootChange?.("rename", "tracked.txt");
    expect(backend.getDiagnostics().pendingClassificationCount).toBeGreaterThan(0);
    ignoreGenerated = true;
    await backend.updateIgnore();
    expect(backend.getDiagnostics().pendingClassificationCount).toBeLessThanOrEqual(1);
    await expect.poll(() => delivered.includes(tracked)).toBe(true);
  } finally {
    active = false;
    await backend.close();
    await observer.close();
    await rm(root, { recursive: true, force: true });
  }
});

// A pool-holding readdir: each call first reads one byte from its root's FIFO, which parks a
// libuv threadpool thread until the test writes a byte there. That is what a slow-disk readdir
// does to the four threads the whole daemon shares, made deterministic. One FIFO per root, so
// releasing one scan can never feed another.
async function createThreadpoolGate(roots: string[]) {
  const directory = await mkdtemp(join(tmpdir(), "linux-pool-gate-"));
  const fds = new Map<string, number>();
  for (const [index, root] of roots.entries()) {
    const fifo = join(directory, `gate-${index}`);
    execFileSync("mkfifo", [fifo]);
    // O_RDWR keeps the open from blocking and keeps reads waiting for data rather than EOF.
    fds.set(root, openSync(fifo, constants.O_RDWR));
  }
  const fdFor = (target: string) => {
    for (const [root, fd] of fds) {
      if (target === root || target.startsWith(`${root}${sep}`)) return fd;
    }
    throw new Error(`No gate for ${target}`);
  };
  const calls: Array<{ directory: string; settled: Promise<unknown> }> = [];
  const readDirectory: ReadDirectory = (target) => {
    const fd = fdFor(target);
    const settled = new Promise<void>((resolveRead, rejectRead) => {
      read(fd, Buffer.alloc(1), 0, 1, null, (error) => (error ? rejectRead(error) : resolveRead()));
    }).then(() => readdir(target, { withFileTypes: true }));
    calls.push({ directory: target, settled });
    return settled;
  };
  return {
    calls,
    readDirectory,
    release: (root: string, count: number) => writeSync(fdFor(root), Buffer.alloc(count)),
    async dispose() {
      // Unblock any thread still parked so the worker can exit.
      for (const fd of fds.values()) writeSync(fd, Buffer.alloc(256));
      await Promise.allSettled(calls.map((call) => call.settled));
      for (const fd of fds.values()) closeSync(fd);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function poolSize(): number {
  return Number(process.env.UV_THREADPOOL_SIZE) || 4;
}

test.skipIf(process.platform === "win32")(
  "a startup storm of initial scans leaves the threadpool free for other file reads",
  async () => {
    const paths = createObserverPaths(process.platform);
    const base = await mkdtemp(join(tmpdir(), "linux-storm-"));
    const transcript = join(base, "transcript.jsonl");
    await writeFile(transcript, "replayed line\n");
    // More roots than the pool has threads: unbounded, their scans take every thread.
    const roots = await Promise.all(
      Array.from({ length: poolSize() + 4 }, async (_, index) => {
        const root = join(base, `workspace-${index}`);
        await mkdir(join(root, "src"), { recursive: true });
        return root;
      }),
    );
    const gate = await createThreadpoolGate(roots);
    const observer = createFileObserver({
      createBackend: (host) => createLinuxBackend(host, paths, undefined, gate.readDirectory),
    });
    try {
      const subscriptions = roots.map((root) => observer.subscribe(root, () => {}));
      await expect
        .poll(() => gate.calls.length, { timeout: 10_000 })
        .toBe(FILE_OBSERVER_START_CONCURRENCY);

      const replay = readFile(transcript, "utf8").then(() => "read" as const);
      const stalled = new Promise<"stalled">((resolveStall) => {
        setTimeout(() => resolveStall("stalled"), 2_000).unref();
      });
      await expect(Promise.race([replay, stalled])).resolves.toBe("read");
      expect(gate.calls.length).toBe(FILE_OBSERVER_START_CONCURRENCY);

      for (const root of roots) gate.release(root, 2);
      const settled = await Promise.all(subscriptions);
      await Promise.all(settled.map((subscription) => subscription.unsubscribe()));
    } finally {
      await gate.dispose();
      await observer.close();
      await rm(base, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "a start deadline counts from admission and stops the scan when it expires",
  async () => {
    const paths = createObserverPaths(process.platform);
    const base = await mkdtemp(join(tmpdir(), "linux-deadline-"));
    const roots = await Promise.all(
      ["first", "second", "late"].map(async (name) => {
        const root = join(base, name);
        await mkdir(join(root, "nested", "deeper"), { recursive: true });
        return root;
      }),
    );
    const [first, second, late] = roots as [string, string, string];
    const gate = await createThreadpoolGate(roots);
    const observer = createFileObserver({
      createBackend: (host) => createLinuxBackend(host, paths, undefined, gate.readDirectory),
    });
    try {
      const admitted = [first, second].map((root) => observer.subscribe(root, () => {}));
      await expect
        .poll(() => gate.calls.length, { timeout: 10_000 })
        .toBe(FILE_OBSERVER_START_CONCURRENCY);
      let lateOutcome: unknown = "pending";
      const lateSubscription = observer.subscribe(late, () => {}, { startTimeoutMs: 50 });
      lateSubscription.then(
        () => {
          lateOutcome = "subscribed";
          return undefined;
        },
        (error: unknown) => {
          lateOutcome = error;
        },
      );

      // Queued behind the full start slots, well past its deadline, it has not expired.
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
      expect(lateOutcome).toBe("pending");

      // Let both admitted scans finish their three directories each so `late` is admitted.
      gate.release(first, 3);
      gate.release(second, 3);
      await expect
        .poll(() => gate.calls.some((call) => call.directory === late), { timeout: 10_000 })
        .toBe(true);
      await expect(lateSubscription).rejects.toBeInstanceOf(FileObserverStartTimeoutError);

      const lateCalls = () => gate.calls.filter((call) => paths.isInside(late, call.directory));
      expect(lateCalls()).toHaveLength(1);
      gate.release(late, 3);
      await Promise.allSettled(lateCalls().map((call) => call.settled));
      await new Promise((resolveTurn) => setImmediate(resolveTurn));
      // A scan left running would have read `late/nested` next.
      expect(lateCalls()).toHaveLength(1);

      const settled = await Promise.all(admitted);
      await Promise.all(settled.map((subscription) => subscription.unsubscribe()));
      expect(observer.getDiagnostics().nativeHandleCount).toBe(0);
    } finally {
      await gate.dispose();
      await observer.close();
      await rm(base, { recursive: true, force: true });
    }
  },
);
