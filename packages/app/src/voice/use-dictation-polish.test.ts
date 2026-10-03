import { describe, expect, it, vi } from "vitest";
import { polishDictationTextWithClient } from "./use-dictation-polish";

function createClient(response: unknown) {
  return {
    polishDictationText: vi.fn(async () => response),
  };
}

describe("polishDictationTextWithClient", () => {
  it("returns polished text on success", async () => {
    const client = createClient({ polishedText: "Hello.", error: null });
    const onState = vi.fn();
    const polished = await polishDictationTextWithClient(client as never, "um hello", {
      timeoutMs: 30_000,
      failedMessage: "failed",
      onState,
    });
    expect(polished).toBe("Hello.");
    expect(onState).toHaveBeenCalledWith({ isPolishing: true, error: null });
    expect(onState).toHaveBeenCalledWith({ isPolishing: false, error: null });
  });

  it("returns null when the endpoint reports an error", async () => {
    const client = createClient({
      polishedText: null,
      error: { code: "endpoint_not_configured", message: "no endpoint" },
    });
    const onState = vi.fn();
    const polished = await polishDictationTextWithClient(client as never, "hello", {
      timeoutMs: 30_000,
      failedMessage: "failed",
      onState,
    });
    expect(polished).toBeNull();
    expect(onState).toHaveBeenCalledWith({ isPolishing: false, error: "failed" });
  });

  it("returns null when the RPC throws", async () => {
    const client = {
      polishDictationText: vi.fn(async () => {
        throw new Error("Update the host to polish dictated text.");
      }),
    };
    const onState = vi.fn();
    const polished = await polishDictationTextWithClient(client as never, "hello", {
      timeoutMs: 30_000,
      failedMessage: "failed",
      onState,
    });
    expect(polished).toBeNull();
    expect(onState).toHaveBeenCalledWith({ isPolishing: false, error: "failed" });
  });

  it("returns null without a client", async () => {
    const onState = vi.fn();
    const polished = await polishDictationTextWithClient(null, "hello", {
      timeoutMs: 30_000,
      failedMessage: "failed",
      onState,
    });
    expect(polished).toBeNull();
    expect(onState).not.toHaveBeenCalled();
  });
});
