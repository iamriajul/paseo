import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-api-context";
import { useDraftStore } from "@/stores/draft-store";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { useHostFeature } from "@/runtime/host-features";
import { useSessionStore } from "@/stores/session-store";
import { generateMessageId } from "@/types/stream";
import { toErrorMessage } from "@/utils/error-messages";
import { storeFetchedAgentDetail } from "@/utils/store-fetched-agent-detail";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { openWorkspaceTargetBeside } from "@/workspace-tabs/open-beside";
import { canAskSideQuestions } from "@/side-questions/model";
import type {
  SideQuestionActions,
  SideQuestionOpenRequest,
} from "@/side-questions/actions-context";

/**
 * Whether a chat offers side questions: the host has the feature, the provider can fork its
 * session, and the chat is not itself a side question.
 */
export function useSideQuestionsAvailable(serverId: string, agentId: string): boolean {
  const hostSupports = useHostFeature(serverId, "sideQuestions");
  const canFork = useSessionStore((state) =>
    canAskSideQuestions(state.sessions[serverId]?.agents.get(agentId)),
  );
  return hostSupports && canFork;
}

/**
 * Opens a side question of this chat beside it (a sheet on phones) and fills it in: the quote the
 * user asked about, or the question typed after `/btw`.
 */
export function useBuildSideQuestionActions(input: {
  serverId: string;
  agentId: string;
  workspaceId: string;
}): SideQuestionActions | null {
  const { serverId, agentId, workspaceId } = input;
  const { t } = useTranslation();
  const toast = useToast();
  const available = useSideQuestionsAvailable(serverId, agentId);
  return useMemo(() => {
    if (!available) return null;
    return {
      open: async (request: SideQuestionOpenRequest = {}) => {
        try {
          const client = useSessionStore.getState().sessions[serverId]?.client;
          if (!client) throw new Error(t("sideQuestion.errors.disconnected"));
          const opened = await client.openSideQuestion(agentId, request.boundary);
          if (!opened.accepted || !opened.agentId) {
            throw new Error(opened.error ?? t("sideQuestion.errors.openFailed"));
          }
          const sideAgentId = opened.agentId;
          // The sheet decides tab or sheet by what the agent is, so the app must know it first.
          const fetched = await client.fetchAgent({ agentId: sideAgentId });
          if (fetched) storeFetchedAgentDetail({ serverId, result: fetched });
          if (request.quote) {
            await useDraftStore.getState().attachQuote({
              draftKey: buildDraftStoreKey({ serverId, agentId: sideAgentId }),
              quote: { id: generateMessageId(), ...request.quote },
            });
          }
          if (request.question) {
            await client.sendAgentMessage(sideAgentId, request.question, {
              messageId: generateMessageId(),
              images: [],
              attachments: [],
            });
          }
          openWorkspaceTargetBeside({
            workspaceKey: buildWorkspaceTabPersistenceKey({ serverId, workspaceId }),
            target: { kind: "agent", agentId: sideAgentId },
          });
        } catch (error) {
          toast.error(toErrorMessage(error) || t("sideQuestion.errors.openFailed"));
        }
      },
    };
  }, [agentId, available, serverId, t, toast, workspaceId]);
}
