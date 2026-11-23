import { memo, useCallback, useMemo, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Archive } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ComposerTrackActions, ComposerTrackPill, ComposerTrackRow } from "@/composer/tracks";
import { mutedIconColorMapping } from "@/components/ui/icon-button-chrome";
import { ToolbarButton, paneContentToolbarIconSize } from "@/components/ui/pane-content-toolbar";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { useArchiveAgent } from "@/hooks/use-archive-agent";
import { formatUsdEstimate, resolveSessionCostUsd } from "@/prompt-cache/prompt-cache-cost";
import { useSessionStore, type Agent } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { openWorkspaceTargetBeside } from "@/workspace-tabs/open-beside";
import { readSideQuestionPoint, selectSideQuestionsOf } from "@/side-questions/model";

const ThemedArchive = withUnistyles(Archive);
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ROW_ICON_SIZE = 14;
const EMPTY_AGENTS: Agent[] = [];

/** The live side questions of one chat. Stable between store updates that leave them alone. */
export function useSideQuestionRows(serverId: string, sourceAgentId: string): Agent[] {
  const agents = useSessionStore((state) => state.sessions[serverId]?.agents);
  return useMemo(
    () => (agents ? selectSideQuestionsOf(agents, sourceAgentId) : EMPTY_AGENTS),
    [agents, sourceAgentId],
  );
}

function countAnswers(agent: Agent): number {
  return (agent.promptCache?.history ?? []).filter((entry) => entry.kind === "turn").length;
}

/** An answer that arrived while its pane was closed leaves the agent marked for attention. */
function hasUnseenAnswer(agent: Agent): boolean {
  return agent.requiresAttention === true && agent.attentionReason === "finished";
}

/**
 * The **Side questions** pill in the composer track bar, above the main chat's composer. Its panel
 * lists this chat's side questions: pressing one reopens it, and **Archive all** clears them.
 */
export const SideQuestionsTrack = memo(function SideQuestionsTrack({
  serverId,
  agentId,
  workspaceId,
}: {
  serverId: string;
  agentId: string;
  workspaceId: string;
}): ReactElement | null {
  const { t } = useTranslation();
  const rows = useSideQuestionRows(serverId, agentId);
  const { archiveAgent } = useArchiveAgent();
  const handleOpen = useCallback(
    (sideAgentId: string) => {
      openWorkspaceTargetBeside({
        workspaceKey: buildWorkspaceTabPersistenceKey({ serverId, workspaceId }),
        target: { kind: "agent", agentId: sideAgentId },
      });
    },
    [serverId, workspaceId],
  );
  const handleArchive = useCallback(
    (sideAgentId: string) => void archiveAgent({ serverId, agentId: sideAgentId }),
    [archiveAgent, serverId],
  );
  const handleArchiveAll = useCallback(() => {
    for (const row of rows) void archiveAgent({ serverId, agentId: row.id });
  }, [archiveAgent, rows, serverId]);
  const unseen = rows.some(hasUnseenAnswer);
  const segments = useMemo(
    () => [
      {
        bucket: unseen ? ("attention" as const) : null,
        text: `${t("sideQuestion.pill")} · ${rows.length}`,
      },
    ],
    [rows.length, t, unseen],
  );
  if (rows.length === 0) return null;
  return (
    <ComposerTrackPill
      testID="side-questions-track-header"
      segments={segments}
      accessibilityLabel={t("sideQuestion.pill")}
      panelTitle={t("sideQuestion.listTitle")}
    >
      <ComposerTrackActions>
        <ArchiveAllRow onPress={handleArchiveAll} />
      </ComposerTrackActions>
      {rows.map((row) => (
        <SideQuestionRow key={row.id} row={row} onOpen={handleOpen} onArchive={handleArchive} />
      ))}
    </ComposerTrackPill>
  );
});

function ArchiveAllRow({ onPress }: { onPress: () => void }): ReactElement {
  const { t } = useTranslation();
  const renderRow = useCallback(
    ({ active }: { active: boolean }) => (
      <>
        <ThemedArchive
          size={ROW_ICON_SIZE}
          uniProps={active ? foregroundColorMapping : foregroundMutedColorMapping}
        />
        <Text style={styles.rowLabel} numberOfLines={1}>
          {t("sideQuestion.archiveAll")}
        </Text>
      </>
    ),
    [t],
  );
  return (
    <ComposerTrackRow
      accessibilityLabel={t("sideQuestion.archiveAll")}
      testID="side-questions-archive-all"
      onPress={onPress}
    >
      {renderRow}
    </ComposerTrackRow>
  );
}

function SideQuestionRow({
  row,
  onOpen,
  onArchive,
}: {
  row: Agent;
  onOpen: (agentId: string) => void;
  onArchive: (agentId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const title = row.title?.trim() || t("sideQuestion.untitled");
  const answers = countAnswers(row);
  const cost = resolveSessionCostUsd(row);
  const facts = [
    t(answers === 1 ? "sideQuestion.answersOne" : "sideQuestion.answersOther", { count: answers }),
    t(
      readSideQuestionPoint(row.labels) === "earlier"
        ? "sideQuestion.pointEarlier"
        : "sideQuestion.pointLatest",
    ),
    ...(cost !== null ? [`≈ ${formatUsdEstimate(cost)}`] : []),
  ].join(" · ");
  const handlePress = useCallback(() => onOpen(row.id), [onOpen, row.id]);
  const handleArchive = useCallback(() => onArchive(row.id), [onArchive, row.id]);
  const visible = isNative || isCompact;
  const iconSize = paneContentToolbarIconSize(isCompact);
  const renderRow = useCallback(
    ({ active }: { active: boolean }) => (
      <>
        <View style={styles.rowText}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {title}
          </Text>
          <Text
            style={styles.rowFacts}
            numberOfLines={1}
            testID={`side-question-row-facts-${row.id}`}
          >
            {facts}
          </Text>
        </View>
        <View
          style={visible || active ? styles.actionVisible : styles.actionHidden}
          pointerEvents={visible || active ? "auto" : "none"}
        >
          <ToolbarButton
            label={t("sideQuestion.archive")}
            tooltipSide="top"
            compact={isCompact}
            onPress={handleArchive}
            testID={`side-question-archive-${row.id}`}
          >
            <ThemedArchive size={iconSize} uniProps={mutedIconColorMapping} />
          </ToolbarButton>
        </View>
      </>
    ),
    [facts, handleArchive, iconSize, isCompact, row.id, t, title, visible],
  );
  return (
    <ComposerTrackRow
      accessibilityLabel={title}
      testID={`side-question-row-${row.id}`}
      onPress={handlePress}
    >
      {renderRow}
    </ComposerTrackRow>
  );
}

const styles = StyleSheet.create((theme) => ({
  rowLabel: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "auto",
    minWidth: 0,
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  rowText: { flexGrow: 1, flexShrink: 1, flexBasis: "auto", minWidth: 0 },
  rowTitle: { fontSize: theme.fontSize.base, color: theme.colors.foreground },
  rowFacts: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  actionVisible: { opacity: 1 },
  actionHidden: { opacity: 0 },
}));
