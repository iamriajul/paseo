import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  ArrowLeft,
  ArrowRight,
  Keyboard,
  Monitor,
  MoreHorizontal,
  MousePointer2,
  RotateCw,
  Server,
  Smartphone,
} from "lucide-react-native";
import invariant from "tiny-invariant";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { isNative } from "@/constants/platform";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel, type PanelDescriptor, type PanelIconProps } from "@/panels/panel-registry";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { normalizeBrowserUrl } from "@/desktop/browser/store/state";
import { truncateBrowserText } from "@/desktop/browser/browser-element-attachment";
import { WebAnnotationComposer } from "@/desktop/browser/pane/web-annotation-composer";
import { useHostFeature } from "@/runtime/host-features";
import { useServerBrowserStatus, useServerBrowserTab, type ServerBrowserTab } from "./store";
import { ServerBrowserSurface, type ServerBrowserSurfaceHandle } from "./surface";
import { useServerBrowserAnnotate } from "./use-server-browser-annotate";

const ThemedArrowLeft = withUnistyles(ArrowLeft);
const ThemedArrowRight = withUnistyles(ArrowRight);
const ThemedRotateCw = withUnistyles(RotateCw);
const ThemedMonitor = withUnistyles(Monitor);
const ThemedSmartphone = withUnistyles(Smartphone);
const ThemedMore = withUnistyles(MoreHorizontal);
const ThemedKeyboard = withUnistyles(Keyboard);
const ThemedMousePointer2 = withUnistyles(MousePointer2);
const ThemedUrlInput = withUnistyles(EditingTextInput, (theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
}));
const muted = (theme: { colors: { foregroundMuted: string } }) => ({
  color: theme.colors.foregroundMuted,
});
const accent = (theme: { colors: { accent: string } }) => ({
  color: theme.colors.accent,
});

export const SERVER_BROWSER_VIEWPORTS = {
  desktop: { width: 1280, height: 800, mobile: false },
  phone: { width: 390, height: 844, mobile: true },
} as const;

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
  const annotate = useServerBrowserAnnotate({
    client,
    serverId,
    workspaceId,
    browserId,
    onError: setError,
  });
  const isPicking = annotate.state.status === "picking";
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
  const isPhone = tab?.viewport.mobile === true;
  const handleToggleViewport = useCallback(() => {
    const next = isPhone ? SERVER_BROWSER_VIEWPORTS.desktop : SERVER_BROWSER_VIEWPORTS.phone;
    run(() => client?.serverBrowserSetViewport(browserId, next));
  }, [browserId, client, isPhone, run]);
  const handleClearData = useCallback(
    () => run(() => client?.serverBrowserClearWorkspaceData(workspaceId)),
    [client, run, workspaceId],
  );
  const handleCloseTab = useCallback(
    () => run(() => client?.serverBrowserCloseTab(browserId)),
    [browserId, client, run],
  );
  const handleKeyboard = useCallback(() => surfaceRef.current?.focusKeyboard(), []);

  if (!tab || !client) return <ServerBrowserTabGone status={status} />;

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <View style={styles.group}>
          <ToolbarButton label="Back" disabled={!tab.canGoBack} onPress={handleBack}>
            <ThemedArrowLeft size={16} uniProps={muted} />
          </ToolbarButton>
          <ToolbarButton label="Forward" disabled={!tab.canGoForward} onPress={handleForward}>
            <ThemedArrowRight size={16} uniProps={muted} />
          </ToolbarButton>
          <ToolbarButton label="Reload" onPress={handleReload}>
            <ThemedRotateCw size={16} uniProps={muted} />
          </ToolbarButton>
        </View>
        <View style={styles.urlBarWrap}>
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
          {isNative ? (
            <ToolbarButton label="Keyboard" onPress={handleKeyboard}>
              <ThemedKeyboard size={16} uniProps={muted} />
            </ToolbarButton>
          ) : null}
          {supportsAnnotate ? (
            <ToolbarButton
              label={
                isPicking
                  ? t("workspace.browser.controls.cancelSelector")
                  : t("workspace.browser.controls.annotateElement")
              }
              selected={isPicking}
              onPress={annotate.toggle}
              testID="server-browser-annotate"
            >
              <ThemedMousePointer2 size={16} uniProps={isPicking ? accent : muted} />
            </ToolbarButton>
          ) : null}
          <ToolbarButton
            label={isPhone ? "Switch to desktop viewport" : "Switch to phone viewport"}
            onPress={handleToggleViewport}
          >
            {isPhone ? (
              <ThemedSmartphone size={16} uniProps={muted} />
            ) : (
              <ThemedMonitor size={16} uniProps={muted} />
            )}
          </ToolbarButton>
          <DropdownMenu>
            <ToolbarButton kind="menu" label="Server browser actions">
              <ThemedMore size={16} uniProps={muted} />
            </ToolbarButton>
            <DropdownMenuContent align="end">
              {/* A shared-profile engine has no per-workspace data to clear. */}
              {status?.engine?.sharedStorage ? null : (
                <DropdownMenuItem onSelect={handleClearData}>Clear browser data</DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={handleCloseTab}>Close tab</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
      <ServerBrowserSurface
        ref={surfaceRef}
        client={client}
        browserId={browserId}
        pageWidth={tab.viewport.width}
        pageHeight={tab.viewport.height}
        annotating={isPicking}
        onCancelAnnotate={annotate.cancel}
      />
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
