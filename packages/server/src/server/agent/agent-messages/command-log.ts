import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import type { AgentTimelineItem } from "../agent-sdk-types.js";
import { formatAgentMessage, projectAgentMessages, sourceSchema } from "./envelope.js";

const deliveredCommandSchema = z.object({
  messageId: z.string().min(1),
  source: sourceSchema,
  text: z.string().min(1),
  sentAt: z.string().min(1),
});
export type DeliveredAgentCommand = z.infer<typeof deliveredCommandSchema>;

/**
 * How far a replayed command's transcript timestamp may sit from its delivery. Delivery is
 * recorded as the turn starts, and the provider writes the command a moment later.
 */
const REPLAY_MATCH_WINDOW_MS = 2 * 60_000;

/**
 * The slash commands other agents delivered raw to each agent. The provider's transcript holds
 * only the bare command, so replay reads the sender back from here. Append-only JSON lines.
 */
export class AgentCommandLog {
  private readonly directory: string;
  private readonly logger: Logger;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(input: { directory: string; logger: Logger }) {
    this.directory = input.directory;
    this.logger = input.logger;
  }

  private filePath(agentId: string): string {
    return path.join(this.directory, `${encodeURIComponent(agentId)}.jsonl`);
  }

  append(agentId: string, command: DeliveredAgentCommand): Promise<void> {
    const previous = this.queues.get(agentId) ?? Promise.resolve();
    const next = previous.then(() => this.write(agentId, command));
    this.queues.set(agentId, next);
    void next.finally(() => {
      if (this.queues.get(agentId) === next) this.queues.delete(agentId);
    });
    return next;
  }

  private async write(agentId: string, command: DeliveredAgentCommand): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true });
      await appendFile(this.filePath(agentId), `${JSON.stringify(command)}\n`);
    } catch (error) {
      this.logger.warn({ err: error, agentId }, "Agent command log write failed");
    }
  }

  async read(agentId: string): Promise<DeliveredAgentCommand[]> {
    await this.queues.get(agentId);
    let text: string;
    try {
      text = await readFile(this.filePath(agentId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const commands: DeliveredAgentCommand[] = [];
    for (const raw of text.split("\n")) {
      if (!raw.trim()) continue;
      try {
        const parsed = deliveredCommandSchema.safeParse(JSON.parse(raw));
        if (parsed.success) commands.push(parsed.data);
      } catch {
        // A crash mid-append leaves a torn last line; the rest still reads.
      }
    }
    return commands;
  }

  async delete(agentId: string): Promise<void> {
    await this.queues.get(agentId);
    await rm(this.filePath(agentId), { force: true });
  }
}

interface ReplayedItem {
  item: AgentTimelineItem;
  timestamp?: string;
}

/**
 * Give replayed raw commands back their sender. Each delivered command claims the first replayed
 * user prompt with the same text inside the match window, in order, so a person who typed the
 * same command keeps their own prompt.
 */
export function attributeReplayedCommands<T extends ReplayedItem>(
  events: readonly T[],
  commands: readonly DeliveredAgentCommand[],
): T[] {
  const unclaimed = [...commands];
  return events.map((event) => {
    const { item, timestamp } = event;
    if (item.type !== "user_message" || !timestamp) return event;
    const at = Date.parse(timestamp);
    const index = unclaimed.findIndex(
      (command) =>
        command.text === item.text.trim() &&
        Math.abs(at - Date.parse(command.sentAt)) <= REPLAY_MATCH_WINDOW_MS,
    );
    if (index === -1) return event;
    const [command] = unclaimed.splice(index, 1);
    const [attributed] = projectAgentMessages({
      type: "user_message",
      text: formatAgentMessage({
        id: command!.messageId,
        source: command!.source,
        text: command!.text,
      }),
    });
    return attributed ? { ...event, item: attributed } : event;
  });
}
