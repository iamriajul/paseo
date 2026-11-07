import { describe, expect, it } from "vitest";
import {
  DEFAULT_CACHE_WARM_PING_PROMPT,
  type GatewayAccountChange,
} from "@getpaseo/protocol/agent-cache-warm";
import type { StreamItem } from "@/types/stream";
import { describeServedBy, placeServedByLines, sameServedByLines } from "./served-by";

function prompt(id: string, at: string, text = "do the thing"): StreamItem {
  return { kind: "user_message", id, text, timestamp: new Date(at) };
}

const rows: StreamItem[] = [
  prompt("p1", "2026-11-07T01:00:00Z"),
  prompt("p2", "2026-11-07T01:05:00Z"),
  prompt("p3", "2026-11-07T01:10:00Z"),
];

describe("placeServedByLines", () => {
  it("names the first account above the prompt it answered, and nothing above unchanged turns", () => {
    const lines = placeServedByLines(rows, [{ at: "2026-11-07T01:00:02Z", account: "A" }]);
    expect([...lines]).toEqual([["p1", { account: "A", cacheLost: false }]]);
  });

  it("puts a switch above the prompt whose turn it happened in", () => {
    const changes: GatewayAccountChange[] = [
      { at: "2026-11-07T01:00:02Z", account: "A" },
      {
        at: "2026-11-07T01:10:03Z",
        account: "B",
        from: "A",
        reason: "quota",
        statusCode: 429,
        missAt: "2026-11-07T01:10:04Z",
      },
    ];
    const lines = placeServedByLines(rows, changes);
    expect(lines.get("p2")).toBeUndefined();
    expect(lines.get("p3")).toEqual({
      account: "B",
      from: "A",
      reason: "quota",
      statusCode: 429,
      cacheLost: true,
    });
  });

  it("tolerates a Gateway clock a few seconds behind the prompt's", () => {
    const lines = placeServedByLines(rows, [
      { at: "2026-11-07T01:04:57Z", account: "B", from: "A" },
    ]);
    expect(lines.has("p2")).toBe(true);
  });

  it("reads several switches in one turn as one move from the first account left", () => {
    const lines = placeServedByLines(rows, [
      { at: "2026-11-07T01:05:01Z", account: "B", from: "A", reason: "quota", missAt: "x" },
      { at: "2026-11-07T01:05:30Z", account: "C", from: "B", reason: "cooldown" },
    ]);
    expect(lines.get("p2")).toEqual({
      account: "C",
      from: "A",
      reason: "cooldown",
      cacheLost: true,
    });
  });

  it("moves a switch made during a warm-up or a resume to the user's next prompt", () => {
    const withDaemonTurns: StreamItem[] = [
      ...rows,
      prompt("warm", "2026-11-07T01:20:00Z", DEFAULT_CACHE_WARM_PING_PROMPT),
      { ...prompt("resume", "2026-11-07T01:40:00Z"), resume: { reason: "restart" } } as StreamItem,
      prompt("p4", "2026-11-07T02:00:00Z"),
    ];
    const lines = placeServedByLines(withDaemonTurns, [
      { at: "2026-11-07T01:20:03Z", account: "B", from: "A", reason: "quota" },
      { at: "2026-11-07T01:40:02Z", account: "C", from: "B", reason: "cooldown" },
    ]);
    // p3's turn ended before either switch, so it keeps no line.
    expect([...lines.keys()]).toEqual(["p4"]);
    expect(lines.get("p4")).toEqual({
      account: "C",
      from: "A",
      reason: "cooldown",
      cacheLost: false,
    });
  });

  it("holds a warm-up switch until the user writes again", () => {
    const lines = placeServedByLines(
      [...rows, prompt("warm", "2026-11-07T01:20:00Z", DEFAULT_CACHE_WARM_PING_PROMPT)],
      [{ at: "2026-11-07T01:20:03Z", account: "B", from: "A" }],
    );
    expect(lines.size).toBe(0);
  });

  it("never draws on warm-up or resume rows, nor for changes older than every loaded prompt", () => {
    const withNoise: StreamItem[] = [
      ...rows,
      prompt("warm", "2026-11-07T01:11:00Z", DEFAULT_CACHE_WARM_PING_PROMPT),
      { ...prompt("resume", "2026-11-07T01:12:00Z"), resume: { reason: "restart" } } as StreamItem,
      prompt("p4", "2026-11-07T01:15:00Z"),
    ];
    const lines = placeServedByLines(withNoise, [
      { at: "2026-11-07T00:30:00Z", account: "Z" },
      { at: "2026-11-07T01:10:05Z", account: "B", from: "A" },
      { at: "2026-11-07T01:12:05Z", account: "C", from: "B" },
    ]);
    expect([...lines.keys()]).toEqual(["p3", "p4"]);
    expect(lines.get("p3")).toMatchObject({ account: "B", from: "A" });
    expect(lines.get("p4")).toMatchObject({ account: "C", from: "B" });
  });
});

describe("describeServedBy", () => {
  it("names the account, the switch and its cause, and the cache it cost", () => {
    expect(describeServedBy({ account: "A", cacheLost: false })).toBe("Served by A");
    expect(
      describeServedBy({
        account: "B",
        from: "A",
        reason: "quota",
        statusCode: 429,
        cacheLost: true,
      }),
    ).toBe("Served by B · switched from A (quota, 429) · cache lost");
    expect(describeServedBy({ account: "B", from: "A", cacheLost: false })).toBe(
      "Served by B · switched from A",
    );
  });
});

describe("sameServedByLines", () => {
  it("compares the lines, not the map identity", () => {
    const line = { account: "B", from: "A", reason: "quota", cacheLost: true };
    expect(sameServedByLines(new Map([["p", line]]), new Map([["p", { ...line }]]))).toBe(true);
    expect(
      sameServedByLines(new Map([["p", line]]), new Map([["p", { ...line, cacheLost: false }]])),
    ).toBe(false);
    expect(sameServedByLines(new Map([["p", line]]), new Map([["q", line]]))).toBe(false);
  });
});
