import { useSessionStore } from "@/stores/session-store";
import type { HostFeatureSessionState } from "@/runtime/host-features";

export function selectBrowserPreviewTemplate(
  state: HostFeatureSessionState,
  serverId: string,
): string | null {
  const template = state.sessions[serverId]?.serverInfo?.browserPreview?.urlTemplate;
  return typeof template === "string" && template.length > 0 ? template : null;
}

export function useBrowserPreviewTemplate(serverId: string | null | undefined): string | null {
  const normalized = serverId?.trim() ?? "";
  return useSessionStore((state) => selectBrowserPreviewTemplate(state, normalized));
}

export function buildBrowserPreviewUrl(template: string, port: number): string {
  return template.replace("{port}", String(port));
}
