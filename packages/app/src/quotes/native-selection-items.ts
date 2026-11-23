import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useChatQuoteActions } from "@/quotes/chat-quote-context";
import { isNative } from "@/constants/platform";

interface NativeMenuItem {
  text: string;
  onPress: (event: { text: string }) => void;
}

/**
 * Quote and Ask aside, after Copy, in the native selection menu of an assistant message's text.
 * Code blocks and tables are separate native views without this menu; the footer button quotes them.
 */
export function useNativeQuoteMenuItems(
  messageId: string | undefined,
): NativeMenuItem[] | undefined {
  const { t } = useTranslation();
  const actions = useChatQuoteActions();
  const addQuote = actions?.addQuote;
  const askAside = actions?.askAside;
  return useMemo(() => {
    if (!isNative || !messageId || !addQuote) return undefined;
    const items: NativeMenuItem[] = [
      {
        text: t("quotes.quote"),
        onPress: ({ text }) => addQuote({ origin: "assistant", text, partial: true, messageId }),
      },
    ];
    if (askAside) {
      items.push({
        text: t("quotes.askAside"),
        onPress: ({ text }) => askAside({ origin: "assistant", text, partial: true, messageId }),
      });
    }
    return items;
  }, [addQuote, askAside, messageId, t]);
}
