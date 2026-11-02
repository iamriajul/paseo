/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutocompletePopover } from "@/components/ui/autocomplete-popover";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { hostRect, keyboardAnchor, measurePortalHost } = vi.hoisted(() => {
  const anchorRect = { x: 0, y: 300, width: 400, height: 40 };
  return {
    hostRect: { x: 0, y: 0, width: 1024, height: 768 },
    keyboardAnchor: {
      measureAtRest: async () => anchorRect,
      translation: {},
      reservedLift: { value: 0 },
    },
    measurePortalHost: vi.fn<(name: string) => Promise<typeof anchorRect | null>>(),
  };
});

const noOptions: never[] = [];
const ignoreSelect = () => {};
// Frames run on the timer queue, so each retry lands inside the test's wait.
const runFrame = (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0);

vi.mock("react-native", () => {
  const View = React.forwardRef<HTMLDivElement, { children?: React.ReactNode; testID?: string }>(
    function View({ children, testID }, ref) {
      return (
        <div ref={ref} data-testid={testID}>
          {children}
        </div>
      );
    },
  );
  return {
    View,
    useWindowDimensions: () => ({ width: 1024, height: 768, scale: 1, fontScale: 1 }),
  };
});

vi.mock("@gorhom/portal", () => ({
  Portal: ({ children }: { children?: React.ReactNode }) => children,
}));

vi.mock("react-native-reanimated", () => ({
  default: {
    View: ({ children, testID }: { children?: React.ReactNode; testID?: string }) => (
      <div data-testid={testID}>{children}</div>
    ),
  },
  useAnimatedReaction: () => undefined,
  useAnimatedStyle: () => ({}),
}));

vi.mock("react-native-worklets", () => ({
  scheduleOnRN: (callback: () => void) => callback(),
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock("@/styles/theme", () => ({ SPACING: [0, 4, 8, 12, 16, 24] }));

vi.mock("@/styles/unistyles-inline-style", () => ({
  inlineUnistylesStyle: <T,>(style: T) => style,
}));

vi.mock("@/components/ui/autocomplete", () => ({
  Autocomplete: ({ emptyText }: { emptyText?: string }) => <div>{emptyText}</div>,
}));

vi.mock("@/components/ui/floating-panel-portal", () => ({
  measureFloatingPanelPortalHost: measurePortalHost,
  useFloatingPanelPortalHostName: () => "test-host",
}));

vi.mock("@/keyboard/shift", () => ({
  KeyboardTranslateView: ({ children }: { children?: React.ReactNode }) => children,
  useKeyboardAnchor: () => keyboardAnchor,
  useKeyboardShift: () => ({ isMoving: { value: false } }),
}));

describe("AutocompletePopover", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", runFrame);
    vi.stubGlobal("cancelAnimationFrame", clearTimeout);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    measurePortalHost.mockReset();
    vi.unstubAllGlobals();
  });

  it("mounts once a later measurement lands, without waiting for the anchor to resize", async () => {
    // The first measurement and its next-frame retry both run before the portal host is
    // registered. Nothing else re-measures, so the popover must measure again by itself.
    measurePortalHost
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue(hostRect);

    act(() => {
      root.render(
        <AutocompletePopover
          visible
          options={noOptions}
          selectedIndex={-1}
          onSelect={ignoreSelect}
          emptyText="Choose a project to see commands"
        >
          <span>composer</span>
        </AutocompletePopover>,
      );
    });
    // The measurements and their frame retries run after the render commits.
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 100)));

    expect(container.querySelector('[data-testid="composer-autocomplete-popover"]')).not.toBeNull();
    expect(measurePortalHost.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});
