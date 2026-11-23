import { useCallback, useMemo, type ReactNode } from "react";
import { AskAsideButton } from "@/side-questions/ask-aside-button";
import { useSideQuestionActions } from "@/side-questions/actions-context";
import { useSideQuestionPane } from "@/side-questions/pane-context";
import { QuoteInMainChatButton } from "@/side-questions/quote-in-main-button";
import { useSideQuestionTurnUsage } from "@/side-questions/use-turn-usage";
import { type AssistantTurnForkBoundary } from "@/agent-stream/turn-boundary";
import type { StreamItem } from "@/types/stream";
import type { TurnTiming } from "@/timeline/turn-time";

/**
 * The side-question controls of one completed turn's footer. In the main chat, an assistant turn
 * can start a side question. In a side question's own pane, an answer brings itself back to the
 * main chat, and its footer says what it cost the cache; that chat has no fork menu.
 */
export function useTurnSideQuestionActions(input: {
  items: readonly StreamItem[];
  startIndex: number;
  turnText: string;
  boundary: AssistantTurnForkBoundary | undefined;
  messageId: string | undefined;
  timing: TurnTiming | undefined;
}): { node: ReactNode; inPane: boolean; usageLabel: string | null } {
  const { items, startIndex, turnText, boundary, messageId, timing } = input;
  const pane = useSideQuestionPane();
  const actions = useSideQuestionActions();
  const completedAtMs = timing?.completedAt.getTime();
  const startedAtMs =
    completedAtMs !== undefined && timing?.durationMs != null
      ? completedAtMs - timing.durationMs
      : undefined;
  const usageLabel = useSideQuestionTurnUsage({
    serverId: pane?.serverId ?? "",
    agentId: pane?.sideAgentId ?? "",
    startedAtMs: pane ? startedAtMs : undefined,
    completedAtMs: pane ? completedAtMs : undefined,
  });
  const isLatest = useMemo(
    () => !items.slice(startIndex + 1).some((item) => item.kind === "assistant_message"),
    [items, startIndex],
  );
  const quoteRequest = useMemo(
    () => ({ origin: "assistant" as const, text: turnText, partial: false, messageId }),
    [messageId, turnText],
  );
  const open = actions?.open;
  const askLatest = useCallback(() => void open?.(), [open]);
  const askAbout = useCallback(() => void open?.({ quote: quoteRequest }), [open, quoteRequest]);
  const askFrom = useCallback(
    () => void open?.({ boundary: boundary as AssistantTurnForkBoundary }),
    [boundary, open],
  );
  const quoteInMain = pane?.quoteInMainChat;
  const handleQuoteInMain = useCallback(
    () => quoteInMain?.({ ...quoteRequest, origin: "side_question" }),
    [quoteInMain, quoteRequest],
  );

  let node: ReactNode = null;
  if (pane) {
    node = turnText.trim() ? <QuoteInMainChatButton onPress={handleQuoteInMain} /> : null;
  } else if (open && turnText.trim()) {
    node = (
      <AskAsideButton
        isLatest={isLatest || !boundary}
        onAskLatest={askLatest}
        onAskAboutReply={askAbout}
        onAskFromPoint={askFrom}
      />
    );
  }
  return { node, inPane: pane !== null, usageLabel: pane ? usageLabel : null };
}
