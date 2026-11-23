// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The phone build: Metro resolves `platform-image` to its base file there, which draws with
// expo-image. Vitest resolves the `.web` file, so the test points the import at the base file.
const drawn = vi.hoisted(() => [] as Array<{ source: unknown; testID?: string }>);
vi.mock("expo-image", () => ({
  Image: (props: { source: unknown; testID?: string }) => {
    drawn.push({ source: props.source, testID: props.testID });
    return null;
  },
}));
vi.mock("@/components/zoomable-viewport/platform-image", () => {
  const nativeFile = "@/components/zoomable-viewport/platform-image.tsx";
  return import(/* @vite-ignore */ nativeFile);
});

import { createFaviconTabIcon } from "./favicon-icon";

const VITE_SVG = `data:image/svg+xml;base64,${btoa("<svg xmlns='http://www.w3.org/2000/svg'/>")}`;

afterEach(() => {
  drawn.length = 0;
});

describe("the server tab's favicon on a phone", () => {
  it("draws an SVG favicon with expo-image", () => {
    const Icon = createFaviconTabIcon(VITE_SVG);
    render(<Icon size={16} color="#000" />);

    expect(drawn).toEqual([{ source: VITE_SVG, testID: "server-browser-tab-favicon-image" }]);
  });
});
