import React, { memo, type ReactNode } from "react";
import type { StreamLayoutItem } from "./layout";
import type { StreamItem } from "@/types/stream";

// History rows sit inside FlatList cells that rerender on every data change (RN recreates each
// CellRenderer with a fresh ref and, in a newest-first list, a shifted index). This boundary is
// what stops that churn: a row renders again only when its stream item identity, its layout item
// identity, or the renderer itself changes. Item identity is the revision signal the strategy
// already uses (`useRevisedHistoryRows` clones items whose content or display state changed).
//
// The live head renders through this same component so a row keeps its element type when its turn
// ends and it graduates into history. React answers a type change by unmounting the subtree, which
// throws away anything owning a document of its own — the mermaid runtime's iframe, and the
// diagram already committed inside it.
//
// A live row opts out of the memo rather than being compared: `renderLiveHeadRow` is a
// `useStableEvent` that reads the newest layout from a ref, so its props are identical on every
// flush and a shallow compare would freeze the streaming row.
const StreamRow = memo(
  function StreamRow({
    layoutItem,
    renderStreamItem,
  }: {
    item: StreamItem;
    layoutItem: StreamLayoutItem;
    live: boolean;
    renderStreamItem: (layoutItem: StreamLayoutItem) => ReactNode;
  }) {
    return <>{renderStreamItem(layoutItem)}</>;
  },
  (previous, next) =>
    !next.live &&
    previous.live === next.live &&
    previous.item === next.item &&
    previous.layoutItem === next.layoutItem &&
    previous.renderStreamItem === next.renderStreamItem,
);

/**
 * Renders one stream row. Both segments call this, so a row cannot end up with a different element
 * type on either side of the live-head/history handoff.
 */
export function renderStreamRow(input: {
  item: StreamItem;
  layoutItemById: Map<string, StreamLayoutItem>;
  renderStreamItem: (layoutItem: StreamLayoutItem) => ReactNode;
  live: boolean;
}): ReactNode {
  const layoutItem = input.layoutItemById.get(input.item.id);
  if (!layoutItem) {
    return null;
  }
  return (
    <StreamRow
      item={input.item}
      layoutItem={layoutItem}
      live={input.live}
      renderStreamItem={input.renderStreamItem}
    />
  );
}
