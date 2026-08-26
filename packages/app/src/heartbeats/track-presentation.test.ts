import { describe, expect, it } from "vitest";
import type { HeartbeatRow } from "./select";
import { buildHeartbeatPillPresentation, isActiveHeartbeat } from "./track-presentation";

const t = ((key: string, options?: { count?: number }) => {
  if (key === "heartbeats.headerCount") {
    return `Heartbeats (${options?.count ?? 0})`;
  }
  return key;
}) as never;

function paseo(status: "active" | "paused"): HeartbeatRow {
  return {
    kind: "paseo",
    id: `hb-${status}`,
    name: "nightly",
    prompt: "check",
    status,
    cadenceLabel: "every 30m",
    nextRunAt: null,
    serverId: "server-1",
  };
}

describe("heartbeat pill presentation", () => {
  it("marks the pill running when any heartbeat is active", () => {
    const pill = buildHeartbeatPillPresentation(t, [paseo("active"), paseo("paused")]);
    expect(pill.segments).toEqual([{ bucket: "running", text: "Heartbeats (2)" }]);
    expect(isActiveHeartbeat(paseo("paused"))).toBe(false);
  });

  it("draws no running mark when every heartbeat is paused", () => {
    const pill = buildHeartbeatPillPresentation(t, [paseo("paused")]);
    expect(pill.segments).toEqual([{ bucket: null, text: "Heartbeats (1)" }]);
  });
});
