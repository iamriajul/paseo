import type { AgentAddress } from "@getpaseo/protocol/addresses";
import { memo, useCallback, type ReactElement, type ReactNode } from "react";
import { WorkspaceDiffStatPill } from "@/composer/diff-stat-pill";
import { WorkspaceTodoPill } from "@/composer/todo-pill";
import { useWorkspaceHasDiffStat } from "@/composer/workspace-diff-stat";
import { useWorkspaceTodoSummary } from "@/todos/workspace-todo-store";
import { AgentTaskList } from "@/composer/task-list";
import { ComposerTrackBar } from "@/composer/tracks";
import { useIsCompactFormFactor } from "@/constants/layout";
import { usePaneContext } from "@/panels/pane-context";
import { useSettings } from "@/hooks/use-settings";
import { PluginComposerPills } from "@/plugins";
import { useSessionStore } from "@/stores/session-store";
import {
  type ArchiveFinishedStatus,
  useArchiveSubagent,
  useDetachSubagent,
  useSubagentSheetTab,
  type SubagentRow,
} from "@/subagents";
import { ParentAgentPill } from "@/subagents/parent";
import { SubagentsTrack } from "@/subagents/track";
import type { TodoEntry } from "@/types/stream";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { buildWorkspaceTabPersistenceKey, type WorkspaceTabTarget } from "@/workspace-tabs/model";
import { openPreferredWorkspaceTarget } from "@/workspace-tabs/open-beside";
import { openComposerChanges } from "@/workspace-tabs/open-supporting-view";
import { openExplorerSidebarView } from "@/workspace-tabs/explorer-sidebar";
import { shouldShowAgentTrackBar } from "@/panels/agent-tracks-visibility";
import { RateLimitCooldownPill } from "@/rate-limit-cooldown/rate-limit-cooldown-pill";
import { useIsRateLimitCooldownActive } from "@/rate-limit-cooldown/use-rate-limit-cooldown";

/**
 * The pane's ambient context — workspace changes, subagents, and tasks — as a row of pills above
 * the composer.
 *
 * The row shares the composer's keyboard transform and owns the space between itself and the
 * transcript. Each pill owns its action while tab placement stays behind the workspace boundary.
 */
export const AgentTracks = memo(function AgentTracks({
  serverId,
  workspaceId,
  agentId,
  parentAgentId,
  subagentRows,
  tasks,
  archiveFinishedStatus,
  onArchiveFinished,
  hasPluginComposerPills,
  hasExtraPills = false,
  children,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  parentAgentId: string | null;
  subagentRows: SubagentRow[];
  tasks: TodoEntry[] | undefined;
  archiveFinishedStatus: ArchiveFinishedStatus;
  onArchiveFinished: () => void;
  hasPluginComposerPills: boolean;
  hasExtraPills?: boolean;
  children?: ReactNode;
}): ReactElement | null {
  const { tabId } = usePaneContext();
  const hasWorkspaceDiffStat = useWorkspaceHasDiffStat(serverId, workspaceId);
  const todoSummary = useWorkspaceTodoSummary(serverId, workspaceId);
  const hasWorkspaceTodos = Boolean(todoSummary && todoSummary.total > 0);
  const isCompact = useIsCompactFormFactor();
  const openInSidePane = useSettings((settings) => settings.openInSidePane);
  const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  const rateLimitCooldown = useSessionStore((state) => {
    const session = state.sessions[serverId];
    const agent = session?.agents?.get(agentId) ?? session?.agentDetails?.get(agentId);
    return agent?.rateLimitCooldown ?? null;
  });
  const isCooldownActive = useIsRateLimitCooldownActive(rateLimitCooldown);
  const canDetachSubagents = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.agentDetach === true,
  );
  const archiveSubagent = useArchiveSubagent();
  const detachSubagent = useDetachSubagent();
  const openSubagentTarget = useCallback(
    (target: WorkspaceTabTarget) => {
      openPreferredWorkspaceTarget({
        workspaceKey,
        target,
        source: "subagents",
        preferences: openInSidePane,
        parentTabId: tabId,
      });
    },
    [openInSidePane, tabId, workspaceKey],
  );
  const handleOpenSubagent = useCallback(
    ({ serverId: targetServerId, agentId: subagentId }: AgentAddress) => {
      const session = useSessionStore.getState().sessions[targetServerId];
      const agent = session?.agents.get(subagentId) ?? session?.agentDetails.get(subagentId);
      // A subagent in another workspace lives in that workspace's tabs.
      if (
        targetServerId !== serverId ||
        (agent?.workspaceId && agent.workspaceId !== workspaceId)
      ) {
        navigateToAgent({ serverId: targetServerId, agentId: subagentId });
        return;
      }
      openSubagentTarget({ kind: "agent", agentId: subagentId });
    },
    [openSubagentTarget, serverId, workspaceId],
  );
  const handleOpenProviderSubagent = useCallback(
    (ownerAgentId: string, subagentId: string) => {
      openSubagentTarget({
        kind: "provider_subagent",
        parentAgentId: ownerAgentId,
        subagentId,
      });
    },
    [openSubagentTarget],
  );
  const sheetTabFor = useSubagentSheetTab(workspaceKey, tabId);
  const handleOpenChanges = useCallback(() => {
    if (!workspaceKey) {
      return;
    }
    openComposerChanges({
      isCompact,
      workspaceKey,
      preferences: openInSidePane,
    });
  }, [isCompact, openInSidePane, workspaceKey]);

  const handleOpenTodo = useCallback(() => {
    openExplorerSidebarView({
      isCompact,
      workspaceKey,
      view: "todo",
    });
  }, [isCompact, workspaceKey]);

  if (
    !shouldShowAgentTrackBar({
      hasOfficialTracks: hasAgentTracks({
        parentAgentId,
        subagentRows,
        tasks,
        archiveFinishedStatus,
        hasPluginComposerPills,
      }),
      hasWorkspaceDiffStat,
      hasWorkspaceTodos,
      hasExtraPills: hasExtraPills || isCooldownActive,
    })
  ) {
    return null;
  }

  return (
    <ComposerTrackBar>
      {parentAgentId ? <ParentAgentPill serverId={serverId} parentAgentId={parentAgentId} /> : null}
      {isCooldownActive && rateLimitCooldown ? (
        <RateLimitCooldownPill serverId={serverId} agentId={agentId} cooldown={rateLimitCooldown} />
      ) : null}
      <AgentTaskList tasks={tasks} />
      <SubagentsTrack
        serverId={serverId}
        rows={subagentRows}
        onOpenSubagent={handleOpenSubagent}
        onOpenProviderSubagent={handleOpenProviderSubagent}
        sheetTabFor={sheetTabFor}
        onArchiveSubagent={archiveSubagent}
        onArchiveFinished={onArchiveFinished}
        archiveFinishedStatus={archiveFinishedStatus}
        onDetachSubagent={canDetachSubagents ? detachSubagent : undefined}
      />
      <PluginComposerPills
        serverId={serverId}
        workspaceId={workspaceId}
        agentId={agentId}
        compact={isCompact}
      />
      <WorkspaceTodoPill serverId={serverId} workspaceId={workspaceId} onPress={handleOpenTodo} />
      <WorkspaceDiffStatPill
        serverId={serverId}
        workspaceId={workspaceId}
        onPress={handleOpenChanges}
      />
      {children}
    </ComposerTrackBar>
  );
});

export function hasAgentTracks({
  parentAgentId,
  subagentRows,
  tasks,
  archiveFinishedStatus,
  hasPluginComposerPills = false,
}: {
  parentAgentId: string | null;
  subagentRows: readonly SubagentRow[];
  tasks: readonly TodoEntry[] | undefined;
  archiveFinishedStatus: ArchiveFinishedStatus;
  hasPluginComposerPills?: boolean;
}): boolean {
  return (
    parentAgentId !== null ||
    subagentRows.length > 0 ||
    Boolean(tasks?.length) ||
    archiveFinishedStatus.kind !== "idle" ||
    hasPluginComposerPills
  );
}

export { shouldShowAgentTrackBar } from "@/panels/agent-tracks-visibility";
