import type { TFunction } from "i18next";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { planTimelinePromptJump } from "@/timeline/timeline-sync-plan";
import type { ChatFindFailure, ChatFindModel, ChatFindOperations } from "./model";

/** The host half of chat find, the same on every platform; the viewport half is per platform. */
export function createChatFindHostOperations(
  serverId: string,
  agentId: string,
): Pick<ChatFindOperations, "search" | "load"> {
  return {
    search(query, cursor) {
      const client = getHostRuntimeStore().getClient(serverId);
      if (!client) return Promise.reject(new Error("Host disconnected"));
      return client.searchAgentTimeline({ agentId, query, cursor });
    },
    load(targetEpoch, seq) {
      return getHostRuntimeStore().fetchAgentTimeline(
        serverId,
        agentId,
        planTimelinePromptJump({ epoch: targetEpoch, seq }),
      );
    },
  };
}

export const CHAT_FIND_FAILURE_TEXT: Record<ChatFindFailure, string> = {
  connection: "paneFind.connectionFailure",
  historyChanged: "paneFind.historyChangedFailure",
  reveal: "paneFind.revealFailure",
};

/** What the find bar shows beside the query. */
export function chatFindStatusText(
  state: ReturnType<ChatFindModel["getSnapshot"]>,
  t: TFunction,
): string {
  if (state.phase === "searching") return t("paneFind.searching");
  if (state.phase === "loading") return t("paneFind.loading");
  if (state.phase === "error") return t("paneFind.failed");
  if (!state.query.trim()) return "";
  return state.count
    ? t("paneFind.position", { current: state.occurrence + 1, total: state.count })
    : t("paneFind.noMatches");
}
