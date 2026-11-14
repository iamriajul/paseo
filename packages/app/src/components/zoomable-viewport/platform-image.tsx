import { Image } from "expo-image";
import type { ImageStyle, StyleProp } from "react-native";

interface PlatformImageProps {
  uri: string;
  style: StyleProp<ImageStyle>;
  accessibilityLabel?: string;
  onError?: () => void;
  testID?: string;
}

/**
 * iOS and Android draw images with expo-image: React Native's Image cannot decode SVG on either,
 * nor AVIF before iOS 16 and Android 12. Nothing is cached: a file tab's image keeps its URL
 * when the file changes on disk.
 */
export function PlatformImage({
  uri,
  style,
  accessibilityLabel,
  onError,
  testID,
}: PlatformImageProps) {
  return (
    <Image
      accessibilityLabel={accessibilityLabel}
      accessible={accessibilityLabel !== undefined}
      cachePolicy="none"
      contentFit="contain"
      onError={onError}
      source={uri}
      style={style}
      testID={testID}
    />
  );
}

export function measureImage(
  uri: string,
  onSize: (width: number, height: number) => void,
  onError: () => void,
): void {
  void (async () => {
    let image: Awaited<ReturnType<typeof Image.loadAsync>>;
    try {
      image = await Image.loadAsync(uri);
    } catch {
      onError();
      return;
    }
    onSize(image.width, image.height);
    image.release();
  })();
}
