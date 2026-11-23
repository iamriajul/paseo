import { memo, useCallback } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Archive, Ellipsis, GitFork, Lock } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { StatusBadge } from "@/components/ui/status-badge";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { PressHighlight } from "@/components/ui/press-highlight";
import { usePaneContext } from "@/panels/pane-context";
import { useArchiveAgent } from "@/hooks/use-archive-agent";
import { useToast } from "@/contexts/toast-api-context";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { ICON_SIZE } from "@/styles/theme";
import { toErrorMessage } from "@/utils/error-messages";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { readSideQuestionPoint } from "@/side-questions/model";
import { useDiscardEmptySideQuestion } from "@/side-questions/use-discard-empty";

const ThemedEllipsis = withUnistyles(Ellipsis);
const ThemedLock = withUnistyles(Lock);
const ThemedFork = withUnistyles(GitFork);
const ThemedArchive = withUnistyles(Archive);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const lockIcon = <ThemedLock size={ICON_SIZE.sm - 2} uniProps={mutedMapping} />;
const forkIcon = <ThemedFork size={ICON_SIZE.sm} uniProps={foregroundMapping} />;
const archiveIcon = <ThemedArchive size={ICON_SIZE.sm} uniProps={foregroundMapping} />;

export function useContinueSideQuestion(input: { serverId: string; sideAgentId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { serverId, sideAgentId } = input;
  return useCallback(async () => {
    try {
      const client = useSessionStore.getState().sessions[serverId]?.client;
      if (!client) throw new Error(t("sideQuestion.errors.disconnected"));
      const forked = await client.nativeForkAgent(sideAgentId, { target: "tab" });
      if (!forked.accepted || !forked.agentId) {
        throw new Error(forked.error ?? t("sideQuestion.errors.continueFailed"));
      }
      navigateToAgent({ serverId, agentId: forked.agentId });
    } catch (error) {
      toast.error(toErrorMessage(error) || t("sideQuestion.errors.continueFailed"));
    }
  }, [serverId, sideAgentId, t, toast]);
}

/**
 * The top of a side question's pane or sheet: its name, the Read-only badge, and a menu. Under it,
 * what the question can see. Pressing the chat's title goes to that chat.
 */
export const SideQuestionHeader = memo(function SideQuestionHeader({
  serverId,
  sideAgentId,
  mainAgentId,
}: {
  serverId: string;
  sideAgentId: string;
  mainAgentId: string;
}) {
  const { t } = useTranslation();
  useDiscardEmptySideQuestion({ serverId, sideAgentId });
  const { closeCurrentTab } = usePaneContext();
  const { archiveAgent } = useArchiveAgent();
  // Primitive selectors: an object built in a selector is new on every read and loops the store.
  const mainTitle = useSessionStore((state) => {
    const session = state.sessions[serverId];
    const agent = session?.agents.get(mainAgentId) ?? session?.agentDetails.get(mainAgentId);
    return agent?.title ?? null;
  });
  const mainRunning = useSessionStore(
    (state) => state.sessions[serverId]?.agents.get(mainAgentId)?.status === "running",
  );
  const point = useSessionStore((state) =>
    readSideQuestionPoint(state.sessions[serverId]?.agents.get(sideAgentId)?.labels),
  );
  const handleContinue = useContinueSideQuestion({ serverId, sideAgentId });
  const handleArchive = useCallback(() => {
    void archiveAgent({ serverId, agentId: sideAgentId });
    closeCurrentTab();
  }, [archiveAgent, closeCurrentTab, serverId, sideAgentId]);
  const handleOpenMain = useCallback(
    () => navigateToAgent({ serverId, agentId: mainAgentId }),
    [mainAgentId, serverId],
  );
  const title = mainTitle?.trim() || t("sideQuestion.mainChatMissing");
  const context = t(
    point === "earlier" ? "sideQuestion.contextEarlier" : "sideQuestion.contextLatest",
    {
      title,
    },
  );
  return (
    <View style={styles.header} testID="side-question-header">
      <View style={styles.titleRow}>
        <Text style={styles.title} numberOfLines={1}>
          {t("sideQuestion.title")}
        </Text>
        <StatusBadge label={t("sideQuestion.readOnly")} size="xs" leading={lockIcon} />
        <View style={styles.spacer} />
        <DropdownMenu>
          <ToolbarButton
            kind="menu"
            label={t("sideQuestion.menu")}
            compact
            testID="side-question-menu"
          >
            <ThemedEllipsis size={ICON_SIZE.md} uniProps={mutedMapping} />
          </ToolbarButton>
          <DropdownMenuContent
            align="end"
            minWidth={240}
            side="bottom"
            testID="side-question-menu-content"
          >
            <DropdownMenuItem
              leading={forkIcon}
              onSelect={handleContinue}
              testID="side-question-continue"
            >
              {t("sideQuestion.continueFull")}
            </DropdownMenuItem>
            <DropdownMenuItem
              leading={archiveIcon}
              onSelect={handleArchive}
              testID="side-question-archive"
            >
              {t("sideQuestion.archive")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </View>
      <PressHighlight
        onPress={handleOpenMain}
        accessibilityRole="link"
        accessibilityLabel={context}
        testID="side-question-context"
      >
        <Text style={styles.context} numberOfLines={2}>
          {context}
          {mainRunning ? ` · ${t("sideQuestion.agentKeepsWorking")}` : ""}
        </Text>
      </PressHighlight>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  header: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[2],
    gap: theme.spacing[1],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  titleRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  spacer: { flex: 1 },
  context: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
