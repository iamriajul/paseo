import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { useWorkspaceAttachmentsStore } from "@/attachments/workspace-attachments-store";
import { isWeb } from "@/constants/platform";
import {
  buildBrowserAttachmentScopeKey,
  buildBrowserElementAttachment,
  truncateBrowserText,
  type BrowserElementAnnotation,
} from "@/desktop/browser/browser-element-attachment";
import {
  RESPONSIVE_BROWSER_VIEWPORT,
  useBrowserStore,
  type BrowserViewport,
} from "@/desktop/browser/store";
import { useBrowserPreviewTemplate } from "@/desktop/browser/workspace-browser-preview";
import { useStableEvent } from "@/hooks/use-stable-event";
import { WebAnnotationComposer } from "./web-annotation-composer";
import {
  createPreviewBridge,
  type BridgeEvent,
  type BridgeSelection,
  type PreviewBridge,
} from "./web-bridge";
import {
  applyWebNavigation,
  createWebNavigationState,
  webNavigationReducer,
  type WebNavigationAction,
  type WebNavigationState,
} from "./web-navigation";
import { WebBrowserNotice } from "./web-notice";
import {
  getUnsupportedIframeProtocol,
  resolveWebBrowserSrc,
  toDisplayUrl,
} from "./web-preview-url";
import { decideSubmit } from "./web-submit";
import { WebBrowserToolbar } from "./web-toolbar";

export interface WebBrowserPaneProps {
  browserId: string;
  serverId: string;
  workspaceId: string;
  cwd: string | null;
  isInteractive?: boolean;
  isWorkspaceFocused?: boolean;
  onFocusPane?: () => void;
  onOpenUrlInBrowserTab?: (url: string) => void;
  chrome?: "visible" | "hidden";
}

const RESPONSIVE_FRAME_STYLE: CSSProperties = {
  flex: 1,
  border: "none",
  width: "100%",
  height: "100%",
};

export function WebBrowserPane({
  browserId,
  serverId,
  workspaceId,
  cwd,
  chrome,
}: WebBrowserPaneProps) {
  const { t } = useTranslation();
  const browser = useBrowserStore((state) => state.browsersById[browserId] ?? null);
  const updateBrowser = useBrowserStore((state) => state.updateBrowser);
  const setBrowserViewport = useBrowserStore((state) => state.setBrowserViewport);
  const addWorkspaceAttachment = useWorkspaceAttachmentsStore(
    (state) => state.addWorkspaceAttachment,
  );
  const template = useBrowserPreviewTemplate(serverId);
  const url = browser?.url ?? "https://example.com";
  const viewport = browser?.viewport ?? RESPONSIVE_BROWSER_VIEWPORT;

  const [state, dispatch] = useReducer(webNavigationReducer, url, createWebNavigationState);
  const [reloadKey, setReloadKey] = useState(0);
  const [isSelecting, setIsSelecting] = useState(false);
  const [isErudaOpen, setIsErudaOpen] = useState(false);
  const [pendingSelection, setPendingSelection] = useState<BridgeSelection | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const bridgeRef = useRef<PreviewBridge | null>(null);

  // Where the frame is *pointed*, which is not where it currently *is*: with a
  // live bridge the page routes itself and `state.displayUrl` follows, while the
  // src must stay put or every client-side route change would reload the page
  // out from under the user. `stack[index]` is the reducer's own record of the
  // pointed-at URL — it moves on navigate/back/forward/reset and on nothing else —
  // so reading it here keeps one owner for the parent-side history.
  const target = state.stack[state.index] ?? url;
  const resolved = useMemo(
    () => resolveWebBrowserSrc({ url: target, template }),
    [target, template],
  );
  const previewSrc = resolved.kind === "preview" ? resolved.src : null;

  // The record's `url` is written from two places — this pane, and anything
  // external (tab restore, an `open-url` arriving from chat). Only the external
  // one may reset navigation state, so the pane records every URL it writes and
  // the effect below skips those. Without this, `updateBrowser` on an address-bar
  // submit would fire the reset effect, `reset` would rebuild from the factory,
  // and the parent stack would be pinned at `[url]` index 0 forever — silently
  // deleting the direct-URL back/forward the reducer maintains.
  const syncedUrlRef = useRef(url);
  useEffect(() => {
    if (url === syncedUrlRef.current) {
      return;
    }
    syncedUrlRef.current = url;
    dispatch({ type: "reset", url });
  }, [url]);

  const handleBridgeEvent = useStableEvent((event: BridgeEvent) => {
    dispatch({ type: "bridge", event });
    switch (event.type) {
      case "ready":
        // A fresh document: eruda is re-injected hidden and any selector overlay
        // went with the old one.
        setIsErudaOpen(false);
        setIsSelecting(false);
        return;
      case "navigation": {
        const displayed = toDisplayUrl({ url: event.url, template, originalUrl: target });
        syncedUrlRef.current = displayed;
        updateBrowser(browserId, {
          url: displayed,
          title: event.title,
          canGoBack: event.canGoBack,
          canGoForward: event.canGoForward,
        });
        return;
      }
      case "selection":
        // The overlay tears itself down before posting, so selecting is over.
        setIsSelecting(false);
        setPendingSelection(event.selection);
        return;
      case "select-cancelled":
        setIsSelecting(false);
        return;
      case "eruda-failed":
        setIsErudaOpen(false);
        return;
      case "eruda-ready":
        return;
    }
  });

  useEffect(() => {
    // Both belong to the document being replaced.
    setIsSelecting(false);
    setIsErudaOpen(false);
    if (!previewSrc) {
      return;
    }
    const bridge = createPreviewBridge({
      origin: new URL(previewSrc).origin,
      getFrame: () => iframeRef.current?.contentWindow ?? null,
      onEvent: handleBridgeEvent,
    });
    bridgeRef.current = bridge;
    return () => {
      bridge.dispose();
      if (bridgeRef.current === bridge) {
        bridgeRef.current = null;
      }
    };
  }, [handleBridgeEvent, previewSrc]);

  const handleReload = useCallback(() => {
    if (state.bridgeReady) {
      bridgeRef.current?.send({ command: "reload" });
      return;
    }
    setReloadKey((key) => key + 1);
  }, [state.bridgeReady]);

  // Every parent-side navigation goes through here. The record has to be written
  // at dispatch time, and on this path nothing ever corrects it: it only runs
  // when there is no bridge, while the tab's label, subtitle and tooltip come
  // from the record (`panel.tsx:45,49,50`) and it is what gets persisted
  // (`store/state.ts:192-203`). `applyWebNavigation` runs the reducer to get the
  // fields rather than recomputing the destination here, so the record and the
  // toolbar cannot drift apart, and a null answer is the reducer refusing the
  // move rather than a second copy of its bounds guards.
  const applyNavigation = useCallback(
    (action: WebNavigationAction) => {
      const applied = applyWebNavigation(state, action);
      if (!applied) {
        return;
      }
      dispatch(action);
      syncedUrlRef.current = applied.record.url;
      updateBrowser(browserId, applied.record);
    },
    [browserId, state, updateBrowser],
  );

  const handleSubmitUrl = useCallback(
    (raw: string) => {
      const decision = decideSubmit({
        raw,
        template,
        currentSrc: resolved.kind === "no-template" ? null : resolved.src,
      });
      if (decision.kind === "reload") {
        setReloadKey((key) => key + 1);
        return;
      }
      // Never `goto`: a cross-origin goto navigates the frame off the preview
      // origin and ends the bridge session, leaving the controls silently inert.
      // The src is the only thing that re-points the frame.
      applyNavigation({ type: "user-navigate", url: decision.url });
    },
    [applyNavigation, resolved, template],
  );

  // The reducer has no bridge-side back/forward action, so `bridgeReady` is the
  // discriminator rather than a preference. Dispatching `user-back` over a live
  // bridge would walk the parent stack instead of the page's real history — and
  // with no prior URL-bar moves that stack is one entry at index 0, so it hits
  // the bounds guard and returns unchanged. It would also keep `bridgeReady` and
  // `title`, which the reducer's "no bridge implies no title" invariant relies on
  // never happening over a live session.
  const handleBack = useCallback(() => {
    if (state.bridgeReady) {
      bridgeRef.current?.send({ command: "back" });
      return;
    }
    applyNavigation({ type: "user-back" });
  }, [applyNavigation, state.bridgeReady]);

  const handleForward = useCallback(() => {
    if (state.bridgeReady) {
      bridgeRef.current?.send({ command: "forward" });
      return;
    }
    applyNavigation({ type: "user-forward" });
  }, [applyNavigation, state.bridgeReady]);

  const handleToggleEruda = useCallback(() => {
    // The frame reports `eruda-ready`/`eruda-failed` but never which way the
    // panel went, so the open state is the parent's own optimistic mirror,
    // corrected by `eruda-failed` and reset by each new document.
    bridgeRef.current?.send({ command: "toggle-eruda" });
    setIsErudaOpen((open) => !open);
  }, []);

  const handleToggleSelect = useCallback(() => {
    bridgeRef.current?.send({ command: isSelecting ? "cancel-select" : "start-select" });
    setIsSelecting(!isSelecting);
  }, [isSelecting]);

  const handleChangeViewport = useCallback(
    (next: BrowserViewport) => setBrowserViewport(browserId, next),
    [browserId, setBrowserViewport],
  );

  const scopeKey = useMemo(
    () => buildBrowserAttachmentScopeKey({ cwd, serverId, workspaceId }),
    [cwd, serverId, workspaceId],
  );

  const handleAnnotationSubmit = useCallback(
    (annotation: BrowserElementAnnotation) => {
      const selection = pendingSelection;
      setPendingSelection(null);
      if (!selection || !scopeKey) {
        return;
      }
      addWorkspaceAttachment({
        scopeKey,
        attachment: {
          kind: "browser_element",
          // No screenshot argument: Electron's element capture is a main-process
          // bridge with no iframe equivalent, so web attaches text only.
          attachment: buildBrowserElementAttachment(selection, annotation),
        },
      });
    },
    [addWorkspaceAttachment, pendingSelection, scopeKey],
  );

  const handleAnnotationCancel = useCallback(() => setPendingSelection(null), []);

  // The bridge reports the preview origin; the address bar must keep showing the
  // loopback URL the user asked for. The toolbar reads `state.displayUrl`, so the
  // translation happens on the state handed to it rather than on a second prop.
  const toolbarState = useMemo<WebNavigationState>(
    () => ({
      ...state,
      displayUrl: toDisplayUrl({ url: state.displayUrl, template, originalUrl: target }),
    }),
    [state, target, template],
  );

  // The Code Server panel embeds this pane as a bare surface, so that it feels
  // like an embedded editor rather than a browser tab. Everything Paseo puts
  // around the frame is chrome: the toolbar — whose devtools and element picker
  // would otherwise sit over the VS Code UI — and the notice.
  const showChrome = chrome !== "hidden";
  const isResponsive = viewport.mode === "responsive";
  const frameWrapStyle = useMemo(
    () => [styles.frameWrap, isResponsive ? null : styles.frameWrapDeviceFrame],
    [isResponsive],
  );
  const frameStyle = useMemo<CSSProperties>(
    () =>
      viewport.mode === "fixed"
        ? {
            border: "none",
            width: viewport.width,
            height: viewport.height,
            boxShadow: "0 2px 16px rgba(0,0,0,0.25)",
          }
        : RESPONSIVE_FRAME_STYLE,
    [viewport],
  );

  // Which element the picker returned. The composer takes no `selection` prop, so
  // the identity line the Electron and Android panes render inside their cards is
  // rendered here instead, in the column where it cannot collide with the
  // composer's own absolute layout.
  const pendingSelectionLabel = useMemo(() => {
    if (!pendingSelection) {
      return null;
    }
    const text = truncateBrowserText(pendingSelection.text.trim().replace(/\s+/g, " "), 60);
    return text ? `${pendingSelection.tag} · ${text}` : pendingSelection.tag;
  }, [pendingSelection]);

  // No reachable preview origin for this host — nothing to navigate to, so no
  // toolbar either.
  if (resolved.kind === "no-template") {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>{t("workspace.browser.previewNotConfigured.title")}</Text>
        <Text style={styles.subtitle}>{t("workspace.browser.previewNotConfigured.subtitle")}</Text>
      </View>
    );
  }

  const unsupportedProtocol =
    resolved.kind === "direct" ? getUnsupportedIframeProtocol(resolved.src) : null;

  let content: ReactNode;
  if (unsupportedProtocol) {
    content = (
      <View style={styles.container}>
        <Text style={styles.title}>
          {t("workspace.browser.errors.unsupportedProtocol", { protocol: unsupportedProtocol })}
        </Text>
      </View>
    );
  } else if (!isWeb) {
    content = null;
  } else {
    content = (
      // Previews the user's own dev server (or an arbitrary site) like a real browser tab;
      // the daemon already strips X-Frame-Options/CSP so it runs unrestricted, and a sandbox
      // would break the scripts, forms, and popups a real page needs. Cross-origin isolation
      // already separates it from the Paseo origin.
      //
      // `src` is in the key on purpose. Assigning a new `src` to a mounted iframe
      // navigates it, and an iframe navigation lands on the *top-level* joint
      // session history — the app's own back button would start walking preview
      // pages. Keying on it makes every re-point a remount, so the rule holds
      // structurally instead of depending on each call site remembering it.
      // oxlint-disable-next-line react/iframe-missing-sandbox
      <iframe
        key={`${reloadKey}:${resolved.src}`}
        ref={iframeRef}
        src={resolved.src}
        style={frameStyle}
        title={t("workspace.tabs.fallback.browser")}
      />
    );
  }

  return (
    <View style={styles.pane}>
      {showChrome ? (
        <WebBrowserToolbar
          state={toolbarState}
          bridgeAvailable={state.bridgeReady}
          isSelecting={isSelecting}
          isErudaOpen={isErudaOpen}
          viewport={viewport}
          onSubmitUrl={handleSubmitUrl}
          onBack={handleBack}
          onForward={handleForward}
          onReload={handleReload}
          onToggleEruda={handleToggleEruda}
          onToggleSelect={handleToggleSelect}
          onChangeViewport={handleChangeViewport}
        />
      ) : null}
      {showChrome && resolved.kind === "direct" ? <WebBrowserNotice /> : null}
      {pendingSelectionLabel ? (
        <View style={styles.selectedElement}>
          <Text numberOfLines={1} style={styles.selectedElementText}>
            {pendingSelectionLabel}
          </Text>
        </View>
      ) : null}
      <View style={frameWrapStyle}>{content}</View>
      {pendingSelection ? (
        <WebAnnotationComposer
          onSubmit={handleAnnotationSubmit}
          onCancel={handleAnnotationCancel}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  pane: {
    flex: 1,
  },
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: 16,
  },
  frameWrap: {
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
  },
  // A fixed device size centres the framed page over a muted backdrop instead of
  // left-aligning it, matching the Electron pane.
  frameWrapDeviceFrame: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[3],
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
  title: {
    fontSize: theme.fontSize.base,
    fontWeight: "600",
    color: theme.colors.foreground,
  },
  subtitle: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
