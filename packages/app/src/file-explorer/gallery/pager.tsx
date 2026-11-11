import { useCallback, useLayoutEffect, useMemo, useState } from "react";
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

export type { GallerySlide } from "./pager-types";

const PAGE_DURATION = 220;
const PAGE_DISTANCE = 0.2;
const PAGE_VELOCITY = 500;
const EDGE_RESISTANCE = 0.3;

/**
 * A horizontal strip of the folder's images that follows the finger. Slides are placed by their
 * folder index, so when a page lands and the tab retargets, nothing on the strip moves: the
 * strip's offset already shows the new image.
 */
export function GalleryPager({
  index,
  count,
  slides,
  pagingEnabled,
  gesturesActive,
  onSelect,
}: GalleryPagerProps) {
  const isCompact = useIsCompactFormFactor();
  const [width, setWidth] = useState(0);
  const offset = useSharedValue(0);
  const settled = useSharedValue(index);
  // A horizontal swipe here pages; it must not also open a mobile sidebar.
  useBlockMobilePanelOpenGestures(isCompact && gesturesActive && count > 1);

  useLayoutEffect(() => {
    if (width <= 0) return;
    const target = -index * width;
    // A swipe already moved the strip; a button, key or retarget from elsewhere slides it.
    offset.value =
      settled.value === index ? target : withTiming(target, { duration: PAGE_DURATION });
    settled.value = index;
  }, [index, offset, settled, width]);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    setWidth(event.nativeEvent.layout.width);
  }, []);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .enabled(pagingEnabled && count > 1 && width > 0)
        .maxPointers(1)
        .activeOffsetX([-12, 12])
        .failOffsetY([-12, 12])
        .onUpdate((event) => {
          const current = settled.value;
          const pullingPastEnd =
            (event.translationX > 0 && current === 0) ||
            (event.translationX < 0 && current === count - 1);
          const dx = pullingPastEnd ? event.translationX * EDGE_RESISTANCE : event.translationX;
          offset.value = -current * width + dx;
        })
        .onEnd((event) => {
          const current = settled.value;
          let delta: -1 | 0 | 1 = 0;
          const forward =
            event.translationX < -width * PAGE_DISTANCE || event.velocityX < -PAGE_VELOCITY;
          const back =
            event.translationX > width * PAGE_DISTANCE || event.velocityX > PAGE_VELOCITY;
          if (forward && current < count - 1) delta = 1;
          else if (back && current > 0) delta = -1;
          const next = current + delta;
          settled.value = next;
          offset.value = withTiming(-next * width, { duration: PAGE_DURATION }, (finished) => {
            if (finished && delta !== 0) runOnJS(onSelect)(next);
          });
        }),
    [count, offset, onSelect, pagingEnabled, settled, width],
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
