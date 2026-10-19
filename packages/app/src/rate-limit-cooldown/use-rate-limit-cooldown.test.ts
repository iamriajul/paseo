// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  formatCooldownCountdown,
  formatCooldownTimeUtc,
  isRateLimitCooldownActive,
  useIsRateLimitCooldownActive,
} from "./use-rate-limit-cooldown";

describe("formatCooldownCountdown", () => {
  it("formats seconds", () => {
    expect(formatCooldownCountdown(0)).toBe("0s");
    expect(formatCooldownCountdown(-500)).toBe("0s");
    expect(formatCooldownCountdown(5000)).toBe("5s");
    expect(formatCooldownCountdown(45000)).toBe("45s");
  });

  it("formats minutes and seconds", () => {
    expect(formatCooldownCountdown(60000)).toBe("1m");
    expect(formatCooldownCountdown(75000)).toBe("1m 15s");
    expect(formatCooldownCountdown(14 * 60 * 1000 + 23 * 1000)).toBe("14m 23s");
  });

  it("formats hours and minutes", () => {
    expect(formatCooldownCountdown(3600000)).toBe("1h");
    expect(formatCooldownCountdown(3600000 + 15 * 60000)).toBe("1h 15m");
  });
});

describe("formatCooldownTimeUtc", () => {
  it("formats UTC time string", () => {
    const d = new Date("2026-10-20T02:00:12.000Z");
    expect(formatCooldownTimeUtc(d)).toBe("02:00:12 UTC");
  });
});

describe("isRateLimitCooldownActive", () => {
  it("returns true for future cooldown and false for past or null", () => {
    const now = new Date("2026-10-20T01:00:00.000Z").getTime();
    expect(
      isRateLimitCooldownActive(
        { scheduledFor: "2026-10-20T02:00:00.000Z", retryAfter: "2026-10-20T02:00:00.000Z" },
        now,
      ),
    ).toBe(true);

    expect(
      isRateLimitCooldownActive(
        { scheduledFor: "2026-10-20T00:59:00.000Z", retryAfter: "2026-10-20T00:59:00.000Z" },
        now,
      ),
    ).toBe(false);

    expect(isRateLimitCooldownActive(null, now)).toBe(false);
  });
});

describe("useIsRateLimitCooldownActive", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T01:50:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("flips to false when scheduledFor arrives without requiring a store change", async () => {
    const cooldown = {
      scheduledFor: "2026-10-20T02:00:00.000Z",
      retryAfter: "2026-10-20T02:00:00.000Z",
    };

    const { result } = renderHook(() => useIsRateLimitCooldownActive(cooldown));
    expect(result.current).toBe(true);

    // Advance to 1 second before expiry
    act(() => {
      vi.advanceTimersByTime(10 * 60 * 1000 - 1000);
    });
    expect(result.current).toBe(true);

    // Advance past expiry
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current).toBe(false);
  });
});
