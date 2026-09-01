import { describe, expect, test } from "vitest";
import {
  GetProvidersSnapshotResponseMessageSchema,
  ProviderSnapshotEntrySchema,
  ProvidersSnapshotUpdateMessageSchema,
} from "./messages.js";

describe("provider snapshot message schemas", () => {
  test("defaults missing provider snapshot entry enabled state to true", () => {
    const parsed = ProviderSnapshotEntrySchema.parse({
      provider: "codex",
      status: "ready",
      label: "Codex",
    });

    expect(parsed.enabled).toBe(true);
  });

  test("preserves disabled provider snapshot entries", () => {
    const parsed = ProviderSnapshotEntrySchema.parse({
      provider: "claude",
      status: "unavailable",
      enabled: false,
      label: "Claude",
    });

    expect(parsed.enabled).toBe(false);
  });

  test("preserves enabled provider snapshot entries", () => {
    const parsed = ProviderSnapshotEntrySchema.parse({
      provider: "opencode",
      status: "loading",
      enabled: true,
      label: "OpenCode",
    });

    expect(parsed.enabled).toBe(true);
  });

  test("preserves provider snapshot entry source", () => {
    const parsed = ProviderSnapshotEntrySchema.parse({
      provider: "gemini",
      status: "ready",
      enabled: true,
      source: "custom",
      label: "Gemini",
    });

    expect(parsed.source).toBe("custom");
  });

  test("preserves optional model capacity metadata", () => {
    const parsed = ProviderSnapshotEntrySchema.parse({
      provider: "claude",
      status: "ready",
      models: [
        {
          provider: "claude",
          id: "grok-4.5",
          label: "Grok 4.5",
          contextWindowMaxTokens: 500_000,
          maxOutputTokens: 65_536,
          needsCapacityConfig: true,
          modelsDevCandidates: [
            {
              providerId: "x-ai",
              matchedId: "grok-4.5",
              name: "Grok 4.5",
              contextWindowMaxTokens: 131_072,
              maxOutputTokens: 32_768,
            },
          ],
        },
      ],
    });

    expect(parsed.models?.[0]).toEqual({
      provider: "claude",
      id: "grok-4.5",
      label: "Grok 4.5",
      contextWindowMaxTokens: 500_000,
      maxOutputTokens: 65_536,
      needsCapacityConfig: true,
      modelsDevCandidates: [
        {
          providerId: "x-ai",
          matchedId: "grok-4.5",
          name: "Grok 4.5",
          contextWindowMaxTokens: 131_072,
          maxOutputTokens: 32_768,
        },
      ],
    });
  });

  test("defaults missing enabled state in providers snapshot response entries", () => {
    const parsed = GetProvidersSnapshotResponseMessageSchema.parse({
      type: "get_providers_snapshot_response",
      payload: {
        entries: [
          {
            provider: "codex",
            status: "ready",
            label: "Codex",
          },
          {
            provider: "claude",
            status: "unavailable",
            enabled: false,
            label: "Claude",
          },
        ],
        generatedAt: "2026-04-24T00:00:00.000Z",
        requestId: "req-providers",
      },
    });

    expect(parsed.payload.entries.map((entry) => entry.enabled)).toEqual([true, false]);
  });

  test("defaults missing enabled state in providers snapshot update entries", () => {
    const parsed = ProvidersSnapshotUpdateMessageSchema.parse({
      type: "providers_snapshot_update",
      payload: {
        cwd: "/tmp/repo",
        entries: [
          {
            provider: "codex",
            status: "ready",
            label: "Codex",
          },
        ],
        generatedAt: "2026-04-24T00:00:00.000Z",
      },
    });

    expect(parsed.payload.entries[0]?.enabled).toBe(true);
  });
});

test("accepts a bodyless announcement with separate discovery freshness", async () => {
  const { validateWSOutboundMessage } = await import("./validation/ws-outbound.js");
  const message = {
    type: "providers_snapshot_update",
    payload: {
      cwd: "/project",
      entries: [],
      snapshotHash: "content-hash",
      fetchedAt: { codex: "2026-09-06T12:00:00.000Z" },
      generatedAt: "2026-09-06T13:00:00.000Z",
    },
  };
  expect(ProvidersSnapshotUpdateMessageSchema.parse(message)).toEqual(message);
  const result = validateWSOutboundMessage({ type: "session", message });
  expect(result.success).toBe(true);
});
