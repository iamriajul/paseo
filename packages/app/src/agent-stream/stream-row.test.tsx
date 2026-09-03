/**
 * @vitest-environment jsdom
 */
import React, { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamItem } from "@/types/stream";
import type { StreamLayoutItem } from "./layout";
import { renderStreamRow } from "./stream-row";

function streamItem(id: string): StreamItem {
  return {
    kind: "assistant_message",
    id,
    text: "```mermaid\nflowchart LR\n  Start --> Middle\n```",
    timestamp: new Date("2026-04-20T00:00:00.000Z"),
  };
}

function layoutItem(
  item: StreamItem,
  phase: StreamLayoutItem["phase"] = "streaming",
): StreamLayoutItem {
  return {
    item,
    aboveItem: null,
    belowItem: null,
    gapBelow: 0,
    assistantSpacing: "default",
    completedFooter: null,
    toolSequence: "none",
    isFirstInUserGroup: false,
    isLastInUserGroup: false,
    isLastInToolSequence: false,
    frameOrder: "content-then-footer",
    phase,
  };
}

describe("renderStreamRow", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      value: true,
      configurable: true,
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  /**
   * Renders whatever the row's content function returns, and reports its own mount and unmount.
   * A remount here is what destroys a fence that owns a document — the mermaid runtime's iframe
   * loses its page, and with it the diagram already rendered into it.
   */
  function makeContent(mounted: () => void, unmounted: () => void) {
    return function RowContent({ text }: { text: string }) {
      useEffect(() => {
        mounted();
        return unmounted;
      }, []);
      return <div data-testid="row-content">{text}</div>;
    };
  }

  it("keeps the row mounted when a turn ends and the item graduates into history", () => {
    const mounted = vi.fn();
    const unmounted = vi.fn();
    const RowContent = makeContent(mounted, unmounted);
    const item = streamItem("assistant-1");
    const renderStreamItem = (layout: StreamLayoutItem): ReactNode => (
      <RowContent text={layout.phase} />
    );

    act(() => {
      root?.render(
        renderStreamRow({
          item,
          layoutItemById: new Map([[item.id, layoutItem(item, "streaming")]]),
          renderStreamItem,
          live: true,
        }),
      );
    });
    expect(mounted).toHaveBeenCalledTimes(1);

    act(() => {
      root?.render(
        renderStreamRow({
          item,
          layoutItemById: new Map([[item.id, layoutItem(item, "complete")]]),
          renderStreamItem,
          live: false,
        }),
      );
    });

    expect(mounted).toHaveBeenCalledTimes(1);
    expect(unmounted).not.toHaveBeenCalled();
    expect(container?.querySelector('[data-testid="row-content"]')?.textContent).toBe("complete");
  });

  it("repaints a live row whose props are unchanged", () => {
    // `renderLiveHeadRow` is a `useStableEvent` reading the newest layout from a ref, so a
    // streaming flush arrives with identical props. Comparing them would freeze the row.
    const item = streamItem("assistant-1");
    const layoutItemById = new Map([[item.id, layoutItem(item)]]);
    const renderStreamItem = vi.fn((): ReactNode => <div />);
    const props = { item, layoutItemById, renderStreamItem, live: true };

    act(() => root?.render(renderStreamRow(props)));
    act(() => root?.render(renderStreamRow(props)));

    expect(renderStreamItem).toHaveBeenCalledTimes(2);
  });

  it("holds a history row still while its item and layout are unchanged", () => {
    const item = streamItem("assistant-1");
    const layoutItemById = new Map([[item.id, layoutItem(item, "complete")]]);
    const renderStreamItem = vi.fn((): ReactNode => <div />);
    const props = { item, layoutItemById, renderStreamItem, live: false };

    act(() => root?.render(renderStreamRow(props)));
    act(() => root?.render(renderStreamRow(props)));

    expect(renderStreamItem).toHaveBeenCalledTimes(1);
  });

  it("repaints a history row when its layout item changes", () => {
    const item = streamItem("assistant-1");
    const renderStreamItem = vi.fn((): ReactNode => <div />);

    act(() =>
      root?.render(
        renderStreamRow({
          item,
          layoutItemById: new Map([[item.id, layoutItem(item, "complete")]]),
          renderStreamItem,
          live: false,
        }),
      ),
    );
    act(() =>
      root?.render(
        renderStreamRow({
          item,
          layoutItemById: new Map([[item.id, layoutItem(item, "complete")]]),
          renderStreamItem,
          live: false,
        }),
      ),
    );

    expect(renderStreamItem).toHaveBeenCalledTimes(2);
  });

  it("renders nothing for an item with no layout", () => {
    const item = streamItem("assistant-1");
    const renderStreamItem = vi.fn((): ReactNode => <div />);

    act(() =>
      root?.render(
        renderStreamRow({ item, layoutItemById: new Map(), renderStreamItem, live: true }),
      ),
    );

    expect(renderStreamItem).not.toHaveBeenCalled();
    expect(container?.innerHTML).toBe("");
  });
});
