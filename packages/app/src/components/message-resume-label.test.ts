import { describe, expect, it } from "vitest";

import { i18n } from "@/i18n/i18next";
import { getResumeMarkerLabel } from "./message-resume-label";

describe("getResumeMarkerLabel", () => {
  it("names the prompt that was sent in the agent recovery marker", () => {
    expect(getResumeMarkerLabel({ reason: "restart", prompt: "Resume working." })).toBe(
      "---- Agent recovery: Resume working. ----",
    );
  });

  it("keeps a marker's text when the configured prompt changes", () => {
    expect(
      getResumeMarkerLabel({ reason: "restart", prompt: "Continue the interrupted work." }),
    ).toBe("---- Agent recovery: Continue the interrupted work. ----");
  });

  it("labels a rate-limit resume with its fixed label", () => {
    expect(getResumeMarkerLabel({ reason: "rate_limit_retry", prompt: "Continue." })).toBe(
      "Resumed after rate limit cooldown",
    );
  });

  it("renders the recovery marker in the active app language", async () => {
    await i18n.changeLanguage("zh-CN");
    try {
      expect(getResumeMarkerLabel({ reason: "restart", prompt: "继续" })).toBe(
        "---- 智能体恢复：继续 ----",
      );
      expect(getResumeMarkerLabel({ reason: "rate_limit_retry", prompt: "" })).toBe(
        "速率限制冷却后已恢复",
      );
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});
