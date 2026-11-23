import { createContext, useContext } from "react";
import type { QuoteRequest } from "@/quotes/chat-quote-context";

export interface SideQuestionBoundary {
  boundaryCursor?: { epoch: string; seq: number };
  boundaryMessageId?: string;
}

export interface SideQuestionOpenRequest {
  /** Forks at this reply instead of the latest point. */
  boundary?: SideQuestionBoundary;
  /** A passage quoted into the new side question's composer. */
  quote?: QuoteRequest;
  /** Sent as the first question, with any quotes already serialized into it. */
  question?: string;
}

/**
 * What a chat offers for asking about itself without disturbing it. Absent where side questions do
 * not apply: a host that lacks the feature, a provider that cannot fork, a side question's own pane.
 */
export interface SideQuestionActions {
  open: (request?: SideQuestionOpenRequest) => Promise<void>;
}

const SideQuestionActionsContext = createContext<SideQuestionActions | null>(null);

export const SideQuestionActionsProvider = SideQuestionActionsContext.Provider;

export function useSideQuestionActions(): SideQuestionActions | null {
  return useContext(SideQuestionActionsContext);
}
