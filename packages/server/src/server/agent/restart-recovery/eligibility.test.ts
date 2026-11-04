import { describe, expect, it } from "vitest";

import type { StoredAgentRecord } from "../agent-storage.js";
import { CLAUDE_PROMPT_CACHE_TTL_FEATURE_ID } from "../providers/claude/feature-definitions.js";
import { isRestartResumeEligible } from "./eligibility.js";

function storedRecord(overrides: Partial<StoredAgentRecord> = {}): StoredAgentRecord {
  return {
    id: "agent-1",
    provider: "claude",
    cwd: "/workspace",
    workspaceId: undefined,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastUserMessageAt: null,
    title: null,
    labels: {},
    lastStatus: "running",
    lastModeId: null,
    config: null,
    persistence: { provider: "claude", sessionId: "session-1" },
    archivedAt: null,
    ...overrides,
  } as StoredAgentRecord;
}

// A Claude agent whose last response came back at 00:00 on a five-minute prompt cache.
function claudeAgentWithFiveMinuteCache(): StoredAgentRecord {
  return storedRecord({
    lastResponseAt: "2026-01-01T00:00:00.000Z",
    config: {
      provider: "claude",
      cwd: "/workspace",
      model: "claude-opus-5-5",
      featureValues: { [CLAUDE_PROMPT_CACHE_TTL_FEATURE_ID]: "5m" },
    } as unknown as StoredAgentRecord["config"],
  });
}

describe("isRestartResumeEligible", () => {
  it("does not resume a live agent that is running a cache warm-up ping", () => {
    const record = storedRecord();
    const nowMs = Date.parse("2026-01-01T00:01:00.000Z");

    expect(
      isRestartResumeEligible({ record, liveWarmPing: true, workspaceArchived: false, nowMs }),
    ).toBe(false);
    expect(
      isRestartResumeEligible({ record, liveWarmPing: false, workspaceArchived: false, nowMs }),
    ).toBe(true);
  });

  it("does not resume an agent whose five-minute prompt cache has expired", () => {
    const record = claudeAgentWithFiveMinuteCache();

    expect(
      isRestartResumeEligible({
        record,
        liveWarmPing: false,
        workspaceArchived: false,
        nowMs: Date.parse("2026-01-01T00:01:00.000Z"),
      }),
    ).toBe(true);
    expect(
      isRestartResumeEligible({
        record,
        liveWarmPing: false,
        workspaceArchived: false,
        nowMs: Date.parse("2026-01-01T00:10:00.000Z"),
      }),
    ).toBe(false);
  });
});
