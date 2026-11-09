import { isTurnBoundary, isTurnTrigger } from "../turn-membership";
import {
  getStreamItemMessageId,
  type StreamItem,
  type ThoughtItem,
  type ToolCallItem,
} from "@/types/stream";
import { summarizeToolCalls, type OverviewSummary } from "@/tool-calls/detail-level/overview/model";

export interface TurnSummary {
  tools: OverviewSummary;
}

export interface CollapsedTurn {
  /** The input or first loaded row that carries the turn's summary line. */
  hostId: string;
  expanded: boolean;
  summary: TurnSummary;
}

export interface TurnCollapse {
  tail: StreamItem[];
  turnsByHostId: ReadonlyMap<string, CollapsedTurn>;
  /** Rows of expanded turns, which render inside the turn's indent rail. */
  nestedItemIds: ReadonlySet<string>;
  /** The turn a folded message belongs to, for surfaces that must reveal it. */
  hostIdByFoldedMessageId: ReadonlyMap<string, string>;
  /** Mounted rows replaced by a closed turn's host, for preserving the reading position. */
  hostIdByHiddenRowId: ReadonlyMap<string, string>;
}

export interface CollapseTurnsInput {
  tail: StreamItem[];
  /** The latest turn is still producing output, so it stays unfolded. */
  isLatestTurnOpen: boolean;
  expandedHostIds: ReadonlySet<string>;
  /** The calls a tool-call group row stands for; undefined for a single call. */
  getGroupedCalls: (itemId: string) => readonly (ToolCallItem | ThoughtItem)[] | undefined;
  /**
   * Whether a host's turn takes in the turns the agent then started on its own (a task
   * notification, a background wake) up to the next input, rather than ending at its own run.
   */
  spansWakes?: (host: StreamItem) => boolean;
}

const EMPTY_TURNS: ReadonlyMap<string, CollapsedTurn> = new Map();
const EMPTY_IDS: ReadonlySet<string> = new Set();
const EMPTY_HOSTS: ReadonlyMap<string, string> = new Map();

function summarizeTurn(
  items: readonly StreamItem[],
  getGroupedCalls: CollapseTurnsInput["getGroupedCalls"],
): TurnSummary {
  const calls: (ToolCallItem | ThoughtItem)[] = [];
  for (const item of items) {
    if ((item.kind === "tool_call" || item.kind === "thought") && !isTurnTrigger(item))
      calls.push(...(getGroupedCalls(item.id) ?? [item]));
  }
  return { tools: summarizeToolCalls(calls) };
}

function hasWork(summary: TurnSummary): boolean {
  const { paseoActions, thoughtCount: _thoughtCount, ...counts } = summary.tools;
  return Object.keys(paseoActions).length > 0 || Object.values(counts).some((count) => count > 0);
}

function staysVisibleWhenCollapsed(item: StreamItem): boolean {
  return isTurnTrigger(item) || item.kind === "compaction";
}

function findLastAssistantIndex(tail: StreamItem[], start: number, end: number): number {
  for (let index = end - 1; index >= start; index -= 1) {
    if (tail[index]?.kind === "assistant_message") return index;
  }
  return -1;
}

/** The first row after `start` that opens another turn, or `end`. */
function nextTurnStart(tail: StreamItem[], start: number, end: number): number {
  for (let index = start + 1; index < end; index += 1) {
    if (isTurnBoundary(tail[index - 1]!, tail[index]!)) return index;
  }
  return end;
}

/** The first row of the run's last turn, or `start` when the run is one turn. */
function lastTurnStart(tail: StreamItem[], start: number, end: number): number {
  for (let index = end - 1; index > start; index -= 1) {
    if (isTurnBoundary(tail[index - 1]!, tail[index]!)) return index;
  }
  return start;
}

/**
 * Folds each answered turn into its user message: everything the agent did before its last
 * message collapses into one summary line, and that message stays in the chat. A turn folds
 * only once it is complete, its user message is loaded, and it sent messages or called tools
 * before its reply. Reasoning is revealed only when the turn opens. A host that spans wakes
 * folds the turns the agent then started on its own as well, keeping only the last reply.
 */
export function collapseTurns(input: CollapseTurnsInput): TurnCollapse {
  const { tail } = input;
  const output: StreamItem[] = [];
  const turnsByHostId = new Map<string, CollapsedTurn>();
  const nestedItemIds = new Set<string>();
  const hostIdByFoldedMessageId = new Map<string, string>();
  const hostIdByHiddenRowId = new Map<string, string>();

  let runStart = 0;
  const flushRun = (runEnd: number) => {
    const host = tail[runStart - 1];
    // A run that spans wakes and is still working folds the turns it finished; the live one
    // stays open below them.
    const foldEnd =
      runEnd === tail.length && input.isLatestTurnOpen
        ? lastTurnStart(tail, runStart, runEnd)
        : runEnd;
    const replyIndex = findLastAssistantIndex(tail, runStart, foldEnd);
    if (!host || (host.kind !== "user_message" && host.kind !== "tool_call") || replyIndex < 0) {
      output.push(...tail.slice(runStart, runEnd));
      return;
    }
    // The reply keeps the rows after it in its own turn; later wakes that sent no message fold.
    const replyEnd = nextTurnStart(tail, replyIndex, foldEnd);
    const before = tail.slice(runStart, replyIndex);
    const after = tail.slice(replyEnd, foldEnd);
    const folded = after.length ? [...before, ...after] : before;
    if (folded.length === 0) {
      output.push(...tail.slice(runStart, runEnd));
      return;
    }
    const summary = summarizeTurn(folded, input.getGroupedCalls);
    if (!hasWork(summary) && !folded.some((item) => item.kind === "assistant_message")) {
      output.push(...tail.slice(runStart, runEnd));
      return;
    }
    const expanded = input.expandedHostIds.has(host.id);
    turnsByHostId.set(host.id, { hostId: host.id, expanded, summary });
    const reveal = (items: StreamItem[]) =>
      expanded
        ? items.flatMap<StreamItem>((item) =>
            item.kind === "tool_call" || item.kind === "thought"
              ? [...(input.getGroupedCalls(item.id) ?? [item])]
              : [item],
          )
        : items;
    const shown = (items: StreamItem[]) => {
      const revealed = reveal(items);
      for (const item of revealed) {
        if (staysVisibleWhenCollapsed(item)) continue;
        hostIdByFoldedMessageId.set(getStreamItemMessageId(item), host.id);
        if (expanded) nestedItemIds.add(item.id);
        else hostIdByHiddenRowId.set(item.id, host.id);
      }
      return expanded ? revealed : revealed.filter((item) => staysVisibleWhenCollapsed(item));
    };
    output.push(...shown(before));
    output.push(...tail.slice(replyIndex, replyEnd));
    output.push(...shown(after));
    output.push(...tail.slice(foldEnd, runEnd));
  };

  for (let index = 0; index < tail.length; index += 1) {
    const item = tail[index]!;
    if (!(index === 0 && isTurnTrigger(item)) && !isTurnBoundary(tail[index - 1] ?? null, item))
      continue;
    // A turn the agent started on its own belongs to a host whose turn spans wakes.
    const host = tail[runStart - 1];
    if (!isTurnTrigger(item) && host && input.spansWakes?.(host)) continue;
    flushRun(index);
    output.push(item);
    runStart = index + 1;
  }
  flushRun(tail.length);

  if (turnsByHostId.size === 0) {
    return {
      tail,
      turnsByHostId: EMPTY_TURNS,
      nestedItemIds: EMPTY_IDS,
      hostIdByFoldedMessageId: EMPTY_HOSTS,
      hostIdByHiddenRowId: EMPTY_HOSTS,
    };
  }
  return {
    tail:
      output.length === tail.length && output.every((item, index) => item === tail[index])
        ? tail
        : output,
    turnsByHostId,
    nestedItemIds,
    hostIdByFoldedMessageId,
    hostIdByHiddenRowId,
  };
}
