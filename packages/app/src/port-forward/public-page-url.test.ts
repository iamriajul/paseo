import { describe, expect, it } from "vitest";
import type { WorkspaceScriptPayload } from "@getpaseo/protocol/messages";
import { resolvePublicPageUrl } from "./public-page-url";

function service(input: Partial<WorkspaceScriptPayload>): WorkspaceScriptPayload {
  return {
    scriptName: "web",
    type: "service",
    hostname: "web--app.localhost",
    port: 5173,
    localProxyUrl: "http://web--app.localhost:6767",
    publicProxyUrl: null,
    proxyUrl: null,
    lifecycle: "running",
    health: "healthy",
    exitCode: null,
    terminalId: null,
    ...input,
  };
}

describe("resolvePublicPageUrl", () => {
  it("opens a page that is not on loopback as it is", () => {
    expect(
      resolvePublicPageUrl({ url: "https://example.com/a", previewTemplate: null, scripts: [] }),
    ).toEqual({ kind: "direct", url: "https://example.com/a" });
  });

  it("prefers the host's preview template, which serves every port, keeping the path", () => {
    expect(
      resolvePublicPageUrl({
        url: "http://localhost:5173/app?x=1#top",
        previewTemplate: "https://{port}.preview.example.com",
        scripts: [service({ publicProxyUrl: "https://web--app.apps.example.com" })],
      }),
    ).toEqual({ kind: "preview", url: "https://5173.preview.example.com/app?x=1#top" });
  });

  it("falls back to the public alias of the service on that port", () => {
    expect(
      resolvePublicPageUrl({
        url: "http://127.0.0.1:5173/app",
        previewTemplate: null,
        scripts: [service({ publicProxyUrl: "https://web--app.apps.example.com" })],
      }),
    ).toEqual({
      kind: "service",
      url: "https://web--app.apps.example.com/app",
      serviceName: "web",
    });
  });

  it("says which port has no public URL when the host serves none", () => {
    expect(
      resolvePublicPageUrl({
        url: "http://localhost:8080/",
        previewTemplate: null,
        scripts: [service({ publicProxyUrl: "https://web--app.apps.example.com" })],
      }),
    ).toEqual({ kind: "none", port: 8080 });
    expect(
      resolvePublicPageUrl({
        url: "http://localhost:5173/",
        previewTemplate: null,
        scripts: [service({ lifecycle: "stopped", publicProxyUrl: "https://x.example.com" })],
      }),
    ).toEqual({ kind: "none", port: 5173 });
  });

  it("offers nothing for a page that is not http", () => {
    expect(
      resolvePublicPageUrl({ url: "about:blank", previewTemplate: null, scripts: [] }),
    ).toBeNull();
  });
});
