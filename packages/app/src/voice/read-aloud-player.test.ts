import { describe, expect, it, vi } from "vitest";
import { createReadAloudPlayer, type ReadAloudEngine } from "./read-aloud-player";

function createEngine(): ReadAloudEngine & { spoken: string[]; stops: number } {
  const spoken: string[] = [];
  let stops = 0;
  let releaseCurrent: (() => void) | null = null;
  const engine: ReadAloudEngine & { spoken: string[]; stops: number } = {
    spoken,
    get stops() {
      return stops;
    },
    async speak(text) {
      spoken.push(text);
      await new Promise<void>((resolve) => {
        releaseCurrent = resolve;
      });
      releaseCurrent = null;
    },
    async stop() {
      stops += 1;
      releaseCurrent?.();
      releaseCurrent = null;
    },
  };
  return engine;
}

describe("read aloud player", () => {
  it("speaks raw text and returns to idle", async () => {
    const engine = createEngine();
    const player = createReadAloudPlayer(engine);
    const seen: string[] = [];
    player.subscribe(() => {
      const state = player.getSnapshot().state;
      seen.push(state.status);
    });

    const speaking = player.speakRaw("hello", "key-1");
    expect(player.getSnapshot()).toEqual({
      state: { status: "speaking" },
      activeKey: "key-1",
    });
    await engine.stop();
    await speaking;
    expect(player.getSnapshot()).toEqual({ state: { status: "idle" }, activeKey: null });
    expect(engine.spoken).toEqual(["hello"]);
    expect(seen).toContain("speaking");
    expect(seen).toContain("idle");
  });

  it("preempts the previous utterance with the new one", async () => {
    const engine = createEngine();
    const player = createReadAloudPlayer(engine);

    const first = player.speakRaw("first", "key-1");
    await engine.stop();
    await first;
    const second = player.speakRaw("second", "key-2");
    await engine.stop();
    await second;

    expect(engine.spoken).toEqual(["first", "second"]);
    expect(player.getSnapshot().activeKey).toBeNull();
  });
  it("stops playback and clears the active key", async () => {
    const engine = createEngine();
    const player = createReadAloudPlayer(engine);
    const speaking = player.speakRaw("hello", "key-1");
    await player.stop();
    await speaking;
    expect(engine.stops).toBe(1);
    expect(player.getSnapshot()).toEqual({ state: { status: "idle" }, activeKey: null });
  });

  it("ignores blank text", async () => {
    const engine = createEngine();
    const speak = vi.spyOn(engine, "speak");
    const player = createReadAloudPlayer(engine);
    await player.speakRaw("   ");
    expect(speak).not.toHaveBeenCalled();
  });
});
