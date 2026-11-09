import { useReducedMotion } from "react-native-reanimated";
import { useSettings } from "@/hooks/use-settings";
import type { PromptCacheWarmup } from "./use-prompt-cache";

/** Warm-up stops covering the cache within the user's warning window. */
export function isNearCap(
  warmup: Pick<PromptCacheWarmup, "enabled" | "coverEndsInMs"> | null | undefined,
  warningMinutes: number,
): boolean {
  const coverEndsInMs = warmup?.enabled ? warmup.coverEndsInMs : null;
  return coverEndsInMs !== null && coverEndsInMs > 0 && coverEndsInMs <= warningMinutes * 60_000;
}

/**
 * Whether a cache countdown draws in the warning colour at `now`. Near the cap it alternates each
 * second, so the countdown blinks; under reduced motion it holds the warning colour instead.
 */
export function resolveCountdownFlash(input: {
  nearCap: boolean;
  now: number;
  reduceMotion: boolean;
}): boolean {
  if (!input.nearCap) return false;
  return input.reduceMotion || Math.floor(input.now / 1000) % 2 === 0;
}

/**
 * The one urgency rule for every cache countdown, the composer pill's and the sidebar row's. The
 * caller re-renders each second while its countdown ticks and passes that render's time.
 */
export function useCountdownFlash(
  warmup: Pick<PromptCacheWarmup, "enabled" | "coverEndsInMs"> | null | undefined,
  now: number,
): boolean {
  const warningMinutes = useSettings((settings) => settings.promptCacheCapWarningMinutes);
  const reduceMotion = useReducedMotion();
  return resolveCountdownFlash({ nearCap: isNearCap(warmup, warningMinutes), now, reduceMotion });
}
