// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { PromptCacheHistoryEntry } from "@getpaseo/protocol/agent-cache-warm";
import { SessionActivitySection } from "./session-activity-section";

vi.hoisted(() => {
  Object.assign(globalThis, { __DEV__: false });
});

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function"
        ? factory({
            spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
            fontSize: { xs: 11, sm: 12, base: 14 },
            fontWeight: { semibold: "600", medium: "500" },
            borderRadius: { sm: 4, md: 6, full: 9999 },
            colors: new Proxy({}, { get: () => "#888" }),
          })
        : factory,
  },
}));

function turn(at: string): PromptCacheHistoryEntry {
  return {
    at,
    kind: "turn",
    readTokens: 20_000,
    writeTokens: 500,
    uncachedTokens: 0,
    gapMs: 60_000,
    writeInferred: true,
  };
}

const REQUESTS = [turn("2026-11-23T15:00:00Z"), turn("2026-11-23T15:20:00Z")];

function renderSection(windowAdvice: boolean) {
  return render(
    <SessionActivitySection
      requests={REQUESTS}
      sessionRequests={2}
      busy={false}
      price={null}
      nowMs={Date.parse("2026-11-23T15:20:00Z")}
      windowAdvice={windowAdvice}
    />,
  );
}

describe("SessionActivitySection", () => {
  afterEach(cleanup);

  it("says which Cache window covers each gap for an agent with warm-up", () => {
    const { getByText } = renderSection(true);
    expect(getByText("a 1h window covers these; 5m needs warm-up")).toBeTruthy();
    expect(getByText(/warm-ups included/)).toBeTruthy();
  });

  it("leaves window and warm-up advice out for a provider without them (Codex, OpenCode)", () => {
    const { getByText, queryByText } = renderSection(false);
    expect(getByText("Gaps between turns")).toBeTruthy();
    expect(queryByText(/window covers these/)).toBeNull();
    expect(queryByText(/warm-up/)).toBeNull();
  });
});
