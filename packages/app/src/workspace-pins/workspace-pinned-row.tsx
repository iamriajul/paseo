import { useCallback, useMemo, type ReactElement } from "react";
import {
  useWorkspaceTabLaunchCatalog,
  type WorkspaceTabLaunchItem,
  type WorkspaceTabLaunchPurpose,
} from "@/workspace-tabs/launcher";
import { usePinnedLaunchers } from "@/workspace-pins/launch";
import { pinTargetLaunchItemId } from "@/workspace-pins/launch-item";
import { PinnedTargetsRow } from "@/workspace-pins/pinned-targets-row";
import type { PinnedTabTarget } from "@/workspace-pins/target";

export function WorkspacePinnedTargetsRow({
  serverId,
  purpose,
  paneId,
}: {
  serverId: string;
  purpose: WorkspaceTabLaunchPurpose;
  paneId?: string;
}): ReactElement | null {
  const groups = useWorkspaceTabLaunchCatalog({ serverId, purpose });
  const itemsById = useMemo(() => {
    const map = new Map<string, WorkspaceTabLaunchItem>();
    for (const group of groups) {
      for (const item of group.items) {
        map.set(item.id, item);
      }
    }
    return map;
  }, [groups]);

  const onLaunch = useCallback(
    (target: PinnedTabTarget) => {
      itemsById.get(pinTargetLaunchItemId(target))?.launch({ kind: "open", paneId });
    },
    [itemsById, paneId],
  );

  const launchers = usePinnedLaunchers({ serverId, onLaunch });
  if (launchers.length === 0) {
    return null;
  }
  return <PinnedTargetsRow launchers={launchers} testIdPrefix="workspace-pinned-target" />;
}
