import { describe, expect, test } from "vitest";
import {
  forgetObservedLoopbackPorts,
  listObservedLoopbackPorts,
  loopbackPortFromUrl,
  observeBrowserLoopbackTraffic,
} from "./browser-loopback-traffic";

describe("browser loopback traffic", () => {
  test("collects the loopback ports a tab's page talks to", () => {
    let listener: ((details: { url: string; webContentsId?: number }) => void) | null = null;
    const session = {
      webRequest: {
        onSendHeaders: (_filter: { urls: string[] }, next: typeof listener) => {
          listener = next;
        },
      },
    };
    observeBrowserLoopbackTraffic({
      session,
      resolveBrowserId: (id) => (id === 7 ? "tab-a" : null),
    });
    for (const url of [
      "http://localhost:3000/",
      "http://localhost:3000/assets/app.js",
      "http://127.0.0.1:8080/api/me",
      "ws://localhost:24678/",
      "https://fonts.example.com/inter.css",
    ]) {
      listener!({ url, webContentsId: 7 });
    }
    listener!({ url: "http://localhost:9999/", webContentsId: 8 });

    expect(listObservedLoopbackPorts("tab-a")).toEqual([3000, 8080, 24678]);
    forgetObservedLoopbackPorts("tab-a");
    expect(listObservedLoopbackPorts("tab-a")).toEqual([]);
  });

  test("parses default ports and IPv6 loopback", () => {
    expect(loopbackPortFromUrl("http://localhost/")).toBe(80);
    expect(loopbackPortFromUrl("wss://app.localhost/")).toBe(443);
    expect(loopbackPortFromUrl("http://[::1]:5173/")).toBe(5173);
    expect(loopbackPortFromUrl("http://10.0.0.5:3000/")).toBeNull();
  });
});
