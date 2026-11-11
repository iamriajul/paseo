import { requireNativeView } from "expo";
import { requireOptionalNativeModule } from "expo-modules-core";
import type { ComponentType, Ref } from "react";
import type { StyleProp, ViewStyle } from "react-native";

/** The view's functions, through its ref. */
export interface PaseoVideoViewHandle {
  /**
   * Decodes one H.264 picture. iOS takes AVCC (4-byte lengths), Android Annex B (4-byte start
   * codes); a keyframe brings its SPS and PPS (without start codes).
   */
  decode(
    id: number,
    sample: Uint8Array,
    key: boolean,
    sps: Uint8Array | null,
    pps: Uint8Array | null,
  ): Promise<void>;
  /** Drops the decoder; the last frame stays on screen. */
  reset(): Promise<void>;
}

export interface PaseoVideoViewProps {
  ref?: Ref<PaseoVideoViewHandle>;
  /** A frame is on screen: chunk `id` and every one before it are done. */
  onFrame?: (event: { nativeEvent: { id: number } }) => void;
  /** The decoder failed; it drops deltas until the next keyframe rebuilds it. */
  onDecoderError?: (event: { nativeEvent: { message: string } }) => void;
  style?: StyleProp<ViewStyle>;
}

/**
 * Whether this app build has the native decoder. A build from before it has no PaseoVideo module
 * and keeps asking for JPEG.
 */
export function isPaseoVideoAvailable(): boolean {
  return requireOptionalNativeModule("PaseoVideo") !== null;
}

let view: ComponentType<PaseoVideoViewProps> | null = null;

/** The native view; only call when `isPaseoVideoAvailable()`. */
export function getPaseoVideoView(): ComponentType<PaseoVideoViewProps> {
  view ??= requireNativeView<PaseoVideoViewProps>("PaseoVideo");
  return view;
}
