import { describe, expect, it } from "vitest";
import type { WorkspaceScriptPayload } from "@getpaseo/protocol/messages";
import {
  findMainPreviewService,
  stepPendingServiceOpen,
  type PendingServiceOpen,
} from "./workspace-services";

function service(overrides: Partial<WorkspaceScriptPayload> = {}): WorkspaceScriptPayload {
  return {
    scriptName: "web",
    type: "service",
    hostname: "web--repo.localhost",
    port: null,
    proxyUrl: null,
    lifecycle: "stopped",
    health: null,
    exitCode: null,
    terminalId: null,
    ...overrides,
  };
}

const pending: PendingServiceOpen = { scriptName: "web", sawRunning: false };

describe("findMainPreviewService", () => {
  it("returns the service the daemon marked preview", () => {
    const docs = service({ scriptName: "docs" });
    const web = service({ preview: true });
    expect(findMainPreviewService([docs, web])).toBe(web);
  });

  it("returns null when the daemon marked none, as an older daemon never does", () => {
    expect(findMainPreviewService([service()])).toBeNull();
  });

  it("ignores a plain script even if it carries the flag", () => {
    expect(findMainPreviewService([service({ type: "script", preview: true })])).toBeNull();
  });
});

describe("stepPendingServiceOpen", () => {
  it("waits while the service has not started yet", () => {
    expect(stepPendingServiceOpen(pending, [service()])).toEqual({ kind: "wait", pending });
  });

  it("waits for a port once running, remembering that it ran", () => {
    expect(stepPendingServiceOpen(pending, [service({ lifecycle: "running" })])).toEqual({
      kind: "wait",
      pending: { scriptName: "web", sawRunning: true },
    });
  });

  it("waits while the health probe has no verdict, since the server may not listen yet", () => {
    expect(
      stepPendingServiceOpen(pending, [service({ lifecycle: "running", port: 3000 })]),
    ).toEqual({ kind: "wait", pending: { scriptName: "web", sawRunning: true } });
  });

  it("opens once the health probe reports on the running service", () => {
    const healthy = service({ lifecycle: "running", port: 3000, health: "healthy" });
    expect(stepPendingServiceOpen(pending, [healthy])).toEqual({ kind: "open", service: healthy });
    const unhealthy = service({ lifecycle: "running", port: 3000, health: "unhealthy" });
    expect(stepPendingServiceOpen(pending, [unhealthy])).toEqual({
      kind: "open",
      service: unhealthy,
    });
  });

  it("drops the open when the service exits after it started", () => {
    expect(
      stepPendingServiceOpen({ scriptName: "web", sawRunning: true }, [service({ exitCode: 1 })]),
    ).toEqual({ kind: "drop" });
  });

  it("drops the open when the service leaves paseo.json", () => {
    expect(stepPendingServiceOpen(pending, [])).toEqual({ kind: "drop" });
  });
});
