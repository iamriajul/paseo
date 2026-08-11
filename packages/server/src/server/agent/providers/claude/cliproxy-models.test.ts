import { describe, expect, test } from "vitest";
import {
  decodeCliproxyClaudeModelId,
  isOfficialCpaOwner,
  isCliproxyNonChatModel,
} from "./cliproxy-models.js";

describe("decodeCliproxyClaudeModelId", () => {
  test("decodes reversed non-claude ids", () => {
    expect(decodeCliproxyClaudeModelId("claude-fable-5-dd-5.4-korg")).toBe("grok-4.5");
    expect(decodeCliproxyClaudeModelId("claude-fable-5-dd-los-6.5-tpg")).toBe("gpt-5.6-sol");
    expect(decodeCliproxyClaudeModelId("claude-fable-5-dd-xam-8.3newq")).toBe("qwen3.8-max");
  });

  test("leaves real claude ids unchanged", () => {
    expect(decodeCliproxyClaudeModelId("claude-fable-5")).toBe("claude-fable-5");
    expect(decodeCliproxyClaudeModelId("claude-opus-5")).toBe("claude-opus-5");
  });

  test("preserves thinking suffix on encoded ids", () => {
    expect(decodeCliproxyClaudeModelId("claude-fable-5-dd-5.4-korg(high)")).toBe("grok-4.5(high)");
  });
});

describe("isOfficialCpaOwner", () => {
  test("accepts official brands case-insensitively", () => {
    expect(isOfficialCpaOwner("openai")).toBe(true);
    expect(isOfficialCpaOwner("Anthropic")).toBe(true);
    expect(isOfficialCpaOwner("xAI")).toBe(true);
    expect(isOfficialCpaOwner("antigravity")).toBe(true);
  });

  test("rejects openai-compat and empty", () => {
    expect(isOfficialCpaOwner("OpenCodeGo")).toBe(false);
    expect(isOfficialCpaOwner("")).toBe(false);
    expect(isOfficialCpaOwner(undefined)).toBe(false);
  });
});

describe("isCliproxyNonChatModel", () => {
  test("filters image and video models by decoded id", () => {
    expect(isCliproxyNonChatModel({ id: "gpt-image-2" })).toBe(true);
    expect(isCliproxyNonChatModel({ id: "grok-imagine-video" })).toBe(true);
    expect(isCliproxyNonChatModel({ id: "grok-4.5", displayName: "Grok 4.5" })).toBe(false);
  });
});
