import { useMemo, type RefObject } from "react";
import { useDraftStore } from "@/stores/draft-store";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { generateMessageId } from "@/types/stream";
import type { ChatQuoteActions } from "@/quotes/chat-quote-context";

/**
 * Quote actions for one chat: a quote lands in that chat's composer draft, whichever surface
 * (this chat's own messages, or a side question's "Quote in main chat") asks.
 */
export function useChatQuoteActionsForAgent(input: {
  serverId: string;
  agentId: string;
  scrollTarget: RefObject<{ scrollToItem(itemId: string): void } | null>;
}): ChatQuoteActions {
  const { serverId, agentId, scrollTarget } = input;
  return useMemo(
    () => ({
      addQuote: (request) => {
        void useDraftStore.getState().attachQuote({
          draftKey: buildDraftStoreKey({ serverId, agentId }),
          quote: { id: generateMessageId(), ...request },
        });
      },
      scrollToMessage: (messageId) => scrollTarget.current?.scrollToItem(messageId),
    }),
    [agentId, scrollTarget, serverId],
  );
}
