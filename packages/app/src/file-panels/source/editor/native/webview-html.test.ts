import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseNativeEditorEvent } from "./bridge";
import { sourceEditorWebViewHtml } from "./webview-html";

const BUILD_SCRIPT = fileURLToPath(
  new URL("../../../../../scripts/build-source-editor-webview-html.mjs", import.meta.url),
);

describe("native source editor page", () => {
  it("is built from the current editor sources", () => {
    expect(() =>
      execFileSync(process.execPath, [BUILD_SCRIPT, "--check"], { stdio: "pipe" }),
    ).not.toThrow();
  }, 60_000);

  it("loads nothing from the network", () => {
    const policy = /Content-Security-Policy" content="([^"]+)"/.exec(sourceEditorWebViewHtml)?.[1];
    expect(policy?.split("; ")).toEqual(
      expect.arrayContaining(["default-src 'none'", "script-src 'unsafe-inline'"]),
    );
    expect(policy).not.toMatch(/connect-src|https?:/);
  });
});

describe("native source editor bridge", () => {
  it("accepts a change with its revision and drops malformed messages", () => {
    expect(
      parseNativeEditorEvent(
        JSON.stringify({
          type: "change",
          editorKey: "k",
          revision: 2,
          changes: [{ from: 0, to: 1, insert: "x" }],
        }),
      ),
    ).toEqual({
      type: "change",
      editorKey: "k",
      revision: 2,
      changes: [{ from: 0, to: 1, insert: "x" }],
    });
    expect(parseNativeEditorEvent("not json")).toBeNull();
    expect(
      parseNativeEditorEvent(JSON.stringify({ type: "change", editorKey: "k", changes: [] })),
    ).toBeNull();
    expect(
      parseNativeEditorEvent(
        JSON.stringify({
          type: "change",
          editorKey: "k",
          revision: 0,
          changes: [{ from: -1, to: 0, insert: "" }],
        }),
      ),
    ).toBeNull();
    expect(
      parseNativeEditorEvent(JSON.stringify({ type: "cursor", editorKey: "k", line: 0 })),
    ).toBeNull();
  });
});
