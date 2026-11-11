import { Buffer } from "buffer";
import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from "react";
import {
  Image,
  PixelRatio,
  Text,
  // An invisible IME bridge, not an editing surface: EditingTextInput's focus authority hands
  // focus back to the last editor (the URL bar), so the soft keyboard typed into it instead.
  // oxlint-disable-next-line no-restricted-imports
  TextInput,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { DaemonClient, ServerBrowserFrame } from "@getpaseo/client/internal/daemon-client";
import type { ServerBrowserInputEvent } from "@getpaseo/protocol/server-browser/rpc-schemas";
import { InputBatcher, namedKeyPress } from "./input";
import {
  pagePixelsPerSurfacePixel,
  quantizeScreencastViewport,
  surfacePointToPage,
  useServerBrowserScreencast,
  type ScreencastViewport,
} from "./use-screencast";

export interface ServerBrowserSurfaceHandle {
  focusKeyboard(): void;
}

interface ServerBrowserSurfaceProps {
  client: DaemonClient;
  browserId: string;
  pageWidth: number;
  pageHeight: number;
  /** Annotate element is picking: a touch points, a drag moves the highlight, lifting picks. */
  annotating?: boolean;
  onCancelAnnotate?: () => void;
  /** The surface's size in CSS pixels, each time it changes; the Responsive device size follows it. */
  onSize?: (size: { width: number; height: number }) => void;
  /** Web only for now: native viewers have no WebCodecs and keep JPEG frames. */
  video?: boolean;
}

const TAP_SLOP = 8;
const LONG_PRESS_MS = 500;

/**
 * Native: frames are JPEG data URIs in two stacked Images, so the visible one never blanks while
 * the next decodes. A tap clicks, a drag scrolls, a long press right-clicks, and the toolbar's
 * keyboard button focuses a hidden TextInput whose text goes to the page.
 */
export const ServerBrowserSurface = forwardRef<
  ServerBrowserSurfaceHandle,
  ServerBrowserSurfaceProps
>(function ServerBrowserSurface(
  { client, browserId, pageWidth, pageHeight, annotating = false, onSize },
  ref,
) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState<ScreencastViewport | null>(null);
  const [uris, setUris] = useState<[string | null, string | null]>([null, null]);
  // Each buffer's frame is acked once, when its Image has decoded it.
  const pendingFramesRef = useRef<[ServerBrowserFrame | null, ServerBrowserFrame | null]>([
    null,
    null,
  ]);
  const [front, setFront] = useState<0 | 1>(0);
  const frontRef = useRef<0 | 1>(0);
  const keyboardRef = useRef<TextInput | null>(null);
  const typedRef = useRef("");
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const pageRef = useRef({ width: pageWidth, height: pageHeight });
  pageRef.current = { width: pageWidth, height: pageHeight };
  const annotatingRef = useRef(annotating);
  annotatingRef.current = annotating;
  const onSizeRef = useRef(onSize);
  onSizeRef.current = onSize;

  const batcherRef = useRef<InputBatcher | null>(null);
  if (!batcherRef.current) {
    batcherRef.current = new InputBatcher((events) =>
      client
        .serverBrowserInput(browserId, events)
        .catch((error: unknown) => console.warn("[server-browser] input failed", error)),
    );
  }
  const send = useCallback((event: ServerBrowserInputEvent, flush: boolean) => {
    batcherRef.current?.push(event, flush);
  }, []);

  // The keyboard button toggles a visible "type into the page" bar; it mounts focused.
  const [typing, setTyping] = useState(false);
  useImperativeHandle(
    ref,
    () => ({
      focusKeyboard: () =>
        setTyping((current) => {
          if (current) keyboardRef.current?.blur();
          return !current;
        }),
    }),
    [],
  );
  const handleTypingEnd = useCallback(() => {
    typedRef.current = "";
    setTyping(false);
  }, []);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize({ width, height });
    onSizeRef.current?.({ width, height });
    const ratio = PixelRatio.get();
    setViewport((previous) =>
      quantizeScreencastViewport(previous, { maxWidth: width * ratio, maxHeight: height * ratio }),
    );
  }, []);

  const handleFrame = useCallback((frame: ServerBrowserFrame) => {
    const back = frontRef.current === 0 ? 1 : 0;
    const uri = `data:image/jpeg;base64,${Buffer.from(frame.jpeg).toString("base64")}`;
    pendingFramesRef.current[back]?.ack();
    pendingFramesRef.current[back] = frame;
    setUris((current) => (back === 0 ? [uri, current[1]] : [current[0], uri]));
  }, []);

  useServerBrowserScreencast({ client, browserId, viewport, onFrame: handleFrame });

  const handleBufferLoaded = useCallback((index: 0 | 1) => {
    frontRef.current = index;
    setFront(index);
    const frame = pendingFramesRef.current[index];
    pendingFramesRef.current[index] = null;
    frame?.ack();
  }, []);
  const handleLoad0 = useCallback(() => handleBufferLoaded(0), [handleBufferLoaded]);
  const handleLoad1 = useCallback(() => handleBufferLoaded(1), [handleBufferLoaded]);

  const gesture = useRef({
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    startedAt: 0,
    moved: false,
    longPress: null as ReturnType<typeof setTimeout> | null,
    longPressed: false,
  });

  const toPage = useCallback((x: number, y: number) => {
    return surfacePointToPage({
      x,
      y,
      surfaceWidth: sizeRef.current.width,
      surfaceHeight: sizeRef.current.height,
      pageWidth: pageRef.current.width,
      pageHeight: pageRef.current.height,
    });
  }, []);

  const click = useCallback(
    (x: number, y: number, button: "left" | "right") => {
      const point = toPage(x, y);
      if (!point) return;
      send({ kind: "mouse", action: "move", ...point, button: "none", clickCount: 0 }, false);
      send({ kind: "mouse", action: "down", ...point, button, clickCount: 1 }, false);
      send({ kind: "mouse", action: "up", ...point, button, clickCount: 1 }, true);
    },
    [send, toPage],
  );

  const pointAt = useCallback(
    (x: number, y: number) => {
      const point = toPage(x, y);
      if (point)
        send({ kind: "mouse", action: "move", ...point, button: "none", clickCount: 0 }, true);
    },
    [send, toPage],
  );

  const handleGrant = useCallback(
    (event: GestureResponderEvent) => {
      const { locationX, locationY } = event.nativeEvent;
      const state = gesture.current;
      state.startX = state.lastX = locationX;
      state.startY = state.lastY = locationY;
      state.startedAt = Date.now();
      state.moved = false;
      state.longPressed = false;
      state.longPress = null;
      if (annotatingRef.current) {
        pointAt(locationX, locationY);
        return;
      }
      state.longPress = setTimeout(() => {
        state.longPressed = true;
        click(state.startX, state.startY, "right");
      }, LONG_PRESS_MS);
    },
    [click, pointAt],
  );

  const handleMove = useCallback(
    (event: GestureResponderEvent) => {
      const { locationX, locationY } = event.nativeEvent;
      const state = gesture.current;
      if (annotatingRef.current) {
        state.lastX = locationX;
        state.lastY = locationY;
        pointAt(locationX, locationY);
        return;
      }
      if (
        !state.moved &&
        Math.hypot(locationX - state.startX, locationY - state.startY) < TAP_SLOP
      ) {
        return;
      }
      if (state.longPress) clearTimeout(state.longPress);
      state.moved = true;
      const scale = pagePixelsPerSurfacePixel({
        surfaceWidth: sizeRef.current.width,
        surfaceHeight: sizeRef.current.height,
        pageWidth: pageRef.current.width,
        pageHeight: pageRef.current.height,
      });
      const point = toPage(state.startX, state.startY) ?? { x: 0.5, y: 0.5 };
      send(
        {
          kind: "wheel",
          ...point,
          deltaX: (state.lastX - locationX) * scale,
          deltaY: (state.lastY - locationY) * scale,
        },
        false,
      );
      state.lastX = locationX;
      state.lastY = locationY;
    },
    [pointAt, send, toPage],
  );

  const handleRelease = useCallback(() => {
    const state = gesture.current;
    if (state.longPress) clearTimeout(state.longPress);
    if (annotatingRef.current) {
      click(state.lastX, state.lastY, "left");
      return;
    }
    if (!state.moved && !state.longPressed) click(state.startX, state.startY, "left");
    batcherRef.current?.flush();
  }, [click]);

  // A gesture another responder took is not a pick.
  const handleTerminate = useCallback(() => {
    if (annotatingRef.current) {
      const state = gesture.current;
      if (state.longPress) clearTimeout(state.longPress);
      return;
    }
    handleRelease();
  }, [handleRelease]);

  // The hidden input keeps what was typed; the page gets only the difference, so IME
  // composition, autocorrect and deletes all arrive as insertions or Backspaces.
  const handleText = useCallback(
    (text: string) => {
      const previous = typedRef.current;
      typedRef.current = text;
      let common = 0;
      while (
        common < previous.length &&
        common < text.length &&
        previous[common] === text[common]
      ) {
        common += 1;
      }
      for (let i = common; i < previous.length; i++) {
        for (const input of namedKeyPress("Backspace")) send(input, false);
      }
      const inserted = text.slice(common);
      if (inserted) send({ kind: "text", text: inserted }, false);
      batcherRef.current?.flush();
    },
    [send],
  );
  const handleSubmit = useCallback(() => {
    for (const input of namedKeyPress("Enter")) send(input, true);
  }, [send]);

  const source0 = useMemo(() => (uris[0] ? { uri: uris[0] } : null), [uris]);
  const source1 = useMemo(() => (uris[1] ? { uri: uris[1] } : null), [uris]);
  const hasFrame = (front === 0 ? source0 : source1) !== null;

  return (
    <View style={styles.column}>
      <View
        style={styles.surface}
        onLayout={handleLayout}
        onStartShouldSetResponder={returnTrue}
        onMoveShouldSetResponder={returnTrue}
        onResponderGrant={handleGrant}
        onResponderMove={handleMove}
        onResponderRelease={handleRelease}
        onResponderTerminate={handleTerminate}
        testID="server-browser-surface"
      >
        {/* Fixed slots: only the back slot's source changes, so the shown frame never reloads. */}
        {source0 ? (
          <Image
            source={source0}
            style={front === 0 ? styles.frameFront : styles.frame}
            resizeMode="contain"
            fadeDuration={0}
            onLoad={handleLoad0}
          />
        ) : null}
        {source1 ? (
          <Image
            source={source1}
            style={front === 1 ? styles.frameFront : styles.frame}
            resizeMode="contain"
            fadeDuration={0}
            onLoad={handleLoad1}
          />
        ) : null}
        {hasFrame ? null : (
          <Text style={styles.placeholder}>Connecting to the server browser…</Text>
        )}
      </View>
      {typing ? (
        <View style={styles.typingBar}>
          <TextInput
            ref={keyboardRef}
            style={styles.typingInput}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="Type into the page"
            submitBehavior="submit"
            returnKeyType="send"
            onChangeText={handleText}
            onSubmitEditing={handleSubmit}
            onBlur={handleTypingEnd}
            testID="server-browser-typing-input"
          />
        </View>
      ) : null}
    </View>
  );
});

function returnTrue(): boolean {
  return true;
}

const styles = StyleSheet.create((theme) => ({
  surface: {
    flex: 1,
    minHeight: 0,
    backgroundColor: "#111111",
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  frame: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 0,
  },
  frameFront: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 1,
  },
  placeholder: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  column: {
    flex: 1,
    minHeight: 0,
  },
  typingBar: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  typingInput: {
    height: 36,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
}));
