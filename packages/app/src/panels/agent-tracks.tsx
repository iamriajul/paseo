import { memo, useCallback, type ReactElement, type ReactNode } from "react";
import { WorkspaceDiffStatPill } from "@/composer/diff-stat-pill";
import { WorkspaceTodoPill } from "@/composer/todo-pill";
import { useWorkspaceHasDiffStat } from "@/composer/workspace-diff-stat";
import { useWorkspaceTodoSummary } from "@/todos/workspace-todo-store";
import { AgentTaskList } from "@/composer/task-list";
import { ComposerTrackBar } from "@/composer/tracks";
import { supportsDesktopPaneSplits, useIsCompactFormFactor } from "@/constants/layout";
import { usePaneContext } from "@/panels/pane-context";
import { useSettings } from "@/hooks/use-settings";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import {
  type ArchiveFinishedStatus,
  useArchiveSubagent,
  useDetachSubagent,
  type SubagentRow,
} from "@/subagents";
import { SubagentsTrack } from "@/subagents/track";
import type { TodoEntry } from "@/types/stream";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { openPreferredWorkspaceTarget } from "@/workspace-tabs/open-beside";
import { openExplorerSidebarView } from "@/workspace-tabs/explorer-sidebar";
import { shouldShowAgentTrackBar } from "@/panels/agent-tracks-visibility";

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
  subagentRows,
  tasks,
  archiveFinishedStatus,
  onArchiveFinished,
  hasExtraPills = false,
  children,
}: {
  serverId: string;
  workspaceId: string;
  subagentRows: SubagentRow[];
  tasks: TodoEntry[] | undefined;
  archiveFinishedStatus: ArchiveFinishedStatus;
  onArchiveFinished: () => void;
  hasExtraPills?: boolean;
  children?: ReactNode;
}): ReactElement | null {
  const { tabId, openTab } = usePaneContext();
  const hasWorkspaceDiffStat = useWorkspaceHasDiffStat(serverId, workspaceId);
  const todoSummary = useWorkspaceTodoSummary(serverId, workspaceId);
  const hasWorkspaceTodos = Boolean(todoSummary && todoSummary.total > 0);
  const workspaceDirectory = useWorkspaceDirectory(serverId, workspaceId);
  const isCompact = useIsCompactFormFactor();
  const canSplit = supportsDesktopPaneSplits() && !isCompact;
  const openInSidePane = useSettings((settings) => settings.openInSidePane);
  const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  const canDetachSubagents = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.agentDetach === true,
  );
  const archiveSubagent = useArchiveSubagent({ serverId });
  const detachSubagent = useDetachSubagent({ serverId });
  const handleOpenSubagent = useCallback(
    (subagentId: string) => {
      const session = useSessionStore.getState().sessions[serverId];
      const agent = session?.agents.get(subagentId) ?? session?.agentDetails.get(subagentId);
      if (agent?.workspaceId && agent.workspaceId !== workspaceId) {
        navigateToAgent({ serverId, agentId: subagentId });
        return;
      }
      if (canSplit && workspaceKey) {
        openPreferredWorkspaceTarget({
          isCompact,
          workspaceKey,
          target: { kind: "agent", agentId: subagentId },
          source: "subagents",
          preferences: openInSidePane,
          parentTabId: tabId,
        });
        return;
      }
      navigateToAgent({ serverId, agentId: subagentId });
    },
    [canSplit, isCompact, openInSidePane, serverId, tabId, workspaceId, workspaceKey],
  );
  const handleOpenProviderSubagent = useCallback(
    (parentAgentId: string, subagentId: string) => {
      if (canSplit && workspaceKey) {
        openPreferredWorkspaceTarget({
          isCompact,
          workspaceKey,
          target: { kind: "provider_subagent", parentAgentId, subagentId },
          source: "subagents",
          preferences: openInSidePane,
          parentTabId: tabId,
        });
        return;
      }
      openTab({ kind: "provider_subagent", parentAgentId, subagentId });
    },
    [canSplit, isCompact, openInSidePane, openTab, tabId, workspaceKey],
  );
  const handleOpenChanges = useCallback(() => {
    if (!workspaceKey) {
      return;
    }
    openPreferredWorkspaceTarget({
      isCompact,
      workspaceKey,
      target: { kind: "working_diff" },
      source: "changesLinks",
      preferences: openInSidePane,
    });
  }, [isCompact, openInSidePane, workspaceKey]);

  const handleOpenTodo = useCallback(() => {
    openExplorerSidebarView({
      isCompact,
      workspaceKey,
      checkout: { serverId, cwd: workspaceDirectory ?? "", isGit: true },
      view: "todo",
    });
  }, [isCompact, serverId, workspaceDirectory, workspaceKey]);

  if (
    !shouldShowAgentTrackBar({
      hasOfficialTracks: hasAgentTracks({ subagentRows, tasks, archiveFinishedStatus }),
      hasWorkspaceDiffStat,
      hasWorkspaceTodos,
      hasExtraPills,
    })
  ) {
    return null;
  }

  return (
    <ComposerTrackBar>
      <AgentTaskList tasks={tasks} />
      <SubagentsTrack
        rows={subagentRows}
        onOpenSubagent={handleOpenSubagent}
        onOpenProviderSubagent={handleOpenProviderSubagent}
        onArchiveSubagent={archiveSubagent}
        onArchiveFinished={onArchiveFinished}
        archiveFinishedStatus={archiveFinishedStatus}
        onDetachSubagent={canDetachSubagents ? detachSubagent : undefined}
      />
      {children}
      <WorkspaceTodoPill serverId={serverId} workspaceId={workspaceId} onPress={handleOpenTodo} />
      <WorkspaceDiffStatPill
        serverId={serverId}
        workspaceId={workspaceId}
        onPress={handleOpenChanges}
      />
    </ComposerTrackBar>
  );
});

export function hasAgentTracks({
  subagentRows,
  tasks,
  archiveFinishedStatus,
}: {
  subagentRows: readonly SubagentRow[];
  tasks: readonly TodoEntry[] | undefined;
  archiveFinishedStatus: ArchiveFinishedStatus;
}): boolean {
  return subagentRows.length > 0 || Boolean(tasks?.length) || archiveFinishedStatus.kind !== "idle";
}

export { shouldShowAgentTrackBar } from "@/panels/agent-tracks-visibility";
