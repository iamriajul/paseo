import { describe, expect, it, vi } from "vitest";
import { applyOsFocusSteal } from "./window-focus.js";

describe("applyOsFocusSteal", () => {
  it("steals focus on macOS so fullscreen Space swipes bring Paseo forward", () => {
    const focusApp = vi.fn();
    applyOsFocusSteal({ platform: "darwin", focusApp });
    expect(focusApp).toHaveBeenCalledWith({ steal: true });
  });

  it("does not steal on other platforms", () => {
    const focusApp = vi.fn();
    applyOsFocusSteal({ platform: "linux", focusApp });
    expect(focusApp).not.toHaveBeenCalled();
  });
});
