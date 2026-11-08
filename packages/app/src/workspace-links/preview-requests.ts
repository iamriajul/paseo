import { useEffect } from "react";
import { create } from "zustand";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { useWorkspaceScriptActions } from "@/screens/workspace/scripts/use-workspace-script-actions";
import { useWorkspaceServiceOpener } from "@/workspace-services/use-workspace-services";
import { findMainPreviewService } from "@/workspace-services/workspace-services";

/**
 * A preview link names a workspace that may not be mounted yet. The link press
 * records the request here; the workspace screen opens the preview once it is
 * focused and knows its scripts, because only it owns the Browser that the
 * preview opens in (local or server-side).
 */
interface PreviewRequestState {
  pending: ReadonlySet<string>;
  request: (workspaceKey: string) => void;
  take: (workspaceKey: string) => boolean;
}

export const usePreviewRequestStore = create<PreviewRequestState>((set, get) => ({
  pending: new Set(),
  request: (workspaceKey) =>
    set((state) => ({ pending: new Set(state.pending).add(workspaceKey) })),
  take: (workspaceKey) => {
    if (!get().pending.has(workspaceKey)) {
      return false;
    }
    set((state) => {
      const pending = new Set(state.pending);
      pending.delete(workspaceKey);
      return { pending };
    });
    return true;
  },
}));

export function previewRequestKey(serverId: string, workspaceId: string): string {
  return `${serverId}:${workspaceId}`;
}

export function requestWorkspacePreview(serverId: string, workspaceId: string): void {
  usePreviewRequestStore.getState().request(previewRequestKey(serverId, workspaceId));
}

const NO_SCRIPTS: WorkspaceDescriptor["scripts"] = [];

/** Run by the workspace screen: opens a preview a link asked this workspace for. */
export function useWorkspacePreviewRequests(input: {
  serverId: string;
  workspaceId: string;
  focused: boolean;
  workspace: WorkspaceDescriptor | null | undefined;
  openUrlInBrowserTab: (url: string) => boolean;
}): void {
  const { serverId, workspaceId, focused, workspace, openUrlInBrowserTab } = input;
  const { t } = useTranslation();
  const toast = useToast();
  const scripts = workspace?.scripts ?? NO_SCRIPTS;
  const ready = focused && workspace != null;
  const key = previewRequestKey(serverId, workspaceId);
  const requested = usePreviewRequestStore((state) => state.pending.has(key));
  const { openService, start } = useWorkspaceScriptActions({ serverId, workspaceId, scripts });
  const { open: openPreview } = useWorkspaceServiceOpener({
    scripts,
    start,
    onOpen: (service) => openService(service, openUrlInBrowserTab),
  });

  useEffect(() => {
    if (!requested || !ready || !usePreviewRequestStore.getState().take(key)) {
      return;
    }
    const preview = findMainPreviewService(scripts);
    if (preview) {
      openPreview(preview.scriptName);
    } else {
      toast.error(t("workspaceLinks.previewMissing"));
    }
  }, [key, openPreview, ready, requested, scripts, t, toast]);
}
