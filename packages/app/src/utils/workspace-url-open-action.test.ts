import { describe, expect, test } from "vitest";

import { resolveWorkspaceUrlOpenAction } from "./workspace-url-open-action";

const TEMPLATE = "https://{{port}}--main--coder--iamriajul.coder.riajul.dev";

describe("workspace URL open action", () => {
  test("opens localhost URLs in workspace Browser on Electron", () => {
    expect(
      resolveWorkspaceUrlOpenAction({
        url: "http://localhost:5173",
        isElectron: true,
        hasWorkspaceBrowser: true,
        vscodeProxyUri: TEMPLATE,
      }),
    ).toEqual({ kind: "browser", url: "http://localhost:5173" });
  });

  test("rewrites localhost URLs through VSCODE_PROXY_URI outside Electron", () => {
    expect(
      resolveWorkspaceUrlOpenAction({
        url: "http://localhost:5173/src/main.tsx?cache=1#module",
        isElectron: false,
        hasWorkspaceBrowser: false,
        vscodeProxyUri: TEMPLATE,
      }),
    ).toEqual({
      kind: "external",
      url: "https://5173--main--coder--iamriajul.coder.riajul.dev/src/main.tsx?cache=1#module",
    });
  });

  test("keeps normal external URLs unchanged", () => {
    expect(
      resolveWorkspaceUrlOpenAction({
        url: "https://example.com/docs",
        isElectron: true,
        hasWorkspaceBrowser: true,
        vscodeProxyUri: TEMPLATE,
      }),
    ).toEqual({ kind: "external", url: "https://example.com/docs" });
  });

  test("falls back to original localhost URL without a valid proxy template", () => {
    expect(
      resolveWorkspaceUrlOpenAction({
        url: "http://localhost:5173",
        isElectron: false,
        hasWorkspaceBrowser: false,
      }),
    ).toEqual({ kind: "external", url: "http://localhost:5173" });
  });
});
