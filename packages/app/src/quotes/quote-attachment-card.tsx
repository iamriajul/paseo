import { memo, useCallback } from "react";
import { QuoteCard } from "@/quotes/quote-card";
import { useChatQuoteActions } from "@/quotes/chat-quote-context";
import type { ComposerQuote } from "@/attachments/types";

export const QuoteAttachmentCard = memo(function QuoteAttachmentCard({
  quote,
  index,
  onRemove,
}: {
  quote: ComposerQuote;
  index: number;
  onRemove: (index: number) => void;
}) {
  const actions = useChatQuoteActions();
  const handleRemove = useCallback(() => onRemove(index), [index, onRemove]);
  return (
    <QuoteCard
      quote={quote}
      onRemove={handleRemove}
      onPressSource={actions?.scrollToMessage}
      testID="composer-quote-card"
    />
  );
});
