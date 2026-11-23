import { describe, expect, it, vi } from "vitest";
import type { StreamItem } from "@/types/stream";
import type { MessageScrollPoint } from "../native-scroll-point";
import type { StreamViewportHandle } from "../strategy";
import { createNativeFindViewport, type SelectedMark } from "./native-viewport";
import { onChatFindRequest, requestChatFind } from "./open-request";

function message(kind: "user_message" | "assistant_message", id: string, text: string) {
  return { kind, id, text, timestamp: new Date(0) } as StreamItem;
}

function harness(items: StreamItem[], mounted: string[]) {
  const visible = new Set(mounted);
  const marks: (SelectedMark | null)[] = [];
  const scrolls: { messageId: string; point: MessageScrollPoint }[] = [];
  const revealLoadedMessage = vi.fn((messageId: string) => {
    visible.add(messageId);
    return true;
  });
  const handle: StreamViewportHandle = {
    scrollToBottom: () => {},
    scrollToItem: () => {},
    prepareForViewportChange: () => {},
    holdReadingPosition: () => {},
    scrollToMessagePoint: (messageId, point) => {
      scrolls.push({ messageId, point });
    },
  };
  const viewport = createNativeFindViewport({
    getBindings: () => ({
      items,
      revealLoadedMessage,
      visibleMessageIds: visible,
      viewportRef: { current: handle },
    }),
    getTopClearance: () => 100,
    setMark: (mark) => marks.push(mark),
  });
  return { viewport, marks, scrolls, revealLoadedMessage };
}

const text = `needle at the start, ${"filler ".repeat(40)}and a needle at the end`;

describe("native chat find viewport", () => {
  it("marks the occurrence and scrolls to where it sits in the message", async () => {
    const { viewport, marks, scrolls } = harness([message("assistant_message", "a", text)], ["a"]);
    const signal = new AbortController().signal;
    await expect(viewport.reveal("a", "needle", 0, signal)).resolves.toEqual({
      occurrence: 0,
      count: 2,
    });
    expect(marks.at(-1)).toEqual({ messageId: "a", query: "needle", occurrence: 0 });
    expect(scrolls.at(-1)).toEqual({ messageId: "a", point: { fraction: 0, topClearance: 100 } });

    await expect(viewport.reveal("a", "needle", -1, signal)).resolves.toEqual({
      occurrence: 1,
      count: 2,
    });
    expect(marks.at(-1)?.occurrence).toBe(1);
    expect(scrolls.at(-1)?.point.fraction).toBeGreaterThan(0.8);
  });

  it("mounts a message outside the history window before landing on it", async () => {
    const { viewport, scrolls, revealLoadedMessage } = harness(
      [message("user_message", "old", "an old needle")],
      [],
    );
    await viewport.reveal("old", "needle", 0, new AbortController().signal);
    expect(revealLoadedMessage).toHaveBeenCalledWith("old");
    expect(scrolls.map((scroll) => scroll.messageId)).toEqual(["old"]);
  });

  it("reports no occurrences when the message does not hold the query, and marks nothing", async () => {
    const { viewport, marks, scrolls } = harness([message("user_message", "u", "nothing")], ["u"]);
    await expect(viewport.reveal("u", "needle", 0, new AbortController().signal)).resolves.toEqual({
      occurrence: 0,
      count: 0,
    });
    expect(marks).toEqual([]);
    expect(scrolls).toEqual([]);
  });

  it("stops when the search moves on, and clears the mark with the search", async () => {
    const { viewport, marks, scrolls } = harness([message("user_message", "u", "needle")], ["u"]);
    const abort = new AbortController();
    const reveal = viewport.reveal("u", "needle", 0, abort.signal);
    abort.abort();
    await expect(reveal).rejects.toThrow("Search cancelled");
    expect(scrolls).toEqual([]);
    viewport.clear();
    expect(marks).toEqual([null]);
  });
});

describe("chat find open request", () => {
  it("reaches only the chat for that agent, and nobody after it unsubscribes", () => {
    const opened = vi.fn();
    const other = vi.fn();
    const unsubscribe = onChatFindRequest("host", "agent", opened);
    onChatFindRequest("host", "other-agent", other);
    requestChatFind("host", "agent");
    expect(opened).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    unsubscribe();
    requestChatFind("host", "agent");
    expect(opened).toHaveBeenCalledTimes(1);
  });
});
