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
import { BackHandler, Keyboard, Text, View, type LayoutChangeEvent } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { PaneFind } from "@/pane-find";
import { Button } from "@/components/ui/button";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useStreamTopOverlayInset } from "../top-overlay";
import { ChatFindModel } from "./model";
import { splitPlainMatch } from "./marks";
import { createNativeFindViewport, type SelectedMark } from "./native-viewport";
import { onChatFindRequest } from "./open-request";
import { CHAT_FIND_FAILURE_TEXT, chatFindStatusText, createChatFindHostOperations } from "./shared";
import type { ChatFindExpansionProps, ChatFindPlainTextProps, ChatFindProps } from "./types";

const SelectedMessage = createContext<string | null>(null);
const Mark = createContext<SelectedMark | null>(null);
/** Space between the floating header and the find bar, and under the bar. */
const BAR_GAP = 8;

export function useChatFindSelectedMessageId(): string | null {
  return useContext(SelectedMessage);
}

function useChatFindMark(messageId: string | undefined): SelectedMark | null {
  const mark = useContext(Mark);
  return mark !== null && mark.messageId === messageId ? mark : null;
}

export function ChatFindExpansion({ messageId, children }: ChatFindExpansionProps) {
  const selected = useChatFindSelectedMessageId() === messageId;
  return children(selected, useChatFindMark(messageId));
}

/** A prompt's text, with the occurrence chat find landed on highlighted. */
export function ChatFindPlainText({ messageId, text, source }: ChatFindPlainTextProps) {
  const mark = useChatFindMark(messageId);
  const parts = useMemo(
    () => (mark ? splitPlainMatch(text, mark, source) : null),
    [mark, text, source],
  );
  if (!parts) return text;
  return (
    <>
      {parts.before}
      <Text style={styles.highlight}>{parts.match}</Text>
      {parts.after}
    </>
  );
}

/**
 * Chat find on iOS and Android. It runs the same model as web against the same host
 * search; what differs is the viewport half (`native-viewport.ts`) and that the header
 * menu opens it, since a phone has no find shortcut.
 */
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
  const active = useRetainedPanelActive();
  const topInset = useStreamTopOverlayInset();
  const [mark, setMark] = useState<SelectedMark | null>(null);
  const barHeight = useRef(0);
  const bindings = useRef({ viewportRef, revealLoadedMessage, visibleMessageIds, items });
  bindings.current = { viewportRef, revealLoadedMessage, visibleMessageIds, items };
  const clearance = useRef(0);
  clearance.current = topInset + BAR_GAP + barHeight.current + BAR_GAP;
  const model = useMemo(
    () =>
      new ChatFindModel({
        ...createChatFindHostOperations(serverId, agentId),
        ...createNativeFindViewport({
          getBindings: () => bindings.current,
          getTopClearance: () => clearance.current,
          setMark,
        }),
      }),
    [agentId, serverId],
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
    if (!active) return;
    return onChatFindRequest(serverId, agentId, model.open);
  }, [active, agentId, model, serverId]);
  const close = useCallback(() => {
    Keyboard.dismiss();
    model.close();
  }, [model]);
  useEffect(() => {
    if (!state.open) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      close();
      return true;
    });
    return () => subscription.remove();
  }, [close, state.open]);
  const measureBar = useCallback((event: LayoutChangeEvent) => {
    barHeight.current = event.nativeEvent.layout.height;
  }, []);
  const overlayStyle = useMemo(() => [styles.overlay, { top: topInset + BAR_GAP }], [topInset]);
  return (
    <View style={styles.root}>
      <SelectedMessage.Provider value={state.selectedItemId}>
        <Mark.Provider value={mark}>{children}</Mark.Provider>
      </SelectedMessage.Provider>
      {state.open && (
        <View style={overlayStyle} pointerEvents="box-none">
          <View style={styles.bar} onLayout={measureBar} testID="chat-find-bar">
            <PaneFind
              query={state.query}
              status={chatFindStatusText(state, t)}
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
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, minHeight: 0 },
  // Inset on both sides so the bar never leaves a narrow phone; touches beside it pass through.
  overlay: {
    position: "absolute",
    left: theme.spacing[3],
    right: theme.spacing[3],
    zIndex: 10,
    alignItems: "flex-end",
  },
  bar: { maxWidth: "100%" },
  error: {
    flexDirection: "row",
    alignItems: "center",
    padding: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
  },
  errorText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, flex: 1 },
  highlight: { backgroundColor: theme.colors.statusWarning, color: theme.colors.surface0 },
}));
