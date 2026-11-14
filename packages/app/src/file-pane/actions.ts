import { useCallback, useMemo } from "react";
import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import type { FileTabActions, FileTabChanges } from "@/file-panels/actions";
import type { FilePreviewReadTarget } from "@/file-explorer/preview-target";
import { useFileDownload } from "@/hooks/use-file-download";
import { useCheckoutDiffQuery } from "@/git/use-diff-query";
import { useCheckoutStatusQuery } from "@/git/use-status-query";
import { useWorkingDiffComparison } from "@/git/working-diff-comparison";
import { useChangesPreferences } from "@/hooks/use-changes-preferences";
import { usePaneContext } from "@/panels/pane-context";
import { isAbsolutePath } from "@/utils/path";

/** The file tab's actions; `target` is null while the host is disconnected. */
export function useFileTabActions(input: {
  serverId: string;
  workspaceRoot: string;
  path: string;
  target: FilePreviewReadTarget | null;
  active: boolean;
}): FileTabActions {
  const { serverId, workspaceRoot, path, target, active } = input;
  const { workspaceId } = usePaneContext();
  const changes = useFileTabChanges({
    serverId,
    workspaceRoot,
    path,
    enabled: target !== null && active,
  });
  const downloadFile = useFileDownload({
    serverId,
    workspaceId,
    workspaceRoot: target?.cwd ?? workspaceRoot,
  });
  const download = useMemo(() => {
    if (!target) return null;
    const fileName = target.path.split(/[\\/]/).pop() || target.path;
    return () => downloadFile({ fileName, path: target.path });
  }, [downloadFile, target]);
  return useMemo(() => ({ changes, download }), [changes, download]);
}

/**
 * The file's entry in the workspace's Changes, as Changes compares it now. It reads the same
 * diff subscription as the Changes view, so with both open the daemon diffs once.
 */
function useFileTabChanges({
  serverId,
  workspaceRoot,
  path,
  enabled,
}: {
  serverId: string;
  workspaceRoot: string;
  path: string;
  enabled: boolean;
}): FileTabChanges | null {
  const { workspaceId, openPreferredTarget } = usePaneContext();
  const changesPath = workspaceRelativePath(path, workspaceRoot);
  const { status } = useCheckoutStatusQuery({ serverId, cwd: workspaceRoot });
  const gitStatus = status?.isGit ? status : null;
  const { comparison } = useWorkingDiffComparison({ serverId, workspaceId, cwd: workspaceRoot });
  const { preferences } = useChangesPreferences();
  const { files } = useCheckoutDiffQuery({
    serverId,
    cwd: workspaceRoot,
    mode: comparison,
    baseRef: gitStatus?.baseRef ?? undefined,
    ignoreWhitespace: preferences.hideWhitespace,
    enabled: enabled && gitStatus !== null && changesPath !== null,
  });
  const entry = changesPath === null ? null : findChangedFile(files, changesPath);
  const show = useCallback(() => {
    if (changesPath === null) return;
    openPreferredTarget(
      { kind: "working_diff", focusPath: changesPath, focusRequestId: Date.now() },
      "diffs",
    );
  }, [changesPath, openPreferredTarget]);
  const listed = entry !== null;
  const additions = entry?.additions ?? 0;
  const deletions = entry?.deletions ?? 0;
  return useMemo(
    () => (listed ? { additions, deletions, show } : null),
    [additions, deletions, listed, show],
  );
}

/** Changes lists files by their path in the workspace; a file outside it is never listed. */
export function workspaceRelativePath(path: string, workspaceRoot: string): string | null {
  const normalized = path.replace(/\\/g, "/");
  if (!isAbsolutePath(path)) return normalized.replace(/^\.\//, "");
  const root = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!root || !normalized.startsWith(`${root}/`)) return null;
  return normalized.slice(root.length + 1);
}

export function findChangedFile(
  files: readonly ParsedDiffFile[],
  path: string,
): ParsedDiffFile | null {
  return files.find((file) => file.path === path && !file.isDeleted) ?? null;
}
