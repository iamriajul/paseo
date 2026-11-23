import { getStreamItemMessageId, type StreamItem } from "@/types/stream";
import type { ChatFindOperations } from "./model";
import type { ChatFindProps } from "./types";
import { findSourceMatches, type ChatFindMark } from "./marks";

export interface SelectedMark extends ChatFindMark {
  messageId: string;
}

interface ViewportInput {
  getBindings(): Pick<
    ChatFindProps,
    "viewportRef" | "revealLoadedMessage" | "visibleMessageIds" | "items"
  >;
  /** Height covered at the top of the chat: the floating header and the find bar. */
  getTopClearance(): number;
  setMark(mark: SelectedMark | null): void;
}

const POLL_MS = 16;
const REVEAL_TIMEOUT_MS = 5000;

/** The text chat find can count in a row; null for a row that renders no message text. */
function searchableText(items: StreamItem[], messageId: string): string | null {
  const item = items.find((candidate) => getStreamItemMessageId(candidate) === messageId);
  if (item?.kind === "user_message" || item?.kind === "assistant_message") return item.text;
  return null;
}

/**
 * Native has no rendered text to walk, so an occurrence is a match in the message's
 * source: that is what gets counted, marked and, by its position in the text, scrolled to.
 */
export function createNativeFindViewport({
  getBindings,
  getTopClearance,
  setMark,
}: ViewportInput): Pick<ChatFindOperations, "reveal" | "clear"> {
  return {
    clear() {
      setMark(null);
    },
    reveal(messageId, query, occurrence, signal) {
      return new Promise((resolve, reject) => {
        const deadline = Date.now() + REVEAL_TIMEOUT_MS;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", cancelled);
        };
        const cancelled = () => {
          cleanup();
          reject(new Error("Search cancelled"));
        };
        const poll = () => {
          if (signal.aborted) {
            cancelled();
            return;
          }
          if (Date.now() >= deadline) {
            cleanup();
            reject(new Error("Could not reveal this match; retry"));
            return;
          }
          const current = getBindings();
          if (!current.visibleMessageIds.has(messageId)) {
            current.revealLoadedMessage(messageId);
            timer = setTimeout(poll, POLL_MS);
            return;
          }
          cleanup();
          const topClearance = getTopClearance();
          const text = searchableText(current.items, messageId);
          if (text === null) {
            // A plugin row draws its own content; land on the row and count it once.
            setMark(null);
            current.viewportRef.current?.scrollToMessagePoint?.(messageId, {
              fraction: 0,
              topClearance,
            });
            resolve({ occurrence: 0, count: 1 });
            return;
          }
          const matches = findSourceMatches(text, query);
          const index =
            occurrence < 0 ? matches.length - 1 : Math.min(occurrence, matches.length - 1);
          const match = matches[index];
          if (!match) {
            resolve({ occurrence: 0, count: 0 });
            return;
          }
          setMark({ messageId, query, occurrence: index });
          current.viewportRef.current?.scrollToMessagePoint?.(messageId, {
            fraction: text.length ? match.start / text.length : 0,
            topClearance,
          });
          resolve({ occurrence: index, count: matches.length });
        };
        signal.addEventListener("abort", cancelled, { once: true });
        timer = setTimeout(poll, 0);
      });
    },
  };
}
