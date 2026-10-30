import { describe, expect, it } from "vitest";
import { pendingChangeForAgent, resolveCacheWindowChange } from "./cache-window-change";

describe("resolveCacheWindowChange", () => {
  it("holds the change for confirmation while a live cache has time left", () => {
    expect(resolveCacheWindowChange({ status: { kind: "warm", remainingMs: 252_000 } })).toEqual({
      kind: "confirm",
      remainingMs: 252_000,
    });
    expect(
      resolveCacheWindowChange({ status: { kind: "awaiting-question", remainingMs: 60_000 } }),
    ).toEqual({ kind: "confirm", remainingMs: 60_000 });
    expect(
      resolveCacheWindowChange({ status: { kind: "awaiting-permission", remainingMs: 90_000 } }),
    ).toEqual({ kind: "confirm", remainingMs: 90_000 });
    expect(resolveCacheWindowChange({ status: { kind: "busy", remainingMs: 30_000 } })).toEqual({
      kind: "confirm",
      remainingMs: 30_000,
    });
  });

  it("applies the change at once when no live cache has time left", () => {
    expect(resolveCacheWindowChange({ status: { kind: "automatic" } })).toEqual({ kind: "apply" });
    expect(resolveCacheWindowChange({ status: { kind: "expired" } })).toEqual({ kind: "apply" });
    expect(resolveCacheWindowChange({ status: { kind: "busy-expired" } })).toEqual({
      kind: "apply",
    });
    expect(resolveCacheWindowChange({ status: { kind: "busy", remainingMs: null } })).toEqual({
      kind: "apply",
    });
  });
});

describe("pendingChangeForAgent", () => {
  it("returns the pending change only for the agent it was asked for", () => {
    const pending = { agentId: "agent-a", featureId: "prompt_cache_ttl", value: "1h" };

    expect(pendingChangeForAgent(pending, "agent-a")).toBe(pending);
    expect(pendingChangeForAgent(pending, "agent-b")).toBeNull();
  });

  it("returns nothing when no change is pending", () => {
    expect(pendingChangeForAgent(null, "agent-a")).toBeNull();
  });
});
