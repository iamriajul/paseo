import { useMemo } from "react";
import { Image, type ImageStyle, type StyleProp } from "react-native";

interface PlatformImageProps {
  uri: string;
  style: StyleProp<ImageStyle>;
  accessibilityLabel?: string;
  onError?: () => void;
  testID?: string;
}

/** The browser decodes every format the image panel opens, SVG included. */
export function PlatformImage({
  uri,
  style,
  accessibilityLabel,
  onError,
  testID,
}: PlatformImageProps) {
  const source = useMemo(() => ({ uri }), [uri]);
  return (
    <Image
      accessibilityLabel={accessibilityLabel}
      accessibilityRole={accessibilityLabel ? "image" : undefined}
      onError={onError}
      resizeMode="contain"
      source={source}
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
  Image.getSize(uri, onSize, onError);
}
