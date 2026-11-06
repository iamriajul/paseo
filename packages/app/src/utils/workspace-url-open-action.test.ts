import { describe, expect, test } from "vitest";

import {
  openWorkspaceLoopbackUrl,
  resolveWorkspaceUrlOpenAction,
} from "./workspace-url-open-action";

const TEMPLATE = "https://{{port}}--main--coder--iamriajul.coder.riajul.dev";

describe("workspace URL open action", () => {
  test("opens localhost URLs in workspace Browser on Electron", () => {
    expect(
      resolveWorkspaceUrlOpenAction({
        url: "http://localhost:5173",
        hasWorkspaceBrowser: true,
        vscodeProxyUri: TEMPLATE,
      }),
    ).toEqual({ kind: "browser", url: "http://localhost:5173" });
  });

  test("opens localhost URLs in the Android workspace Browser when available", () => {
    expect(
      resolveWorkspaceUrlOpenAction({
        url: "http://127.0.0.1:3000",
        hasWorkspaceBrowser: true,
        vscodeProxyUri: TEMPLATE,
      }),
    ).toEqual({ kind: "browser", url: "http://127.0.0.1:3000" });
  });

  test("rewrites localhost URLs through VSCODE_PROXY_URI when Browser is unavailable", () => {
    expect(
      resolveWorkspaceUrlOpenAction({
        url: "http://localhost:5173/src/main.tsx?cache=1#module",
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
        hasWorkspaceBrowser: true,
        vscodeProxyUri: TEMPLATE,
      }),
    ).toEqual({ kind: "external", url: "https://example.com/docs" });
  });

  test("falls back to original localhost URL without a valid proxy template", () => {
    expect(
      resolveWorkspaceUrlOpenAction({
        url: "http://localhost:5173",
        hasWorkspaceBrowser: false,
      }),
    ).toEqual({ kind: "external", url: "http://localhost:5173" });
  });

  test("opens a loopback link in the workspace Browser", () => {
    const opened: string[] = [];
    const external: string[] = [];
    const handled = openWorkspaceLoopbackUrl({
      url: "http://localhost:3000/",
      hasWorkspaceBrowser: true,
      openInBrowserTab: (url) => (opened.push(url), true),
      openExternal: (url) => external.push(url),
    });
    expect(handled).toBe(true);
    expect(opened).toEqual(["http://localhost:3000/"]);
    expect(external).toEqual([]);
  });

  test("falls back to the proxy-rewritten URL when the Browser tab refuses", () => {
    const external: string[] = [];
    const handled = openWorkspaceLoopbackUrl({
      url: "http://localhost:5173/",
      hasWorkspaceBrowser: true,
      vscodeProxyUri: TEMPLATE,
      openInBrowserTab: () => false,
      openExternal: (url) => external.push(url),
    });
    expect(handled).toBe(true);
    expect(external).toEqual(["https://5173--main--coder--iamriajul.coder.riajul.dev/"]);
  });

  test("leaves non-loopback links to the caller", () => {
    const handled = openWorkspaceLoopbackUrl({
      url: "https://example.com/",
      hasWorkspaceBrowser: true,
      openInBrowserTab: () => true,
      openExternal: () => undefined,
    });
    expect(handled).toBe(false);
  });
});
