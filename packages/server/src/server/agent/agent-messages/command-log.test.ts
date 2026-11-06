import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { expect, test } from "vitest";
import { AgentCommandLog, attributeReplayedCommands } from "./command-log.js";

const source = { kind: "agent-message", agentId: "orchestrator", title: "Orchestrator" } as const;

test("a replayed raw command gets its sender back; a person's identical command stays theirs", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-command-log-"));
  try {
    const log = new AgentCommandLog({ directory, logger: pino({ level: "silent" }) });
    await log.append("owner", {
      messageId: "m1",
      source,
      text: "/compact keep the plan",
      sentAt: "2026-11-06T08:50:37.400Z",
    });

    const replay = attributeReplayedCommands(
      [
        {
          item: { type: "user_message" as const, text: "/compact keep the plan" },
          timestamp: "2026-11-06T08:50:37.758Z",
        },
        {
          item: { type: "compaction" as const, status: "completed" as const },
          timestamp: "2026-11-06T08:50:44.026Z",
        },
        {
          item: { type: "user_message" as const, text: "/compact keep the plan" },
          timestamp: "2026-11-06T09:30:00.000Z",
        },
      ],
      await log.read("owner"),
    );

    expect(replay.map((event) => event.item)).toEqual([
      expect.objectContaining({
        type: "tool_call",
        callId: "paseo-agent-message:m1",
        agentMessage: {
          event: "message",
          sender: { id: "orchestrator", title: "Orchestrator" },
          text: "/compact keep the plan",
        },
      }),
      { type: "compaction", status: "completed" },
      { type: "user_message", text: "/compact keep the plan" },
    ]);

    await log.delete("owner");
    expect(await log.read("owner")).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
