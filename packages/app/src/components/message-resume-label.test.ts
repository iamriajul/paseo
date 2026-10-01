import { describe, expect, it } from "vitest";

import { i18n } from "@/i18n/i18next";
import { getResumeMarkerLabel } from "./message-resume-label";

describe("getResumeMarkerLabel", () => {
  it("distinguishes an unexpected shutdown from a manual resume", () => {
    expect(getResumeMarkerLabel({ reason: "power_cut" })).toBe(
      "Resumed after an unexpected shutdown",
    );
    expect(getResumeMarkerLabel({ reason: "manual" })).toBe("Resumed");
  });

  it("renders labels in the active app language", async () => {
    await i18n.changeLanguage("zh-CN");
    try {
      expect(getResumeMarkerLabel({ reason: "power_cut" })).toBe("意外关闭后已恢复");
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});
