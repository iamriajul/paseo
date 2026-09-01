import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import {
  findChatHistoryMatches,
  navigateChatHistoryMatches,
  normalizeChatHistoryQuery,
  preserveOrSelectChatHistoryMatch,
  selectInitialChatHistoryMatch,
} from "./chat-history-search";

const timestamp = new Date("2026-01-01T00:00:00Z");
const items: StreamItem[] = [
  { kind: "user_message", id: "u1", text: "Alpha alpha", timestamp },
  { kind: "thought", id: "t1", text: "alpha", timestamp, status: "ready" },
  { kind: "assistant_message", id: "a1", text: "Beta ALPHA", timestamp },
  { kind: "activity_log", id: "l1", message: "alpha", activityType: "info", timestamp },
  { kind: "user_message", id: "u2", text: "unrelated", timestamp },
];

describe("chat history search", () => {
  it("normalizes whitespace and case", () => {
    expect(normalizeChatHistoryQuery("  MiXeD  ")).toBe("mixed");
  });

  it("matches committed user and assistant messages once and excludes other item kinds", () => {
    expect(
      findChatHistoryMatches(items, " alpha ", {
        includeUser: true,
        includeAssistant: true,
      }),
    ).toEqual([
      { id: "u1", kind: "user_message" },
      { id: "a1", kind: "assistant_message" },
    ]);
  });

  it("honors role filters and returns no matches when both are off", () => {
    expect(
      findChatHistoryMatches(items, "alpha", {
        includeUser: false,
        includeAssistant: true,
      }),
    ).toEqual([{ id: "a1", kind: "assistant_message" }]);
    expect(
      findChatHistoryMatches(items, "alpha", {
        includeUser: false,
        includeAssistant: false,
      }),
    ).toEqual([]);
  });

  it("selects the newest match and preserves a still-valid selection", () => {
    const matches = findChatHistoryMatches(items, "alpha", {
      includeUser: true,
      includeAssistant: true,
    });
    expect(selectInitialChatHistoryMatch(matches)).toBe("a1");
    expect(preserveOrSelectChatHistoryMatch(matches, "u1")).toBe("u1");
    expect(preserveOrSelectChatHistoryMatch(matches, "missing")).toBe("a1");
  });

  it("navigates chronologically and wraps at both ends", () => {
    const matches = [
      { id: "old", kind: "user_message" as const },
      { id: "new", kind: "assistant_message" as const },
    ];
    expect(navigateChatHistoryMatches(matches, "old", "next")).toBe("new");
    expect(navigateChatHistoryMatches(matches, "new", "next")).toBe("old");
    expect(navigateChatHistoryMatches(matches, "old", "previous")).toBe("new");
  });
});
