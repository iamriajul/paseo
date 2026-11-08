import type { AgentMessage } from "@getpaseo/protocol/agent-message";
import type { AgentMessagesDisplay } from "@/hooks/use-settings";
import {
  getStreamItemMessageId,
  type AgentMessageGroup,
  type AgentRowFold,
  type StreamItem,
} from "@/types/stream";

/** The reader's one-by-one choices, kept apart from the persisted display. */
export interface AgentMessageFoldState {
  /** Agent messages shown the other way from the display: full when collapsed, one line when expanded. */
  toggledIds: ReadonlySet<string>;
  /** Group hosts the reader opened. */
  openGroupIds: ReadonlySet<string>;
}

export interface AgentMessageFold {
  /** The rows to draw; a row from another agent carries its `agentFold`. */
  rows: StreamItem[];
  /** Rows a closed group hides, for preserving the reading position. */
  hostIdByHiddenRowId: ReadonlyMap<string, string>;
  /** The group a hidden message belongs to, for surfaces that must reveal it. */
  hostIdByFoldedMessageId: ReadonlyMap<string, string>;
}

export interface FoldAgentMessagesInput {
  rows: StreamItem[];
  display: AgentMessagesDisplay;
  state: AgentMessageFoldState;
}

/** A row another agent sent: a received message, or a finished, errored or permission notice. */
export function agentSenderOf(item: StreamItem): AgentMessage["sender"] | null {
  if (item.kind === "user_message") return item.sender ?? null;
  if (item.kind === "tool_call" && item.payload.source === "agent") {
    return item.payload.data.agentMessage?.sender ?? null;
  }
  return null;
}

const EMPTY_HOSTS: ReadonlyMap<string, string> = new Map();

function foldKey(fold: AgentRowFold): string {
  const group = fold.group
    ? `${fold.group.expanded ? "open" : "closed"}${fold.group.more ? "+" : ""}:${fold.group.memberIds.join(",")}`
    : "";
  return `${fold.line ? "line" : "full"}|${fold.nested ? "nested" : ""}|${group}`;
}

/**
 * The fold travels on the row, so a row whose fold changed reaches the list as a new identity and
 * redraws, and an unchanged one keeps its identity across folds.
 */
const projected = new WeakMap<StreamItem, { key: string; row: StreamItem }>();

function withFold(row: StreamItem, fold: AgentRowFold): StreamItem {
  if (row.kind !== "user_message" && row.kind !== "tool_call") return row;
  const key = foldKey(fold);
  const cached = projected.get(row);
  if (cached?.key === key) return cached.row;
  const next: StreamItem = { ...row, agentFold: fold };
  projected.set(row, { key, row: next });
  return next;
}

function isLine(row: StreamItem, input: FoldAgentMessagesInput): boolean {
  if (row.kind !== "user_message" || !row.sender) return false;
  const toggled = input.state.toggledIds.has(row.id);
  return input.display === "collapsed" ? !toggled : toggled;
}

/**
 * Collapsed, each received agent message draws as one line, and consecutive rows from the same
 * agent fold into one group row hosted by the first of them. Nothing moves: another agent's row
 * ends the group, because it can change how the agent handles the rows after it. A later group
 * from an agent that already has a row in the same run of agent rows reads as "more". Expanded
 * leaves the rows as sent. The reader's toggles flip single messages and open groups either way.
 */
export function foldAgentMessages(input: FoldAgentMessagesInput): AgentMessageFold {
  const { rows, display, state } = input;
  const output: StreamItem[] = [];
  const hostIdByHiddenRowId = new Map<string, string>();
  const hostIdByFoldedMessageId = new Map<string, string>();
  const line = (row: StreamItem) => withFold(row, { line: isLine(row, input), nested: false });
  // Agents with a row since the last row of the user's or the agent's own.
  const seenInRun = new Set<string>();

  let index = 0;
  while (index < rows.length) {
    const row = rows[index]!;
    const sender = agentSenderOf(row);
    if (!sender) {
      seenInRun.clear();
      output.push(row);
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < rows.length && agentSenderOf(rows[end]!)?.id === sender.id) end += 1;
    const members = rows.slice(index, end);
    index = end;
    const more = seenInRun.has(sender.id);
    seenInRun.add(sender.id);
    if (display === "expanded" || members.length === 1) {
      output.push(...members.map(line));
      continue;
    }
    const group: AgentMessageGroup = {
      hostId: row.id,
      memberIds: members.map((member) => member.id),
      sender,
      more,
      expanded: state.openGroupIds.has(row.id),
    };
    output.push(withFold(row, { line: isLine(row, input), nested: false, group }));
    for (const member of members.slice(1)) {
      if (group.expanded) {
        output.push(withFold(member, { line: isLine(member, input), nested: true }));
      } else {
        hostIdByHiddenRowId.set(member.id, row.id);
      }
    }
    if (!group.expanded) {
      for (const member of members) {
        hostIdByFoldedMessageId.set(getStreamItemMessageId(member), row.id);
      }
    }
  }

  return {
    rows:
      output.length === rows.length && output.every((row, i) => row === rows[i]) ? rows : output,
    hostIdByHiddenRowId: hostIdByHiddenRowId.size ? hostIdByHiddenRowId : EMPTY_HOSTS,
    hostIdByFoldedMessageId: hostIdByFoldedMessageId.size ? hostIdByFoldedMessageId : EMPTY_HOSTS,
  };
}

const AGENT_HEADER = /^\s*\[agent [^\]\n]*\]\s*/;

/** The first line of a message's own words: the `[agent … · role]` header and Markdown marks go. */
export function agentMessagePreview(text: string): string {
  const body = text.replace(AGENT_HEADER, "");
  const line = body.split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
  return line
    .replace(/^\s*(?:#{1,6}|>|[-*+]|\d+\.)\s+/, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
