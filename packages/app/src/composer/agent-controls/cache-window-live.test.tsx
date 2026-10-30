// @vitest-environment jsdom

import React, { useContext } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CacheWindowLiveContext, CacheWindowLiveProvider } from "./cache-window-live";

const { promptCache } = vi.hoisted(() => ({
  promptCache: { status: { kind: "expired" } as { kind: string; remainingMs?: number } },
}));

vi.mock("@/prompt-cache/use-prompt-cache", () => ({
  usePromptCache: () => promptCache,
}));

function LiveProbe() {
  return <span>{useContext(CacheWindowLiveContext) ? "live" : "idle"}</span>;
}

afterEach(() => {
  cleanup();
});

describe("CacheWindowLiveProvider", () => {
  it("reports a live cache while it has time left", () => {
    promptCache.status = { kind: "warm", remainingMs: 60_000 };

    render(
      <CacheWindowLiveProvider serverId="srv" agentId="agent">
        <LiveProbe />
      </CacheWindowLiveProvider>,
    );

    expect(screen.getByText("live")).toBeTruthy();
  });

  it("reports no live cache once it has expired", () => {
    promptCache.status = { kind: "expired" };

    render(
      <CacheWindowLiveProvider serverId="srv" agentId="agent">
        <LiveProbe />
      </CacheWindowLiveProvider>,
    );

    expect(screen.getByText("idle")).toBeTruthy();
  });
});
