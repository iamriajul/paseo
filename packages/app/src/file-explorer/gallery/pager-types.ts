import type { ReactNode } from "react";

export interface GallerySlide {
  /** The image's index in the folder; slides sit at `index * width` on one strip. */
  index: number;
  key: string;
  content: ReactNode;
}

export interface GalleryPagerProps {
  index: number;
  count: number;
  /** The previous, current and next slides that exist. */
  slides: readonly GallerySlide[];
  /** The image is zoomed in: a drag pans it instead of paging. */
  zoomed: boolean;
  keyboardActive: boolean;
  gesturesActive: boolean;
  /** One step back or forward: keys and touch swipes on web. */
  onNavigate: (delta: -1 | 1) => void;
  /** Shows the folder image at this index. */
  onSelect: (index: number) => void;
  onTouchInput: () => void;
}
