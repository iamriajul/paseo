import React, { type ReactElement, useCallback, useState } from "react";
import { promptCacheInputTokens } from "@getpaseo/protocol/agent-cache-warm";
import type { ComposerAttachment } from "@/attachments/types";
import type { ComposerCompactFirst } from "@/composer/actions";
import { useHostFeature } from "@/runtime/host-features";
import {
  COLD_SEND_COMPACT_MODEL_ID,
  COLD_SEND_COMPACT_THINKING_OPTION_ID,
  formatClaudeModelFamily,
  resolveColdSendGuard,
} from "./cache-guards";
import { ColdSendConfirm } from "./cold-send-confirm";
import { resolvePromptCacheView, usePromptCacheAgent } from "./use-prompt-cache";

export interface ColdSend {
  text: string;
  attachments: ComposerAttachment[];
  forceSend?: boolean;
}

const COMPACT_FIRST: ComposerCompactFirst = {
  model: COLD_SEND_COMPACT_MODEL_ID,
  thinkingOptionId: COLD_SEND_COMPACT_THINKING_OPTION_ID,
};

/**
 * Holds a message for confirmation when it would reach an expired cache. `intercept` returns true
 * when it held the message; `element` is the dialog to render while one is held.
 */
export function useColdSendGuard(input: {
  serverId: string;
  agentId: string;
  /** False where the composer has no agent of its own yet, such as a draft. */
  enabled: boolean;
  send: (message: ColdSend, compactFirst?: ComposerCompactFirst) => void;
}): { intercept: (message: ColdSend) => boolean; element: ReactElement | null } {
  const { serverId, agentId, enabled, send } = input;
  const agent = usePromptCacheAgent(serverId, agentId);
  const canCompactFirst = useHostFeature(serverId, "compactThenSend");
  const [held, setHeld] = useState<(ColdSend & { agentId: string }) | null>(null);
  const visible = held?.agentId === agentId ? held : null;
  const modelId = agent?.model ?? agent?.runtimeInfo?.model;

  const intercept = useCallback(
    (message: ColdSend) => {
      if (!enabled || !agent) return false;
      const guarded = resolveColdSendGuard({
        agent: { provider: agent.provider, modelId },
        text: message.text,
        view: resolvePromptCacheView(agent, Date.now()),
      });
      if (guarded) setHeld({ ...message, agentId });
      return guarded;
    },
    [agent, agentId, enabled, modelId],
  );

  const cancel = useCallback(() => setHeld(null), []);
  const sendAnyway = useCallback(() => {
    setHeld(null);
    if (visible) send(visible);
  }, [send, visible]);
  const compactFirst = useCallback(() => {
    setHeld(null);
    if (!visible) return;
    // Decided again on press: a warm-up or a turn may have made the cache live while the
    // dialog was open, and compacting a live cache would throw away detail for nothing.
    const stillCold =
      agent !== undefined &&
      resolveColdSendGuard({
        agent: { provider: agent.provider, modelId },
        text: visible.text,
        view: resolvePromptCacheView(agent, Date.now()),
      });
    send(visible, stillCold ? COMPACT_FIRST : undefined);
  }, [agent, modelId, send, visible]);

  const element = visible ? (
    <ColdSendConfirm
      modelLabel={formatClaudeModelFamily(modelId)}
      contextTokens={
        agent?.promptCache ? promptCacheInputTokens(agent.promptCache.lastRequest) : null
      }
      onCompactFirst={canCompactFirst ? compactFirst : null}
      onCancel={cancel}
      onSend={sendAnyway}
    />
  ) : null;
  return { intercept, element };
}
