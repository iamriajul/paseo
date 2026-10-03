import { describe, expect, it } from "vitest";
import { VoiceQuality } from "expo-speech";
import { resolvePreferredTtsVoice } from "./read-aloud-voice";

describe("resolvePreferredTtsVoice", () => {
  it("prefers the exact locale match", () => {
    const resolved = resolvePreferredTtsVoice(
      [
        { identifier: "en-gb", name: "Daniel", language: "en-GB", quality: VoiceQuality.Default },
        { identifier: "en-us", name: "Aaron", language: "en-US", quality: VoiceQuality.Default },
      ],
      "en-US",
    );
    expect(resolved.identifier).toBe("en-us");
  });

  it("falls back to the language prefix when no exact match exists", () => {
    const resolved = resolvePreferredTtsVoice(
      [{ identifier: "en-au", name: "Karen", language: "en-AU", quality: VoiceQuality.Default }],
      "en-US",
    );
    expect(resolved.identifier).toBe("en-au");
  });

  it("returns no identifier when no voices exist", () => {
    expect(resolvePreferredTtsVoice([], "en-US").identifier).toBeUndefined();
  });
});
