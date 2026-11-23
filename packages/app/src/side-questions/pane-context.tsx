import { createContext, useContext } from "react";
import type { QuoteRequest } from "@/quotes/chat-quote-context";

/**
 * Set inside a side question's pane or sheet. Its chat has no rewind and no fork menu, and each
 * answer offers to quote itself into the main chat.
 */
export interface SideQuestionPaneContextValue {
  serverId: string;
  sideAgentId: string;
  mainAgentId: string;
  quoteInMainChat: (request: QuoteRequest) => void;
}

const SideQuestionPaneContext = createContext<SideQuestionPaneContextValue | null>(null);

export const SideQuestionPaneProvider = SideQuestionPaneContext.Provider;

export function useSideQuestionPane(): SideQuestionPaneContextValue | null {
  return useContext(SideQuestionPaneContext);
}
