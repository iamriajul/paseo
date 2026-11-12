import { connect, type Socket } from "node:net";
import { describe, expect, test } from "vitest";

import {
  browserLoopbackProxyBypassRules,
  buildProxyFailureResponse,
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

describe("loopback proxy failure responses", () => {
  test("a failed page load gets a readable, self-retrying error page", () => {
    const parsed = parseRawRequest(
      [
        "GET http://localhost:3000/ HTTP/1.1",
        "Host: localhost:3000",
        "Sec-Fetch-Dest: document",
        "Accept: text/html",
        "",
        "",
      ].join("\r\n"),
    );
    expect(parsed?.wantsDocument).toBe(true);
    const response = buildProxyFailureResponse({
      parsed: parsed!,
      reason: "Workspace host is not connected.",
    });
    const [head, body] = response.split("\r\n\r\n");
    expect(head).toContain("HTTP/1.1 502 Bad Gateway");
    expect(head).toContain(`Content-Length: ${Buffer.byteLength(body!, "utf8")}`);
    expect(body).toContain("Can't reach localhost:3000");
    expect(body).toContain("Workspace host is not connected.");
    expect(body).toContain("location.reload()");
  });

  test("subresource and WebSocket failures stay empty so pages see a plain error", () => {
    const fetchRequest = parseRawRequest(
      ["GET /api HTTP/1.1", "Host: localhost:3000", "Sec-Fetch-Dest: empty", "", ""].join("\r\n"),
    );
    expect(fetchRequest?.wantsDocument).toBe(false);
    expect(buildProxyFailureResponse({ parsed: fetchRequest!, reason: "<refused>" })).not.toContain(
      "<refused>",
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

  test("answers the proxy challenge for a guest that has not registered yet", async () => {
    await registerBrowserLoopbackProxy({
      browserId: "tab-early",
      serverId: "server-remote",
      workspaceId: "ws-early",
      rendererWebContentsId: 999,
      directLoopback: false,
    });
    const port = getBrowserLoopbackProxyPortForTest("tab-early")!;

    // The guest's first request reaches the proxy before register-attached maps
    // its webContents to a browserId. Its session still identifies it.
    const credentials = resolveBrowserLoopbackProxyCredentials({
      browserId: null,
      guestUsesPartition: (partition) => partition === "persist:paseo-browser-workspace-ws-early",
      isProxy: true,
      host: "127.0.0.1",
      port,
    });
    expect(credentials).not.toBeNull();
    expect(
      resolveBrowserLoopbackProxyCredentials({
        browserId: null,
        guestUsesPartition: (partition) => partition === "persist:paseo-browser-workspace-other",
        isProxy: true,
        host: "127.0.0.1",
        port,
      }),
    ).toBeNull();

    await unregisterBrowserLoopbackProxy("tab-early");
  });

  test("closing a workspace's last tab closes the proxy while the guest holds connections open", async () => {
    await registerBrowserLoopbackProxy({
      browserId: "tab-open-sockets",
      serverId: "server-remote",
      workspaceId: "ws-open-sockets",
      rendererWebContentsId: 999,
      directLoopback: false,
    });
    const proxyPort = getBrowserLoopbackProxyPortForTest("tab-open-sockets")!;
    const connectToProxy = () =>
      new Promise<Socket>((resolve, reject) => {
        const socket = connect(proxyPort, "127.0.0.1", () => resolve(socket));
        socket.once("error", reject);
      });
    // Chromium keeps pooled sockets to the proxy open after the guest is gone: an idle
    // keep-alive socket, and one that has sent part of a request.
    const idle = await connectToProxy();
    const partial = await connectToProxy();
    partial.write("GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n");
    const closed = (socket: Socket) =>
      new Promise<void>((resolve) => {
        if (socket.destroyed) resolve();
        else socket.once("close", () => resolve());
      });

    const unregistered = await Promise.race([
      unregisterBrowserLoopbackProxy("tab-open-sockets").then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("still open"), 2_000)),
    ]);

    expect(unregistered).toBe("closed");
    await Promise.all([closed(idle), closed(partial)]);
  });
});
