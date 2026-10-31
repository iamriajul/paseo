import React from "react";
import { Network } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { ExplorerPortsPane } from "@/components/explorer-ports-pane";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel, type PanelPresentation } from "@/panels/panel-registry";

const ThemedNetwork = withUnistyles(Network);

export const portsPanelPresentation = {
  label: (t) => t("workspace.tabs.explorerSidebar.ports"),
  subtitle: (t) => t("workspace.tabs.explorerSidebar.ports"),
  tooltip: (t) => t("workspace.tabs.explorerSidebar.ports"),
  icon: ThemedNetwork,
} satisfies PanelPresentation;

/** Ports of the workspace's scripts. Before v0.14.0 this was a fixed compact Explorer tab. */
function PortsPanel() {
  const { serverId, workspaceId, target } = usePaneContext();
  invariant(target.kind === "ports", "PortsPanel requires ports target");
  return <ExplorerPortsPane serverId={serverId} workspaceId={workspaceId} />;
}

export const portsPanelRegistration = definePanel("ports", {
  component: PortsPanel,
  presentation: portsPanelPresentation,
});
