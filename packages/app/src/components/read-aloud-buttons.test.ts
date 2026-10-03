import { describe, expect, it } from "vitest";
import { shouldShowReadAloudControls } from "./read-aloud-buttons";

describe("shouldShowReadAloudControls", () => {
  it("shows controls on hover even when idle", () => {
    expect(
      shouldShowReadAloudControls({
        visible: true,
        isActive: false,
        isRewriting: false,
        hasError: false,
      }),
    ).toBe(true);
  });

  it("hides idle controls without hover", () => {
    expect(
      shouldShowReadAloudControls({
        visible: false,
        isActive: false,
        isRewriting: false,
        hasError: false,
      }),
    ).toBe(false);
  });

  it("keeps controls mounted while speaking", () => {
    expect(
      shouldShowReadAloudControls({
        visible: false,
        isActive: true,
        isRewriting: false,
        hasError: false,
      }),
    ).toBe(true);
  });

  it("keeps controls mounted while rewriting or on error", () => {
    expect(
      shouldShowReadAloudControls({
        visible: false,
        isActive: false,
        isRewriting: true,
        hasError: false,
      }),
    ).toBe(true);
    expect(
      shouldShowReadAloudControls({
        visible: false,
        isActive: false,
        isRewriting: false,
        hasError: true,
      }),
    ).toBe(true);
  });
});
