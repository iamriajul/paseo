import { describe, expect, it } from "vitest";
import type { HeartbeatRow } from "./select";
import { buildHeartbeatPillPresentation, isActiveHeartbeat } from "./track-presentation";

const t = ((key: string, options?: Record<string, string | number>) => {
  switch (key) {
    case "heartbeats.pillPaused":
      return `${options?.count ?? 0} paused`;
    case "heartbeats.pillNextRunAccessible":
      return `${options?.count ?? 0} heartbeats, next ${options?.when ?? ""}`;
    case "heartbeats.pillPausedAccessible":
      return `${options?.count ?? 0} heartbeats, paused`;
    default:
      return key;
  }
}) as never;

function paseo(status: "active" | "paused", nextRunAt: string | null = null): HeartbeatRow {
  return {
    kind: "paseo",
    id: `hb-${status}`,
    name: "nightly",
    prompt: "check",
    status,
    cadenceLabel: "every 30m",
    nextRunAt,
    serverId: "server-1",
  };
}

function provider(nextHint: string | null): HeartbeatRow {
  return {
    kind: "provider",
    id: "hb-provider",
    parentAgentId: "agent-1",
    provider: "claude",
    prompt: "check",
    mode: "recurring",
    scheduleLabel: "every 30m",
    nextHint,
  };
}

describe("heartbeat pill presentation", () => {
  it("shows the soonest next run as a short relative time", () => {
    const soon = new Date(Date.now() + 3 * 60_000).toISOString();
    const later = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const pill = buildHeartbeatPillPresentation(t, [paseo("active", later), paseo("active", soon)]);
    expect(pill.segments).toEqual([{ bucket: null, text: "in 3m" }]);
    expect(pill.accessibilityLabel).toBe("2 heartbeats, next in 3m");
  });

  it("falls back to a paused count when no next run is known", () => {
    const pill = buildHeartbeatPillPresentation(t, [paseo("paused"), provider(null)]);
    expect(pill.segments).toEqual([{ bucket: null, text: "2 paused" }]);
    expect(pill.accessibilityLabel).toBe("2 heartbeats, paused");
  });

  it("ignores next runs of paused heartbeats", () => {
    const soon = new Date(Date.now() + 3 * 60_000).toISOString();
    const pill = buildHeartbeatPillPresentation(t, [paseo("paused", soon)]);
    expect(pill.segments).toEqual([{ bucket: null, text: "1 paused" }]);
  });

  it("never draws a running mark", () => {
    const soon = new Date(Date.now() + 60_000).toISOString();
    const pill = buildHeartbeatPillPresentation(t, [paseo("active", soon)]);
    expect(pill.segments[0].bucket).toBeNull();
    expect(isActiveHeartbeat(paseo("active"))).toBe(true);
  });
});
