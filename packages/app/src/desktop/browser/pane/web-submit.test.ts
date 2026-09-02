import { describe, expect, it } from "vitest";
import { resolveWebBrowserSrc } from "./web-preview-url";
import { decideSubmit } from "./web-submit";

const TEMPLATE = "https://{port}.preview.example.com";

// Built through the real resolver rather than written out, so the test cannot
// drift from what the pane actually puts in the iframe's src.
function srcFor(url: string): string {
  const resolved = resolveWebBrowserSrc({ url, template: TEMPLATE });
  if (resolved.kind === "no-template") {
    throw new Error(`expected a src for ${url}`);
  }
  return resolved.src;
}

describe("decideSubmit", () => {
  it("reloads when the submitted URL resolves to the src already showing", () => {
    // Pressing Enter on an unedited field.
    expect(
      decideSubmit({
        raw: "http://localhost:3000/",
        template: TEMPLATE,
        currentSrc: srcFor("http://localhost:3000/"),
      }),
    ).toEqual({ kind: "reload" });
  });

  it("reloads on a spelling that differs from the frame's URL but shares its src", () => {
    // The case a string comparison misses: `localhost:3000` normalises to
    // `http://localhost:3000`, which is not the record's `http://localhost:3000/`,
    // yet both resolve to the same preview src. Calling this a navigation clears
    // `bridgeReady` with no document load to restore it.
    const currentSrc = srcFor("http://localhost:3000/");
    expect(decideSubmit({ raw: "localhost:3000", template: TEMPLATE, currentSrc })).toEqual({
      kind: "reload",
    });
  });

  it("navigates to the normalised URL when the src changes", () => {
    expect(
      decideSubmit({
        raw: "localhost:3000/about",
        template: TEMPLATE,
        currentSrc: srcFor("http://localhost:3000/"),
      }),
    ).toEqual({ kind: "navigate", url: "http://localhost:3000/about" });
  });

  it("navigates when leaving the preview origin for a direct URL", () => {
    expect(
      decideSubmit({
        raw: "example.com",
        template: TEMPLATE,
        currentSrc: srcFor("http://localhost:3000/"),
      }),
    ).toEqual({ kind: "navigate", url: "https://example.com" });
  });

  it("navigates rather than reloading when no template resolves a src", () => {
    // Both sides are null here. A bare equality check would call that a match and
    // swallow the submit as a reload.
    expect(decideSubmit({ raw: "localhost:3000", template: null, currentSrc: null })).toEqual({
      kind: "navigate",
      url: "http://localhost:3000",
    });
  });
});
