import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-api-context";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { useWorkspaceScriptActions } from "@/screens/workspace/scripts/use-workspace-script-actions";
import { useWorkspaceServiceOpener } from "@/workspace-services/use-workspace-services";
import { findMainPreviewService } from "@/workspace-services/workspace-services";

import { previewRequestKey, usePreviewRequestStore } from "./preview-request-store";

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
