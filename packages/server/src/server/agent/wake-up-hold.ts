// wake-up-hold.ts — hold an automated wake-up while the CLIProxyAPI account serving the agent is
// blocked and due back soon.
//
// A request to a blocked account makes the Gateway switch the session to another account, which
// re-reads the whole context cold. Nothing waits on an automated wake-up (a heartbeat, an agent
// message or notification, a restart resume), so when the account is back soon the wake-up waits
// for it and the next request reads the cache it left. Past the horizon, with no return time, or
// when the check cannot answer, the wake-up goes out at once: the miss is cheaper than a stranded
// agent. A message a person typed never comes through here.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Logger } from "pino";
import { z } from "zod";
import { writeJsonFileAtomic } from "../atomic-file.js";
import type { AgentPromptInput, AgentRunOptions } from "./agent-sdk-types.js";
import type { WarmUpAccountBlock } from "./gateway/warm-up-account.js";
import { WARM_UP_ACCOUNT_CHECK_MAX_AGE_MS } from "./gateway/warm-up-account.js";

/**
 * The longest a wake-up waits for its account. CLIProxyAPI cools an account down for seconds to
 * minutes after a 429, and names the reset of a used-up quota window; both are within reach
 * here. A wait longer than this delays work an agent was asked to do by more than the miss is
 * worth, and a 1h cache left alone that long is close to expiring anyway.
 */
export const WAKE_UP_HOLD_HORIZON_MS = 30 * 60_000;

/**
 * Delivery waits this long past the account's reported return, so the re-check reads the
 * Gateway after it (the check's shared cache may hold a read up to its maximum age).
 */
export const WAKE_UP_HOLD_RETURN_SLACK_MS = WARM_UP_ACCOUNT_CHECK_MAX_AGE_MS + 5_000;

/** A held wake-up still has to reach the account this long before the cache expires. */
export const WAKE_UP_HOLD_CACHE_MARGIN_MS = 30_000;

export const wakeUpKindSchema = z.enum([
  "heartbeat",
  "agent-message",
  "agent-notification",
  "restart",
]);
export type WakeUpKind = z.infer<typeof wakeUpKindSchema>;

const heldWakeUpSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  kind: wakeUpKindSchema,
  coalesceKey: z.string().nullable(),
  reason: z.enum(["quota", "cooldown"]),
  account: z.string(),
  until: z.string(),
  window: z.string().optional(),
  heldAt: z.string(),
  /** Never held past this: `heldAt` plus the horizon. */
  deadline: z.string(),
  /** Later fires of the same wake-up that joined this hold instead of queuing. */
  repeats: z.number(),
  /**
   * The prompt to send after a daemon restart, for a wake-up nothing else re-sends. Absent for a
   * heartbeat (its schedule fires again) and a notification (its finish subscription re-sends).
   */
  redeliver: z.object({ text: z.string(), clientMessageId: z.string().optional() }).optional(),
});
export type HeldWakeUp = z.infer<typeof heldWakeUpSchema>;

/** What the agent's snapshot shows while at least one wake-up is held. */
export interface WakeUpHoldView {
  kind: WakeUpKind;
  reason: "quota" | "cooldown";
  account: string;
  until: string;
  window?: string;
  heldAt: string;
  /** Wake-ups waiting, counting coalesced repeats. */
  count: number;
}

export interface WakeUpHoldRequest {
  agentId: string;
  kind: WakeUpKind;
  /** Repeats of one wake-up (a heartbeat's schedule) join the hold already waiting. */
  coalesceKey?: string;
  redeliver?: HeldWakeUp["redeliver"];
  signal?: AbortSignal;
}

/**
 * - "send": go out now (nothing blocks it, it waited and the account is back, or it gave up).
 * - "coalesced": the same wake-up is already held; this fire is dropped and counted on it.
 * - "deferred": the daemon stopped while it was held, and it goes out after the restart instead:
 *   the saved prompt is re-sent, or a heartbeat's schedule fires again. A notification is sent at
 *   shutdown, as before, because its finish subscription counts it delivered once dispatched.
 */
export type WakeUpHoldOutcome =
  | { status: "send"; heldMs: number }
  | { status: "coalesced" }
  | { status: "deferred" };

export interface WakeUpHoldStore {
  load(): Promise<HeldWakeUp[]>;
  save(entries: readonly HeldWakeUp[]): Promise<void>;
}

export interface WakeUpHoldDependencies {
  readBlock(agentId: string): Promise<WarmUpAccountBlock | null>;
  /** When the agent's prompt cache expires, or null when unknown. */
  cacheExpiresAtMs(agentId: string): Promise<number | null>;
  /** When the agent last sent a request of its own; one after the hold began releases it. */
  lastRequestAtMs(agentId: string): number | null;
  /** A running turn already talks to the Gateway, so a wake-up steered into it adds no request. */
  isBusy(agentId: string): boolean;
  store: WakeUpHoldStore;
  /** Sends a restored hold's prompt once it may go out. */
  redeliver(entry: HeldWakeUp): Promise<void>;
  /** The agent's hold changed; `started` is set when a new wake-up began waiting. */
  onChange(agentId: string, view: WakeUpHoldView | null, started: HeldWakeUp | null): void;
  logger: Logger;
  now?: () => number;
  schedule?: (delayMs: number, callback: () => void) => () => void;
}

/** A wake-up to hold: the account the Gateway says is blocked, and when it goes out. */
export interface WakeUpHoldRelease {
  releaseMs: number;
  reason: "quota" | "cooldown";
  account: string;
  until: string;
}

/**
 * When a wake-up held now goes out, or null to send it at once. Only an account the Gateway says
 * is out of quota or cooling down, with a return time, holds. A moved, untracked or unlisted
 * session would not get its cache back by waiting, and an unconfirmed check sends.
 */
export function resolveWakeUpHoldRelease(input: {
  block: WarmUpAccountBlock | null;
  nowMs: number;
  deadlineMs: number;
  cacheExpiresAtMs: number | null;
}): WakeUpHoldRelease | null {
  const { block } = input;
  if (!block || (block.reason !== "quota" && block.reason !== "cooldown") || !block.until) {
    return null;
  }
  const untilMs = Date.parse(block.until);
  if (!Number.isFinite(untilMs) || untilMs <= input.nowMs) return null;
  const releaseMs = untilMs + WAKE_UP_HOLD_RETURN_SLACK_MS;
  if (releaseMs > input.deadlineMs) return null;
  // The account back after the cache expired would miss anyway; the hold would only delay.
  if (
    input.cacheExpiresAtMs !== null &&
    releaseMs > input.cacheExpiresAtMs - WAKE_UP_HOLD_CACHE_MARGIN_MS
  ) {
    return null;
  }
  return { releaseMs, reason: block.reason, account: block.account, until: block.until };
}

/**
 * The hold for one batch of agent messages. Only a batch of plain-text messages from other agents
 * is saved for a restart: a notification's finish subscription re-sends it itself, and a prompt
 * with images is not written to disk.
 */
export function holdRequestForAgentMessages(batch: {
  recipientId: string;
  sourceKinds: readonly ("agent-message" | "agent-notification")[];
  messageIds: readonly string[];
  prompt: AgentPromptInput;
}): WakeUpHoldRequest {
  const onlyMessages = batch.sourceKinds.every((kind) => kind === "agent-message");
  const onlyNotifications = batch.sourceKinds.every((kind) => kind === "agent-notification");
  return {
    agentId: batch.recipientId,
    kind: onlyNotifications ? "agent-notification" : "agent-message",
    ...(onlyMessages && typeof batch.prompt === "string"
      ? {
          redeliver: {
            text: batch.prompt,
            ...(batch.messageIds[0] ? { clientMessageId: batch.messageIds[0] } : {}),
          },
        }
      : {}),
  };
}

/** Run options for re-sending a restored hold: a restart resume says so, a message keeps its id. */
export function heldWakeUpRunOptions(entry: HeldWakeUp): AgentRunOptions | undefined {
  if (entry.kind === "restart") return { resume: { reason: "restart" } };
  const clientMessageId = entry.redeliver?.clientMessageId;
  return clientMessageId ? { clientMessageId } : undefined;
}

const KIND_LABELS: Record<WakeUpKind, string> = {
  heartbeat: "Heartbeat",
  "agent-message": "Agent message",
  "agent-notification": "Agent notification",
  restart: "Restart resume",
};

/**
 * The timeline line for a wake-up that began waiting: "Heartbeat held: s***b is cooling down,
 * back at 14:20 UTC. It goes out then, so the cache is not re-read on another account." The
 * daemon writes the clock in its own time zone and names it.
 */
export function describeHeldWakeUp(entry: HeldWakeUp): string {
  const account = entry.account || "the serving account";
  const state =
    entry.reason === "quota"
      ? `used up its ${entry.window ? `${entry.window} ` : ""}quota`
      : "is cooling down";
  const back = new Date(entry.until).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
  return `${KIND_LABELS[entry.kind]} held: ${account} ${state}, back at ${back}. It goes out then, so the cache is not re-read on another account.`;
}

export function createJsonWakeUpHoldStore(filePath: string): WakeUpHoldStore {
  return {
    async load() {
      let raw: string;
      try {
        raw = await readFile(filePath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      return z.array(heldWakeUpSchema).parse(JSON.parse(raw));
    },
    save: (entries) => writeJsonFileAtomic(filePath, entries),
  };
}

interface Waiter {
  entry: HeldWakeUp;
  wake(): void;
}

export class WakeUpHolds {
  private readonly deps: WakeUpHoldDependencies;
  private readonly now: () => number;
  private readonly schedule: (delayMs: number, callback: () => void) => () => void;
  private readonly waiters = new Map<string, Waiter>();
  private saving: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(deps: WakeUpHoldDependencies) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.schedule =
      deps.schedule ??
      ((delayMs, callback) => {
        const timer = setTimeout(callback, delayMs);
        timer.unref?.();
        return () => clearTimeout(timer);
      });
  }

  /** Resolves when the wake-up may go out, or at once when it joined a hold already waiting. */
  async hold(request: WakeUpHoldRequest): Promise<WakeUpHoldOutcome> {
    const { agentId } = request;
    if (this.closed || this.deps.isBusy(agentId)) return { status: "send", heldMs: 0 };
    if (this.joinCoalesced(request)) return { status: "coalesced" };
    const nowMs = this.now();
    const deadlineMs = nowMs + WAKE_UP_HOLD_HORIZON_MS;
    const block = await this.readBlock(agentId);
    const release = resolveWakeUpHoldRelease({
      block,
      nowMs,
      deadlineMs,
      cacheExpiresAtMs: await this.deps.cacheExpiresAtMs(agentId),
    });
    if (!release) return { status: "send", heldMs: 0 };
    // Another fire of the same wake-up may have started holding during the read.
    if (this.joinCoalesced(request)) return { status: "coalesced" };
    const entry: HeldWakeUp = {
      id: randomUUID(),
      agentId,
      kind: request.kind,
      coalesceKey: request.coalesceKey ?? null,
      reason: release.reason,
      account: release.account,
      until: release.until,
      ...(block?.window ? { window: block.window } : {}),
      heldAt: new Date(nowMs).toISOString(),
      deadline: new Date(deadlineMs).toISOString(),
      repeats: 0,
      ...(request.redeliver ? { redeliver: request.redeliver } : {}),
    };
    this.deps.logger.info(
      {
        agentId,
        kind: entry.kind,
        reason: entry.reason,
        account: entry.account,
        until: entry.until,
      },
      "Holding automated wake-up until the serving account is back",
    );
    await this.waitForRelease(entry, release.releaseMs, request.signal);
    if (this.closed && (entry.redeliver || entry.kind === "heartbeat"))
      return { status: "deferred" };
    return { status: "send", heldMs: this.now() - nowMs };
  }

  /** The agent's state changed: a request of its own or a running turn releases its holds. */
  noteActivity(agentId: string): void {
    for (const waiter of this.waiters.values()) {
      if (waiter.entry.agentId === agentId && this.released(waiter.entry)) waiter.wake();
    }
  }

  /**
   * Picks up the holds a previous daemon left. A hold with a prompt to re-send waits again from a
   * fresh check, then sends; the others are dropped because their source fires again.
   */
  async restore(): Promise<void> {
    let entries: HeldWakeUp[];
    try {
      entries = await this.deps.store.load();
    } catch (error) {
      this.deps.logger.warn({ err: error }, "Could not read held wake-ups; starting with none");
      entries = [];
    }
    const resumed = entries.filter((entry) => entry.redeliver);
    for (const entry of resumed) this.waiters.set(entry.id, { entry, wake: () => {} });
    await this.persist();
    for (const entry of resumed) {
      void this.resume(entry).catch((error) =>
        this.deps.logger.error(
          { err: error, agentId: entry.agentId },
          "Could not send a held wake-up",
        ),
      );
    }
  }

  /**
   * Releases every hold so shutdown is not kept waiting, after saving them for the next start;
   * nothing is removed from the saved list after this.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    const saved = this.persist();
    this.closed = true;
    for (const waiter of this.waiters.values()) waiter.wake();
    await saved;
  }

  /** What an agent's snapshot shows, or null when nothing is held for it. */
  view(agentId: string): WakeUpHoldView | null {
    const entries = [...this.waiters.values()]
      .map((waiter) => waiter.entry)
      .filter((entry) => entry.agentId === agentId)
      .sort((a, b) => Date.parse(a.heldAt) - Date.parse(b.heldAt));
    const first = entries[0];
    if (!first) return null;
    const latest = entries.reduce((best, entry) =>
      Date.parse(entry.until) > Date.parse(best.until) ? entry : best,
    );
    return {
      kind: first.kind,
      reason: latest.reason,
      account: latest.account,
      until: latest.until,
      ...(latest.window ? { window: latest.window } : {}),
      heldAt: first.heldAt,
      count: entries.reduce((sum, entry) => sum + 1 + entry.repeats, 0),
    };
  }

  private async resume(entry: HeldWakeUp): Promise<void> {
    try {
      const block = this.deps.isBusy(entry.agentId) ? null : await this.readBlock(entry.agentId);
      const release = resolveWakeUpHoldRelease({
        block,
        nowMs: this.now(),
        deadlineMs: Date.parse(entry.deadline),
        cacheExpiresAtMs: await this.deps.cacheExpiresAtMs(entry.agentId),
      });
      if (release && !this.closed) {
        entry.until = release.until;
        entry.account = release.account;
        // The timeline already says this wake-up is held; a restart does not say it again.
        await this.waitForRelease(entry, release.releaseMs, undefined, { announce: false });
      }
    } finally {
      this.waiters.delete(entry.id);
      this.changed(entry.agentId, null);
    }
    if (!this.closed) await this.deps.redeliver(entry);
  }

  private async waitForRelease(
    entry: HeldWakeUp,
    firstReleaseMs: number,
    signal?: AbortSignal,
    options?: { announce: boolean },
  ): Promise<void> {
    let releaseMs = firstReleaseMs;
    this.waiters.set(entry.id, { entry, wake: () => {} });
    this.changed(entry.agentId, options?.announce === false ? null : entry);
    try {
      while (!this.closed) {
        if (signal?.aborted) return;
        await this.sleepUntil(entry, releaseMs, signal);
        if (this.closed || signal?.aborted || this.released(entry)) return;
        const block = await this.readBlock(entry.agentId);
        if (this.closed || signal?.aborted || this.released(entry)) return;
        const next = resolveWakeUpHoldRelease({
          block,
          nowMs: this.now(),
          deadlineMs: Date.parse(entry.deadline),
          cacheExpiresAtMs: await this.deps.cacheExpiresAtMs(entry.agentId),
        });
        if (!next) return;
        // Still blocked with a later return inside the horizon: keep waiting for it.
        entry.until = next.until;
        entry.account = next.account;
        releaseMs = next.releaseMs;
        this.changed(entry.agentId, null);
      }
    } finally {
      this.waiters.delete(entry.id);
      this.changed(entry.agentId, null);
    }
  }

  private sleepUntil(entry: HeldWakeUp, releaseMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        cancel();
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const cancel = this.schedule(Math.max(0, releaseMs - this.now()), finish);
      signal?.addEventListener("abort", finish, { once: true });
      const waiter = this.waiters.get(entry.id);
      if (waiter) waiter.wake = finish;
    });
  }

  private released(entry: HeldWakeUp): boolean {
    if (this.deps.isBusy(entry.agentId)) return true;
    const lastRequestAtMs = this.deps.lastRequestAtMs(entry.agentId);
    return lastRequestAtMs !== null && lastRequestAtMs > Date.parse(entry.heldAt);
  }

  private async readBlock(agentId: string): Promise<WarmUpAccountBlock | null> {
    try {
      return await this.deps.readBlock(agentId);
    } catch (error) {
      this.deps.logger.warn({ err: error, agentId }, "Wake-up hold could not read the account");
      return null;
    }
  }

  /** Counts the wake-up on a hold of the same wake-up already waiting; true when it joined one. */
  private joinCoalesced(request: WakeUpHoldRequest): boolean {
    if (!request.coalesceKey) return false;
    for (const waiter of this.waiters.values()) {
      const { entry } = waiter;
      if (entry.agentId === request.agentId && entry.coalesceKey === request.coalesceKey) {
        entry.repeats += 1;
        this.changed(entry.agentId, null);
        return true;
      }
    }
    return false;
  }

  private changed(agentId: string, started: HeldWakeUp | null): void {
    if (this.closed) return;
    void this.persist();
    try {
      this.deps.onChange(agentId, this.view(agentId), started);
    } catch (error) {
      this.deps.logger.warn({ err: error, agentId }, "Could not publish a wake-up hold");
    }
  }

  private persist(): Promise<void> {
    const entries = [...this.waiters.values()].map((waiter) => structuredClone(waiter.entry));
    this.saving = this.saving
      .catch(() => undefined)
      .then(() => this.deps.store.save(entries))
      .catch((error) => this.deps.logger.warn({ err: error }, "Could not save held wake-ups"));
    return this.saving;
  }
}
