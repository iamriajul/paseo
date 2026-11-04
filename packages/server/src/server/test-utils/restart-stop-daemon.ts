import pino from "pino";
// Isolated process fixture for the stop-policy e2e. It stops the way the daemon worker does: a
// client's shutdown or restart RPC and Ctrl-C are intentional stops, and an OS SIGTERM is not.
// Never targets a developer home.
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { isAutomaticDaemonStopReason } from "../lifecycle-reasons.js";
import { createTestPaseoDaemon } from "./paseo-daemon.js";
import { createTestAgentClients } from "./fake-agent-client.js";

const root = process.argv[2];
if (!root || !process.send) throw new Error("Expected isolated test home and IPC parent");
await mkdir(join(root, "static"), { recursive: true });
const settings = JSON.parse(process.argv[3] ?? "{}") as { resumeOnStartup?: boolean };
// A turn that never completes, so the agent is still running when the stop arrives.
const neverFinishes = new Promise<void>(() => undefined);

let daemon: Awaited<ReturnType<typeof createTestPaseoDaemon>> | null = null;
let stopping = false;
function stopDaemon(intentional: boolean, keepTerminals = false): void {
  const running = daemon;
  if (stopping || !running) return;
  stopping = true;
  void (async () => {
    await running.daemon.stop({ intentional, keepTerminals });
    await running.daemon.agentManager.flush().catch(() => undefined);
    process.exit(0);
  })().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}

const started = await createTestPaseoDaemon({
  paseoHomeRoot: root,
  resumeOnStartup: settings.resumeOnStartup,
  staticDir: join(root, "static"),
  logger: pino({ level: "warn" }, pino.destination(join(root, "fixture.log"))),
  cleanup: false,
  mcpEnabled: true,
  onLifecycleIntent: (intent) =>
    stopDaemon(!isAutomaticDaemonStopReason(intent.reason), intent.keepTerminals),
  agentClients: createTestAgentClients({
    // A close that never returns, as a provider that will not exit. The daemon gives up after
    // AGENT_CLOSE_TIMEOUT_MS and the record is left running, which markStoppedByUser must repair.
    closeSession: () => neverFinishes,
    onStartTurn: (prompt, config) => {
      void appendFile(join(root, "all-prompts.jsonl"), `${JSON.stringify({ prompt, config })}\n`);
    },
    beforeTurnComplete: (prompt) =>
      String(prompt).includes("HOLD_CHILD") ? neverFinishes : Promise.resolve(),
  }),
});
daemon = started;
process.on("SIGINT", () => stopDaemon(true));
process.on("SIGTERM", () => stopDaemon(false));
process.send({ port: started.port, paseoHome: started.paseoHome, cwd: started.staticDir });
