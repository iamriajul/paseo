import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Image, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { ZoomableImage } from "@/components/zoomable-viewport/image";
import { FilePanelLoading } from "@/file-panels/loading";
import { usePaneContext, usePaneFocus } from "@/panels/pane-context";
import { GalleryControls } from "./controls";
import { useGalleryImage } from "./hooks";
import type { GalleryImageState } from "./image-cache";
import { stepImageGallery, type ImageGallery } from "./model";
import { GalleryPager, type GallerySlide } from "./pager";

/**
 * The file tab's image with its folder's other images a step away. Paging retargets the tab, so
 * its title, restore and Escape/Back behave as if the user had opened that image from Files.
 */
export function ImageGalleryView({
  serverId,
  workspaceRoot,
  gallery,
  version,
}: {
  serverId: string;
  workspaceRoot: string;
  gallery: ImageGallery;
  /** The observed version of the image on screen, or null before its stat. */
  version: string | null;
}) {
  const { retargetCurrentTab } = usePaneContext();
  const { isInteractive } = usePaneFocus();
  const active = useRetainedPanelActive();
  const isCompact = useIsCompactFormFactor();
  const [zoomed, setZoomed] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [touched, setTouched] = useState(false);
  const { items, index } = gallery;
  const previous = items[index - 1] ?? null;
  const current = items[index];
  const next = items[index + 1] ?? null;
  // The neighbours load with the image on screen, so a page lands on a decoded image.
  const previousImage = useGalleryImage({
    serverId,
    workspaceRoot,
    targetPath: previous?.targetPath ?? null,
    version: null,
  });
  const currentImage = useGalleryImage({
    serverId,
    workspaceRoot,
    targetPath: current.targetPath,
    version,
  });
  const nextImage = useGalleryImage({
    serverId,
    workspaceRoot,
    targetPath: next?.targetPath ?? null,
    version: null,
  });

  const select = useCallback(
    (target: number) => {
      const item = items[target];
      if (!item || target === index) return;
      setZoomed(false);
      retargetCurrentTab({ kind: "file", path: item.targetPath });
    },
    [index, items, retargetCurrentTab],
  );
  const navigate = useCallback(
    (delta: -1 | 1) => {
      const target = stepImageGallery(gallery, delta);
      if (target !== null) select(target);
    },
    [gallery, select],
  );
  const showPrevious = useCallback(() => navigate(-1), [navigate]);
  const showNext = useCallback(() => navigate(1), [navigate]);
  const handlePointerEnter = useCallback(() => setHovered(true), []);
  const handlePointerLeave = useCallback(() => setHovered(false), []);
  const handleTouchInput = useCallback(() => setTouched(true), []);

  const slides: GallerySlide[] = [
    previous && { index: index - 1, key: previous.targetPath, content: neighbour(previousImage) },
    {
      index,
      key: current.targetPath,
      content: <CurrentImage image={currentImage} name={current.name} onZoomChange={setZoomed} />,
    },
    next && { index: index + 1, key: next.targetPath, content: neighbour(nextImage) },
  ].filter((slide): slide is GallerySlide => Boolean(slide));

  return (
    // Hover lives on a plain View around everything it reveals (docs/hover.md).
    <View
      style={styles.root}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      testID="image-gallery"
    >
      <GalleryPager
        index={index}
        count={items.length}
        slides={slides}
        pagingEnabled={!zoomed}
        keyboardActive={isInteractive && active}
        gesturesActive={active}
        onSelect={select}
        onNavigate={navigate}
        onTouchInput={handleTouchInput}
      />
      <GalleryControls
        index={index}
        count={items.length}
        visible={hovered || touched || isNative || isCompact}
        onPrevious={showPrevious}
        onNext={showNext}
      />
    </View>
  );
}

function CurrentImage({
  image,
  name,
  onZoomChange,
}: {
  image: GalleryImageState;
  name: string;
  onZoomChange: (zoomed: boolean) => void;
}) {
  if (image.status === "loading") return <FilePanelLoading />;
  if (image.status === "error") return <SlideMessage>{image.message}</SlideMessage>;
  return (
    <ZoomableImage
      uri={image.url}
      contentSize={image.size ?? undefined}
      accessibilityLabel={name}
      onZoomChange={onZoomChange}
      testID="image-file-preview"
    />
  );
}

/** A neighbour is drawn plainly: it is seen only while a swipe drags it in. */
function neighbour(image: GalleryImageState): ReactNode {
  if (image.status === "loading") return <FilePanelLoading />;
  if (image.status === "error") return <SlideMessage>{image.message}</SlideMessage>;
  return <NeighbourImage uri={image.url} />;
}

function NeighbourImage({ uri }: { uri: string }) {
  const source = useMemo(() => ({ uri }), [uri]);
  return <Image source={source} resizeMode="contain" style={styles.neighbour} />;
}

function SlideMessage({ children }: { children: string }) {
  return (
    <View style={styles.message}>
      <Text style={styles.messageText}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    minHeight: 0,
    position: "relative",
  },
  neighbour: {
    width: "100%",
    height: "100%",
  },
  message: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
  messageText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));
