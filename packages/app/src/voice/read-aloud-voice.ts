import { isNative } from "@/constants/platform";
import type { Voice } from "expo-speech";

const PREFERRED_VOICE_NAMES = [
  "samantha",
  "google us english",
  "google uk english",
  "siri",
  "aaron",
  "fred",
];

export interface ResolvedTtsVoice {
  identifier: string | undefined;
  language: string | undefined;
}

export function resolvePreferredTtsVoice(
  voices: readonly Voice[],
  preferredLanguage = "en-US",
): ResolvedTtsVoice {
  const normalizedPreferred = preferredLanguage.toLowerCase();
  const preferredPrefix = normalizedPreferred.split("-")[0] ?? normalizedPreferred;
  const scored = voices.map((voice) => ({
    voice,
    score: scoreVoice(voice, normalizedPreferred, preferredPrefix),
  }));
  scored.sort((left, right) => right.score - left.score);
  const best = scored[0]?.voice;
  if (!best) {
    return { identifier: undefined, language: preferredLanguage };
  }
  return { identifier: best.identifier, language: best.language || preferredLanguage };
}

function scoreVoice(voice: Voice, normalizedPreferred: string, preferredPrefix: string): number {
  let score = 0;
  const language = (voice.language || "").toLowerCase();
  if (language === normalizedPreferred) {
    score += 100;
  } else if (language.startsWith(preferredPrefix)) {
    score += 50;
  } else if (language.startsWith("en")) {
    score += 10;
  }
  const name = (voice.name || "").toLowerCase();
  for (const preferred of PREFERRED_VOICE_NAMES) {
    if (name.includes(preferred)) {
      score += 20;
      break;
    }
  }
  if (isNative && voice.quality === "Enhanced") {
    score += 5;
  }
  return score;
}
