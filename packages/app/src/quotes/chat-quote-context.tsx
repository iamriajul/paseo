import { createContext, useContext } from "react";
import type { QuoteOrigin } from "@/quotes/quote-format";

export interface QuoteRequest {
  origin: QuoteOrigin;
  text: string;
  /** True when the user selected part of the message. */
  partial: boolean;
  messageId?: string;
}

/**
 * What the chat surface offers its messages: put a passage in this chat's composer and scroll back
 * to it. Absent where quoting does not apply (a read-only pane), so callers render no action.
 */
export interface ChatQuoteActions {
  addQuote: (request: QuoteRequest) => void;
  scrollToMessage: (messageId: string) => void;
  /** Opens a side question with this passage quoted. Absent when side questions are unavailable. */
  askAside?: (request: QuoteRequest) => void;
}

const ChatQuoteContext = createContext<ChatQuoteActions | null>(null);

export const ChatQuoteProvider = ChatQuoteContext.Provider;

export function useChatQuoteActions(): ChatQuoteActions | null {
  return useContext(ChatQuoteContext);
}
