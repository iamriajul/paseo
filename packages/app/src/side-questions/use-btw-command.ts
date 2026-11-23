import { useCallback } from "react";
import type { ComposerAttachment } from "@/attachments/types";
import { collectComposerQuotes } from "@/quotes/composer-quotes";
import { serializeQuotedPrompt } from "@/quotes/quote-format";
import { useSideQuestionActions } from "@/side-questions/actions-context";
import { parseBtwCommand } from "@/side-questions/model";

/**
 * `/btw <question>` in the composer asks a side question instead of messaging the agent. Returns
 * whether it took the text; the caller then clears the composer. A host or provider without side
 * questions leaves `/btw` as the ordinary text it is.
 */
export function useBtwCommand(): (input: {
  text: string;
  attachments: readonly ComposerAttachment[];
}) => boolean {
  const actions = useSideQuestionActions();
  const open = actions?.open;
  return useCallback(
    ({ text, attachments }) => {
      const command = open ? parseBtwCommand(text) : null;
      if (!command || !open) return false;
      const question = serializeQuotedPrompt({
        quotes: collectComposerQuotes(attachments),
        text: command.question,
      });
      void open(command.question ? { question } : undefined);
      return true;
    },
    [open],
  );
}
