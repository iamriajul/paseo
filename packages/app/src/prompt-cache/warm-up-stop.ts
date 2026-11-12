import {
  isAvoidablePromptCacheMiss,
  type CacheWarmStop,
  type PromptCacheHistoryEntry,
} from "@getpaseo/protocol/agent-cache-warm";
import type { AgentCacheWarmPause, AgentWakeUpHold } from "@getpaseo/protocol/messages";
import { formatResetTime } from "@/usage/format";

/** What a warm-up stop or an account pause says about the account; both share the vocabulary. */
type WarmUpReasonFacts = Pick<CacheWarmStop, "reason" | "account" | "until" | "window">;

/** Reasons that come from the account check; the rest are the warm-up's own limits. */
const ACCOUNT_REASONS = new Set([
  "quota",
  "cooldown",
  "unlisted",
  "moved",
  "untracked",
  "unsupported",
  "unconfirmed",
]);

/**
 * Why the warm-up could not go out, as a clause: "s***b used up its 5h quota (back 14:05)".
 * `until` is judged at `now`: the pill passes the clock, insights pass the stop's own time.
 */
export function describeWarmUpReason(facts: WarmUpReasonFacts, now: number): string {
  const account = facts.account || "the account";
  const until = formatResetTime(facts.until, now);
  const back = until ? ` (back ${until})` : "";
  switch (facts.reason) {
    case "quota":
      return `${account} used up its ${facts.window ? `${facts.window} ` : ""}quota${back}`;
    case "cooldown":
      return `${account} is cooling down${back}`;
    case "unlisted":
      return `${account} no longer serves this model`;
    case "moved":
      return facts.account
        ? `the gateway had already moved this session to ${facts.account}`
        : "the gateway had already moved this session to another account";
    case "untracked":
      return "the gateway no longer tracks this session";
    case "unsupported":
      return "the gateway can't say which account serves this session";
    case "unconfirmed":
      return "couldn't confirm the account could serve (gateway didn't answer)";
    case "capped":
      return "the idle cap was reached";
    case "failed":
      return "the last warm-up didn't reach Anthropic";
    case "parent-answers":
      return "a question waits on the parent agent";
    case "off":
      return "warm-up was switched off";
    default:
      return "the serving account couldn't take it";
  }
}

/** "Warm-up skipped: s***b used up its 5h quota (back 14:05), cache left to expire". */
export function describeWarmUpStop(stop: CacheWarmStop): string {
  const verb = ACCOUNT_REASONS.has(stop.reason) || stop.reason === "failed" ? "skipped" : "stopped";
  const reason = describeWarmUpReason(stop, Date.parse(stop.at));
  return `Warm-up ${verb}: ${reason}, cache left to expire`;
}

/**
 * "Paused · s***b is cooling down (back 17:43) · resumes on your next message". An unanswered
 * check that still has time reads the gateway again instead of waiting for a message.
 */
export function describeAccountPause(pause: AgentCacheWarmPause, now = Date.now()): string {
  const next = pause.retryAt ? "checking again shortly" : "resumes on your next message";
  return `Paused · ${describeWarmUpReason(pause, now)} · ${next}`;
}

const WAKE_UP_KINDS: Record<string, string> = {
  heartbeat: "Heartbeat",
  "agent-message": "Agent message",
  "agent-notification": "Agent notification",
  restart: "Restart resume",
};

/**
 * "Heartbeat held · s***b is cooling down (back 14:20) · goes out when it's back". Automated
 * wake-ups wait for the serving account so the next request reads its cache there.
 */
export function describeWakeUpHold(hold: AgentWakeUpHold, now = Date.now()): string {
  const what =
    hold.count > 1
      ? `${hold.count} wake-ups held`
      : `${WAKE_UP_KINDS[hold.kind] ?? "Wake-up"} held`;
  const goes = hold.count > 1 ? "they go out when it's back" : "goes out when it's back";
  return `${what} · ${describeWarmUpReason(hold, now)} · ${goes}`;
}

/**
 * The stop behind each expired miss, keyed by the request's `at`: the latest stop journaled in
 * the gap before it. A stop after the session's last request is still waiting for that request;
 * `latestOpen` returns it so insights can say why the cache is expiring now.
 */
export function indexWarmUpStops(input: {
  requests: readonly PromptCacheHistoryEntry[];
  stops: readonly CacheWarmStop[];
  cacheWindowMs: number;
}): { byRequest: ReadonlyMap<string, CacheWarmStop>; latestOpen: CacheWarmStop | null } {
  const byRequest = new Map<string, CacheWarmStop>();
  if (input.stops.length === 0) return { byRequest, latestOpen: null };
  const stops = [...input.stops].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const entry of input.requests) {
    if (entry.gapMs === null || entry.gapMs <= input.cacheWindowMs) continue;
    if (!isAvoidablePromptCacheMiss(entry)) continue;
    const endMs = Date.parse(entry.at);
    const startMs = endMs - entry.gapMs;
    const stop = stops.findLast((candidate) => {
      const atMs = Date.parse(candidate.at);
      return atMs >= startMs && atMs <= endMs;
    });
    if (stop) byRequest.set(entry.at, stop);
  }
  const lastAt = input.requests.at(-1)?.at;
  const newest = stops.at(-1) ?? null;
  const latestOpen =
    newest && (!lastAt || Date.parse(newest.at) > Date.parse(lastAt)) ? newest : null;
  return { byRequest, latestOpen };
}
