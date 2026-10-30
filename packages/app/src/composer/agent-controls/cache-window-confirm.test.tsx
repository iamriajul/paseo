// @vitest-environment jsdom

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CacheWindowConfirm } from "./cache-window-confirm";

const { theme } = vi.hoisted(() => {
  Object.assign(globalThis, { __DEV__: false });
  return {
    theme: {
      spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
      fontSize: { xs: 11, sm: 12, base: 14 },
      fontWeight: { semibold: "600", medium: "500" },
      borderRadius: { md: 6, lg: 8, xl: 12, full: 9999 },
      borderWidth: { 1: 1 },
      opacity: { 0: 0, 50: 0.5, 100: 1 },
      colors: {
        surface0: "#000",
        surface1: "#111",
        surface3: "#333",
        foreground: "#fff",
        foregroundMuted: "#aaa",
        border: "#555",
        borderAccent: "#777",
        accent: "#20744a",
        statusWarning: "#c09664",
      },
    },
  };
});

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  withUnistyles: (Component: unknown) => Component,
}));

vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({
    visible,
    header,
    children,
    footer,
  }: {
    visible: boolean;
    header: { title: string };
    children: React.ReactNode;
    footer: React.ReactNode;
  }) =>
    visible ? (
      <section>
        <h2>{header.title}</h2>
        {children}
        {footer}
      </section>
    ) : null,
}));

vi.mock("@/prompt-cache/use-prompt-cache", () => ({
  usePromptCache: () => ({ status: { kind: "expired" } }),
}));

const NOOP = () => {};

afterEach(() => {
  cleanup();
});

describe("CacheWindowConfirm", () => {
  it("states the live countdown and the write prices", () => {
    render(<CacheWindowConfirm remainingMs={252_000} onCancel={NOOP} onConfirm={NOOP} />);

    expect(screen.getByText(/Your cache expires in 4:12/)).toBeTruthy();
    expect(screen.getByText(/1\.25×/)).toBeTruthy();
    expect(screen.getByText(/2×/)).toBeTruthy();
  });

  it("says that changing the window may drop the cache and the next request may write it again", () => {
    render(<CacheWindowConfirm remainingMs={252_000} onCancel={NOOP} onConfirm={NOOP} />);

    expect(screen.getByText(/may drop this cache/)).toBeTruthy();
    expect(screen.getByText(/may write it again/)).toBeTruthy();
  });

  it("says there is nothing to drop once no live cache has time left", () => {
    render(<CacheWindowConfirm remainingMs={null} onCancel={NOOP} onConfirm={NOOP} />);

    expect(screen.getByText(/has expired, so there is nothing to drop/)).toBeTruthy();
    expect(screen.queryByText(/Your cache expires/)).toBeNull();
  });

  it("changes the window only when the user confirms", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(<CacheWindowConfirm remainingMs={252_000} onCancel={onCancel} onConfirm={onConfirm} />);

    fireEvent.click(screen.getByTestId("cache-window-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("cache-window-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
