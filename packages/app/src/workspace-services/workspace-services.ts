import type { WorkspaceScriptPayload } from "@getpaseo/protocol/messages";

/**
 * The URL a service opens at inside a workspace Browser: plain `localhost:<port>`.
 * Browser localhost routing (docs/browser-localhost-routing.md) sends it to the
 * service on the workspace host on every platform, so a service tab shares one
 * origin with a hand-typed or agent-opened localhost tab.
 */
export function serviceBrowserUrl(port: number): string {
  return `http://localhost:${port}/`;
}

export function listWorkspaceServices(
  scripts: readonly WorkspaceScriptPayload[],
): WorkspaceScriptPayload[] {
  return scripts.filter((script) => script.type === "service");
}

/**
 * The service paseo.json marks `"preview": true`. The daemon sets the flag on at
 * most one service; an older daemon never sets it.
 */
export function findMainPreviewService(
  scripts: readonly WorkspaceScriptPayload[],
): WorkspaceScriptPayload | null {
  return scripts.find((script) => script.type === "service" && script.preview === true) ?? null;
}

export function isServiceOpenable(service: WorkspaceScriptPayload): boolean {
  return service.lifecycle === "running" && service.port !== null;
}

/** A service the user asked to open that has to start first. */
export interface PendingServiceOpen {
  scriptName: string;
  /** The daemon has reported it running since the start. */
  sawRunning: boolean;
}

export type PendingServiceOpenStep =
  | { kind: "open"; service: WorkspaceScriptPayload }
  | { kind: "wait"; pending: PendingServiceOpen }
  | { kind: "drop" };

/**
 * Advances a pending open against the latest script list. It opens once the
 * daemon's health probe has a verdict on the running service: `running` arrives
 * before a just-started server listens, and opening then loads a 502. An
 * unhealthy verdict still opens, so the user sees the failure. It gives up when
 * the service leaves paseo.json or exits after it started, so a crashed service
 * never opens a tab minutes later.
 */
export function stepPendingServiceOpen(
  pending: PendingServiceOpen,
  scripts: readonly WorkspaceScriptPayload[],
): PendingServiceOpenStep {
  const service = scripts.find((script) => script.scriptName === pending.scriptName);
  if (!service || service.type !== "service") {
    return { kind: "drop" };
  }
  if (isServiceOpenable(service) && service.health !== null) {
    return { kind: "open", service };
  }
  if (service.lifecycle === "running") {
    return pending.sawRunning
      ? { kind: "wait", pending }
      : { kind: "wait", pending: { ...pending, sawRunning: true } };
  }
  return pending.sawRunning ? { kind: "drop" } : { kind: "wait", pending };
}
