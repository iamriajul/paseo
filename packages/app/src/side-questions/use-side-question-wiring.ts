import { useMemo, type RefObject } from "react";
import { useDraftStore } from "@/stores/draft-store";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { useIsCompactFormFactor } from "@/constants/layout";
import { usePaneContext } from "@/panels/pane-context";
import { generateMessageId } from "@/types/stream";
import type { ChatQuoteActions, QuoteRequest } from "@/quotes/chat-quote-context";
import { useChatQuoteActionsForAgent } from "@/quotes/use-chat-quote-actions";
import type { SideQuestionActions } from "@/side-questions/actions-context";
import type { SideQuestionPaneContextValue } from "@/side-questions/pane-context";
import { useBuildSideQuestionActions } from "@/side-questions/use-side-question-actions";
import { useSideQuestionSourceId } from "@/side-questions/use-side-question-source";
import { useSideQuestionRows } from "@/side-questions/track";
import type { Agent } from "@/stores/session-store";

export interface SideQuestionWiring {
  chatQuoteActions: ChatQuoteActions;
  /** The main chat's way to start side questions; null in a side question and where unavailable. */
  sideActions: SideQuestionActions | null;
  /** Set only inside a side question's pane. */
  pane: SideQuestionPaneContextValue | null;
}

/**
 * What one chat surface offers its messages. A main chat can quote and, where the host allows it,
 * ask aside. A side question's pane quotes into its own composer and can bring a passage back to
 * the main chat, which on phones also closes the sheet.
 */
export function useSideQuestionWiring(input: {
  serverId: string;
  agentId: string;
  workspaceId: string;
  scrollTarget: RefObject<{ scrollToItem(itemId: string): void } | null>;
  /** The main chat, when this surface is a side question. */
  mainAgentId: string | null;
}): SideQuestionWiring {
  const { serverId, agentId, workspaceId, scrollTarget, mainAgentId } = input;
  const base = useChatQuoteActionsForAgent({ serverId, agentId, scrollTarget });
  const built = useBuildSideQuestionActions({ serverId, agentId, workspaceId });
  const isCompact = useIsCompactFormFactor();
  const { closeCurrentTab } = usePaneContext();
  return useMemo(() => {
    if (mainAgentId) {
      const quoteInMainChat = (request: QuoteRequest) => {
        void useDraftStore.getState().attachQuote({
          draftKey: buildDraftStoreKey({ serverId, agentId: mainAgentId }),
          quote: { id: generateMessageId(), ...request, origin: "side_question" },
        });
        if (isCompact) closeCurrentTab();
      };
      return {
        chatQuoteActions: { ...base, quoteInMainChat },
        sideActions: null,
        pane: { serverId, sideAgentId: agentId, mainAgentId, quoteInMainChat },
      };
    }
    const askAside = built
      ? (request: QuoteRequest) => void built.open({ quote: request })
      : undefined;
    return {
      chatQuoteActions: { ...base, ...(askAside ? { askAside } : {}) },
      sideActions: built,
      pane: null,
    };
  }, [agentId, base, built, closeCurrentTab, isCompact, mainAgentId, serverId]);
}

/** The side-question facts one chat surface needs: which chat it is a side question of, its own side questions, and what it offers its messages. */
export function useSideQuestionSurface(input: {
  serverId: string;
  agentId: string;
  workspaceId: string;
  scrollTarget: RefObject<{ scrollToItem(itemId: string): void } | null>;
}): { mainAgentId: string | null; rows: Agent[]; wiring: SideQuestionWiring } {
  const { serverId, agentId, workspaceId, scrollTarget } = input;
  const mainAgentId = useSideQuestionSourceId(serverId, agentId);
  const rows = useSideQuestionRows(serverId, agentId);
  const wiring = useSideQuestionWiring({
    serverId,
    agentId,
    workspaceId,
    scrollTarget,
    mainAgentId,
  });
  return { mainAgentId, rows, wiring };
}
