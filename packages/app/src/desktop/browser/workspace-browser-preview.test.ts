import { afterEach, describe, expect, it } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useSessionStore } from "@/stores/session-store";
import { buildBrowserPreviewUrl, selectBrowserPreviewTemplate } from "./workspace-browser-preview";

const stateWith = (template: string | null) => ({
  sessions: {
    "srv-a": {
      serverInfo: template
        ? ({ browserPreview: { urlTemplate: template } } as never)
        : ({} as never),
    },
  },
});

describe("selectBrowserPreviewTemplate", () => {
  it("returns the template advertised by that host", () => {
    expect(
      selectBrowserPreviewTemplate(stateWith("https://{port}.preview.example.com"), "srv-a"),
    ).toBe("https://{port}.preview.example.com");
  });

  it("returns null when the host advertises none", () => {
    expect(selectBrowserPreviewTemplate(stateWith(null), "srv-a")).toBeNull();
  });

  it("returns null for an unknown server id", () => {
    expect(selectBrowserPreviewTemplate(stateWith("https://{port}.x.com"), "srv-b")).toBeNull();
  });
});

describe("selectBrowserPreviewTemplate against the real session store", () => {
  const serverId = "preview-test-server";

  afterEach(() => {
    useSessionStore.getState().clearSession(serverId);
  });

  it("reads the template the way production actually produces it: through initializeSession + updateSessionServerInfo, not a hand-built state object", () => {
    useSessionStore.getState().initializeSession(serverId, null as unknown as DaemonClient);
    useSessionStore.getState().updateSessionServerInfo(serverId, {
      serverId,
      hostname: null,
      version: "1.0.0",
      browserPreview: { urlTemplate: "https://{port}--daemon-1.example.com" },
    });

    expect(selectBrowserPreviewTemplate(useSessionStore.getState(), serverId)).toBe(
      "https://{port}--daemon-1.example.com",
    );
  });

  it("returns null once the real store holds a session whose serverInfo has no browserPreview", () => {
    useSessionStore.getState().initializeSession(serverId, null as unknown as DaemonClient);
    useSessionStore.getState().updateSessionServerInfo(serverId, {
      serverId,
      hostname: null,
      version: "1.0.0",
    });

    expect(selectBrowserPreviewTemplate(useSessionStore.getState(), serverId)).toBeNull();
  });
});

describe("buildBrowserPreviewUrl", () => {
  it("substitutes the port", () => {
    expect(buildBrowserPreviewUrl("https://{port}--daemon-1.studio.example.com", 3000)).toBe(
      "https://3000--daemon-1.studio.example.com",
    );
  });
});
