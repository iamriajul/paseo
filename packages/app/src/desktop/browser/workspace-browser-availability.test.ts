import { describe, expect, it } from "vitest";
import { resolveWorkspaceBrowserAvailability } from "./workspace-browser-availability";

describe("resolveWorkspaceBrowserAvailability", () => {
  it("keeps Electron Browser available independently of the Android capability gate", () => {
    expect(
      resolveWorkspaceBrowserAvailability({
        isElectron: true,
        isAndroid: false,
        isWeb: true,
        hasTcpTunnel: false,
        hasBrowserPreviewTemplate: false,
      }),
    ).toBe(true);
  });

  it("requires tcpTunnel on Android", () => {
    expect(
      resolveWorkspaceBrowserAvailability({
        isElectron: false,
        isAndroid: true,
        isWeb: false,
        hasTcpTunnel: true,
        hasBrowserPreviewTemplate: false,
      }),
    ).toBe(true);
    expect(
      resolveWorkspaceBrowserAvailability({
        isElectron: false,
        isAndroid: true,
        isWeb: false,
        hasTcpTunnel: false,
        hasBrowserPreviewTemplate: false,
      }),
    ).toBe(false);
  });

  it("does not expose the Browser on iOS regardless of tunnel or template state", () => {
    expect(
      resolveWorkspaceBrowserAvailability({
        isElectron: false,
        isAndroid: false,
        isWeb: false,
        hasTcpTunnel: true,
        hasBrowserPreviewTemplate: true,
      }),
    ).toBe(false);
  });

  it("is available on web when the host advertises a preview template", () => {
    expect(
      resolveWorkspaceBrowserAvailability({
        isElectron: false,
        isAndroid: false,
        isWeb: true,
        hasTcpTunnel: false,
        hasBrowserPreviewTemplate: true,
      }),
    ).toBe(true);
  });

  it("is unavailable on web when the host advertises no template", () => {
    expect(
      resolveWorkspaceBrowserAvailability({
        isElectron: false,
        isAndroid: false,
        isWeb: true,
        hasTcpTunnel: false,
        hasBrowserPreviewTemplate: false,
      }),
    ).toBe(false);
  });

  it("stays available on Electron even with no template, since Electron reports web", () => {
    expect(
      resolveWorkspaceBrowserAvailability({
        isElectron: true,
        isAndroid: false,
        isWeb: true,
        hasTcpTunnel: false,
        hasBrowserPreviewTemplate: false,
      }),
    ).toBe(true);
  });
});
