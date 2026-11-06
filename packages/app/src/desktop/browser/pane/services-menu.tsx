import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { useTranslation } from "react-i18next";
import { Server } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { WorkspaceScriptPayload } from "@getpaseo/protocol/messages";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceScriptActions } from "@/screens/workspace/scripts/use-workspace-script-actions";
import { findServiceForBrowserUrl } from "@/utils/workspace-script-links";

const EMPTY_SCRIPTS: WorkspaceScriptPayload[] = [];
const ThemedServer = withUnistyles(Server);
const mutedIcon = (theme: { colors: { foregroundMuted: string } }) => ({
  color: theme.colors.foregroundMuted,
});
const accentIcon = (theme: { colors: { accent: string } }) => ({ color: theme.colors.accent });

export function serviceBrowserUrl(port: number): string {
  return `http://localhost:${port}/`;
}

function useWorkspaceServices(serverId: string, workspaceId: string): WorkspaceScriptPayload[] {
  const scripts = useSessionStore(
    (state) => state.sessions[serverId]?.workspaces?.get(workspaceId)?.scripts ?? EMPTY_SCRIPTS,
  );
  return useMemo(() => scripts.filter((script) => script.type === "service"), [scripts]);
}

/** The paseo.json service this tab is showing, when its URL points at one. */
export function useBrowserTabService(input: {
  serverId: string;
  workspaceId: string;
  url: string;
}): WorkspaceScriptPayload | null {
  const services = useWorkspaceServices(input.serverId, input.workspaceId);
  return useMemo(
    () => findServiceForBrowserUrl({ url: input.url, scripts: services }),
    [input.url, services],
  );
}

/**
 * Lists the workspace's paseo.json services inside the Browser. A running service
 * opens at its localhost route (the same origin a hand-typed localhost tab gets);
 * a stopped one starts first and opens once the daemon reports it running.
 */
export function BrowserServicesMenu(props: {
  serverId: string;
  workspaceId: string;
  currentUrl: string;
  onNavigate: (url: string) => void;
  triggerStyle: (state: { hovered?: boolean; pressed?: boolean }) => StyleProp<ViewStyle>;
}): ReactElement | null {
  const { t } = useTranslation();
  const services = useWorkspaceServices(props.serverId, props.workspaceId);
  const actions = useWorkspaceScriptActions({
    serverId: props.serverId,
    workspaceId: props.workspaceId,
    scripts: services,
  });
  const current = findServiceForBrowserUrl({ url: props.currentUrl, scripts: services });
  const [pendingOpen, setPendingOpen] = useState<string | null>(null);
  const startService = actions.start;
  const handleStart = useCallback(
    (scriptName: string) => {
      setPendingOpen(scriptName);
      startService(scriptName);
    },
    [startService],
  );
  const onNavigateRef = useRef(props.onNavigate);
  onNavigateRef.current = props.onNavigate;

  useEffect(() => {
    if (!pendingOpen) {
      return;
    }
    const started = services.find((service) => service.scriptName === pendingOpen);
    if (started?.lifecycle === "running" && started.port !== null) {
      setPendingOpen(null);
      onNavigateRef.current(serviceBrowserUrl(started.port));
    }
  }, [pendingOpen, services]);

  if (services.length === 0) {
    return null;
  }
  const label = t("workspace.browser.services.label");
  return (
    <DropdownMenu>
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger
            accessibilityLabel={label}
            style={props.triggerStyle}
            testID="browser-services-trigger"
          >
            <ThemedServer size={16} uniProps={current ? accentIcon : mutedIcon} />
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center" offset={8}>
          <Text style={styles.tooltipText}>{label}</Text>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" scrollable maxHeight={360}>
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {services.map((service) => (
          <ServiceMenuItem
            key={service.scriptName}
            service={service}
            selected={current?.scriptName === service.scriptName}
            starting={pendingOpen === service.scriptName}
            onOpen={props.onNavigate}
            onStart={handleStart}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ServiceMenuItem(props: {
  service: WorkspaceScriptPayload;
  selected: boolean;
  starting: boolean;
  onOpen: (url: string) => void;
  onStart: (scriptName: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const { service, onOpen, onStart } = props;
  const isRunning = service.lifecycle === "running" && service.port !== null;
  const handleSelect = useCallback(() => {
    if (isRunning && service.port !== null) {
      onOpen(serviceBrowserUrl(service.port));
      return;
    }
    onStart(service.scriptName);
  }, [isRunning, onOpen, onStart, service.port, service.scriptName]);
  const leading = useMemo(
    () => <View style={[styles.dot, isRunning ? styles.dotRunning : styles.dotStopped]} />,
    [isRunning],
  );
  let description: string;
  if (props.starting) {
    description = t("workspace.browser.services.starting");
  } else if (isRunning) {
    description = `localhost:${service.port}${
      service.health === "unhealthy" ? ` · ${t("workspace.browser.services.unhealthy")}` : ""
    }`;
  } else {
    description = t("workspace.browser.services.startAndOpen");
  }
  return (
    <DropdownMenuItem
      onSelect={handleSelect}
      selected={props.selected}
      showSelectedCheck
      description={description}
      muted={!isRunning}
      testID={`browser-service-${service.scriptName}`}
      leading={leading}
    >
      {service.scriptName}
    </DropdownMenuItem>
  );
}

const styles = StyleSheet.create((theme) => ({
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.popoverForeground,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  dotRunning: {
    backgroundColor: theme.colors.palette.green[500],
  },
  dotStopped: {
    backgroundColor: theme.colors.foregroundMuted,
  },
}));
