import { describe, expect, test } from "vitest";

import {
  browserLoopbackProxyBypassRules,
  parseBrowserLoopbackProxyRequestForTest,
  registerBrowserLoopbackProxy,
  resolveBrowserLoopbackProxyCredentials,
  getBrowserLoopbackProxyPortForTest,
  unregisterBrowserLoopbackProxy,
} from "./browser-loopback-proxy";

function parseRawRequest(raw: string) {
  const buffer = Buffer.from(raw, "latin1");
  const headerEnd = buffer.indexOf("\r\n\r\n") + 4;
  return parseBrowserLoopbackProxyRequestForTest(buffer, headerEnd);
}

describe("browser loopback proxy", () => {
  test("keeps Electron loopback traffic inside the proxy session", () => {
    expect(browserLoopbackProxyBypassRules()).toBe("<-loopback>");
  });

  test("rewrites Vite module asset requests to origin-form for the workspace tunnel", () => {
    const parsed = parseRawRequest(
      [
        "GET http://localhost:5173/src/main.tsx?t=123 HTTP/1.1",
        "Host: localhost:5173",
        "Connection: keep-alive",
        "Proxy-Authorization: Basic dXNlcjpwYXNz",
        "Proxy-Connection: keep-alive",
        "Accept: */*",
        "",
        "",
      ].join("\r\n"),
    );

    expect(parsed?.target).toEqual({
      host: "localhost",
      port: 5173,
      path: "/src/main.tsx?t=123",
      isConnect: false,
    });
    expect(parsed?.initialUpstreamBytes.toString("latin1")).toBe(
      [
        "GET /src/main.tsx?t=123 HTTP/1.1",
        "Host: localhost:5173",
        "Accept: */*",
        "Connection: close",
        "",
        "",
      ].join("\r\n"),
    );
  });

  test("preserves websocket upgrade requests for Vite HMR", () => {
    const parsed = parseRawRequest(
      [
        "GET /@vite/client HTTP/1.1",
        "Host: localhost:5173",
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Key: test-key",
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n"),
    );

    expect(parsed?.target).toEqual({
      host: "localhost",
      port: 5173,
      path: "/@vite/client",
      isConnect: false,
    });
    expect(parsed?.initialUpstreamBytes.toString("latin1")).toBe(
      [
        "GET /@vite/client HTTP/1.1",
        "Host: localhost:5173",
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Key: test-key",
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n"),
    );
  });
});

describe("workspace loopback proxy multi-tab lifecycle", () => {
  test("shares proxy and credentials across tabs of the same workspace", async () => {
    await registerBrowserLoopbackProxy({
      browserId: "tab-1",
      serverId: "server-1",
      workspaceId: "ws-alpha",
      rendererWebContentsId: 999,
      directLoopback: false,
    });

    const port = getBrowserLoopbackProxyPortForTest("tab-1");
    expect(typeof port === "number" && port > 0).toBe(true);
    const creds1 = resolveBrowserLoopbackProxyCredentials({
      browserId: "tab-1",
      isProxy: true,
      host: "127.0.0.1",
      port: port!,
    });
    expect(creds1).not.toBeNull();

    // Register tab 2 in the same workspace
    await registerBrowserLoopbackProxy({
      browserId: "tab-2",
      serverId: "server-1",
      workspaceId: "ws-alpha",
      rendererWebContentsId: 999,
      directLoopback: false,
    });

    const creds2 = resolveBrowserLoopbackProxyCredentials({
      browserId: "tab-2",
      isProxy: true,
      host: "127.0.0.1",
      port: port!,
    });
    expect(creds2).toEqual(creds1);

    // Unregister tab 1; tab 2 remains alive in the workspace
    await unregisterBrowserLoopbackProxy("tab-1");

    // Unregister tab 2; cleans up workspace proxy
    await unregisterBrowserLoopbackProxy("tab-2");

    expect(
      resolveBrowserLoopbackProxyCredentials({
        browserId: "tab-2",
        isProxy: true,
        host: "127.0.0.1",
        port: 12345,
      }),
    ).toBeNull();
  });
});
