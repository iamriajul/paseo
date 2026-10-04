import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n as testI18n } from "@/i18n/i18next";
import { DictationOverlay } from "./dictation-controls";

void testI18n;
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
        isRecording={false}
        isProcessing={false}
        status="idle"
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

describe("DictationOverlay polish visibility", () => {
  it("stays mounted with a polishing label while the request is in flight", () => {
    const view = mountOverlay({
      onPolish: vi.fn(),
      polishAvailable: true,
      isPolishing: true,
    });
    expect(view.getByText("Polishing transcription…")).toBeTruthy();
  });

  it("stays mounted and shows the error when polish fails", () => {
    const view = mountOverlay({
      isRecording: true,
      status: "recording",
      onPolish: vi.fn(),
      polishAvailable: true,
      isPolishing: false,
      polishError: "Couldn't polish this transcription",
    });
    expect(view.getByTestId("dictation-polish")).toBeTruthy();
    expect(view.getByText("Couldn't polish this transcription")).toBeTruthy();
  });

  it("unmounts when idle with no polish activity", () => {
    const idleContainer = document.createElement("div");
    document.body.appendChild(idleContainer);
    const idleRoot = createRoot(idleContainer);
    act(() =>
      idleRoot.render(
        <DictationOverlay
          volume={0}
          duration={0}
          isRecording={false}
          isProcessing={false}
          status="idle"
          onCancel={vi.fn()}
          onAccept={vi.fn()}
          onAcceptAndSend={vi.fn()}
          onPolish={vi.fn()}
          polishAvailable
        />,
      ),
    );
    mounted.push({ root: idleRoot, container: idleContainer });
    expect(idleContainer.textContent ?? "").toBe("");
  });
});
