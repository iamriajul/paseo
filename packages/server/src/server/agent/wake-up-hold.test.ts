import pino from "pino";
import { describe, expect, test } from "vitest";
import type { AgentPromptInput } from "./agent-sdk-types.js";
import type { WarmUpAccountBlock } from "./gateway/warm-up-account.js";
import {
  WAKE_UP_HOLD_HORIZON_MS,
  WAKE_UP_HOLD_RETURN_SLACK_MS,
  WakeUpHolds,
  heldWakeUpSend,
  planAgentMessageHold,
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
    /** While set, account reads wait for it. */
    readGate: null as Promise<void> | null,
    reads: 0,
    busy: false,
    lastRequestAtMs: (START - 2 * MINUTE) as number | null,
    cacheExpiresAtMs: (START + 58 * MINUTE) as number | null,
  };
  const saved: HeldWakeUp[][] = [];
  const redelivered: HeldWakeUp[] = [];
  /** The saved holds as they stood when each redelivery began. */
  const savedAtRedelivery: (HeldWakeUp[] | undefined)[] = [];
  const views: (WakeUpHoldView | null)[] = [];
  const started: HeldWakeUp[] = [];
  const holds = new WakeUpHolds({
    readBlock: async () => {
      state.reads += 1;
      if (state.readGate) await state.readGate;
      if (state.block instanceof Error) throw state.block;
      return state.block;
    },
    cacheExpiresAtMs: async () => state.cacheExpiresAtMs,
    lastRequestAtMs: () => state.lastRequestAtMs,
    isBusy: () => state.busy,
    store: {
      load: async () => options?.saved ?? [],
      save: async (entries) => {
        // A file write finishes on a later turn of the event loop, not in the same microtask run.
        await new Promise<void>((resolve) => setImmediate(resolve));
        saved.push(entries.map((entry) => ({ ...entry })));
      },
    },
    redeliver: async (entry) => {
      savedAtRedelivery.push(saved.at(-1));
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
    const tracked = {
      outcome: null as WakeUpHoldOutcome | null,
      /** The saved holds as they stood when the hold resolved. */
      savedThen: undefined as HeldWakeUp[] | undefined,
    };
    void promise.then((outcome) => {
      tracked.outcome = outcome;
      tracked.savedThen = saved.at(-1);
      return outcome;
    });
    return tracked;
  }

  return {
    holds,
    state,
    saved,
    redelivered,
    savedAtRedelivery,
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
    // The file dropped it before the send began: a crash during the send does not send it twice.
    expect(h.savedAtRedelivery).toEqual([[]]);
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

  test("a wake-up that starts holding while the daemon stops is saved before it is deferred", async () => {
    const h = createHarness();
    h.state.block = cooldown(START + 10 * MINUTE);
    let readsDone!: () => void;
    h.state.readGate = new Promise<void>((resolve) => {
      readsDone = resolve;
    });
    const restart = h.track(
      h.holds.hold({ agentId: "a1", kind: "restart", redeliver: { text: "Resume working." } }),
    );
    await h.settle();
    // Shutdown saves the holds while this one is still reading the account.
    await h.holds.close();
    readsDone();
    await h.settle();
    expect(restart.outcome).toEqual({ status: "deferred" });
    expect(h.saved.at(-1)?.map((entry) => [entry.kind, entry.redeliver?.text])).toEqual([
      ["restart", "Resume working."],
    ]);
  });

  test("a held wake-up goes out only once the saved holds no longer list it", async () => {
    const h = createHarness();
    h.state.block = cooldown(START + 2 * MINUTE);
    const message = h.track(
      h.holds.hold({ agentId: "a1", kind: "agent-message", redeliver: { text: "check the CI" } }),
    );
    await h.advance(MINUTE);
    expect(h.saved.at(-1)?.map((entry) => entry.kind)).toEqual(["agent-message"]);
    h.state.block = null;
    await h.advance(2 * MINUTE);
    expect(message.outcome).toMatchObject({ status: "send" });
    expect(message.savedThen).toEqual([]);
  });
});

describe("planAgentMessageHold", () => {
  const options = {
    recipientId: "a1",
    unarchive: true,
    activeTurnBehavior: "steer" as const,
    clearPendingPermissions: true,
  };
  const message = (id: string, prompt: AgentPromptInput) => ({
    kind: "agent-message" as const,
    messageId: id,
    prompt,
  });
  const notification = (id: string, prompt: string) => ({
    kind: "agent-notification" as const,
    messageId: id,
    prompt,
  });

  test("saves a batch of plain-text agent messages for a restart, with its send options", () => {
    expect(
      planAgentMessageHold({
        ...options,
        sessionMode: "plan",
        parts: [message("m1", "<m1/>"), message("m2", "<m2/>")],
      }),
    ).toEqual({
      request: {
        agentId: "a1",
        kind: "agent-message",
        redeliver: {
          text: "<m1/>\n\n<m2/>",
          clientMessageId: "m1",
          unarchive: true,
          activeTurnBehavior: "steer",
          sessionMode: "plan",
          clearPendingPermissions: true,
        },
      },
      sendAtShutdown: null,
    });
  });

  test("never saves a notification, which its finish subscription re-sends", () => {
    expect(planAgentMessageHold({ ...options, parts: [notification("n1", "<n1/>")] })).toEqual({
      request: { agentId: "a1", kind: "agent-notification" },
      sendAtShutdown: null,
    });
  });

  test("saves the message half of a batch with a notification, and sends the notification at shutdown", () => {
    const plan = planAgentMessageHold({
      ...options,
      parts: [message("m1", "<m1/>"), notification("n1", "<n1/>")],
    });
    expect(plan.request).toMatchObject({
      kind: "agent-message",
      redeliver: { text: "<m1/>", clientMessageId: "m1" },
    });
    expect(plan.request.unsavedMessageIds).toBeUndefined();
    expect(plan.sendAtShutdown).toBe("<n1/>");
  });

  test("does not write a prompt with images to disk, and names it as unsaved", () => {
    const image = [{ type: "image" as const, data: "aGk=", mimeType: "image/png" }];
    expect(planAgentMessageHold({ ...options, parts: [message("m1", image)] })).toEqual({
      request: { agentId: "a1", kind: "agent-message", unsavedMessageIds: ["m1"] },
      sendAtShutdown: null,
    });
    const mixed = planAgentMessageHold({
      ...options,
      parts: [message("m1", "<m1/>"), message("m2", image)],
    });
    expect(mixed.request).toMatchObject({
      redeliver: { text: "<m1/>" },
      unsavedMessageIds: ["m2"],
    });
    expect(mixed.sendAtShutdown).toEqual(image);
  });
});

describe("heldWakeUpSend", () => {
  const entry: HeldWakeUp = {
    id: "h1",
    agentId: "a1",
    kind: "agent-message",
    coalesceKey: null,
    reason: "cooldown",
    account: "s***b",
    until: iso(START),
    heldAt: iso(START),
    deadline: iso(START + WAKE_UP_HOLD_HORIZON_MS),
    repeats: 0,
  };

  test("re-sends an agent message as the live path would: unarchiving, with its turn behaviour", () => {
    expect(
      heldWakeUpSend({
        ...entry,
        redeliver: {
          text: "<m1/>",
          clientMessageId: "m1",
          unarchive: true,
          activeTurnBehavior: "interrupt",
          clearPendingPermissions: true,
        },
      }),
    ).toEqual({
      prompt: "<m1/>",
      unarchive: true,
      activeTurnBehavior: "interrupt",
      clearPendingPermissions: true,
      runOptions: { clientMessageId: "m1" },
    });
  });

  test("re-sends a restart resume as the live restart dispatch does", () => {
    expect(
      heldWakeUpSend({
        ...entry,
        kind: "restart",
        redeliver: { text: "Resume working.", unarchive: false },
      }),
    ).toEqual({
      prompt: "Resume working.",
      unarchive: false,
      runOptions: { resume: { reason: "restart" } },
    });
  });

  test("has nothing to send for a hold with no saved prompt", () => {
    expect(heldWakeUpSend({ ...entry, kind: "heartbeat" })).toBeNull();
  });
});
