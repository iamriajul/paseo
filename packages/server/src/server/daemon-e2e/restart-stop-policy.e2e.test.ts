import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { AgentStorage } from "../agent/agent-storage.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { DaemonClient } from "../test-utils/daemon-client.js";

// Restart recovery resumes what the daemon stopped on its own, and never what a person stopped.
// Each case runs real daemon processes through the stop-policy fixture.

const RESUME_PROMPT = "Resume working.";
const CASE_TIMEOUT_MS = 60_000;

interface StartedFixture {
  child: ChildProcess;
  port: number;
  paseoHome: string;
  cwd: string;
}

interface Scenario {
  root: string;
  children: ChildProcess[];
  client?: DaemonClient;
}

type StopRequest = (first: StartedFixture, client: DaemonClient) => Promise<unknown>;

const intentionalStops: Array<[string, StopRequest]> = [
  ["the shutdown RPC", (_first, client) => client.shutdownServer()],
  ["the restart RPC", (_first, client) => client.restartServer()],
  [
    "Ctrl-C",
    (first) => {
      first.child.kill("SIGINT");
      return Promise.resolve();
    },
  ],
];

async function startFixture(root: string): Promise<StartedFixture> {
  const child = fork(
    fileURLToPath(new URL("../test-utils/restart-stop-daemon.ts", import.meta.url)),
    [root, JSON.stringify({ resumeOnStartup: true })],
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
  const ready = await Promise.race([
    once(child, "message").then(
      ([message]) => message as { port: number; paseoHome: string; cwd: string },
    ),
    once(child, "exit").then(([code]) => {
      throw new Error(`Fixture exited ${code}: ${output}`);
    }),
  ]);
  return { child, ...ready };
}

function storageOf(paseoHome: string): AgentStorage {
  return new AgentStorage(path.join(paseoHome, "agents"), createTestLogger());
}

async function countResumePrompts(root: string): Promise<number> {
  let text: string;
  try {
    text = await readFile(path.join(root, "all-prompts.jsonl"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => (JSON.parse(line) as { prompt: unknown }).prompt)
    .filter((prompt) => prompt === RESUME_PROMPT).length;
}

function ignoreFailure(pending: Promise<unknown>): Promise<unknown> {
  return pending.catch(() => undefined);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

async function withScenario(body: (scenario: Scenario) => Promise<void>): Promise<void> {
  const scenario: Scenario = {
    root: await mkdtemp(path.join(tmpdir(), "restart-stop-policy-")),
    children: [],
  };
  try {
    await body(scenario);
  } finally {
    await scenario.client?.close();
    await Promise.all(scenario.children.map(stopChild));
    await rm(scenario.root, { recursive: true, force: true });
  }
}

/** Boots a daemon and leaves one agent running on a turn that never finishes. */
async function bootWithRunningAgent(scenario: Scenario): Promise<{
  first: StartedFixture;
  client: DaemonClient;
  agentId: string;
}> {
  const first = await startFixture(scenario.root);
  scenario.children.push(first.child);
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${first.port}/ws`,
    appVersion: "0.13.0",
  });
  scenario.client = client;
  await client.connect();
  const agent = await client.createAgent({
    provider: "claude",
    cwd: first.cwd,
    title: "Running when stopped",
    modeId: "full-access",
  });
  await client.sendMessage(agent.id, "HOLD_CHILD");
  await expect
    .poll(async () => (await storageOf(first.paseoHome).get(agent.id))?.lastStatus, {
      timeout: 10_000,
    })
    .toBe("running");
  return { first, client, agentId: agent.id };
}

describe("restart recovery and the stops a person asks for", () => {
  test.each(intentionalStops)(
    "a stop by %s leaves the running agent down after restart",
    async (_how, stop) => {
      await withScenario(async (scenario) => {
        const { first, client, agentId } = await bootWithRunningAgent(scenario);
        const exited = once(first.child, "exit");
        // The daemon may close the socket before the RPC reply arrives. The exit is what matters.
        await ignoreFailure(stop(first, client));
        await exited;
        await client.close();
        scenario.client = undefined;
        expect(await storageOf(first.paseoHome).get(agentId)).toMatchObject({
          lastStatus: "closed",
          stoppedByUser: true,
        });

        const second = await startFixture(scenario.root);
        scenario.children.push(second.child);
        expect(await storageOf(second.paseoHome).get(agentId)).toMatchObject({
          resumeOnStartup: false,
        });
        expect(await countResumePrompts(scenario.root)).toBe(0);
      });
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "an OS SIGTERM resumes the agent that was running",
    async () => {
      await withScenario(async (scenario) => {
        const { first, client } = await bootWithRunningAgent(scenario);
        const exited = once(first.child, "exit");
        first.child.kill("SIGTERM");
        await exited;
        await client.close();
        scenario.client = undefined;

        const second = await startFixture(scenario.root);
        scenario.children.push(second.child);
        const resumes = (): Promise<number> => countResumePrompts(scenario.root);
        await expect.poll(resumes, { timeout: 15_000 }).toBe(1);
      });
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "clearing the miss count of a stopped agent leaves it stopped",
    async () => {
      await withScenario(async (scenario) => {
        const { first, client, agentId } = await bootWithRunningAgent(scenario);
        const exited = once(first.child, "exit");
        await ignoreFailure(client.shutdownServer());
        await exited;
        await client.close();
        scenario.client = undefined;

        const second = await startFixture(scenario.root);
        scenario.children.push(second.child);
        const reopened = new DaemonClient({
          url: `ws://127.0.0.1:${second.port}/ws`,
          appVersion: "0.13.0",
        });
        scenario.client = reopened;
        await reopened.connect();
        // Clearing loads the stored agent so its count can persist. That load is not a use.
        await reopened.clearPromptCacheMisses({ agentIds: [agentId] });
        expect(await storageOf(second.paseoHome).get(agentId)).toMatchObject({
          stoppedByUser: true,
        });
        expect(await countResumePrompts(scenario.root)).toBe(0);
      });
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "a prompt the user sends to a stopped agent ends the stop",
    async () => {
      await withScenario(async (scenario) => {
        const { first, client, agentId } = await bootWithRunningAgent(scenario);
        const exited = once(first.child, "exit");
        await ignoreFailure(client.shutdownServer());
        await exited;
        await client.close();
        scenario.client = undefined;

        const second = await startFixture(scenario.root);
        scenario.children.push(second.child);
        const reopened = new DaemonClient({
          url: `ws://127.0.0.1:${second.port}/ws`,
          appVersion: "0.13.0",
        });
        scenario.client = reopened;
        await reopened.connect();
        await reopened.sendMessage(agentId, "Are you there?");
        const stopFlag = async (): Promise<boolean | undefined> => {
          const record = await storageOf(second.paseoHome).get(agentId);
          return record?.stoppedByUser;
        };
        await expect.poll(stopFlag, { timeout: 15_000 }).toBeUndefined();
      });
    },
    CASE_TIMEOUT_MS,
  );
});
