import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Keyboard,
  MoreHorizontal,
  MousePointer2,
  RotateCw,
  Server,
  X,
} from "lucide-react-native";
import invariant from "tiny-invariant";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { useIconButtonChromeStyle } from "@/components/ui/icon-button-chrome";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { isNative } from "@/constants/platform";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel, type PanelDescriptor, type PanelIconProps } from "@/panels/panel-registry";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { normalizeBrowserUrl } from "@/desktop/browser/store/state";
import { truncateBrowserText } from "@/desktop/browser/browser-element-attachment";
import { WebAnnotationComposer } from "@/desktop/browser/pane/web-annotation-composer";
import { BrowserServiceChip, BrowserServicesMenu } from "@/desktop/browser/pane/services-menu";
import { BrowserLoadFailure } from "@/desktop/browser/pane/load-failure";
import type { BrowserDeviceSizeId } from "@/desktop/browser/device-presets";
import { BrowserDeviceIcon, BrowserDeviceSizeMenuItems } from "@/desktop/browser/device-size-menu";
import { useHostFeature } from "@/runtime/host-features";
import { useToast } from "@/contexts/toast-api-context";
import { useServerBrowserStatus, useServerBrowserTab, type ServerBrowserTab } from "./store";
import { ServerBrowserSurface, type ServerBrowserSurfaceHandle } from "./surface";
import {
  useServerBrowserAnnotate,
  type ServerBrowserPickMode,
} from "./use-server-browser-annotate";
import { deviceKindForViewport, SERVER_BROWSER_DEFAULT_VIEWPORT } from "./device-size";
import { useServerBrowserDeviceSize } from "./use-server-browser-device-size";
import { ServerBrowserLogsPanel, useServerBrowserLogs } from "./logs-panel";
import { ServerBrowserDialogCard } from "./dialog-card";
import { ServerBrowserFileChooserCard } from "./file-chooser-card";

const ThemedArrowLeft = withUnistyles(ArrowLeft);
const ThemedArrowRight = withUnistyles(ArrowRight);
const ThemedRotateCw = withUnistyles(RotateCw);
const ThemedStop = withUnistyles(X);
const ThemedMore = withUnistyles(MoreHorizontal);
const ThemedKeyboard = withUnistyles(Keyboard);
const ThemedMousePointer2 = withUnistyles(MousePointer2);
const ThemedCamera = withUnistyles(Camera);
const ThemedUrlInput = withUnistyles(EditingTextInput, (theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));
const muted = (theme: { colors: { foregroundMuted: string } }) => ({
  color: theme.colors.foregroundMuted,
});
const accent = (theme: { colors: { accent: string } }) => ({
  color: theme.colors.accent,
});

function tabLabel(tab: ServerBrowserTab | null): string {
  if (!tab) return "Server browser";
  if (tab.title.trim()) return tab.title.trim();
  try {
    return new URL(tab.url).host || tab.url;
  } catch {
    return tab.url;
  }
}

function ServerBrowserTabIcon({ size, color }: PanelIconProps) {
  return <Server size={size} color={color} />;
}

function useServerBrowserDescriptor(
  target: { kind: "server_browser"; browserId: string },
  context: { serverId: string },
): PanelDescriptor {
  const tab = useServerBrowserTab(context.serverId, target.browserId);
  const label = tabLabel(tab);
  return {
    label,
    subtitle: tab?.url ?? "",
    tooltip: tab ? `${tab.url} (server browser)` : label,
    titleState: "ready",
    icon: ServerBrowserTabIcon,
    statusBucket: tab?.isLoading ? "running" : null,
  };
}

function ServerBrowserTabGone({
  status,
}: {
  status: ReturnType<typeof useServerBrowserStatus>;
}): ReactElement {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>
        {status?.enabled === false
          ? "The server browser is turned off on this host"
          : "This server browser tab is closed"}
      </Text>
      {status?.unavailableReason ? (
        <Text style={styles.emptyDetail}>{status.unavailableReason}</Text>
      ) : null}
    </View>
  );
}

function NavigationButtons(props: {
  tab: ServerBrowserTab;
  canStop: boolean;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onStop: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const { tab } = props;
  return (
    <View style={styles.group}>
      <ToolbarButton label="Back" disabled={!tab.canGoBack} onPress={props.onBack}>
        <ThemedArrowLeft size={16} uniProps={muted} />
      </ToolbarButton>
      <ToolbarButton label="Forward" disabled={!tab.canGoForward} onPress={props.onForward}>
        <ThemedArrowRight size={16} uniProps={muted} />
      </ToolbarButton>
      {/* While a page loads, Reload stops it, as in the other Browsers. */}
      {tab.isLoading && props.canStop ? (
        <ToolbarButton
          label={t("workspace.browser.controls.stopLoading")}
          onPress={props.onStop}
          testID="server-browser-stop"
        >
          <ThemedStop size={16} uniProps={muted} />
        </ToolbarButton>
      ) : (
        <ToolbarButton
          label={t("workspace.browser.controls.refresh")}
          onPress={props.onReload}
          testID="server-browser-reload"
        >
          <ThemedRotateCw size={16} uniProps={muted} />
        </ToolbarButton>
      )}
    </View>
  );
}

/** The other Browsers' card for a failed load; Chromium's own error page is blank in the headless shell. */
function LoadFailureOverlay(props: {
  tab: ServerBrowserTab;
  onRetry: () => void;
}): ReactElement | null {
  const { t } = useTranslation();
  const { loadError, isLoading } = props.tab;
  if (!loadError || isLoading) return null;
  return (
    <BrowserLoadFailure
      title={t("workspace.browser.errors.loadFailedTitle")}
      message={`${loadError.errorText ?? t("workspace.browser.errors.failedToLoad")}: ${loadError.url}`}
      retryInSeconds={null}
      onRetry={props.onRetry}
    />
  );
}

/** Annotate element and Screenshot element, the other Browsers' two pickers. */
function PickButtons(props: {
  pickMode: ServerBrowserPickMode | null;
  canScreenshot: boolean;
  onAnnotate: () => void;
  onScreenshot: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const { pickMode } = props;
  return (
    <>
      <ToolbarButton
        label={
          pickMode === "annotate"
            ? t("workspace.browser.controls.cancelSelector")
            : t("workspace.browser.controls.annotateElement")
        }
        selected={pickMode === "annotate"}
        onPress={props.onAnnotate}
        testID="server-browser-annotate"
      >
        <ThemedMousePointer2 size={16} uniProps={pickMode === "annotate" ? accent : muted} />
      </ToolbarButton>
      {props.canScreenshot ? (
        <ToolbarButton
          label={
            pickMode === "screenshot"
              ? t("workspace.browser.controls.cancelSelector")
              : t("workspace.browser.controls.screenshotElement")
          }
          selected={pickMode === "screenshot"}
          onPress={props.onScreenshot}
          testID="server-browser-screenshot"
        >
          <ThemedCamera size={16} uniProps={pickMode === "screenshot" ? accent : muted} />
        </ToolbarButton>
      ) : null}
    </>
  );
}

function ActionsMenu(props: {
  canClearData: boolean;
  canShowConsole: boolean;
  consoleShown: boolean;
  onClearData: () => void;
  onToggleConsole: () => void;
  onCloseTab: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <ToolbarButton kind="menu" label="Server browser actions">
        <ThemedMore size={16} uniProps={muted} />
      </ToolbarButton>
      <DropdownMenuContent align="end">
        {/* A shared-profile engine has no per-workspace data to clear. */}
        {props.canClearData ? (
          <DropdownMenuItem onSelect={props.onClearData}>Clear browser data</DropdownMenuItem>
        ) : null}
        {props.canShowConsole ? (
          <DropdownMenuItem onSelect={props.onToggleConsole} testID="server-browser-console-toggle">
            {props.consoleShown
              ? t("workspace.browser.console.hide")
              : t("workspace.browser.console.show")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={props.onCloseTab}>Close tab</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** What the page asks the user over the page: a dialog to answer, files to pick. */
function PageRequests(props: {
  client: DaemonClient;
  browserId: string;
  tab: ServerBrowserTab;
  run: (action: () => Promise<void> | undefined) => void;
}): ReactElement | null {
  const { client, browserId, tab, run } = props;
  if (tab.dialog) {
    return (
      <ServerBrowserDialogCard
        key={tab.dialog.id}
        client={client}
        browserId={browserId}
        dialog={tab.dialog}
        run={run}
      />
    );
  }
  if (tab.fileChooser) {
    return (
      <ServerBrowserFileChooserCard
        key={tab.fileChooser.id}
        client={client}
        browserId={browserId}
        chooser={tab.fileChooser}
        run={run}
      />
    );
  }
  return null;
}

function ServerBrowserPanel(): ReactElement {
  const { serverId, workspaceId, target } = usePaneContext();
  invariant(
    target.kind === "server_browser",
    "ServerBrowserPanel requires a server_browser target",
  );
  const client = useHostRuntimeClient(serverId);
  const tab = useServerBrowserTab(serverId, target.browserId);
  const status = useServerBrowserStatus(serverId);
  const urlInputRef = useRef<EditingTextInputHandle | null>(null);
  const surfaceRef = useRef<ServerBrowserSurfaceHandle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const browserId = target.browserId;
  const { t } = useTranslation();
  const supportsAnnotate = useHostFeature(serverId, "serverBrowserAnnotate");
  const supportsVideo = useHostFeature(serverId, "serverBrowserVideo");
  const supportsViewerControls = useHostFeature(serverId, "serverBrowserViewerControls");
  const toast = useToast();
  const handleCopied = useCallback(
    (copied: "image" | "text") =>
      toast.show(
        copied === "image"
          ? t("workspace.browser.controls.screenshotCopied")
          : t("workspace.browser.controls.elementCopied"),
        { variant: "success" },
      ),
    [t, toast],
  );
  const annotate = useServerBrowserAnnotate({
    client,
    serverId,
    workspaceId,
    browserId,
    onError: setError,
    onCopied: handleCopied,
  });
  const pickMode = annotate.state.status === "picking" ? annotate.state.mode : null;
  const isPicking = pickMode !== null;
  const composing = annotate.state.status === "composing" ? annotate.state : null;
  // Which element was picked, the line the web pane shows above its composer.
  const selectionLabel = useMemo(() => {
    if (!composing) return null;
    const text = truncateBrowserText(composing.selection.text.trim().replace(/\s+/g, " "), 60);
    return text ? `${composing.selection.tag} · ${text}` : composing.selection.tag;
  }, [composing]);

  const run = useCallback((action: () => Promise<void> | undefined) => {
    setError(null);
    void action()?.catch((caught: unknown) =>
      setError(caught instanceof Error ? caught.message : String(caught)),
    );
  }, []);

  const handleSubmitUrl = useCallback(() => {
    const raw = urlInputRef.current?.getText() ?? "";
    const url = normalizeBrowserUrl(raw);
    run(() => client?.serverBrowserNavigate(browserId, "url", url));
  }, [browserId, client, run]);
  // The server browser runs on the host, so a service's localhost route is the host's own port.
  const handleNavigateService = useCallback(
    (url: string) => run(() => client?.serverBrowserNavigate(browserId, "url", url)),
    [browserId, client, run],
  );
  const menuTriggerStyle = useIconButtonChromeStyle({ size: "small" });
  const handleBack = useCallback(
    () => run(() => client?.serverBrowserNavigate(browserId, "back")),
    [browserId, client, run],
  );
  const handleForward = useCallback(
    () => run(() => client?.serverBrowserNavigate(browserId, "forward")),
    [browserId, client, run],
  );
  const handleReload = useCallback(
    () => run(() => client?.serverBrowserNavigate(browserId, "reload")),
    [browserId, client, run],
  );
  const handleStop = useCallback(
    () => run(() => client?.serverBrowserNavigate(browserId, "stop")),
    [browserId, client, run],
  );
  const deviceSize = useServerBrowserDeviceSize({
    client,
    browserId,
    viewport: tab?.viewport ?? SERVER_BROWSER_DEFAULT_VIEWPORT,
    run,
  });
  const selectDevice = deviceSize.select;
  const handleSelectPreset = useCallback(
    (id: BrowserDeviceSizeId) => selectDevice(id),
    [selectDevice],
  );
  const handleSelectDefault = useCallback(() => selectDevice("default"), [selectDevice]);
  const handleClearData = useCallback(
    () => run(() => client?.serverBrowserClearWorkspaceData(workspaceId)),
    [client, run, workspaceId],
  );
  const handleCloseTab = useCallback(
    () => run(() => client?.serverBrowserCloseTab(browserId)),
    [browserId, client, run],
  );
  const handleKeyboard = useCallback(() => surfaceRef.current?.focusKeyboard(), []);
  const toggleAnnotate = annotate.toggle;
  const handleAnnotate = useCallback(() => toggleAnnotate("annotate"), [toggleAnnotate]);
  const handleScreenshot = useCallback(() => toggleAnnotate("screenshot"), [toggleAnnotate]);
  const [showConsole, setShowConsole] = useState(false);
  const logs = useServerBrowserLogs({ client, browserId, open: showConsole });
  const handleToggleConsole = useCallback(() => setShowConsole((shown) => !shown), []);
  const failedUrl = tab?.loadError?.url;
  const handleRetry = useCallback(() => {
    if (failedUrl) run(() => client?.serverBrowserNavigate(browserId, "url", failedUrl));
  }, [browserId, client, failedUrl, run]);

  if (!tab || !client) return <ServerBrowserTabGone status={status} />;

  const deviceChoice = deviceSize.choice;

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <NavigationButtons
          tab={tab}
          canStop={supportsViewerControls}
          onBack={handleBack}
          onForward={handleForward}
          onReload={handleReload}
          onStop={handleStop}
        />
        <View style={styles.urlBarWrap}>
          <BrowserServiceChip serverId={serverId} workspaceId={workspaceId} url={tab.url} />
          <ThemedUrlInput
            key={tab.url}
            ref={urlInputRef}
            accessibilityLabel="Server browser URL"
            autoCapitalize="none"
            autoCorrect={false}
            initialValue={tab.url}
            onSubmitEditing={handleSubmitUrl}
            placeholder="Enter a URL"
            style={styles.urlInput}
          />
        </View>
        <View style={styles.group}>
          <BrowserServicesMenu
            serverId={serverId}
            workspaceId={workspaceId}
            currentUrl={tab.url}
            onNavigate={handleNavigateService}
            triggerStyle={menuTriggerStyle}
          />
          {isNative ? (
            <ToolbarButton label="Keyboard" onPress={handleKeyboard}>
              <ThemedKeyboard size={16} uniProps={muted} />
            </ToolbarButton>
          ) : null}
          {supportsAnnotate ? (
            <PickButtons
              pickMode={pickMode}
              canScreenshot={supportsViewerControls}
              onAnnotate={handleAnnotate}
              onScreenshot={handleScreenshot}
            />
          ) : null}
          <DropdownMenu>
            <ToolbarButton
              kind="menu"
              label={t("workspace.browser.devices.label")}
              testID="server-browser-device-size"
            >
              <BrowserDeviceIcon kind={deviceKindForViewport(tab.viewport, deviceChoice)} />
            </ToolbarButton>
            <DropdownMenuContent align="end" scrollable maxHeight={360}>
              <DropdownMenuItem
                onSelect={handleSelectDefault}
                selected={deviceChoice === "default"}
                showSelectedCheck
                testID="browser-device-default"
              >
                {`${t("workspace.browser.devices.agentDefault")} · ${SERVER_BROWSER_DEFAULT_VIEWPORT.width}×${SERVER_BROWSER_DEFAULT_VIEWPORT.height}`}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <BrowserDeviceSizeMenuItems
                selectedId={deviceChoice === "default" ? null : deviceChoice}
                onSelect={handleSelectPreset}
              />
            </DropdownMenuContent>
          </DropdownMenu>
          <ActionsMenu
            canClearData={!status?.engine?.sharedStorage}
            canShowConsole={supportsViewerControls}
            consoleShown={showConsole}
            onClearData={handleClearData}
            onToggleConsole={handleToggleConsole}
            onCloseTab={handleCloseTab}
          />
        </View>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {selectionLabel ? (
        <View style={styles.selectedElement}>
          <Text numberOfLines={1} style={styles.selectedElementText}>
            {selectionLabel}
          </Text>
        </View>
      ) : null}
      <View style={styles.surfaceWrap}>
        <ServerBrowserSurface
          ref={surfaceRef}
          client={client}
          browserId={browserId}
          pageWidth={tab.viewport.width}
          pageHeight={tab.viewport.height}
          annotating={isPicking}
          onCancelAnnotate={annotate.cancel}
          onSize={deviceSize.onSurfaceSize}
          video={supportsVideo}
        />
        <LoadFailureOverlay tab={tab} onRetry={handleRetry} />
        <PageRequests client={client} browserId={browserId} tab={tab} run={run} />
      </View>
      {showConsole ? <ServerBrowserLogsPanel entries={logs.entries} onClear={logs.clear} /> : null}
      {composing ? (
        <WebAnnotationComposer onSubmit={annotate.submit} onCancel={annotate.dismiss} />
      ) : null}
    </View>
  );
}

export const serverBrowserPanelRegistration = definePanel("server_browser", {
  component: ServerBrowserPanel,
  useDescriptor: useServerBrowserDescriptor,
});

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  surfaceWrap: {
    flex: 1,
    minHeight: 0,
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  group: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  urlBarWrap: {
    flex: 1,
    minWidth: 0,
    height: 28,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  urlInput: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    paddingVertical: 0,
    paddingHorizontal: 0,
  },
  selectedElement: {
    width: "100%",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    backgroundColor: theme.colors.muted,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  selectedElementText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[4],
  },
  emptyTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: "600",
  },
  emptyDetail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));
