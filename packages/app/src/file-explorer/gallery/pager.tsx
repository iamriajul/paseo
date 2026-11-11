import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useBlockMobilePanelOpenGestures } from "@/mobile-panels/provider";
import type { GalleryPagerProps } from "./pager-types";
import { canSwipePage, dragOffset, settleSwipe } from "./paging";

export type { GallerySlide } from "./pager-types";

const PAGE_DURATION = 220;

/**
 * A horizontal strip of the folder's images that follows the finger. Slides are placed by their
 * folder index, so when a page lands and the tab retargets, nothing on the strip moves: the
 * strip's offset already shows the new image.
 */
export function GalleryPager({
  index,
  count,
  slides,
  zoomed,
  gesturesActive,
  onSelect,
}: GalleryPagerProps) {
  const isCompact = useIsCompactFormFactor();
  const [width, setWidth] = useState(0);
  const offset = useSharedValue(0);
  // The image the strip is at or heading to. A swipe sets it before React hears of the page.
  const settled = useSharedValue(index);
  const laidOutWidth = useRef(0);
  // A horizontal swipe here pages; it must not also open a mobile sidebar.
  useBlockMobilePanelOpenGestures(isCompact && gesturesActive && count > 1);

  useLayoutEffect(() => {
    if (width <= 0) return;
    const target = -index * width;
    if (laidOutWidth.current !== width) {
      // First layout or a resize: jump, there is nothing to animate from.
      laidOutWidth.current = width;
      offset.value = target;
    } else if (settled.value !== index) {
      // A button, key or retarget from elsewhere. A swipe already set `settled` and is animating.
      offset.value = withTiming(target, { duration: PAGE_DURATION });
    }
    settled.value = index;
  }, [index, offset, settled, width]);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    setWidth(event.nativeEvent.layout.width);
  }, []);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .enabled(canSwipePage({ zoomed, count, width }))
        .maxPointers(1)
        .activeOffsetX([-12, 12])
        .failOffsetY([-12, 12])
        .onUpdate((event) => {
          offset.value = dragOffset({
            index: settled.value,
            count,
            width,
            translationX: event.translationX,
          });
        })
        .onEnd((event) => {
          const current = settled.value;
          const next = settleSwipe({
            index: current,
            count,
            width,
            translationX: event.translationX,
            velocityX: event.velocityX,
          });
          settled.value = next;
          offset.value = withTiming(-next * width, { duration: PAGE_DURATION });
          // Retarget now, not when the slide ends: a touch during the slide cancels the
          // animation, and the tab must already show the image the strip is heading to.
          if (next !== current) runOnJS(onSelect)(next);
        }),
    [count, offset, onSelect, settled, width, zoomed],
  );

  const stripStyle = useAnimatedStyle(() => ({ transform: [{ translateX: offset.value }] }));

  return (
    <GestureDetector gesture={pan}>
      <View style={styles.root} onLayout={handleLayout} collapsable={false}>
        {width > 0 ? (
          <Animated.View style={[styles.strip, stripStyle]}>
            {slides.map((slide) => (
              <View
                key={slide.key}
                style={[styles.slide, { left: slide.index * width, width }]}
                testID={slide.index === index ? "image-gallery-slide-current" : undefined}
              >
                {slide.content}
              </View>
            ))}
          </Animated.View>
        ) : null}
      </View>
    </GestureDetector>
  );
}

// Plain React Native styles: Unistyles must not patch nodes Reanimated animates (mobile-panels.md).
const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0, overflow: "hidden" },
  strip: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 },
  slide: { position: "absolute", top: 0, bottom: 0 },
});
