import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n as testI18n } from "@/i18n/i18next";
import { DictationOverlay } from "./dictation-controls";

// Load translations so controls expose their real accessible names.
void testI18n;

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

interface Mounted {
  root: Root;
  container: HTMLDivElement;
}

const mounted: Mounted[] = [];

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

function mountOverlay(props: Partial<React.ComponentProps<typeof DictationOverlay>> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <DictationOverlay
        volume={0.2}
        duration={3}
        isRecording
        isProcessing={false}
        status="recording"
        onCancel={vi.fn()}
        onAccept={vi.fn()}
        onAcceptAndSend={vi.fn()}
        {...props}
      />,
    ),
  );
  mounted.push({ root, container });
  return within(container);
}

describe("DictationOverlay AI polish", () => {
  it("renders the sparkle polish button when available", () => {
    const view = mountOverlay({ onPolish: vi.fn(), polishAvailable: true });
    expect(view.getByTestId("dictation-polish")).toBeTruthy();
    expect(view.getByRole("button", { name: "Polish transcription with AI" })).toBeTruthy();
  });

  it("hides the polish button when the endpoint is not configured", () => {
    const view = mountOverlay({ onPolish: vi.fn(), polishAvailable: false });
    expect(view.queryByTestId("dictation-polish")).toBeNull();
  });

  it("fires the polish handler on tap", () => {
    const onPolish = vi.fn();
    const view = mountOverlay({ onPolish, polishAvailable: true });
    act(() => view.getByTestId("dictation-polish").click());
    expect(onPolish).toHaveBeenCalledTimes(1);
  });

  it("shows the polish error inline", () => {
    const view = mountOverlay({
      onPolish: vi.fn(),
      polishAvailable: true,
      polishError: "Couldn't polish this transcription",
    });
    expect(view.getByText("Couldn't polish this transcription")).toBeTruthy();
  });
});
