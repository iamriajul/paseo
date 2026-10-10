import { useEffect } from "react";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { isNative } from "@/constants/platform";
import { useAppSettings } from "@/hooks/use-settings";

/**
 * Holds a screen wake lock while the app is open when the user opted in.
 * Tag is distinct from the voice runtime's (`paseo:voice`) so toggling this
 * off never drops a lock an active voice session still needs.
 */
const KEEP_SCREEN_AWAKE_TAG = "paseo:keep-screen-awake";

export function KeepScreenAwakeController() {
  const { settings, isLoading } = useAppSettings();

  // Wait for storage: the pre-load default reads opted-in, which would
  // briefly lock the screen on every opted-out cold start.
  useEffect(() => {
    if (!isNative || isLoading || !settings.keepScreenAwake) {
      return;
    }
    void activateKeepAwakeAsync(KEEP_SCREEN_AWAKE_TAG).catch((error) => {
      console.warn("[KeepScreenAwake] Failed to activate keep-awake:", error);
    });
    return () => {
      void deactivateKeepAwake(KEEP_SCREEN_AWAKE_TAG).catch(() => undefined);
    };
  }, [isLoading, settings.keepScreenAwake]);

  return null;
}
