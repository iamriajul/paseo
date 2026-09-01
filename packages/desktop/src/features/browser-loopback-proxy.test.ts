import { describe, expect, test } from "vitest";

import {
  browserLoopbackProxyBypassRules,
  parseBrowserLoopbackProxyRequestForTest,
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
