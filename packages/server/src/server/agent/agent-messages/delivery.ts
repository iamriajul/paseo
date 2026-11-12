import type { PromptDispatchDisposition } from "../agent-prompt.js";
import { randomUUID } from "node:crypto";
import type { AgentPromptInput, AgentPromptContentBlock } from "../agent-sdk-types.js";
import { prepareAgentMessage, readSlashCommandText, type AgentPromptSource } from "./envelope.js";

interface Message {
  recipientId: string;
  messageId?: string;
  source: AgentPromptSource;
  prompt: AgentPromptInput;
  sessionMode?: string;
  unarchive?: boolean;
  clearPendingPermissions?: boolean;
  activeTurnBehavior?: "steer" | "interrupt";
  beforeDispatch?: () => void;
  onDispatch?: (disposition: PromptDispatchDisposition) => void;
}
interface Receipt {
  status: "queued";
  messageId: string;
  dispatched: Promise<PromptDispatchDisposition>;
}
interface Admitted extends Message {
  receipt: Receipt;
  resolve(disposition: PromptDispatchDisposition): void;
  reject(error: unknown): void;
}
export interface AgentMessageDispatchRequest {
  recipientId: string;
  messageIds: readonly string[];
  /**
   * Each batched message on its own, already wrapped, in batch order: `prompt` joins them. A
   * message from another agent and a finish notification are re-sent differently after a crash.
   */
  parts: readonly AgentMessagePart[];
  prompt: AgentPromptInput;
  activeTurnBehavior: "steer" | "interrupt";
  sessionMode?: string;
  clearPendingPermissions: boolean;
  unarchive: boolean;
  /**
   * The request is one slash command another agent sent. It runs as its own turn once the
   * recipient is idle, and later requests wait until that turn ends: steering it would deliver
   * text, and replacing would cancel the running turn or a compaction in progress.
   */
  command: boolean;
  /** Aborted when delivery closes, so a command still waiting for an idle recipient gives up. */
  signal: AbortSignal;
  onDispatch(disposition: PromptDispatchDisposition): void;
}
export interface AgentMessagePart {
  kind: AgentPromptSource["kind"];
  messageId: string;
  prompt: AgentPromptInput;
}

/** One prompt for several wrapped messages: text joined when all are text, else content blocks. */
export function joinAgentMessagePrompts(prompts: readonly AgentPromptInput[]): AgentPromptInput {
  return prompts.every((entry) => typeof entry === "string")
    ? prompts.join("\n\n")
    : prompts.flatMap((entry): AgentPromptContentBlock[] =>
        typeof entry === "string" ? [{ type: "text", text: entry }] : entry,
      );
}

interface Dependencies {
  dispatch(request: AgentMessageDispatchRequest): Promise<PromptDispatchDisposition>;
  onError(error: unknown, request: AgentMessageDispatchRequest): void;
  /** Return a cancellation function. Production uses the daemon's event loop. */
  schedule?: (delayMs: number, callback: () => void) => () => void;
}
export interface AgentMessageDelivery {
  enqueue(message: Message): Receipt;
  /** Queued messages and provider dispatches still owned by this recipient. */
  hasPending(recipientId: string): boolean;
  /** Stop admission, flush pending messages, and await provider dispatch acknowledgments. */
  close(): Promise<void>;
  /** Existing completion waits include agent messages admitted before the wait. */
  waitForDispatch(recipientId: string, signal: AbortSignal): Promise<void>;
}

function isCommand(message: Message): boolean {
  return message.source.kind === "agent-message" && readSlashCommandText(message.prompt) !== null;
}

/** Recipient-owned agent delivery. Human prompts never enter this module. */
export function createAgentMessageDelivery(dependencies: Dependencies): AgentMessageDelivery {
  const schedule =
    dependencies.schedule ??
    ((delayMs, callback) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    });
  const pending = new Map<string, { messages: Admitted[]; cancel(): void }>();
  const dispatching = new Map<string, Promise<void>>();
  const closeController = new AbortController();
  let closed = false;
  let closing: Promise<void> | undefined;

  function dispatch(recipientId: string, messages: Admitted[]): void {
    const parts = messages.map(
      (message): AgentMessagePart => ({
        kind: message.source.kind,
        messageId: message.receipt.messageId,
        prompt: prepareAgentMessage(message.prompt, message.source, message.receipt.messageId)
          .prompt,
      }),
    );
    const request: AgentMessageDispatchRequest = {
      recipientId,
      messageIds: messages.map((message) => message.receipt.messageId),
      parts,
      prompt: joinAgentMessagePrompts(parts.map((part) => part.prompt)),
      activeTurnBehavior: messages[0]!.activeTurnBehavior ?? "steer",
      sessionMode: messages.find((message) => message.sessionMode)?.sessionMode,
      clearPendingPermissions: messages.some((message) => message.clearPendingPermissions),
      unarchive: messages.some((message) => message.unarchive !== false),
      command: messages.length === 1 && isCommand(messages[0]!),
      signal: closeController.signal,
      onDispatch: (disposition) => {
        for (const message of messages) {
          try {
            message.onDispatch?.(disposition);
          } catch (error) {
            dependencies.onError(error, request);
          }
        }
      },
    };
    const previous = dispatching.get(recipientId) ?? Promise.resolve();
    const dispatched = previous
      .catch(() => undefined)
      .then(async () => {
        try {
          for (const message of messages) message.beforeDispatch?.();
          const disposition = await dependencies.dispatch(request);
          for (const message of messages) message.resolve(disposition);
          return undefined;
        } catch (error) {
          for (const message of messages) message.reject(error);
          dependencies.onError(error, request);
          throw error;
        }
      });
    dispatching.set(recipientId, dispatched);
    void dispatched
      .finally(() => {
        if (dispatching.get(recipientId) === dispatched) dispatching.delete(recipientId);
      })
      .catch(() => undefined);
  }

  function flush(recipientId: string): void {
    const entry = pending.get(recipientId);
    if (!entry) return;
    pending.delete(recipientId);
    entry.cancel();
    let group: Admitted[] = [];
    let mode: string | undefined;
    for (const message of entry.messages) {
      // Explicitly conflicting send options require separate, ordered dispatches, and a
      // command is never batched: it reaches the provider raw, so it has to be the whole prompt.
      if (
        group.length &&
        (isCommand(message) ||
          isCommand(group[0]!) ||
          (message.activeTurnBehavior ?? "steer") !== (group[0]!.activeTurnBehavior ?? "steer") ||
          (mode && message.sessionMode && mode !== message.sessionMode))
      ) {
        dispatch(recipientId, group);
        group = [];
        mode = undefined;
      }
      group.push(message);
      mode ??= message.sessionMode;
    }
    if (group.length) dispatch(recipientId, group);
  }

  return {
    hasPending: (recipientId) => pending.has(recipientId) || dispatching.has(recipientId),
    enqueue(message) {
      if (closed) throw new Error("Agent message delivery is closed");
      let resolve!: Admitted["resolve"];
      let reject!: Admitted["reject"];
      const dispatched = new Promise<PromptDispatchDisposition>((accepted, failed) => {
        resolve = accepted;
        reject = failed;
      });
      void dispatched.catch(() => undefined);
      const receipt: Receipt = {
        status: "queued",
        messageId: message.messageId ?? randomUUID(),
        dispatched,
      };
      const entry = pending.get(message.recipientId) ?? { messages: [], cancel: () => {} };
      entry.cancel();
      entry.messages.push({ ...message, receipt, resolve, reject });
      entry.cancel = schedule(2000, () => flush(message.recipientId));
      pending.set(message.recipientId, entry);
      return receipt;
    },
    async waitForDispatch(recipientId, signal) {
      signal.throwIfAborted();
      const admitted =
        pending.get(recipientId)?.messages.map((message) => message.receipt.dispatched) ?? [];
      let aborted!: () => void;
      const cancellation = new Promise<never>((_resolve, reject) => {
        aborted = () => reject(new DOMException("Wait aborted", "AbortError"));
        signal.addEventListener("abort", aborted, { once: true });
      });
      try {
        await Promise.race([
          Promise.all([dispatching.get(recipientId), ...admitted]),
          cancellation,
        ]);
      } finally {
        signal.removeEventListener("abort", aborted);
      }
    },
    close() {
      if (closing) return closing;
      closed = true;
      for (const recipientId of pending.keys()) flush(recipientId);
      // A command still waiting for its recipient to go idle is not delivered.
      closeController.abort(new Error("Agent message delivery closed"));
      // Each failure is reported and rejects its receipts; shutdown still drains other recipients.
      closing = Promise.allSettled(dispatching.values()).then(() => undefined);
      return closing;
    },
  };
}
