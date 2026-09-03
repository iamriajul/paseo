import type { TextStyle, ViewStyle } from "react-native";
import type { ViewportFitOptions, ViewportSize } from "@/components/zoomable-viewport/geometry";

// Height of the hidden box the runtime is laid out in until the diagram has been measured.
export const MEASURING_BOX_HEIGHT = 240;

// Stands in for the column width for the frame or two before the first layout arrives.
// `fitContentSize` scales the content layer down to the viewport, so any placeholder wider than
// the column makes the width ratio bind and the layer still lands on the viewport width. The
// measuring pass is therefore laid out at the column width in both states, never at a placeholder.
const MEASURING_FALLBACK_WIDTH = 10_000;

function edgeLength(value: TextStyle["padding"]): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function boxInset(style: TextStyle): number {
  return edgeLength(style.padding) + edgeLength(style.borderWidth);
}

export function getDiagramBoxStyle(style: TextStyle): ViewStyle {
  return {
    backgroundColor: style.backgroundColor,
    borderColor: style.borderColor,
    borderRadius: style.borderRadius,
    borderWidth: style.borderWidth,
    marginBottom: style.marginBottom,
    marginTop: style.marginTop,
    marginVertical: style.marginVertical,
    padding: style.padding,
  };
}

/**
 * Content size for the measuring pass. `ZoomableViewport` lays its content layer out at
 * `fitContentSize(contentSize, viewport)` and the runtime fills that layer, so this placeholder
 * decides how wide mermaid thinks the column is. Mermaid fits a `useMaxWidth` SVG to the box it
 * renders in, so measuring at anything narrower reports a height the diagram will never have.
 * Matching the measuring box makes the fit an identity and the runtime lands on the column width.
 */
export function getMeasuringContentSize(columnWidth: number | null): ViewportSize {
  return {
    width: columnWidth !== null && columnWidth > 0 ? columnWidth : MEASURING_FALLBACK_WIDTH,
    height: MEASURING_BOX_HEIGHT,
  };
}

/**
 * Content size for a measured diagram. The width is the fence's content box, not the width the
 * runtime last reported: mermaid renders with `useMaxWidth`, so the SVG has no width of its own —
 * it is always as wide as the box it is given, up to its natural width. Handing the last
 * measurement back as the content size closes a loop, and the diagram latches at whatever width
 * it happened to have when it first became visible instead of growing with the source. The old
 * in-flow runtime was always the fence's content box wide, which is the only width that is stable.
 */
export function getRenderedContentSize(
  style: TextStyle,
  columnWidth: number | null,
  measured: ViewportSize,
): ViewportSize {
  const width = columnWidth === null ? measured.width : columnWidth - 2 * boxInset(style);
  return { width: Math.max(1, width), height: measured.height };
}

/**
 * Height of the fence box around a diagram whose content is `contentHeight` tall. Boxes are
 * border-box, so the padding and border `getDiagramBoxStyle` paints have to be added back or they
 * eat into the diagram. The old in-flow runtime got this for free by sizing the box from content.
 */
export function getDiagramBoxHeight(style: TextStyle, contentHeight: number): number {
  return contentHeight + 2 * boxInset(style);
}

/**
 * Layout style for the fence box. `ZoomableViewport`'s root style leads with `flex: 1`, which
 * react-native-web expands to `flex-basis: 0%`, and flex-basis governs the main axis — so a bare
 * `height` never applies. The box drops to padding + border in an auto-height parent and stretches
 * to fill a definite-height one. Opting out of flex sizing is what makes the measured height real.
 */
export function getDiagramBoxLayoutStyle(style: TextStyle, contentHeight: number): ViewStyle {
  return {
    height: getDiagramBoxHeight(style, contentHeight),
    flexBasis: "auto",
    flexGrow: 0,
    flexShrink: 0,
  };
}

/**
 * Keeps the diagram inside the fence's padding, where the old in-flow runtime sat.
 * `ZoomableViewport`'s canvas is `inset: 0`, which resolves against the padding box and so ignores
 * padding; without this the diagram spreads under it and a small one is stretched to fill the box.
 */
export function getDiagramFit(style: TextStyle): ViewportFitOptions {
  return { padding: edgeLength(style.padding) };
}
