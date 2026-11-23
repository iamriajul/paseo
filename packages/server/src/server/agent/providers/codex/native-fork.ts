import type { CodexThreadForkParams, CodexThreadForkResponse } from "./app-server-transport.js";
import { readCodexThreadHistory, type CodexThreadHistoryClient } from "./thread-history.js";

export interface CodexNativeForkClient extends CodexThreadHistoryClient {
  forkThread(params: CodexThreadForkParams): Promise<CodexThreadForkResponse>;
}

interface ThreadTurns {
  /** Turn ids in thread order. */
  order: string[];
  /** Item id to the turn holding it. */
  turnByItemId: Map<string, string>;
}

function readItemId(item: unknown): string | null {
  if (!item || typeof item !== "object") return null;
  const id = (item as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

async function readThreadTurns(
  client: CodexThreadHistoryClient,
  threadId: string,
): Promise<ThreadTurns> {
  const order: string[] = [];
  const turnByItemId = new Map<string, string>();
  for await (const row of readCodexThreadHistory(client, threadId)) {
    if (!row.turnId) continue;
    if (order.at(-1) !== row.turnId) order.push(row.turnId);
    const itemId = readItemId(row.item);
    if (itemId) turnByItemId.set(itemId, row.turnId);
  }
  return { order, turnByItemId };
}

/**
 * Forks a Codex thread through the turn holding the reply `boundaryMessageId`: the fork keeps
 * that turn and every turn before it. A boundary in the latest turn forks the whole thread.
 * `base` carries the thread config the fork needs, which Codex does not copy from the parent.
 *
 * `client` must be an app-server of its own that the caller closes afterwards. An app-server that
 * forks a thread stays its writer until it exits (`thread/unsubscribe` does not unload it), and
 * Codex refuses the fork's agent a second writer, so forking in the source's app-server leaves a
 * fork nobody else can resume. It forks from the rollout on disk, so the source may be running.
 */
export async function forkCodexThreadAtMessage(input: {
  client: CodexNativeForkClient;
  threadId: string;
  boundaryMessageId: string;
  base: Omit<CodexThreadForkParams, "threadId" | "lastTurnId">;
}): Promise<string> {
  const turns = await readThreadTurns(input.client, input.threadId);
  const boundaryTurnId = turns.turnByItemId.get(input.boundaryMessageId);
  if (!boundaryTurnId) {
    throw new Error(`Codex could not find reply ${input.boundaryMessageId} in the thread`);
  }
  const throughLatest = boundaryTurnId === turns.order.at(-1);
  const forked = await input.client.forkThread({
    ...input.base,
    threadId: input.threadId,
    ...(throughLatest ? {} : { lastTurnId: boundaryTurnId }),
  });
  const forkedThreadId = forked.thread.id;
  if (forkedThreadId === input.threadId) {
    throw new Error("Codex fork returned the source thread");
  }
  if (!throughLatest) {
    // A Codex without `lastTurnId` ignores it and forks the whole thread, which would hand the
    // user a fork holding replies they chose to leave out.
    const forkedTurns = await readThreadTurns(input.client, forkedThreadId);
    if (forkedTurns.order.length > turns.order.indexOf(boundaryTurnId) + 1) {
      throw new Error("This Codex version cannot fork at an earlier reply; update Codex");
    }
  }
  return forkedThreadId;
}
