import { afterEach, describe, expect, test } from "vitest";
import {
  exhaustedWindowsResetAt,
  parseCodexTryAgainAt,
  resolveCodexQuotaResetAt,
} from "./usage-limit.js";

// The message agent 821707fc stopped on (Codex 0.167, ChatGPT login through the gateway).
const OBSERVED =
  "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 4:45 PM.";

const NO_LIMITS = { primary: null, secondary: null };

// Dates built from local parts, so the expectations hold in whatever timezone the suite runs.
function local(y: number, mo: number, d: number, h: number, mi: number, s = 0): Date {
  return new Date(y, mo - 1, d, h, mi, s);
}

describe("parseCodexTryAgainAt", () => {
  test("a bare time is today's, at the end of the minute Codex showed", () => {
    const now = local(2026, 11, 23, 12, 51, 39);
    expect(parseCodexTryAgainAt(OBSERVED, now)).toEqual(local(2026, 11, 23, 16, 46));
  });

  test("a bare time still ahead today stays today", () => {
    const now = local(2026, 11, 24, 0, 5);
    expect(parseCodexTryAgainAt("or try again at 11:50 PM.", now)).toEqual(
      local(2026, 11, 24, 23, 51),
    );
  });

  test("a bare time already past means the next day", () => {
    expect(parseCodexTryAgainAt("or try again at 12:30 AM.", local(2026, 11, 23, 23, 58))).toEqual(
      local(2026, 11, 24, 0, 31),
    );
  });

  test("the minute being shown now still means today, not tomorrow", () => {
    const now = local(2026, 11, 23, 16, 45, 40);
    expect(parseCodexTryAgainAt(OBSERVED, now)).toEqual(local(2026, 11, 23, 16, 46));
  });

  test("reads Codex's dated form for a reset on another day", () => {
    const now = local(2026, 11, 23, 22, 0);
    expect(parseCodexTryAgainAt("or try again at Nov 24th, 2026 9:05 AM.", now)).toEqual(
      local(2026, 11, 24, 9, 6),
    );
    expect(parseCodexTryAgainAt("or try again at Jan 1st, 2027 12:00 PM.", now)).toEqual(
      local(2027, 1, 1, 12, 1),
    );
  });

  test("returns null without a time or for an impossible one", () => {
    const now = local(2026, 11, 23, 12, 0);
    expect(parseCodexTryAgainAt("You've hit your usage limit. Try again later.", now)).toBeNull();
    expect(parseCodexTryAgainAt("try again at 13:10 PM", now)).toBeNull();
    expect(parseCodexTryAgainAt("try again at Feb 30th, 2027 1:00 PM", now)).toBeNull();
  });

  describe("in the host's timezone", () => {
    // Restore by assigning the zone the suite started in: on Windows, deleting TZ leaves Node in
    // the zone set last, and every later test would run in Dhaka.
    const original = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    afterEach(() => {
      process.env.TZ = original;
    });

    test("reads the clock time in the daemon's own zone", () => {
      process.env.TZ = "Asia/Dhaka";
      const now = new Date("2026-11-23T06:51:39Z"); // 12:51 PM in Dhaka (UTC+6)
      expect(parseCodexTryAgainAt(OBSERVED, now)?.toISOString()).toBe("2026-11-23T10:46:00.000Z");
    });
  });
});

describe("exhaustedWindowsResetAt", () => {
  test("waits for every used-up window", () => {
    expect(
      exhaustedWindowsResetAt({
        primary: { usedPercent: 100, resetsAt: 1_795_000_000 },
        secondary: { usedPercent: 100, resetsAt: 1_795_300_000 },
      }),
    ).toEqual(new Date(1_795_300_000_000));
  });

  test("ignores a window with quota left", () => {
    expect(
      exhaustedWindowsResetAt({
        primary: { usedPercent: 100, resetsAt: 1_795_000_000 },
        secondary: { usedPercent: 40, resetsAt: 1_795_300_000 },
      }),
    ).toEqual(new Date(1_795_000_000_000));
    expect(
      exhaustedWindowsResetAt({ primary: { usedPercent: 99, resetsAt: 1 }, secondary: null }),
    ).toBeNull();
  });
});

describe("resolveCodexQuotaResetAt", () => {
  // Built inside each test, in the zone the test runs in, like the expectations.
  const at = () => local(2026, 11, 23, 12, 51);

  test("takes the time from the usage-limit message", () => {
    expect(
      resolveCodexQuotaResetAt({
        message: OBSERVED,
        codexErrorInfo: "usageLimitExceeded",
        rateLimits: NO_LIMITS,
        now: at(),
      }),
    ).toEqual(local(2026, 11, 23, 16, 46));
  });

  test("falls back to the rate-limit snapshot when the message has no time", () => {
    expect(
      resolveCodexQuotaResetAt({
        message: "You've hit your usage limit. Try again later.",
        codexErrorInfo: "usageLimitExceeded",
        rateLimits: { primary: { usedPercent: 100, resetsAt: 1_795_449_900 }, secondary: null },
        now: at(),
      }),
    ).toEqual(new Date(1_795_449_900_000));
  });

  test("a failure that is not about quota has no reset", () => {
    expect(
      resolveCodexQuotaResetAt({
        message: "stream disconnected before completion",
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } },
        rateLimits: { primary: { usedPercent: 100, resetsAt: 1_795_449_900 }, secondary: null },
        now: at(),
      }),
    ).toBeNull();
  });
});
