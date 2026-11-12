import { describe, expect, it } from "vitest";
import type { CacheWarmStop, PromptCacheHistoryEntry } from "@getpaseo/protocol/agent-cache-warm";
import {
  describeAccountPause,
  describeWakeUpHold,
  describeWarmUpStop,
  indexWarmUpStops,
} from "./warm-up-stop";

const MINUTE = 60_000;

describe("describeWakeUpHold", () => {
  const now = new Date("2026-11-07T15:00:00Z").getTime();

  it("names the held wake-up, the account and when it is back", () => {
    expect(
      describeWakeUpHold(
        {
          kind: "heartbeat",
          reason: "cooldown",
          account: "s***b",
          until: "2026-11-07T15:20:00Z",
          heldAt: "2026-11-07T14:58:00Z",
          count: 1,
        },
        now,
      ),
    ).toMatch(
      /^Heartbeat held · s\*\*\*b is cooling down \(back \S.*\) · goes out when it's back$/,
    );
  });

  it("counts coalesced repeats and other held wake-ups together", () => {
    expect(
      describeWakeUpHold(
        {
          kind: "agent-message",
          reason: "quota",
          account: "s***b",
          window: "5h",
          until: "2026-11-07T15:10:00Z",
          heldAt: "2026-11-07T14:58:00Z",
          count: 3,
        },
        now,
      ),
    ).toMatch(
      /^3 wake-ups held · s\*\*\*b used up its 5h quota \(back \S.*\) · they go out when it's back$/,
    );
  });
});

describe("describeAccountPause", () => {
  const now = new Date("2026-11-07T15:00:00Z").getTime();

  it("names the account, its cooldown and when it ends", () => {
    const text = describeAccountPause(
      { reason: "cooldown", account: "u***a", until: "2026-11-07T15:43:00Z" },
      now,
    );
    expect(text).toMatch(
      /^Paused · u\*\*\*a is cooling down \(back \S.*\) · resumes on your next message$/,
    );
  });

  it("names the used-up window", () => {
    expect(
      describeAccountPause(
        { reason: "quota", account: "s***b", window: "5h", until: "2026-11-07T17:00:00Z" },
        now,
      ),
    ).toMatch(/^Paused · s\*\*\*b used up its 5h quota \(back \S/);
  });

  it("leaves the time out when the Gateway does not say", () => {
    expect(describeAccountPause({ reason: "cooldown", account: "u***a" }, now)).toBe(
      "Paused · u***a is cooling down · resumes on your next message",
    );
  });

  it("names the account the Gateway moved the session to", () => {
    expect(describeAccountPause({ reason: "moved", account: "n***u" }, now)).toBe(
      "Paused · the gateway had already moved this session to n***u · resumes on your next message",
    );
  });

  it("says the gateway did not answer, and that it checks again while it still can", () => {
    expect(
      describeAccountPause(
        { reason: "unconfirmed", account: "", retryAt: "2026-11-07T15:00:20Z" },
        now,
      ),
    ).toBe(
      "Paused · couldn't confirm the account could serve (gateway didn't answer) · checking again shortly",
    );
  });

  it.each([
    ["unlisted", "u***a no longer serves this model"],
    ["untracked", "the gateway no longer tracks this session"],
    ["unsupported", "the gateway can't say which account serves this session"],
  ])("explains %s", (reason, clause) => {
    expect(
      describeAccountPause({ reason, account: reason === "unlisted" ? "u***a" : "" }, now),
    ).toBe(`Paused · ${clause} · resumes on your next message`);
  });
});

describe("describeWarmUpStop", () => {
  it("reads the account's return at the time the warm-up stopped", () => {
    const stop: CacheWarmStop = {
      at: "2026-11-07T13:00:00Z",
      reason: "quota",
      account: "s***b",
      window: "5h",
      until: "2026-11-07T14:05:00Z",
    };
    expect(describeWarmUpStop(stop)).toMatch(
      /^Warm-up skipped: s\*\*\*b used up its 5h quota \(back \S.*\), cache left to expire$/,
    );
  });

  it("names the warm-up's own limits as a stop", () => {
    expect(describeWarmUpStop({ at: "2026-11-07T13:00:00Z", reason: "capped" })).toBe(
      "Warm-up stopped: the idle cap was reached, cache left to expire",
    );
    expect(describeWarmUpStop({ at: "2026-11-07T13:00:00Z", reason: "off" })).toBe(
      "Warm-up stopped: warm-up was switched off, cache left to expire",
    );
  });
});

describe("indexWarmUpStops", () => {
  function request(at: string, gapMs: number | null, readTokens: number): PromptCacheHistoryEntry {
    return {
      at,
      kind: "turn",
      readTokens,
      writeTokens: 100_000 - readTokens,
      uncachedTokens: 0,
      gapMs,
      previousInputTokens: 100_000,
    };
  }

  const stop: CacheWarmStop = { at: "2026-11-07T10:04:00Z", reason: "moved", account: "n***u" };

  it("puts a stop on the expired miss whose gap it fell in", () => {
    const requests = [
      request("2026-11-07T10:00:00Z", null, 0),
      request("2026-11-07T10:30:00Z", 30 * MINUTE, 0),
    ];
    const { byRequest, latestOpen } = indexWarmUpStops({
      requests,
      stops: [stop],
      cacheWindowMs: 5 * MINUTE,
    });
    expect(byRequest.get("2026-11-07T10:30:00Z")).toEqual(stop);
    expect(latestOpen).toBeNull();
  });

  it("leaves a hit and a miss inside the window alone", () => {
    const requests = [
      request("2026-11-07T10:00:00Z", null, 0),
      request("2026-11-07T10:04:30Z", 4.5 * MINUTE, 0),
    ];
    const { byRequest } = indexWarmUpStops({
      requests,
      stops: [stop],
      cacheWindowMs: 5 * MINUTE,
    });
    expect(byRequest.size).toBe(0);
  });

  it("returns a stop no request has followed yet as the open one", () => {
    const { latestOpen } = indexWarmUpStops({
      requests: [request("2026-11-07T10:00:00Z", null, 0)],
      stops: [stop],
      cacheWindowMs: 5 * MINUTE,
    });
    expect(latestOpen).toEqual(stop);
  });
});
