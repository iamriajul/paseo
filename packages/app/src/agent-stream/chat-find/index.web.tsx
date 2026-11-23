import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { View, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { PaneFind, findShortcutPlatform, isFindShortcut, type PaneFindHandle } from "@/pane-find";
import { Button } from "@/components/ui/button";
import { usePaneFocus } from "@/panels/pane-context";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { hasActiveWebOverlay } from "@/lib/overlay-root";
import { isImeComposingKeyboardEvent } from "@/utils/keyboard-ime";
import { ChatFindModel } from "./model";
import { onChatFindRequest } from "./open-request";
import { CHAT_FIND_FAILURE_TEXT, chatFindStatusText, createChatFindHostOperations } from "./shared";
import { createFindViewport } from "./viewport.web";
import type { ChatFindProps, ChatFindExpansionProps, ChatFindPlainTextProps } from "./types";

const SelectedMessage = createContext<string | null>(null);
const WIDGET_DATASET = { chatFindWidget: "true" };
const ROOT_STYLE = {
  display: "flex",
  flex: 1,
  minHeight: 0,
  position: "relative",
  outline: "none",
} as const;
let nextHighlightId = 0;

/**
 * The message chat find has landed on, for surfaces that must keep it addressable:
 * the row that lifts its render cap, and the web virtualizer that has to mount every
 * block row of it so the whole message can be counted and highlighted.
 */
export function useChatFindSelectedMessageId(): string | null {
  return useContext(SelectedMessage);
}

export function ChatFindExpansion({ messageId, children }: ChatFindExpansionProps) {
  return children(useChatFindSelectedMessageId() === messageId, null);
}

/** Web highlights the rendered DOM, so a prompt's text renders as written. */
export function ChatFindPlainText({ text }: ChatFindPlainTextProps) {
  return text;
}

export function ChatFind({
  agentId,
  serverId,
  epoch,
  items,
  viewportRef,
  revealLoadedMessage,
  visibleMessageIds,
  children,
}: ChatFindProps) {
  const { t } = useTranslation();
  const widget = useRef<PaneFindHandle>(null);
  const root = useRef<HTMLDivElement>(null);
  const bindings = useRef({ viewportRef, revealLoadedMessage, visibleMessageIds });
  bindings.current = { viewportRef, revealLoadedMessage, visibleMessageIds };
  const [highlightName] = useState(() => `paseo-chat-find-${++nextHighlightId}`);
  const { isInteractive } = usePaneFocus();
  const active = useRetainedPanelActive();
  const model = useMemo(
    () =>
      new ChatFindModel({
        ...createChatFindHostOperations(serverId, agentId),
        ...createFindViewport({
          getBindings: () => bindings.current,
          getRoot: () => root.current,
          highlightName,
        }),
      }),
    [agentId, serverId, highlightName],
  );
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  useEffect(() => {
    model.updateHistory(epoch, items);
  }, [model, epoch, items]);
  useEffect(() => () => model.close(), [model]);
  useEffect(() => {
    if (!active) model.close();
  }, [active, model]);
  useEffect(() => {
    if (!active || !isInteractive) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || hasActiveWebOverlay() || isImeComposingKeyboardEvent(event))
        return;
      if (isFindShortcut(event, findShortcutPlatform())) {
        event.preventDefault();
        model.open();
        widget.current?.focus();
      }
    };
    // React Native TextInput stops bubbling key events, including from the composer.
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [active, isInteractive, model]);
  // Fork: the compact header menu opens find where there is no keyboard to press.
  useEffect(() => {
    if (!active) return;
    return onChatFindRequest(serverId, agentId, () => {
      model.open();
      widget.current?.focus();
    });
  }, [active, agentId, model, serverId]);
  const close = useCallback(() => {
    model.close();
    viewportRef.current?.focus?.();
  }, [model, viewportRef]);
  const status = chatFindStatusText(state, t);
  return (
    <div ref={root} tabIndex={-1} style={ROOT_STYLE}>
      <style>{`::highlight(${highlightName}) { background-color: ${styles.highlight.backgroundColor}; color: ${styles.highlight.color}; }`}</style>
      <SelectedMessage.Provider value={state.selectedItemId}>{children}</SelectedMessage.Provider>
      {state.open && (
        <View style={styles.overlay} dataSet={WIDGET_DATASET}>
          <PaneFind
            ref={widget}
            query={state.query}
            status={status}
            canNavigate={state.phase === "ready" && state.count > 0}
            onQueryChange={model.setQuery}
            onNext={model.next}
            onPrevious={model.previous}
            onClose={close}
          />
          {state.failure && (
            <View style={styles.error}>
              <Text style={styles.errorText}>{t(CHAT_FIND_FAILURE_TEXT[state.failure])}</Text>
              <Button size="sm" variant="ghost" onPress={model.retry}>
                {t("paneFind.retry")}
              </Button>
            </View>
          )}
        </View>
      )}
    </div>
  );
}
const styles = StyleSheet.create((theme) => ({
  overlay: {
    position: "absolute",
    top: theme.spacing[2],
    right: theme.spacing[3],
    zIndex: 10,
    maxWidth: "100%",
  },
  error: {
    flexDirection: "row",
    alignItems: "center",
    padding: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
  },
  errorText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, flex: 1 },
  highlight: { backgroundColor: theme.colors.statusWarning, color: theme.colors.surface0 },
}));
