import { useMemo } from "react";
import { useBrowserPreviewTemplate } from "@/desktop/browser/workspace-browser-preview";
import { useWorkspaceServices } from "@/workspace-services/use-workspace-services";
import { resolvePublicPageUrl, type PublicPageUrl } from "./public-page-url";

/** Where a browser off the host can open this tab's page; see resolvePublicPageUrl. */
export function usePublicPageUrl(input: {
  serverId: string;
  workspaceId: string;
  url: string;
}): PublicPageUrl | null {
  const previewTemplate = useBrowserPreviewTemplate(input.serverId);
  const { services } = useWorkspaceServices(input.serverId, input.workspaceId);
  return useMemo(
    () => resolvePublicPageUrl({ url: input.url, previewTemplate, scripts: services }),
    [input.url, previewTemplate, services],
  );
}
