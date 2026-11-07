import { appendFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import type {
  AgentPromptCacheState,
  GatewayAccountChange,
  PromptCacheCompaction,
  PromptCacheHistoryEntry,
} from "@getpaseo/protocol/agent-cache-warm";

type JournalLine =
  | ({ type: "request" } & PromptCacheHistoryEntry)
  | ({ type: "compaction" } & PromptCacheCompaction)
  | ({ type: "account" } & GatewayAccountChange);

export interface PromptCacheJournalHistory {
  requests: PromptCacheHistoryEntry[];
  compactions: PromptCacheCompaction[];
  /** CLIProxyAPI account changes, so insights can name the switch behind a miss. */
  accounts: GatewayAccountChange[];
}

function toLines(
  input: Pick<PromptCacheJournalHistory, "requests" | "compactions">,
): JournalLine[] {
  return [
    ...input.requests.map((entry): JournalLine => ({ type: "request", ...entry })),
    ...input.compactions.map((entry): JournalLine => ({ type: "compaction", ...entry })),
  ].sort((a, b) => a.at.localeCompare(b.at));
}

function serialize(lines: JournalLine[]): string {
  return lines.map((line) => `${JSON.stringify(line)}\n`).join("");
}

function parseLine(text: string): JournalLine | null {
  try {
    const value = JSON.parse(text) as JournalLine;
    return value.type === "request" || value.type === "compaction" || value.type === "account"
      ? value
      : null;
  } catch {
    // A crash mid-append leaves a torn last line; the rest of the journal still reads.
    return null;
  }
}

/**
 * Every main-thread request and compaction of an agent, one JSON line each. The snapshot carries
 * only the latest few requests because it rides on every update; the insights view reads the
 * whole session from here. Append-only, so a write never rewrites what came before.
 */
export class PromptCacheJournal {
  private readonly directory: string;
  private readonly logger: Logger;
  /** Appends per agent run in order; a read waits for the ones already queued. */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(input: { directory: string; logger: Logger }) {
    this.directory = input.directory;
    this.logger = input.logger;
  }

  private filePath(agentId: string): string {
    return path.join(this.directory, `${encodeURIComponent(agentId)}.jsonl`);
  }

  private forgetQueue(agentId: string, settled: Promise<void>): void {
    if (this.queues.get(agentId) === settled) this.queues.delete(agentId);
  }

  private enqueue(agentId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(agentId) ?? Promise.resolve();
    const next = previous.then(task).catch((error: unknown) => {
      this.logger.warn({ err: error, agentId }, "Prompt cache journal write failed");
    });
    this.queues.set(agentId, next);
    void next.then(() => this.forgetQueue(agentId, next));
    return next;
  }

  /**
   * `before` is the cache state before this line was recorded. An agent that existed before the
   * journal did gets its snapshot history written first, so its journal starts where the
   * snapshot window does instead of at this line.
   */
  private append(input: {
    agentId: string;
    line: JournalLine;
    before: AgentPromptCacheState | undefined;
  }): Promise<void> {
    return this.enqueue(input.agentId, async () => {
      const file = this.filePath(input.agentId);
      await mkdir(this.directory, { recursive: true });
      const exists = await stat(file).then(
        () => true,
        () => false,
      );
      const seed =
        exists || !input.before
          ? []
          : toLines({
              requests: input.before.history ?? [],
              compactions: input.before.compactions ?? [],
            });
      await appendFile(file, serialize([...seed, input.line]));
    });
  }

  appendRequest(input: {
    agentId: string;
    entry: PromptCacheHistoryEntry;
    before: AgentPromptCacheState | undefined;
  }): Promise<void> {
    return this.append({
      agentId: input.agentId,
      line: { type: "request", ...input.entry },
      before: input.before,
    });
  }

  appendCompaction(input: {
    agentId: string;
    compaction: PromptCacheCompaction;
    before: AgentPromptCacheState | undefined;
  }): Promise<void> {
    return this.append({
      agentId: input.agentId,
      line: { type: "compaction", ...input.compaction },
      before: input.before,
    });
  }

  appendAccount(input: {
    agentId: string;
    account: GatewayAccountChange;
    before: AgentPromptCacheState | undefined;
  }): Promise<void> {
    return this.append({
      agentId: input.agentId,
      line: { type: "account", ...input.account },
      before: input.before,
    });
  }

  /** Null when nothing was journaled yet; the caller falls back to the snapshot window. */
  async read(agentId: string): Promise<PromptCacheJournalHistory | null> {
    await this.queues.get(agentId);
    let text: string;
    try {
      text = await readFile(this.filePath(agentId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const history: PromptCacheJournalHistory = { requests: [], compactions: [], accounts: [] };
    for (const raw of text.split("\n")) {
      if (!raw.trim()) continue;
      const line = parseLine(raw);
      if (!line) continue;
      const { type, ...entry } = line;
      if (type === "request") history.requests.push(entry as PromptCacheHistoryEntry);
      else if (type === "account") history.accounts.push(entry as GatewayAccountChange);
      else history.compactions.push(entry as PromptCacheCompaction);
    }
    return history;
  }

  async delete(agentId: string): Promise<void> {
    await this.queues.get(agentId);
    await rm(this.filePath(agentId), { force: true });
  }
}
