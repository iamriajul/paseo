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

// A Claude agent whose last response came back in 2026 on a five-minute prompt cache: long expired.
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

    expect(isRestartResumeEligible({ record, liveWarmPing: true, workspaceArchived: false })).toBe(
      false,
    );
    expect(isRestartResumeEligible({ record, liveWarmPing: false, workspaceArchived: false })).toBe(
      true,
    );
  });

  it("resumes an agent whose five-minute prompt cache has expired", () => {
    const record = claudeAgentWithFiveMinuteCache();

    expect(isRestartResumeEligible({ record, liveWarmPing: false, workspaceArchived: false })).toBe(
      true,
    );
  });

  it("does not resume an agent without a provider session or in an archived workspace", () => {
    expect(
      isRestartResumeEligible({
        record: storedRecord({ persistence: null }),
        liveWarmPing: false,
        workspaceArchived: false,
      }),
    ).toBe(false);
    expect(
      isRestartResumeEligible({
        record: storedRecord(),
        liveWarmPing: false,
        workspaceArchived: true,
      }),
    ).toBe(false);
  });
});
