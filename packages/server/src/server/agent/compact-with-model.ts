import type { Logger } from "pino";
import { CACHE_AUTO_COMPACT_PROMPT } from "@getpaseo/protocol/agent-cache-warm";
import type { AgentManager } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { sendPromptToAgent } from "./agent-prompt.js";

export interface CompactWithModelInput {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
  agentId: string;
  model: string;
  thinkingOptionId: string | null;
}

/**
 * Compacts an agent on another model, then puts its own model and thinking back. Once the cache
 * has expired, the compaction re-reads the whole context; on a cheaper model that costs a fraction
 * of what the agent's own model would charge to write it again, and the agent's next request only
 * writes the summary.
 */
export async function compactWithModel(input: CompactWithModelInput): Promise<void> {
  const { agentManager, agentId } = input;
  await ensureAgentLoaded(agentId, {
    agentManager,
    agentStorage: input.agentStorage,
    logger: input.logger,
  });
  const agent = agentManager.getAgent(agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);
  const original = {
    model: agent.config.model ?? null,
    thinkingOptionId: agent.config.thinkingOptionId ?? null,
  };
  input.logger.info(
    { agentId, model: input.model, thinkingOptionId: input.thinkingOptionId },
    "Compacting on another model before the next prompt",
  );
  try {
    await agentManager.setAgentModel(agentId, input.model);
    await agentManager.setAgentThinkingOption(agentId, input.thinkingOptionId);
    const { disposition } = await sendPromptToAgent({
      agentManager,
      agentStorage: input.agentStorage,
      agentId,
      prompt: CACHE_AUTO_COMPACT_PROMPT,
      replaceRunning: false,
      unarchive: false,
      logger: input.logger,
    });
    if (disposition === "skipped") {
      throw new Error("The agent is busy, so it was not compacted");
    }
    const result = await agentManager.waitForAgentEvent(agentId, { waitForActive: true });
    if (result.status === "error") {
      throw new Error("The compaction failed, so the message was not sent");
    }
  } finally {
    await restoreOriginal(input, original);
  }
}

/**
 * Puts the agent's own model and thinking back. Each is tried even when the other fails, so a
 * model Claude Code rejects (it probes a model before switching) still gets its thinking back.
 */
async function restoreOriginal(
  input: CompactWithModelInput,
  original: { model: string | null; thinkingOptionId: string | null },
): Promise<void> {
  const failures: unknown[] = [];
  for (const restore of [
    () => input.agentManager.setAgentModel(input.agentId, original.model),
    () => input.agentManager.setAgentThinkingOption(input.agentId, original.thinkingOptionId),
  ]) {
    try {
      await restore();
    } catch (error) {
      input.logger.warn(
        { err: error, agentId: input.agentId },
        "Failed to restore after compacting",
      );
      failures.push(error);
    }
  }
  if (failures.length > 0) throw failures[0];
}
