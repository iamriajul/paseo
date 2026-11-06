import { describe, expect, it } from "vitest";
import { DEFAULT_CACHE_WARM_PING_PROMPT } from "@getpaseo/protocol/agent-cache-warm";
import type { StreamItem } from "@/types/stream";
import { foldWarmUpStretches, isWarmPingTurnHost } from "./warm-up-stretches";

const MINUTE = 60_000;

function user(id: string, minute: number, text = "do the thing"): StreamItem {
  return { kind: "user_message", id, text, timestamp: new Date(minute * MINUTE) };
}

function assistant(id: string, minute: number, text = "done"): StreamItem {
  return { kind: "assistant_message", id, text, timestamp: new Date(minute * MINUTE) };
}

describe("foldWarmUpStretches", () => {
  it("folds an idle stretch's fork warm-ups into one counted row under the reply", () => {
    const stretches = foldWarmUpStretches({
      rows: [user("u1", 0), assistant("a1", 1), user("u2", 30), assistant("a2", 31)],
      warmUpTimes: [5 * MINUTE, 9 * MINUTE, 13 * MINUTE, 40 * MINUTE],
      hasNewerRows: false,
    });

    expect(Object.fromEntries(stretches)).toEqual({
      a1: { count: 3, firstAt: 5 * MINUTE, lastAt: 13 * MINUTE },
      a2: { count: 1, firstAt: 40 * MINUTE, lastAt: 40 * MINUTE },
    });
  });

  it("reads rows by time, so a newest-first native list folds the same", () => {
    const rows = [user("u1", 0), assistant("a1", 1), user("u2", 30), assistant("a2", 31)];
    const input = { warmUpTimes: [5 * MINUTE, 9 * MINUTE, 40 * MINUTE], hasNewerRows: false };

    const newestFirst = foldWarmUpStretches({ ...input, rows: rows.toReversed() });

    expect(Object.fromEntries(newestFirst)).toEqual(
      Object.fromEntries(foldWarmUpStretches({ ...input, rows })),
    );
    expect(newestFirst.get("a1")?.count).toBe(2);
    expect(newestFirst.get("a2")?.count).toBe(1);
  });

  it("counts warm-ups sent as turns once, whether or not the journal also recorded them", () => {
    const rows = [
      user("u1", 0),
      assistant("a1", 1),
      user("p1", 5, DEFAULT_CACHE_WARM_PING_PROMPT),
      assistant("r1", 5, "ok"),
      user("p2", 9, DEFAULT_CACHE_WARM_PING_PROMPT),
      assistant("r2", 9, "ok"),
    ];

    const withJournal = foldWarmUpStretches({
      rows,
      warmUpTimes: [5 * MINUTE + 1, 9 * MINUTE + 1],
      hasNewerRows: false,
    });
    const withoutJournal = foldWarmUpStretches({ rows, warmUpTimes: [], hasNewerRows: false });

    expect(withJournal.get("a1")?.count).toBe(2);
    expect(withoutJournal.get("a1")).toEqual({ count: 2, firstAt: 5 * MINUTE, lastAt: 9 * MINUTE });
    expect([...withJournal.keys()]).toEqual(["a1"]);
  });

  it("leaves out warm-ups that belong to rows not loaded", () => {
    const rows = [user("u1", 10), assistant("a1", 11)];

    const older = foldWarmUpStretches({ rows, warmUpTimes: [5 * MINUTE], hasNewerRows: false });
    const newer = foldWarmUpStretches({ rows, warmUpTimes: [15 * MINUTE], hasNewerRows: true });

    expect(older.size).toBe(0);
    expect(newer.size).toBe(0);
  });
});

describe("isWarmPingTurnHost", () => {
  it("is a footer on a warm-up turn's reply, in either list order, and not on real work", () => {
    const rows = [
      user("u1", 0),
      assistant("a1", 1),
      user("p1", 5, DEFAULT_CACHE_WARM_PING_PROMPT),
      assistant("r1", 5, "ok"),
    ];
    expect(isWarmPingTurnHost({ items: rows, startIndex: 3 })).toBe(true);
    expect(isWarmPingTurnHost({ items: rows.toReversed(), startIndex: 0 })).toBe(true);
    expect(isWarmPingTurnHost({ items: rows, startIndex: 1 })).toBe(false);
    // A real "ok" reply to a real prompt keeps its footer.
    expect(
      isWarmPingTurnHost({ items: [user("u2", 9), assistant("a2", 9, "ok")], startIndex: 1 }),
    ).toBe(false);
  });
});
