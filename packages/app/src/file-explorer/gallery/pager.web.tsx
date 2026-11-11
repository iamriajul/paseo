import { useCallback, useEffect, useRef, type PointerEvent } from "react";
import { hasActiveWebOverlay } from "@/lib/overlay-root";
import { isImeComposingKeyboardEvent } from "@/utils/keyboard-ime";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useBlockMobilePanelOpenGestures } from "@/mobile-panels/provider";
import type { GalleryPagerProps } from "./pager-types";

export type { GallerySlide } from "./pager-types";

const SWIPE_DISTANCE = 48;

/**
 * Web shows only the image on screen; its neighbours are already loaded and decoded, so a page
 * swaps instantly. Left and Right page while the pane has focus, and so does a touch swipe while
 * the image is not zoomed in.
 */
export function GalleryPager({
  index,
  count,
  slides,
  pagingEnabled,
  keyboardActive,
  gesturesActive,
  onNavigate,
  onTouchInput,
}: GalleryPagerProps) {
  const isCompact = useIsCompactFormFactor();
  useBlockMobilePanelOpenGestures(isCompact && gesturesActive && count > 1);
  const touchStart = useRef<{ id: number; x: number; y: number } | null>(null);

  useEffect(() => {
    if (!keyboardActive) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.shiftKey || hasActiveWebOverlay() || isImeComposingKeyboardEvent(event)) return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      onNavigate(event.key === "ArrowLeft" ? -1 : 1);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [keyboardActive, onNavigate]);

  // Capture phase: the zoom canvas captures the pointer and handles it on its own.
  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.pointerType === "mouse") return;
      onTouchInput();
      touchStart.current = event.isPrimary
        ? { id: event.pointerId, x: event.clientX, y: event.clientY }
        : null;
    },
    [onTouchInput],
  );
  const handlePointerUp = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const start = touchStart.current;
      if (!start || start.id !== event.pointerId) return;
      touchStart.current = null;
      if (!pagingEnabled) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (Math.abs(dx) < SWIPE_DISTANCE || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      onNavigate(dx > 0 ? -1 : 1);
    },
    [onNavigate, pagingEnabled],
  );
  const handlePointerCancel = useCallback(() => {
    touchStart.current = null;
  }, []);

  const current = slides.find((slide) => slide.index === index);
  return (
    <div
      data-testid="image-gallery-slide-current"
      onPointerDownCapture={handlePointerDown}
      onPointerUpCapture={handlePointerUp}
      onPointerCancelCapture={handlePointerCancel}
      style={rootStyle}
    >
      {current?.content}
    </div>
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

const rootStyle: React.CSSProperties = {
  position: "relative",
  display: "flex",
  flexDirection: "column",
  flex: 1,
  minHeight: 0,
};
