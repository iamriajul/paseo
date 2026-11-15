import { AgentStorage } from "../agent/agent-storage.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";
import type { PersistenceHandle } from "@getpaseo/protocol/messages";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-restart-resume-"));
}

describe("daemon restart resume", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  }, 60_000);

  test("Codex agent survives daemon restart with persistence handle", async () => {
    const cwd = tmpCwd();
    const marker = `DAEMON_RESTART_MARKER_${Date.now()}`;
    try {
      const agent = await ctx.client.createAgent({
        provider: "codex",
        cwd,
        title: "Daemon Restart Test Agent",
        modeId: "full-access",
      });

      await ctx.client.sendMessage(
        agent.id,
        `Remember this marker string for a test: "${marker}".`,
      );

      const afterRemember = await ctx.client.waitForFinish(agent.id, 5_000);
      expect(afterRemember.status).toBe("idle");
      expect(afterRemember.final?.persistence).toBeTruthy();
      expect(afterRemember.final!.persistence!.metadata).toMatchObject({ marker });

      const handle = afterRemember.final!.persistence as PersistenceHandle;

      await ctx.cleanup();
      ctx = await createDaemonTestContext();

      const resumed = await ctx.client.resumeAgent(handle);
      await ctx.client.sendMessage(
        resumed.id,
        "What was the marker string I asked you to remember earlier?",
      );

      const afterRecall = await ctx.client.waitForFinish(resumed.id, 5_000);
      expect(afterRecall.status).toBe("idle");
      expect(afterRecall.final?.persistence).toBeTruthy();
      expect(afterRecall.final!.persistence!.metadata).toMatchObject({ marker });

      await ctx.client.deleteAgent(resumed.id);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);
});

// These run in separate OS processes so SIGKILL cannot invoke daemon shutdown hooks.
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import type { FinishSubscriptionDaemonStart } from "../test-utils/finish-subscription-daemon.js";

interface FixtureDaemon {
  port: number;
  paseoHome: string;
  cwd: string;
}
type FixtureMessage = { loaded: true } | { prompt: string } | FixtureDaemon;

/** Forks a fixture process. It loads the daemon's modules at once and creates its daemon on `start`. */
function forkFixture(root: string) {
  const child = fork(
    fileURLToPath(new URL("../test-utils/finish-subscription-daemon.ts", import.meta.url)),
    [root],
    {
      execArgv: ["--conditions=source", "--import", "tsx"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let output = "";
  child.stdout?.on("data", (data) => {
    output += data;
  });
  child.stderr?.on("data", (data) => {
    output += data;
  });
  const exited = once(child, "exit").then(([code]): never => {
    throw new Error(`Fixture exited ${code}: ${output}`);
  });
  exited.catch(() => undefined);
  const loaded = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<FixtureDaemon>();
  const prompts: string[] = [];
  const promptWaiters = new Set<{
    matches(prompt: string): boolean;
    resolve(prompt: string): void;
  }>();
  child.on("message", (message: FixtureMessage) => {
    if ("loaded" in message) loaded.resolve();
    else if ("prompt" in message) {
      prompts.push(message.prompt);
      for (const waiter of promptWaiters) {
        if (!waiter.matches(message.prompt)) continue;
        promptWaiters.delete(waiter);
        waiter.resolve(message.prompt);
      }
    } else ready.resolve(message);
  });
  /** Resolves once an agent of this process's daemon starts a turn with a matching prompt. */
  async function prompt(matches: (prompt: string) => boolean): Promise<string> {
    const seen = prompts.find(matches);
    if (seen !== undefined) return seen;
    const waiter = Promise.withResolvers<string>();
    promptWaiters.add({ matches, resolve: waiter.resolve });
    return Promise.race([waiter.promise, exited]);
  }
  return {
    child,
    loaded: Promise.race([loaded.promise, exited]),
    async start(
      settings: FinishSubscriptionDaemonStart["settings"] = {},
      fixture: FinishSubscriptionDaemonStart["fixture"] = {},
    ) {
      await Promise.race([loaded.promise, exited]);
      child.send({ start: { settings, fixture } satisfies FinishSubscriptionDaemonStart });
      return { child, prompt, ...(await Promise.race([ready.promise, exited])) };
    },
  };
}
type Fixture = ReturnType<typeof forkFixture>;
async function stopFixture(child: ChildProcess, abrupt: boolean) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  if (abrupt) child.kill("SIGKILL");
  else child.send("stop");
  await exited;
}
async function readPrompts(root: string): Promise<string[]> {
  try {
    return (await readFile(path.join(root, "parent-prompts.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

// Each test below restarts the daemon into up to three processes, forked and loaded before it
// starts. Loading the daemon from source takes 20-30 s on a busy machine; paid at each restart
// inside a test, it used up the test's time before the restarted daemon had resumed anything.
let root: string;
let fixtures: [Fixture, Fixture, Fixture];
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "daemon-restart-process-"));
  fixtures = [forkFixture(root), forkFixture(root), forkFixture(root)];
  await Promise.all(fixtures.map((fixture) => fixture.loaded));
});
afterEach(async () => {
  for (const fixture of fixtures.toReversed()) await stopFixture(fixture.child, true);
  await rm(root, { recursive: true, force: true });
});

test.each([false, true])(
  "durable finish subscriptions recover a running child after restart (abrupt=%s)",
  async (abrupt) => {
    let client: DaemonClient | undefined;
    let mcp: Client | undefined;
    try {
      const first = await fixtures[0].start({ resumeOnStartup: true });
      client = new DaemonClient({ url: `ws://127.0.0.1:${first.port}/ws`, appVersion: "0.13.0" });
      await client.connect();
      await client.fetchAgents({ subscribe: {} });
      const parent = await client.createAgent({
        provider: "claude",
        cwd: first.cwd,
        title: "Durable parent",
        modeId: "full-access",
      });
      mcp = new Client({ name: "durable-parent", version: "1" });
      await mcp.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${first.port}/mcp/agents?callerAgentId=${parent.id}`),
        ),
      );
      const result = await mcp.callTool({
        name: "create_agent",
        arguments: {
          provider: "claude/claude-test",
          title: "Held child",
          initialPrompt: "HOLD_CHILD",
        },
      });
      expect(result.isError).not.toBe(true);
      const childId = (result.structuredContent as { agentId: string }).agentId;
      expect((await client.fetchAgent(childId))?.agent.status).toBe("running");
      // Kill only after the running snapshot commits, so this exercises bootstrap repair
      // rather than recovery of the earlier idle snapshot while its write is pending.
      await expect
        .poll(
          async () =>
            (
              await new AgentStorage(path.join(first.paseoHome, "agents"), createTestLogger()).get(
                childId,
              )
            )?.lastStatus,
        )
        .toBe("running");
      expect(
        JSON.parse(await readFile(path.join(first.paseoHome, "finish-subscriptions.json"), "utf8")),
      ).toHaveLength(1);
      await mcp.close();
      mcp = undefined;
      await client.close();
      client = undefined;
      await stopFixture(first.child, abrupt);
      const second = await fixtures[1].start({ resumeOnStartup: true });
      await second.prompt((prompt) => prompt.includes('kind="agent-notification"'));
      const prompts = await readPrompts(root);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain(`Agent ${childId}`);
      expect(prompts[0]).not.toContain("was closed");
      const recoveredPrompts = (await readFile(path.join(root, "all-prompts.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(recoveredPrompts.filter((entry) => entry.prompt === "Resume working.")).toHaveLength(
        1,
      );
      const restored = recoveredPrompts.find((entry) => entry.prompt === "Resume working.").config;
      const original = recoveredPrompts.find((entry) =>
        String(entry.prompt).includes("HOLD_CHILD"),
      ).config;
      expect(restored).toMatchObject({
        provider: original.provider,
        model: original.model,
        modeId: original.modeId,
        cwd: original.cwd,
      });

      await expect
        .poll(
          async () =>
            JSON.parse(
              await readFile(path.join(second.paseoHome, "finish-subscriptions.json"), "utf8"),
            ),
          { timeout: 5000 },
        )
        .toEqual([]);
      client = new DaemonClient({ url: `ws://127.0.0.1:${second.port}/ws`, appVersion: "0.13.0" });
      await client.connect();
      await client.fetchAgents({ subscribe: {} });
      expect((await client.fetchAgent(childId))?.agent.status).toBe("idle");
      await client.close();
      client = undefined;
      await stopFixture(second.child, false);
      const third = await fixtures[2].start({ resumeOnStartup: true });
      expect(await readPrompts(root)).toHaveLength(1);
      expect(
        JSON.parse(await readFile(path.join(third.paseoHome, "finish-subscriptions.json"), "utf8")),
      ).toEqual([]);
    } catch (error) {
      console.error(
        await readFile(path.join(root, "fixture.log"), "utf8").catch(() => "No fixture log"),
      );
      throw error;
    } finally {
      await mcp?.close();
      await client?.close();
    }
  },
  60000,
);

test.each([undefined, false, true])(
  "host restart recovery settings (enabled=%s)",
  async (enabled) => {
    let client: DaemonClient | undefined;
    const settings = { resumeOnStartup: enabled, resumePrompt: "Continue exactly.\n" };
    try {
      const first = await fixtures[0].start(settings);
      client = new DaemonClient({ url: `ws://127.0.0.1:${first.port}/ws`, appVersion: "0.13.0" });
      await client.connect();
      const working = await client.createAgent({
        provider: "claude",
        cwd: first.cwd,
        modeId: "full-access",
      });
      const idle = await client.createAgent({
        provider: "claude",
        cwd: first.cwd,
        modeId: "full-access",
      });
      await client.sendMessage(working.id, "HOLD_CHILD");
      await expect
        .poll(
          async () =>
            (
              await new AgentStorage(path.join(first.paseoHome, "agents"), createTestLogger()).get(
                working.id,
              )
            )?.lastStatus,
        )
        .toBe("running");
      const original = await new AgentStorage(
        path.join(first.paseoHome, "agents"),
        createTestLogger(),
      ).get(working.id);
      await client.close();
      client = undefined;
      await stopFixture(first.child, false);
      const second = await fixtures[1].start(settings);
      client = new DaemonClient({ url: `ws://127.0.0.1:${second.port}/ws`, appVersion: "0.13.0" });
      await client.connect();
      const storage = new AgentStorage(path.join(second.paseoHome, "agents"), createTestLogger());
      // Startup consumes the saved intent before the daemon listens, and a resume it keeps runs
      // in the background: that one is done once its prompt starts.
      if (enabled) await second.prompt((prompt) => prompt === settings.resumePrompt);
      expect((await storage.get(working.id))?.resumeOnStartup).toBe(false);
      const resumePrompts = (await readFile(path.join(root, "all-prompts.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.prompt === settings.resumePrompt);
      expect(resumePrompts).toHaveLength(enabled ? 1 : 0);
      expect((await client.fetchAgent(idle.id))?.agent.status).toBe("closed");
      const restored = await storage.get(working.id);
      expect(restored?.persistence?.sessionId).toBe(original?.persistence?.sessionId);
    } finally {
      await client?.close();
    }
  },
  60000,
);

test("a provider that is slow to reopen does not hold daemon startup", async () => {
  let client: DaemonClient | undefined;
  try {
    const first = await fixtures[0].start({ resumeOnStartup: true });
    client = new DaemonClient({ url: `ws://127.0.0.1:${first.port}/ws`, appVersion: "0.13.0" });
    await client.connect();
    const working = await client.createAgent({
      provider: "claude",
      cwd: first.cwd,
      modeId: "full-access",
    });
    await client.sendMessage(working.id, "HOLD_CHILD");
    await expect
      .poll(
        async () =>
          (
            await new AgentStorage(path.join(first.paseoHome, "agents"), createTestLogger()).get(
              working.id,
            )
          )?.lastStatus,
      )
      .toBe("running");
    await client.close();
    client = undefined;
    await stopFixture(first.child, false);

    const second = await fixtures[1].start({ resumeOnStartup: true }, { holdResume: true });
    client = new DaemonClient({ url: `ws://127.0.0.1:${second.port}/ws`, appVersion: "0.13.0" });
    await client.connect();
    expect((await client.fetchAgent(working.id))?.agent.id).toBe(working.id);
    second.child.send("release-resume");
    await second.prompt((prompt) => prompt === "Resume working.");
    expect(
      (await readFile(path.join(root, "all-prompts.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).prompt)
        .filter((prompt) => prompt === "Resume working."),
    ).toHaveLength(1);
  } finally {
    await client?.close();
  }
}, 30000);
