import { describe, expect, test } from "vitest";
import type { CodexThreadForkParams, CodexThreadForkResponse } from "./app-server-transport.js";
import { forkCodexThreadAtMessage } from "./native-fork.js";

type Turns = Array<{ id: string; itemIds: string[] }>;

// A paginated thread, as Codex 0.143+ serves it: `thread/items/list` rows carry their turn id.
function fakeClient(input: { threads: Record<string, Turns>; forkKeepsAll?: boolean }) {
  const forks: CodexThreadForkParams[] = [];
  const client = {
    async request(method: string, params?: unknown): Promise<unknown> {
      const { threadId } = params as { threadId: string };
      if (method === "thread/read") return { thread: { historyMode: "paginated" } };
      if (method === "thread/items/list") {
        const rows = (input.threads[threadId] ?? []).flatMap((turn) =>
          turn.itemIds.map((id) => ({ turnId: turn.id, item: { id, type: "agentMessage" } })),
        );
        return { data: rows, nextCursor: null };
      }
      throw new Error(`unexpected ${method}`);
    },
    async forkThread(params: CodexThreadForkParams): Promise<CodexThreadForkResponse> {
      forks.push(params);
      const source = input.threads[params.threadId] ?? [];
      const cut = params.lastTurnId
        ? source.findIndex((turn) => turn.id === params.lastTurnId)
        : -1;
      input.threads["fork-thread"] =
        cut >= 0 && !input.forkKeepsAll ? source.slice(0, cut + 1) : source;
      return { thread: { id: "fork-thread" } } as CodexThreadForkResponse;
    },
  };
  return { client, forks };
}

const SOURCE: Turns = [
  { id: "turn-1", itemIds: ["user-1", "reply-1"] },
  { id: "turn-2", itemIds: ["user-2", "reply-2"] },
];

describe("forkCodexThreadAtMessage", () => {
  test("forks through the turn holding an earlier reply", async () => {
    const { client, forks } = fakeClient({ threads: { source: SOURCE } });
    const forked = await forkCodexThreadAtMessage({
      client,
      threadId: "source",
      boundaryMessageId: "reply-1",
      base: { model: "gpt-6.1-terra", excludeTurns: true },
    });
    expect(forked).toBe("fork-thread");
    expect(forks).toEqual([
      { model: "gpt-6.1-terra", excludeTurns: true, threadId: "source", lastTurnId: "turn-1" },
    ]);
  });

  test("forks the whole thread from the latest reply", async () => {
    const { client, forks } = fakeClient({ threads: { source: SOURCE } });
    await forkCodexThreadAtMessage({
      client,
      threadId: "source",
      boundaryMessageId: "reply-2",
      base: {},
    });
    expect(forks).toEqual([{ threadId: "source" }]);
  });

  test("refuses a reply the thread does not hold", async () => {
    const { client, forks } = fakeClient({ threads: { source: SOURCE } });
    await expect(
      forkCodexThreadAtMessage({ client, threadId: "source", boundaryMessageId: "gone", base: {} }),
    ).rejects.toThrow("Codex could not find reply gone in the thread");
    expect(forks).toEqual([]);
  });

  test("refuses a fork that kept the replies after the boundary", async () => {
    const { client } = fakeClient({ threads: { source: SOURCE }, forkKeepsAll: true });
    await expect(
      forkCodexThreadAtMessage({
        client,
        threadId: "source",
        boundaryMessageId: "reply-1",
        base: {},
      }),
    ).rejects.toThrow("This Codex version cannot fork at an earlier reply");
  });
});
