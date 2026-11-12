import pino from "pino";
import { describe, expect, test } from "vitest";
import type { WarmUpAccountBlock } from "./gateway/warm-up-account.js";
import {
  WAKE_UP_HOLD_HORIZON_MS,
  WAKE_UP_HOLD_RETURN_SLACK_MS,
  WakeUpHolds,
  holdRequestForAgentMessages,
  type HeldWakeUp,
  type WakeUpHoldOutcome,
  type WakeUpHoldView,
} from "./wake-up-hold.js";

const START = Date.parse("2026-11-12T14:00:00.000Z");
const MINUTE = 60_000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function cooldown(untilMs: number): WarmUpAccountBlock {
  return { reason: "cooldown", account: "s***b", until: iso(untilMs) };
}

/** A daemon clock and timer queue the test moves by hand, and an account the test blocks. */
function createHarness(options?: { saved?: HeldWakeUp[] }) {
  let nowMs = START;
  const timers: { at: number; fire: () => void; cancelled: boolean }[] = [];
  const state = {
    block: null as WarmUpAccountBlock | null | Error,
    reads: 0,
    busy: false,
    lastRequestAtMs: (START - 2 * MINUTE) as number | null,
    cacheExpiresAtMs: (START + 58 * MINUTE) as number | null,
  };
  const saved: HeldWakeUp[][] = [];
  const redelivered: HeldWakeUp[] = [];
  const views: (WakeUpHoldView | null)[] = [];
  const started: HeldWakeUp[] = [];
  const holds = new WakeUpHolds({
    readBlock: async () => {
      state.reads += 1;
      if (state.block instanceof Error) throw state.block;
      return state.block;
    },
    cacheExpiresAtMs: async () => state.cacheExpiresAtMs,
    lastRequestAtMs: () => state.lastRequestAtMs,
    isBusy: () => state.busy,
    store: {
      load: async () => options?.saved ?? [],
      save: async (entries) => {
        saved.push(entries.map((entry) => ({ ...entry })));
      },
    },
    redeliver: async (entry) => {
      redelivered.push(entry);
    },
    onChange: (_agentId, view, entry) => {
      views.push(view);
      if (entry) started.push(entry);
    },
    logger: pino({ level: "silent" }),
    now: () => nowMs,
    schedule: (delayMs, fire) => {
      const timer = { at: nowMs + delayMs, fire, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });

  async function settle(): Promise<void> {
    for (let i = 0; i < 10; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  }

  /** Moves the clock, firing every timer that falls due on the way. */
  async function advance(ms: number): Promise<void> {
    const target = nowMs + ms;
    for (;;) {
      await settle();
      const due = timers
        .filter((timer) => !timer.cancelled && timer.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      nowMs = Math.max(nowMs, due.at);
      due.cancelled = true;
      due.fire();
    }
    nowMs = target;
    await settle();
  }

  /** Starts a hold and tracks whether it has resolved yet. */
  function track(promise: Promise<WakeUpHoldOutcome>) {
    const tracked = { outcome: null as WakeUpHoldOutcome | null };
    void promise.then((outcome) => {
      tracked.outcome = outcome;
      return outcome;
    });
    return tracked;
  }

  return {
    holds,
    state,
    saved,
    redelivered,
    views,
    started,
    advance,
    settle,
    track,
    now: () => nowMs,
  };
}

describe("WakeUpHolds", () => {
  test("holds a heartbeat while the serving account cools down, and sends it once it is back", async () => {
    const h = createHarness();
    const backAt = START + 5 * MINUTE;
    h.state.block = cooldown(backAt);

    const held = h.track(h.holds.hold({ agentId: "a1", kind: "heartbeat", coalesceKey: "s1" }));
    await h.settle();
    expect(held.outcome).toBeNull();
    expect(h.holds.view("a1")).toMatchObject({
      kind: "heartbeat",
      reason: "cooldown",
      account: "s***b",
      until: iso(backAt),
      count: 1,
    });
    expect(h.started).toHaveLength(1);
    expect(h.saved.at(-1)).toHaveLength(1);

    // Still waiting right up to the reported return.
    await h.advance(5 * MINUTE);
    expect(held.outcome).toBeNull();

    h.state.block = null;
    await h.advance(WAKE_UP_HOLD_RETURN_SLACK_MS);
    expect(held.outcome).toEqual({
      status: "send",
      heldMs: 5 * MINUTE + WAKE_UP_HOLD_RETURN_SLACK_MS,
    });
    expect(h.holds.view("a1")).toBeNull();
    expect(h.views.at(-1)).toBeNull();
    expect(h.saved.at(-1)).toEqual([]);
  });

  test("holds a used-up quota window until it resets", async () => {
    const h = createHarness();
    h.state.block = {
      reason: "quota",
      account: "s***b",
      window: "5h",
      until: iso(START + 20 * MINUTE),
    };
    const held = h.track(h.holds.hold({ agentId: "a1", kind: "agent-message" }));
    await h.advance(19 * MINUTE);
    expect(held.outcome).toBeNull();
    expect(h.holds.view("a1")).toMatchObject({ reason: "quota", window: "5h" });
    h.state.block = null;
    await h.advance(2 * MINUTE);
    expect(held.outcome).toMatchObject({ status: "send" });
  });

  test("keeps waiting when the account is still blocked with a later return inside the horizon", async () => {
    const h = createHarness();
    h.state.block = cooldown(START + 2 * MINUTE);
    const held = h.track(h.holds.hold({ agentId: "a1", kind: "restart" }));
    await h.settle();
    h.state.block = cooldown(START + 6 * MINUTE);
    await h.advance(3 * MINUTE);
    expect(held.outcome).toBeNull();
    expect(h.holds.view("a1")?.until).toBe(iso(START + 6 * MINUTE));
    h.state.block = null;
    await h.advance(4 * MINUTE);
    expect(held.outcome).toMatchObject({ status: "send" });
  });

  test("never holds past the horizon, even when the return keeps moving", async () => {
    const h = createHarness();
    h.state.cacheExpiresAtMs = null;
    h.state.block = cooldown(START + 20 * MINUTE);
    const held = h.track(h.holds.hold({ agentId: "a1", kind: "heartbeat" }));
    await h.settle();
    // At the first return the Gateway pushes it back past the horizon of the first hold.
    h.state.block = cooldown(START + 35 * MINUTE);
    await h.advance(21 * MINUTE);
    expect(held.outcome).toMatchObject({ status: "send" });
  });

  describe("sends at once", () => {
    const cases: [string, (h: ReturnType<typeof createHarness>) => void][] = [
      [
        "when the account is back past the horizon",
        (h) => {
          h.state.block = cooldown(START + WAKE_UP_HOLD_HORIZON_MS + MINUTE);
        },
      ],
      [
        "when the return time is unknown",
        (h) => {
          h.state.block = { reason: "cooldown", account: "s***b" };
        },
      ],
      [
        "when the check cannot answer",
        (h) => {
          h.state.block = { reason: "unconfirmed", account: "" };
        },
      ],
      [
        "when the check throws",
        (h) => {
          h.state.block = new Error("gateway down");
        },
      ],
      [
        "when the session already moved to another account",
        (h) => {
          h.state.block = { reason: "moved", account: "t***c", until: iso(START + MINUTE) };
        },
      ],
      [
        "when the account can serve",
        (h) => {
          h.state.block = null;
        },
      ],
      [
        "when the cache expires before the account is back",
        (h) => {
          h.state.block = cooldown(START + 10 * MINUTE);
          h.state.cacheExpiresAtMs = START + 8 * MINUTE;
        },
      ],
      [
        "when the agent is running a turn that already talks to the Gateway",
        (h) => {
          h.state.block = cooldown(START + 5 * MINUTE);
          h.state.busy = true;
        },
      ],
    ];
    test.each(cases)("%s", async (_name, arrange) => {
      const h = createHarness();
      arrange(h);
      await expect(h.holds.hold({ agentId: "a1", kind: "heartbeat" })).resolves.toEqual({
        status: "send",
        heldMs: 0,
      });
      expect(h.started).toEqual([]);
    });
  });

  test("coalesces repeats of a held heartbeat into the one hold", async () => {
    const h = createHarness();
    h.state.block = cooldown(START + 10 * MINUTE);
    const first = h.track(h.holds.hold({ agentId: "a1", kind: "heartbeat", coalesceKey: "s1" }));
    await h.settle();
    await h.advance(3 * MINUTE);
    await expect(
      h.holds.hold({ agentId: "a1", kind: "heartbeat", coalesceKey: "s1" }),
    ).resolves.toEqual({ status: "coalesced" });
    await h.advance(3 * MINUTE);
    await expect(
      h.holds.hold({ agentId: "a1", kind: "heartbeat", coalesceKey: "s1" }),
    ).resolves.toEqual({ status: "coalesced" });
    expect(h.holds.view("a1")?.count).toBe(3);
    expect(h.started).toHaveLength(1);

    // Another schedule's heartbeat is its own wake-up.
    const other = h.track(h.holds.hold({ agentId: "a1", kind: "heartbeat", coalesceKey: "s2" }));
    await h.settle();
    expect(h.holds.view("a1")?.count).toBe(4);

    h.state.block = null;
    await h.advance(5 * MINUTE);
    expect(first.outcome).toMatchObject({ status: "send" });
    expect(other.outcome).toMatchObject({ status: "send" });
    expect(h.holds.view("a1")).toBeNull();
  });

  test("a message the user sends releases the agent's held wake-ups at once", async () => {
    const h = createHarness();
    h.state.block = cooldown(START + 20 * MINUTE);
    const held = h.track(h.holds.hold({ agentId: "a1", kind: "agent-notification" }));
    await h.advance(MINUTE);
    expect(held.outcome).toBeNull();

    // The user's prompt is never held: it starts a turn and makes a request of its own.
    h.state.lastRequestAtMs = h.now();
    h.state.busy = true;
    h.holds.noteActivity("a1");
    await h.settle();
    expect(held.outcome).toMatchObject({ status: "send", heldMs: MINUTE });
    expect(h.state.reads).toBe(1);
  });

  test("an unrelated state change of a held agent does not release it", async () => {
    const h = createHarness();
    h.state.block = cooldown(START + 20 * MINUTE);
    const held = h.track(h.holds.hold({ agentId: "a1", kind: "heartbeat" }));
    await h.advance(MINUTE);
    h.holds.noteActivity("a1");
    await h.settle();
    expect(held.outcome).toBeNull();
  });

  test("after a restart, re-checks a held message and sends it when the account is back", async () => {
    const message: HeldWakeUp = {
      id: "h1",
      agentId: "a1",
      kind: "agent-message",
      coalesceKey: null,
      reason: "cooldown",
      account: "s***b",
      until: iso(START + 2 * MINUTE),
      heldAt: iso(START - 3 * MINUTE),
      deadline: iso(START - 3 * MINUTE + WAKE_UP_HOLD_HORIZON_MS),
      repeats: 0,
      redeliver: { text: "check the CI run", clientMessageId: "m1" },
    };
    const heartbeat: HeldWakeUp = {
      ...message,
      id: "h2",
      kind: "heartbeat",
      coalesceKey: "s1",
      redeliver: undefined,
    };
    const h = createHarness({ saved: [message, heartbeat] });
    h.state.block = cooldown(START + 4 * MINUTE);
    await h.holds.restore();
    await h.settle();
    // The heartbeat's schedule fires again by itself, so only the message is kept.
    expect(h.saved[0]?.map((entry) => entry.id)).toEqual(["h1"]);
    expect(h.holds.view("a1")).toMatchObject({ until: iso(START + 4 * MINUTE), count: 1 });
    expect(h.started).toEqual([]);
    expect(h.redelivered).toEqual([]);

    h.state.block = null;
    await h.advance(5 * MINUTE);
    expect(h.redelivered.map((entry) => entry.redeliver)).toEqual([
      { text: "check the CI run", clientMessageId: "m1" },
    ]);
    expect(h.saved.at(-1)).toEqual([]);
  });

  test("after a restart, sends a held message at once when the account can serve", async () => {
    const h = createHarness({
      saved: [
        {
          id: "h1",
          agentId: "a1",
          kind: "restart",
          coalesceKey: null,
          reason: "quota",
          account: "s***b",
          until: iso(START - MINUTE),
          heldAt: iso(START - 10 * MINUTE),
          deadline: iso(START + 20 * MINUTE),
          repeats: 0,
          redeliver: { text: "Resume working." },
        },
      ],
    });
    await h.holds.restore();
    await h.settle();
    expect(h.redelivered.map((entry) => entry.kind)).toEqual(["restart"]);
  });

  test("a shutdown keeps a held message for the next start and sends a held notification", async () => {
    const h = createHarness();
    h.state.block = cooldown(START + 10 * MINUTE);
    const message = h.track(
      h.holds.hold({
        agentId: "a1",
        kind: "agent-message",
        redeliver: { text: "check the CI run" },
      }),
    );
    const notification = h.track(h.holds.hold({ agentId: "a2", kind: "agent-notification" }));
    await h.advance(MINUTE);

    await h.holds.close();
    await h.settle();
    expect(message.outcome).toEqual({ status: "deferred" });
    // The finish subscription counts a dispatched notification delivered, so it goes out now.
    expect(notification.outcome).toMatchObject({ status: "send" });
    expect(
      h.saved
        .at(-1)
        ?.map((entry) => entry.kind)
        .sort(),
    ).toEqual(["agent-message", "agent-notification"]);
  });
});

describe("holdRequestForAgentMessages", () => {
  const batch = { recipientId: "a1", messageIds: ["m1", "m2"], prompt: "envelopes" };

  test("saves a batch of plain-text agent messages for a restart", () => {
    expect(
      holdRequestForAgentMessages({ ...batch, sourceKinds: ["agent-message", "agent-message"] }),
    ).toEqual({
      agentId: "a1",
      kind: "agent-message",
      redeliver: { text: "envelopes", clientMessageId: "m1" },
    });
  });

  test("never saves a notification, which its finish subscription re-sends", () => {
    expect(holdRequestForAgentMessages({ ...batch, sourceKinds: ["agent-notification"] })).toEqual({
      agentId: "a1",
      kind: "agent-notification",
    });
    expect(
      holdRequestForAgentMessages({
        ...batch,
        sourceKinds: ["agent-message", "agent-notification"],
      }),
    ).toEqual({ agentId: "a1", kind: "agent-message" });
  });

  test("does not write a prompt with images to disk", () => {
    expect(
      holdRequestForAgentMessages({
        ...batch,
        sourceKinds: ["agent-message"],
        prompt: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
      }),
    ).toEqual({ agentId: "a1", kind: "agent-message" });
  });
});
