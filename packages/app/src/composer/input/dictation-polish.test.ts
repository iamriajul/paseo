import { describe, expect, it, vi } from "vitest";
import {
  createPolishRecordingHandler,
  resolveDictationPolishAvailability,
} from "./dictation-polish";

describe("createPolishRecordingHandler", () => {
  it("polishes the confirmed transcript and hands it to the composer", async () => {
    const handleDictationTranscript = vi.fn();
    const setAutoSend = vi.fn();
    const handler = createPolishRecordingHandler({
      confirmDictationForPolish: async () => "um hello",
      polishTranscript: async (text: string) => `${text}!`,
      handleDictationTranscript,
      setAutoSend,
    });
    await handler();
    expect(setAutoSend).toHaveBeenCalledWith(false);
    expect(handleDictationTranscript).toHaveBeenCalledWith("um hello!", {
      requestId: "dictation-polish",
    });
  });

  it("does nothing when confirmation yields no transcript", async () => {
    const handleDictationTranscript = vi.fn();
    const polishTranscript = vi.fn();
    const handler = createPolishRecordingHandler({
      confirmDictationForPolish: async () => null,
      polishTranscript,
      handleDictationTranscript,
      setAutoSend: vi.fn(),
    });
    await handler();
    expect(polishTranscript).not.toHaveBeenCalled();
    expect(handleDictationTranscript).not.toHaveBeenCalled();
  });

  it("falls back to the raw transcript when polish fails", async () => {
    const handleDictationTranscript = vi.fn();
    const handler = createPolishRecordingHandler({
      confirmDictationForPolish: async () => "hello",
      polishTranscript: async () => null,
      handleDictationTranscript,
      setAutoSend: vi.fn(),
    });
    await handler();
    expect(handleDictationTranscript).toHaveBeenCalledWith("hello", {
      requestId: "dictation-polish-fallback",
    });
  });
});

describe("resolveDictationPolishAvailability", () => {
  it("requires a connected client and the host flag", () => {
    expect(resolveDictationPolishAvailability({ isConnected: true }, true)).toBe(true);
    expect(resolveDictationPolishAvailability({ isConnected: false }, true)).toBe(false);
    expect(resolveDictationPolishAvailability(null, true)).toBe(false);
    expect(resolveDictationPolishAvailability({ isConnected: true }, false)).toBe(false);
  });
});
