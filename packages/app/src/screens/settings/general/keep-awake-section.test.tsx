/**
 * @vitest-environment jsdom
 */
import { i18n as testI18n } from "@/i18n/i18next";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeepAwakeSection } from "./keep-awake-section";

void testI18n;

const platform = vi.hoisted(() => ({ isNative: true, isWeb: false }));
const settingsState = vi.hoisted(() => ({
  keepScreenAwake: true,
  updateSettings: vi.fn(async (_updates: unknown) => undefined),
}));

vi.mock("@/constants/platform", () => platform);
vi.mock("react-native-reanimated", () => ({
  default: { View: "div" },
  Keyframe: class {
    duration() {
      return this;
    }
  },
  Easing: { ease: "ease", inOut: (value: unknown) => value },
  interpolateColor: (value: number, _input: number[], output: string[]) =>
    value >= 1 ? output[1] : output[0],
  useAnimatedStyle: (factory: () => unknown) => factory(),
  useDerivedValue: (factory: () => unknown) => ({ value: factory() }),
  withTiming: (value: unknown) => value,
  runOnJS: (fn: unknown) => fn,
}));
// adaptive-modal-sheet pulls native-only sheet machinery that cannot load in
// jsdom; stub the two value exports the settings kit reaches (same recipe as
// plugins-page.test.tsx and rename-modal.test.tsx).
vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: () => null,
  AdaptiveTextInput: () => null,
}));

vi.mock("@/hooks/use-settings", () => ({
  useAppSettings: () => ({
    settings: { keepScreenAwake: settingsState.keepScreenAwake },
    isLoading: false,
    error: null,
    updateSettings: settingsState.updateSettings,
    resetSettings: vi.fn(),
  }),
}));

beforeEach(() => {
  vi.stubGlobal("React", React);
  platform.isNative = true;
  settingsState.keepScreenAwake = true;
  settingsState.updateSettings.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("KeepAwakeSection", () => {
  it("renders nothing on web", () => {
    platform.isNative = false;
    const { container } = render(<KeepAwakeSection />);
    expect(container.firstChild).toBeNull();
  });

  it("reflects the stored opt-in state", () => {
    settingsState.keepScreenAwake = false;
    render(<KeepAwakeSection />);
    expect(screen.getByTestId("keep-screen-awake-switch")).toBeDefined();
    expect(screen.getByText("Keep screen awake")).toBeDefined();
  });

  it("persists the toggle change", () => {
    render(<KeepAwakeSection />);
    fireEvent.click(screen.getByRole("switch", { name: "Keep screen awake" }));
    expect(settingsState.updateSettings).toHaveBeenCalledWith({
      keepScreenAwake: false,
    });
  });
});
