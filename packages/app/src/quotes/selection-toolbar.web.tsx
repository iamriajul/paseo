import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { View, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { readQuoteSelection, type QuoteSelection } from "@/assistant-selection-copy/content.web";
import { Button } from "@/components/ui/button";
import { useChatQuoteActions } from "@/quotes/chat-quote-context";

const TOOLBAR_GAP_PX = 8;
const TOOLBAR_EDGE_PX = 8;

/**
 * A toolbar above a text selection in the chat: Quote puts the selected text in the composer,
 * Ask aside opens a side question with it quoted. It waits for the pointer to come up, so it does
 * not follow a drag, and it keeps the selection when pressed.
 */
export function QuoteSelectionToolbar() {
  const actions = useChatQuoteActions();
  const [selection, setSelection] = useState<QuoteSelection | null>(null);
  const pointerDownRef = useRef(false);

  useEffect(() => {
    if (!actions) return undefined;
    const refresh = () => {
      if (pointerDownRef.current) return;
      setSelection(readQuoteSelection(window.getSelection()));
    };
    const handlePointerDown = (event: PointerEvent) => {
      if ((event.target as Element | null)?.closest("[data-quote-toolbar]")) return;
      pointerDownRef.current = true;
      setSelection(null);
    };
    const handlePointerUp = () => {
      pointerDownRef.current = false;
      // The browser settles the selection after the event.
      window.setTimeout(refresh, 0);
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("pointerup", handlePointerUp, true);
    document.addEventListener("selectionchange", refresh);
    document.addEventListener("keyup", refresh);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("pointerup", handlePointerUp, true);
      document.removeEventListener("selectionchange", refresh);
      document.removeEventListener("keyup", refresh);
    };
  }, [actions]);

  const finish = useCallback(() => {
    window.getSelection()?.removeAllRanges();
    setSelection(null);
  }, []);
  const addQuote = actions?.addQuote;
  const askAside = actions?.askAside;
  const quoteInMainChat = actions?.quoteInMainChat;
  const handleQuote = useCallback(() => {
    if (!selection) return;
    addQuote?.({
      origin: selection.origin,
      text: selection.text,
      partial: true,
      messageId: selection.messageId,
    });
    finish();
  }, [addQuote, finish, selection]);
  const handleAskAside = useCallback(() => {
    if (!selection) return;
    askAside?.({
      origin: selection.origin,
      text: selection.text,
      partial: true,
      messageId: selection.messageId,
    });
    finish();
  }, [askAside, finish, selection]);

  const handleQuoteInMainChat = useCallback(() => {
    if (!selection) return;
    quoteInMainChat?.({
      origin: "side_question",
      text: selection.text,
      partial: true,
      messageId: selection.messageId,
    });
    finish();
  }, [finish, quoteInMainChat, selection]);

  if (!actions || !selection) return null;
  return createPortal(
    <ToolbarBody
      selection={selection}
      onQuote={handleQuote}
      onAskAside={askAside ? handleAskAside : undefined}
      onQuoteInMainChat={quoteInMainChat ? handleQuoteInMainChat : undefined}
    />,
    document.body,
  );
}

function keepSelection(event: MouseEvent) {
  event.preventDefault();
}

const KEEP_SELECTION_WRAPPER: CSSProperties = { display: "contents" };

function ToolbarBody({
  selection,
  onQuote,
  onAskAside,
  onQuoteInMainChat,
}: {
  selection: QuoteSelection;
  onQuote: () => void;
  onAskAside?: () => void;
  onQuoteInMainChat?: () => void;
}) {
  const { t } = useTranslation();
  const { rect } = selection;
  const left = Math.min(
    Math.max(rect.left + rect.width / 2, TOOLBAR_EDGE_PX + 80),
    window.innerWidth - TOOLBAR_EDGE_PX - 80,
  );
  // Above the selection; below it when there is no room.
  const above = rect.top > 48;
  const top = above ? rect.top - TOOLBAR_GAP_PX : rect.bottom + TOOLBAR_GAP_PX;
  const style = useMemo(
    () => [
      styles.toolbar,
      {
        position: "fixed",
        left,
        top,
        transform: above ? "translate(-50%, -100%)" : "translate(-50%, 0)",
      } as unknown as ViewStyle,
    ],
    [above, left, top],
  );
  return (
    <div onMouseDown={keepSelection} style={KEEP_SELECTION_WRAPPER}>
      <View style={style} testID="quote-selection-toolbar" dataSet={TOOLBAR_DATASET}>
        <Button variant="ghost" size="sm" onPress={onQuote} testID="quote-selection-quote">
          {t("quotes.quote")}
        </Button>
        {onQuoteInMainChat ? (
          <Button
            variant="ghost"
            size="sm"
            onPress={onQuoteInMainChat}
            testID="quote-selection-quote-main"
          >
            {t("quotes.quoteInMainChat")}
          </Button>
        ) : null}
        {onAskAside ? (
          <Button variant="ghost" size="sm" onPress={onAskAside} testID="quote-selection-ask-aside">
            {t("quotes.askAside")}
          </Button>
        ) : null}
      </View>
    </div>
  );
}

const TOOLBAR_DATASET = { quoteToolbar: "true" };

const styles = StyleSheet.create((theme) => ({
  toolbar: {
    zIndex: 1000,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    boxShadow: "0 4px 16px rgba(0, 0, 0, 0.35)",
  },
}));
