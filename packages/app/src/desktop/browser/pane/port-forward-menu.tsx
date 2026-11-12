import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, type StyleProp, type ViewStyle } from "react-native";
import { useTranslation } from "react-i18next";
import { MonitorUp } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuHint,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MenuTextField } from "@/components/ui/menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { getPortForwardController } from "@/port-forward/controller";
import type { PublicPageUrl } from "@/port-forward/public-page-url";
import type { PortForwardRoute, PortForwardStatus } from "@/port-forward/types";
import { openExternalUrl } from "@/utils/open-external-url";
import { isLoopbackHttpUrl } from "@/utils/localhost-url";

const ThemedMonitorUp = withUnistyles(MonitorUp);
const mutedIcon = (theme: { colors: { foregroundMuted: string } }) => ({
  color: theme.colors.foregroundMuted,
});
const accentIcon = (theme: { colors: { accent: string } }) => ({ color: theme.colors.accent });

export function mainPortOfUrl(url: string): number | null {
  try {
    const parsed = new URL(url);
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
}

/** The URL to open on this computer: the tab's URL with its port swapped for the local one. */
export function localUrlFor(input: { url: string; localPort: number }): string {
  const parsed = new URL(input.url);
  parsed.hostname = "localhost";
  parsed.port = String(input.localPort);
  return parsed.toString();
}

/** Ports to forward: the address bar's port first, then every loopback port the page used. */
export function portsToForward(input: {
  mainPort: number | null;
  observedPorts: readonly number[];
  customPorts: readonly number[];
}): number[] {
  const ordered = [
    ...(input.mainPort === null ? [] : [input.mainPort]),
    ...input.observedPorts,
    ...input.customPorts,
  ];
  return Array.from(new Set(ordered));
}

export function parsePortInput(value: string): number | null {
  const trimmed = value.trim().replace(/^:/, "");
  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return port >= 1 && port <= 65535 ? port : null;
}

type MenuState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "local-host" }
  | { status: "error"; message: string };

/**
 * "Open on this computer" (or this phone) for a Browser or server browser tab showing a
 * workspace localhost URL. Forwards the tab's port plus every loopback port its page has used
 * (and any the user adds) to this device, then opens the page in the system browser.
 */
export function BrowserPortForwardMenu(props: {
  browserId: string;
  url: string;
  triggerStyle: (state: { hovered?: boolean; pressed?: boolean }) => StyleProp<ViewStyle>;
  /** A tab this device does not render (a server browser tab): the host its ports live on. */
  route?: PortForwardRoute;
  /** The loopback ports the page used, when another machine renders it. */
  loadObservedPorts?: () => Promise<number[]>;
  /** A public URL the host serves for the page, offered as the no-forward alternative. */
  publicPage?: PublicPageUrl | null;
  /**
   * Called once forwards start, for a tab whose end this device must watch itself so they stop
   * with it (a server tab, an Android Browser tab). Electron main watches its own webviews.
   */
  onForwardsStarted?: () => void;
}): ReactElement | null {
  const { t } = useTranslation();
  const controller = useMemo(() => getPortForwardController(), []);
  const { browserId, loadObservedPorts, onForwardsStarted, route } = props;
  const [forwards, setForwards] = useState<PortForwardStatus[]>([]);
  const [observedPorts, setObservedPorts] = useState<number[]>([]);
  const [customPorts, setCustomPorts] = useState<number[]>([]);
  const [draftPort, setDraftPort] = useState("");
  const [draftKey, setDraftKey] = useState(0);
  const [state, setState] = useState<MenuState>({ status: "idle" });
  const mainPort = mainPortOfUrl(props.url);
  const ports = useMemo(
    () => portsToForward({ mainPort, observedPorts, customPorts }),
    [customPorts, mainPort, observedPorts],
  );
  const forwardByPort = useMemo(
    () => new Map(forwards.map((forward) => [forward.remotePort, forward])),
    [forwards],
  );
  const mainForward = mainPort === null ? null : forwardByPort.get(mainPort);
  const isForwarding = forwards.some((forward) => forward.state === "forwarding");

  const refresh = useCallback(async () => {
    if (!controller) return;
    const [list, remotePorts] = await Promise.all([
      controller.list(browserId),
      loadObservedPorts?.().catch(() => []) ?? Promise.resolve([]),
    ]);
    setForwards(list.forwards);
    setObservedPorts(Array.from(new Set([...list.observedPorts, ...remotePorts])));
  }, [browserId, controller, loadObservedPorts]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        setState({ status: "idle" });
        void refresh();
      }
    },
    [refresh],
  );

  const start = useCallback(
    async (fallbackToAnyPort: boolean) => {
      if (!controller) return;
      setState({ status: "loading" });
      const result = await controller
        .start({ browserId, ports, fallbackToAnyPort, ...(route ? { route } : {}) })
        .catch((error: unknown) => ({
          kind: "unavailable" as const,
          reason: error instanceof Error ? error.message : String(error),
        }));
      if (result.kind === "local-host") {
        setState({ status: "local-host" });
        void openExternalUrl(props.url);
        return;
      }
      if (result.kind === "unavailable") {
        setState({ status: "error", message: result.reason });
        return;
      }
      onForwardsStarted?.();
      await refresh();
      setForwards((current) => mergeForwards(current, result.forwards));
      setState({ status: "idle" });
      const main = result.forwards.find((forward) => forward.remotePort === mainPort);
      if (main?.state === "forwarding") {
        void openExternalUrl(localUrlFor({ url: props.url, localPort: main.localPort }));
      }
    },
    [browserId, controller, mainPort, onForwardsStarted, ports, props.url, refresh, route],
  );

  const handleForward = useCallback(() => void start(false), [start]);
  const handleFallback = useCallback(() => void start(true), [start]);

  const stop = useCallback(
    async (remotePort: number) => {
      await controller?.stop({ browserId, remotePort });
      await refresh();
    },
    [browserId, controller, refresh],
  );

  const addCustomPort = useCallback(() => {
    const port = parsePortInput(draftPort);
    if (port === null) return;
    setCustomPorts((current) => (current.includes(port) ? current : [...current, port]));
    setDraftPort("");
    setDraftKey((key) => key + 1);
  }, [draftPort]);

  if (!controller || !isLoopbackHttpUrl(props.url)) {
    return null;
  }
  const onPhone = controller.device === "phone";
  const label = onPhone
    ? t("workspace.browser.portForward.labelPhone")
    : t("workspace.browser.portForward.label");
  const hasCollision = forwards.some((forward) => forward.state === "port-in-use");
  return (
    <DropdownMenu onOpenChange={handleOpenChange}>
      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger
            accessibilityLabel={label}
            style={props.triggerStyle}
            testID="browser-port-forward-trigger"
          >
            <ThemedMonitorUp size={16} uniProps={isForwarding ? accentIcon : mutedIcon} />
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center" offset={8}>
          <Text style={styles.tooltipText}>{label}</Text>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" scrollable maxHeight={420} minWidth={280}>
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <DropdownMenuHint>
          {onPhone
            ? t("workspace.browser.portForward.hintPhone")
            : t("workspace.browser.portForward.hint")}
        </DropdownMenuHint>
        {ports.map((port) => (
          <PortRow
            key={port}
            port={port}
            isMain={port === mainPort}
            forward={forwardByPort.get(port) ?? null}
            onPhone={onPhone}
            onStop={stop}
          />
        ))}
        <MenuTextField
          key={draftKey}
          placeholder={t("workspace.browser.portForward.addPort")}
          onChangeText={setDraftPort}
          onSubmitEditing={addCustomPort}
          testID="browser-port-forward-add"
        />
        <DropdownMenuSeparator />
        {state.status === "local-host" ? (
          <DropdownMenuHint>{t("workspace.browser.portForward.localHost")}</DropdownMenuHint>
        ) : null}
        {state.status === "error" ? <DropdownMenuHint>{state.message}</DropdownMenuHint> : null}
        <DropdownMenuItem
          onSelect={handleForward}
          closeOnSelect={false}
          status={state.status === "loading" ? "pending" : undefined}
          testID="browser-port-forward-open"
        >
          {mainForward?.state === "forwarding"
            ? t("workspace.browser.portForward.openAgain")
            : t("workspace.browser.portForward.forwardAndOpen")}
        </DropdownMenuItem>
        {hasCollision ? (
          <DropdownMenuItem
            onSelect={handleFallback}
            closeOnSelect={false}
            description={t("workspace.browser.portForward.useOtherPortsHint")}
            testID="browser-port-forward-fallback"
          >
            {t("workspace.browser.portForward.useOtherPorts")}
          </DropdownMenuItem>
        ) : null}
        {props.publicPage?.kind === "preview" || props.publicPage?.kind === "service" ? (
          <PublicPageItem url={props.publicPage.url} />
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PublicPageItem(props: { url: string }): ReactElement {
  const { t } = useTranslation();
  const { url } = props;
  const handleSelect = useCallback(() => void openExternalUrl(url), [url]);
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onSelect={handleSelect}
        description={t("workspace.browser.openInBrowser.publicUrlHint")}
        testID="browser-port-forward-public-url"
      >
        {t("workspace.browser.openInBrowser.publicUrl")}
      </DropdownMenuItem>
    </>
  );
}

function mergeForwards(
  current: PortForwardStatus[],
  latest: PortForwardStatus[],
): PortForwardStatus[] {
  const byPort = new Map(current.map((forward) => [forward.remotePort, forward]));
  for (const forward of latest) {
    byPort.set(forward.remotePort, forward);
  }
  return Array.from(byPort.values()).sort((a, b) => a.remotePort - b.remotePort);
}

function PortRow(props: {
  port: number;
  isMain: boolean;
  forward: PortForwardStatus | null;
  onPhone: boolean;
  onStop: (port: number) => Promise<void>;
}): ReactElement {
  const { t } = useTranslation();
  const { forward, port, onStop } = props;
  let description: string;
  if (forward?.state === "forwarding") {
    description =
      forward.localPort === port
        ? t("workspace.browser.portForward.forwarded")
        : t("workspace.browser.portForward.forwardedTo", { port: forward.localPort });
  } else if (forward?.state === "port-in-use") {
    description = props.onPhone
      ? t("workspace.browser.portForward.portInUsePhone")
      : t("workspace.browser.portForward.portInUse");
  } else if (forward?.state === "failed") {
    description = forward.error;
  } else {
    description = props.isMain
      ? t("workspace.browser.portForward.pagePort")
      : t("workspace.browser.portForward.usedByPage");
  }
  const handleSelect = useCallback(() => {
    if (forward?.state === "forwarding") {
      void onStop(port);
    }
  }, [forward?.state, onStop, port]);
  return (
    <DropdownMenuItem
      description={description}
      selected={forward?.state === "forwarding"}
      showSelectedCheck
      closeOnSelect={false}
      onSelect={handleSelect}
      tooltip={
        forward?.state === "forwarding" ? t("workspace.browser.portForward.stopHint") : undefined
      }
      testID={`browser-port-forward-port-${port}`}
    >
      {`localhost:${port}`}
    </DropdownMenuItem>
  );
}

const styles = StyleSheet.create((theme) => ({
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.popoverForeground,
  },
}));
