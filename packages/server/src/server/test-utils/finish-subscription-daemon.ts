import pino from "pino";
// Isolated process fixture for restart/termination tests. Never targets a developer home.
// Loading the daemon's modules from source is most of a cold start, so a test forks the process
// for a restart ahead of time: it loads, reports "loaded", and creates its daemon on "start".
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "./paseo-daemon.js";
import { createTestAgentClients } from "./fake-agent-client.js";

export interface FinishSubscriptionDaemonStart {
  settings: { resumeOnStartup?: boolean; resumePrompt?: string };
  fixture: { holdResume?: boolean };
}

const root = process.argv[2];
const send = process.send?.bind(process);
if (!root || !send) throw new Error("Expected isolated test home and IPC parent");
await mkdir(join(root, "static"), { recursive: true });
const held = Promise.withResolvers<void>();
const resumeReleased = Promise.withResolvers<void>();
let daemon: TestPaseoDaemon | undefined;

const start = async ({ settings, fixture }: FinishSubscriptionDaemonStart): Promise<void> => {
  if (!fixture.holdResume) resumeReleased.resolve();
  daemon = await createTestPaseoDaemon({
    paseoHomeRoot: root,
    ...settings,
    staticDir: join(root, "static"),
    logger: pino({ level: "warn" }, pino.destination(join(root, "fixture.log"))),
    cleanup: false,
    mcpEnabled: true,
    agentClients: createTestAgentClients({
      onStartTurn: (prompt, config) => {
        const text = String(prompt);
        // The parent hears of a prompt only once the files it reads have it.
        void Promise.all([
          appendFile(join(root, "all-prompts.jsonl"), `${JSON.stringify({ prompt, config })}\n`),
          text.includes('kind="agent-notification"')
            ? appendFile(join(root, "parent-prompts.jsonl"), `${JSON.stringify(prompt)}\n`)
            : undefined,
        ]).then(() => send({ prompt: text }));
      },
      beforeResumeSession: () => resumeReleased.promise,
      beforeTurnComplete: (prompt) =>
        String(prompt).includes("HOLD_CHILD") ? held.promise : Promise.resolve(),
    }),
  });
  send({ port: daemon.port, paseoHome: daemon.paseoHome, cwd: daemon.staticDir });
};

process.on("message", (message) => {
  if (typeof message === "object" && message !== null && "start" in message) {
    void start((message as { start: FinishSubscriptionDaemonStart }).start).catch((error) => {
      console.error(error);
      process.exit(1);
    });
  }
  if (message === "finish") held.resolve();
  if (message === "release-resume") resumeReleased.resolve();
  if (message === "stop") {
    if (!daemon) process.exit(0);
    void daemon.close().then(
      () => process.exit(0),
      (error) => {
        console.error(error);
        process.exit(1);
      },
    );
  }
});
send({ loaded: true });
