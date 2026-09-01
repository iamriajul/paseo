import { Platform } from "react-native";
import { getIsElectron, isWeb } from "@/constants/platform";
import { useHostFeature } from "@/runtime/host-features";
import { useBrowserPreviewTemplate } from "./workspace-browser-preview";

export interface WorkspaceBrowserAvailabilityInput {
  isElectron: boolean;
  isAndroid: boolean;
  isWeb: boolean;
  hasTcpTunnel: boolean;
  hasBrowserPreviewTemplate: boolean;
}

export function resolveWorkspaceBrowserAvailability(
  input: WorkspaceBrowserAvailabilityInput,
): boolean {
  // Electron must short-circuit: it also reports Platform.OS === "web", but it
  // routes loopback through its own session proxy and needs no template.
  if (input.isElectron) {
    return true;
  }
  if (input.isAndroid) {
    return input.hasTcpTunnel;
  }
  return input.isWeb && input.hasBrowserPreviewTemplate;
}

export function useWorkspaceBrowserAvailability(serverId: string): boolean {
  // COMPAT(androidBrowserTcpTunnel): added in v0.1.110, remove after 2027-01-17
  // when the supported daemon floor guarantees server_info.features.tcpTunnel.
  const hasTcpTunnel = useHostFeature(serverId, "tcpTunnel");
  const hasBrowserPreviewTemplate = useBrowserPreviewTemplate(serverId) !== null;
  return resolveWorkspaceBrowserAvailability({
    isElectron: getIsElectron(),
    isAndroid: Platform.OS === "android",
    isWeb,
    hasTcpTunnel,
    hasBrowserPreviewTemplate,
  });
}
