/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeepScreenAwakeController } from "./keep-screen-awake-controller";

const platform = vi.hoisted(() => ({ isNative: true, isWeb: false }));
const settingsState = vi.hoisted(() => ({ keepScreenAwake: true, isLoading: false }));
const keepAwake = vi.hoisted(() => ({
  activateKeepAwakeAsync: vi.fn(async (_tag: string) => undefined),
  deactivateKeepAwake: vi.fn(async (_tag: string) => undefined),
}));

vi.mock("@/constants/platform", () => platform);

vi.mock("@/hooks/use-settings", () => ({
  useAppSettings: () => ({
    settings: { keepScreenAwake: settingsState.keepScreenAwake },
    isLoading: settingsState.isLoading,
    error: null,
    updateSettings: vi.fn(),
    resetSettings: vi.fn(),
  }),
}));

vi.mock("expo-keep-awake", () => keepAwake);

beforeEach(() => {
  platform.isNative = true;
  settingsState.keepScreenAwake = true;
  settingsState.isLoading = false;
  keepAwake.activateKeepAwakeAsync.mockClear();
  keepAwake.deactivateKeepAwake.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("KeepScreenAwakeController", () => {
  it("activates the settings wake-lock tag when opted in", async () => {
    render(<KeepScreenAwakeController />);
    await waitFor(() => {
      expect(keepAwake.activateKeepAwakeAsync).toHaveBeenCalledWith("paseo:keep-screen-awake");
    });
    expect(keepAwake.activateKeepAwakeAsync).toHaveBeenCalledTimes(1);
  });

  it("stays idle while settings are still loading", () => {
    settingsState.isLoading = true;
    render(<KeepScreenAwakeController />);
    expect(keepAwake.activateKeepAwakeAsync).not.toHaveBeenCalled();
  });

  it("releases the lock when the setting turns off", async () => {
    const { rerender } = render(<KeepScreenAwakeController />);
    await waitFor(() => {
      expect(keepAwake.activateKeepAwakeAsync).toHaveBeenCalledTimes(1);
    });
    settingsState.keepScreenAwake = false;
    rerender(<KeepScreenAwakeController />);
    await waitFor(() => {
      expect(keepAwake.deactivateKeepAwake).toHaveBeenCalledWith("paseo:keep-screen-awake");
    });
    expect(keepAwake.activateKeepAwakeAsync).toHaveBeenCalledTimes(1);
  });

  it("releases the lock on unmount", async () => {
    const { unmount } = render(<KeepScreenAwakeController />);
    await waitFor(() => {
      expect(keepAwake.activateKeepAwakeAsync).toHaveBeenCalledTimes(1);
    });
    unmount();
    await waitFor(() => {
      expect(keepAwake.deactivateKeepAwake).toHaveBeenCalledWith("paseo:keep-screen-awake");
    });
  });

  it("never touches the native module on web", () => {
    platform.isNative = false;
    const { container } = render(<KeepScreenAwakeController />);
    expect(container).toBeDefined();
    expect(keepAwake.activateKeepAwakeAsync).not.toHaveBeenCalled();
    expect(keepAwake.deactivateKeepAwake).not.toHaveBeenCalled();
  });
});
