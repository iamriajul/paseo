import { useCallback, useMemo, type ReactElement } from "react";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { useTranslation } from "react-i18next";
import { AppWindow, Server } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { WorkspaceScriptPayload } from "@getpaseo/protocol/messages";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useWorkspaceScriptActions } from "@/screens/workspace/scripts/use-workspace-script-actions";
import { findServiceForBrowserUrl } from "@/utils/workspace-script-links";
import {
  useWorkspaceServiceOpener,
  useWorkspaceServices,
} from "@/workspace-services/use-workspace-services";
import { isServiceOpenable, serviceBrowserUrl } from "@/workspace-services/workspace-services";

const ThemedServer = withUnistyles(Server);
const ThemedAppWindow = withUnistyles(AppWindow);
const mutedIcon = (theme: { colors: { foregroundMuted: string } }) => ({
  color: theme.colors.foregroundMuted,
});
const accentIcon = (theme: { colors: { accent: string } }) => ({ color: theme.colors.accent });
const PREVIEW_ICON = <ThemedAppWindow size={16} uniProps={accentIcon} />;

/** The paseo.json service this tab is showing, when its URL points at one. */
export function useBrowserTabService(input: {
  serverId: string;
  workspaceId: string;
  url: string;
}): WorkspaceScriptPayload | null {
  const { services } = useWorkspaceServices(input.serverId, input.workspaceId);
  return useMemo(
    () => findServiceForBrowserUrl({ url: input.url, scripts: services }),
    [input.url, services],
  );
}

/** The service name the URL bar shows ahead of the address, on every Browser pane. */
export function BrowserServiceChip(props: {
  serverId: string;
  workspaceId: string;
  url: string;
}): ReactElement | null {
  const service = useBrowserTabService(props);
  if (!service) {
    return null;
  }
  return (
    <View style={styles.serviceChip} testID="browser-service-chip">
      <Text style={styles.serviceChipText} numberOfLines={1}>
        {service.scriptName}
      </Text>
    </View>
  );
}

/**
 * Lists the workspace's paseo.json services inside the Browser. A running service
 * opens at its localhost route (the same origin a hand-typed localhost tab gets);
 * a stopped one starts first and opens once the daemon reports it running. The
 * service marked `"preview": true` leads the menu as Open preview.
 */
export function BrowserServicesMenu(props: {
  serverId: string;
  workspaceId: string;
  currentUrl: string;
  onNavigate: (url: string) => void;
  triggerStyle: (state: { hovered?: boolean; pressed?: boolean }) => StyleProp<ViewStyle>;
}): ReactElement | null {
  const { t } = useTranslation();
  const { onNavigate } = props;
  const { services, previewService } = useWorkspaceServices(props.serverId, props.workspaceId);
  const actions = useWorkspaceScriptActions({
    serverId: props.serverId,
    workspaceId: props.workspaceId,
    scripts: services,
  });
  const handleOpen = useCallback(
    (service: WorkspaceScriptPayload) => {
      if (service.port !== null) onNavigate(serviceBrowserUrl(service.port));
    },
    [onNavigate],
  );
  const opener = useWorkspaceServiceOpener({
    scripts: services,
    start: actions.start,
    onOpen: handleOpen,
  });
  const current = findServiceForBrowserUrl({ url: props.currentUrl, scripts: services });

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
        {previewService ? (
          <>
            <PreviewMenuItem
              service={previewService}
              starting={opener.pendingScriptName === previewService.scriptName}
              onOpen={opener.open}
            />
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {services.map((service) => (
          <ServiceMenuItem
            key={service.scriptName}
            service={service}
            selected={current?.scriptName === service.scriptName}
            starting={opener.pendingScriptName === service.scriptName}
            onOpen={opener.open}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PreviewMenuItem(props: {
  service: WorkspaceScriptPayload;
  starting: boolean;
  onOpen: (scriptName: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const { service, onOpen } = props;
  const handleSelect = useCallback(() => onOpen(service.scriptName), [onOpen, service.scriptName]);
  return (
    <DropdownMenuItem
      onSelect={handleSelect}
      leading={PREVIEW_ICON}
      description={`${service.scriptName} · ${describeService(service, props.starting, t)}`}
      testID="browser-services-open-preview"
    >
      {t("workspace.scripts.actions.openPreview")}
    </DropdownMenuItem>
  );
}

function ServiceMenuItem(props: {
  service: WorkspaceScriptPayload;
  selected: boolean;
  starting: boolean;
  onOpen: (scriptName: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const { service, onOpen } = props;
  const isRunning = isServiceOpenable(service);
  const handleSelect = useCallback(() => onOpen(service.scriptName), [onOpen, service.scriptName]);
  const leading = useMemo(
    () => <View style={[styles.dot, isRunning ? styles.dotRunning : styles.dotStopped]} />,
    [isRunning],
  );
  return (
    <DropdownMenuItem
      onSelect={handleSelect}
      selected={props.selected}
      showSelectedCheck
      description={describeService(service, props.starting, t)}
      muted={!isRunning}
      testID={`browser-service-${service.scriptName}`}
      leading={leading}
    >
      {service.scriptName}
    </DropdownMenuItem>
  );
}

function describeService(
  service: WorkspaceScriptPayload,
  starting: boolean,
  t: (key: string) => string,
): string {
  if (starting) {
    return t("workspace.browser.services.starting");
  }
  if (isServiceOpenable(service)) {
    const unhealthy =
      service.health === "unhealthy" ? ` · ${t("workspace.browser.services.unhealthy")}` : "";
    return `localhost:${service.port}${unhealthy}`;
  }
  return t("workspace.browser.services.startAndOpen");
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
  serviceChip: {
    maxWidth: { xs: 88, md: 140 },
    marginRight: theme.spacing[2],
    paddingHorizontal: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
  serviceChipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
