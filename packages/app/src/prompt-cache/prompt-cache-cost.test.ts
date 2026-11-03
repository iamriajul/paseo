import { describe, expect, it } from "vitest";
import { formatUsdEstimate, resolveSessionCostUsd } from "./prompt-cache-cost";

describe("formatUsdEstimate", () => {
  it("keeps cents and marks amounts too small to show", () => {
    expect(formatUsdEstimate(2.25)).toBe("$2.25");
    expect(formatUsdEstimate(0.004)).toBe("<$0.01");
    expect(formatUsdEstimate(1234.4)).toBe("$1,234");
  });
});

describe("resolveSessionCostUsd", () => {
  it("adds the warm-ups Claude Code leaves out of its session cost", () => {
    expect(
      resolveSessionCostUsd({ lastUsage: { totalCostUsd: 43.77 }, warmUpCostUsd: 1.3 }),
    ).toBeCloseTo(45.07, 9);
    expect(resolveSessionCostUsd({ warmUpCostUsd: 0.4 })).toBeCloseTo(0.4, 9);
    expect(resolveSessionCostUsd({ lastUsage: {} })).toBeNull();
  });
});
