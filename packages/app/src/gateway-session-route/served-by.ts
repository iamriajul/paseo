import { isCacheWarmPrompt, type GatewayAccountChange } from "@getpaseo/protocol/agent-cache-warm";
import type { StreamItem } from "@/types/stream";

/**
 * How far a change's Gateway time may sit before the prompt it belongs to. The Gateway stamps a
 * switch when the turn's request reaches it, which is after the prompt was sent; the slack covers
 * clock drift between the Gateway host and the one that stamped the prompt.
 */
export const SERVED_BY_PLACEMENT_SLACK_MS = 5_000;

/** The account line drawn above one prompt: who answered it, and how the session got there. */
export interface ServedByLine {
  account: string;
  /** The account the session left during this turn; absent when it did not switch. */
  from?: string;
  reason?: string;
  statusCode?: number;
  /** The switch made a request write the whole context again. */
  cacheLost: boolean;
}

/**
 * Places each account change above the prompt whose turn it happened in: the latest prompt sent
 * before it. A change inside a turn the user did not write (a warm-up ping, a restart's resume)
 * goes above the next prompt the user writes, the first the new account answers for them; until
 * then it has no row. Several changes on one prompt read as one move, from the first account
 * left to the one that answered last. A change older than every loaded prompt has no row either.
 */
export function placeServedByLines(
  rows: readonly StreamItem[],
  changes: readonly GatewayAccountChange[] | undefined,
): ReadonlyMap<string, ServedByLine> {
  const lines = new Map<string, ServedByLine>();
  if (!changes?.length) return lines;
  // Every turn start, the user's and the daemon's, so a change can tell whose turn it fell in.
  const turns = rows
    .filter(
      (row): row is Extract<StreamItem, { kind: "user_message" }> => row.kind === "user_message",
    )
    .map((row) => ({
      id: row.id,
      at: row.timestamp.getTime(),
      byUser: !row.resume && !isCacheWarmPrompt(row.text),
    }))
    .sort((a, b) => a.at - b.at);
  for (const change of changes) {
    const at = Date.parse(change.at);
    if (!Number.isFinite(at)) continue;
    const prompt = promptForChange(turns, at + SERVED_BY_PLACEMENT_SLACK_MS);
    if (!prompt) continue;
    const earlier = lines.get(prompt.id);
    const from = earlier?.from ?? change.from;
    lines.set(prompt.id, {
      account: change.account,
      ...(from ? { from } : {}),
      ...(change.reason ? { reason: change.reason } : {}),
      ...(change.statusCode ? { statusCode: change.statusCode } : {}),
      cacheLost: Boolean(earlier?.cacheLost) || change.missAt !== undefined,
    });
  }
  return lines;
}

/** Same lines on the same prompts: lets the stream view keep its rows when nothing moved. */
export function sameServedByLines(
  a: ReadonlyMap<string, ServedByLine>,
  b: ReadonlyMap<string, ServedByLine>,
): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [id, line] of a) {
    const other = b.get(id);
    if (
      !other ||
      other.account !== line.account ||
      other.from !== line.from ||
      other.reason !== line.reason ||
      other.statusCode !== line.statusCode ||
      other.cacheLost !== line.cacheLost
    ) {
      return false;
    }
  }
  return true;
}

interface TurnStart {
  id: string;
  at: number;
  byUser: boolean;
}

/**
 * The user's prompt a change at `limit` belongs to: the turn it fell in when the user wrote it,
 * else the user's next prompt after that turn. A loop rather than findLast: older Hermes builds
 * lack the newer Array methods.
 */
function promptForChange(turns: readonly TurnStart[], limit: number): TurnStart | null {
  let index = -1;
  for (let i = 0; i < turns.length && turns[i]!.at <= limit; i += 1) index = i;
  if (index === -1) return null;
  for (let i = index; i < turns.length; i += 1) {
    if (turns[i]!.byUser) return turns[i]!;
  }
  return null;
}

/** "Served by B · switched from A (quota, 429) · cache lost". */
export function describeServedBy(line: ServedByLine): string {
  const parts = [`Served by ${line.account}`];
  if (line.from) {
    const cause = [line.reason, line.statusCode].filter(Boolean).join(", ");
    parts.push(cause ? `switched from ${line.from} (${cause})` : `switched from ${line.from}`);
  }
  if (line.cacheLost) parts.push("cache lost");
  return parts.join(" · ");
}
