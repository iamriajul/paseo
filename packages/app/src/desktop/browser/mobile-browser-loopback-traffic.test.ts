import { describe, expect, it } from "vitest";
import {
  listMobileBrowserLoopbackPorts,
  pagePortOfRequest,
  recordMobileBrowserLoopbackRequest,
} from "./mobile-browser-loopback-traffic";

function head(headers: Record<string, string>): string {
  const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
  return ["GET /api HTTP/1.1", "Host: localhost:8080", ...lines, "", ""].join("\r\n");
}

describe("Android Browser loopback traffic", () => {
  it("files a request under the page that sent it, from Origin or else Referer", () => {
    expect(pagePortOfRequest(head({ Origin: "http://localhost:5173" }))).toBe(5173);
    expect(pagePortOfRequest(head({ Referer: "http://127.0.0.1:3000/app?x=1" }))).toBe(3000);
    expect(
      pagePortOfRequest(head({ Origin: "null", Referer: "http://[::1]:4000/frame.html" })),
    ).toBe(4000);
    expect(pagePortOfRequest(head({ Referer: "http://localhost/" }))).toBe(80);
    expect(pagePortOfRequest(head({ Referer: "https://example.com/" }))).toBeNull();
    expect(pagePortOfRequest(head({}))).toBeNull();
  });

  it("lists every port a page's traffic reached, through its frames, per host", () => {
    const record = (serverId: string, port: number, page: string) =>
      recordMobileBrowserLoopbackRequest({ serverId, port, requestHead: head({ Referer: page }) });
    record("host-a", 8080, "http://localhost:5173/");
    record("host-a", 24678, "http://localhost:5173/");
    record("host-a", 5173, "http://localhost:5173/");
    record("host-a", 3000, "http://localhost:5173/");
    record("host-a", 9229, "http://localhost:3000/embed");
    record("host-a", 5173, "http://localhost:3000/embed");
    record("host-a", 6000, "http://localhost:7000/");
    record("host-b", 1111, "http://localhost:5173/");

    expect(listMobileBrowserLoopbackPorts("host-a", 5173)).toEqual([3000, 8080, 9229, 24678]);
    expect(listMobileBrowserLoopbackPorts("host-a", 3000)).toEqual([5173, 8080, 9229, 24678]);
    expect(listMobileBrowserLoopbackPorts("host-b", 5173)).toEqual([1111]);
    expect(listMobileBrowserLoopbackPorts("host-c", 5173)).toEqual([]);
  });
});
