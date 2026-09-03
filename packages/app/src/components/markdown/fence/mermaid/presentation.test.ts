import { describe, expect, it } from "vitest";
import { StyleSheet, type TextStyle } from "react-native";
import { fitContentSize } from "@/components/zoomable-viewport/geometry";
import {
  MEASURING_BOX_HEIGHT,
  getDiagramBoxHeight,
  getDiagramBoxLayoutStyle,
  getDiagramFit,
  getMeasuringContentSize,
  getRenderedContentSize,
} from "./presentation";

// The markdown `fence` style the host is rendered with (styles/markdown-styles.ts).
const FENCE: TextStyle = { padding: 12, borderWidth: 1 };
const COLUMN_WIDTH = 700;
// The 17-node `flowchart LR` from the mermaid e2e spec, measured at a 700px column.
const MEASURED = { width: 700, height: 48 };

/**
 * Width the runtime iframe is laid out at, and so the width mermaid fits the diagram to.
 * `ZoomableViewport` sizes its content layer to `fitContentSize(contentSize, viewport, fit)` and
 * the iframe is `100%` of that layer, so the host's content size decides the measurement. The
 * viewport is the canvas, which is `inset: 0` and therefore the box's padding box.
 */
function laidOutRuntimeSize(
  contentSize: { width: number; height: number },
  box: { width: number; height: number },
  fit?: { padding?: number },
) {
  return fitContentSize(contentSize, box, fit);
}

describe("mermaid fence sizing", () => {
  describe("the measuring pass", () => {
    // Regression: the host passed a fixed 240x240 placeholder, the height ratio bound, and the
    // runtime was laid out 240px wide whatever the column was. Mermaid fits a `useMaxWidth` SVG
    // to the box it renders in, so every diagram reported a height it would never have.
    it.each([320, 700, 1200])("lays the runtime out at a %ipx column", (columnWidth) => {
      const overlay = { width: columnWidth, height: MEASURING_BOX_HEIGHT };

      expect(laidOutRuntimeSize(getMeasuringContentSize(columnWidth), overlay)).toEqual(overlay);
    });

    it("still lays the runtime out at the column width before the first layout", () => {
      const overlay = { width: COLUMN_WIDTH, height: MEASURING_BOX_HEIGHT };

      // Sub-pixel: the placeholder is scaled down rather than matched exactly.
      expect(laidOutRuntimeSize(getMeasuringContentSize(null), overlay).width).toBeCloseTo(
        COLUMN_WIDTH,
      );
    });
  });

  describe("the rendered pass", () => {
    const boxHeight = getDiagramBoxHeight(FENCE, MEASURED.height);
    // The canvas is `inset: 0` on the fence box, so it spans the box minus its border.
    const canvas = { width: COLUMN_WIDTH - 2, height: boxHeight - 2 };
    const contentBox = { width: COLUMN_WIDTH - 26, height: MEASURED.height };

    it("lays the runtime out in the fence's content box", () => {
      const contentSize = getRenderedContentSize(FENCE, COLUMN_WIDTH, MEASURED);

      expect(laidOutRuntimeSize(contentSize, canvas, getDiagramFit(FENCE))).toEqual(contentBox);
    });

    // Regression: the content size was the last measurement, so the layer was as wide as the
    // diagram happened to be. A streaming diagram measured at that width, reported it back, and
    // latched there instead of growing with the source.
    it("does not narrow when the diagram was last measured narrow", () => {
      const narrow = { width: 430, height: 30 };
      const narrowBox = { height: getDiagramBoxHeight(FENCE, narrow.height) - 2, width: 698 };

      const contentSize = getRenderedContentSize(FENCE, COLUMN_WIDTH, narrow);

      expect(laidOutRuntimeSize(contentSize, narrowBox, getDiagramFit(FENCE)).width).toBe(
        contentBox.width,
      );
    });

    it("keeps a diagram narrower than the column at its measured scale", () => {
      // A 3-node flowchart: its SVG caps itself at 329px, so a wider box does not stretch it.
      const small = { width: 329, height: 70 };
      const smallBox = { width: COLUMN_WIDTH - 2, height: getDiagramBoxHeight(FENCE, 70) - 2 };

      const laidOut = laidOutRuntimeSize(
        getRenderedContentSize(FENCE, COLUMN_WIDTH, small),
        smallBox,
        getDiagramFit(FENCE),
      );

      expect(laidOut).toEqual({ width: contentBox.width, height: small.height });
    });
  });

  describe("the fence box height", () => {
    it("adds the padding and border the box paints", () => {
      expect(getDiagramBoxHeight(FENCE, 48)).toBe(74);
      expect(getDiagramBoxHeight({ padding: 8 }, 48)).toBe(64);
      expect(getDiagramBoxHeight({}, 48)).toBe(48);
    });

    it("ignores lengths it cannot add", () => {
      expect(getDiagramBoxHeight({ padding: "10%" }, 48)).toBe(48);
    });

    // Regression: `{ height }` alone never applied. `ZoomableViewport` prepends `flex: 1`, which
    // react-native-web expands to `flex-basis: 0%`; flex-basis governs the main axis, so the box
    // fell to its border-box floor in an auto-height parent and stretched in a definite one.
    it("survives the `flex: 1` ZoomableViewport prepends", () => {
      const flattened = StyleSheet.flatten([{ flex: 1 }, getDiagramBoxLayoutStyle(FENCE, 48)]);

      expect(flattened).toMatchObject({
        height: 74,
        flexBasis: "auto",
        flexGrow: 0,
        flexShrink: 0,
      });
    });
  });
});
