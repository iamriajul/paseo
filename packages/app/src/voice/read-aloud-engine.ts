import * as Speech from "expo-speech";
import type { ReadAloudEngine } from "./read-aloud-player";
import { resolvePreferredTtsVoice } from "./read-aloud-voice";

const VOICE_CACHE_TTL_MS = 60_000;

let cachedVoices: Speech.Voice[] | null = null;
let cachedVoicesAt = 0;

async function loadVoices(): Promise<Speech.Voice[]> {
  const now = Date.now();
  if (cachedVoices && now - cachedVoicesAt < VOICE_CACHE_TTL_MS) {
    return cachedVoices;
  }
  try {
    cachedVoices = await Speech.getAvailableVoicesAsync();
  } catch {
    cachedVoices = [];
  }
  cachedVoicesAt = now;
  return cachedVoices ?? [];
}

function awaitSpeechEnd(text: string, options: Speech.SpeechOptions): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const settle = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    Speech.speak(text, {
      ...options,
      onDone: settle,
      onStopped: settle,
      onError: settle,
    });
  });
}

export function createOnDeviceReadAloudEngine(): ReadAloudEngine {
  return {
    async speak(text) {
      const voices = await loadVoices();
      const resolved = resolvePreferredTtsVoice(voices);
      await Speech.stop().catch(() => undefined);
      await awaitSpeechEnd(text, {
        ...(resolved.language ? { language: resolved.language } : {}),
        ...(resolved.identifier ? { voice: resolved.identifier } : {}),
      });
    },
    async stop() {
      await Speech.stop().catch(() => undefined);
    },
  };
}

export function resetOnDeviceReadAloudVoiceCache(): void {
  cachedVoices = null;
  cachedVoicesAt = 0;
}
