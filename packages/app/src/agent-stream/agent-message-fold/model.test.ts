import { describe, expect, it } from "vitest";
import type { StreamItem, ToolCallItem, UserMessageItem } from "@/types/stream";
import {
  agentMessagePreview,
  foldAgentMessages,
  type AgentMessageFoldState,
  type FoldAgentMessagesInput,
} from "./model";

const timestamp = new Date("2026-11-08T10:00:00.000Z");
const NONE: AgentMessageFoldState = { toggledIds: new Set(), openGroupIds: new Set() };

function received(id: string, senderId: string): UserMessageItem {
  return {
    kind: "user_message",
    id,
    text: `[agent ${senderId} · owner] Report ${id}`,
    timestamp,
    sender: { id: senderId, title: senderId.toUpperCase() },
  };
}

function finished(id: string, senderId: string): ToolCallItem {
  return {
    kind: "tool_call",
    id,
    timestamp,
    payload: {
      source: "agent",
      data: {
        provider: "claude",
        callId: id,
        name: "agent_message",
        status: "completed",
        error: null,
        detail: { type: "unknown", input: null, output: null },
        agentMessage: { event: "finished", sender: { id: senderId, title: senderId }, text: "" },
      },
    },
  };
}

function own(id: string, kind: "user_message" | "assistant_message" = "user_message"): StreamItem {
  return kind === "user_message"
    ? { kind, id, text: "From the user", timestamp }
    : { kind, id, text: "From the agent", timestamp };
}

function fold(rows: StreamItem[], overrides: Partial<FoldAgentMessagesInput> = {}) {
  return foldAgentMessages({ rows, display: "collapsed", state: NONE, ...overrides });
}

function shape(rows: StreamItem[]) {
  return rows.map((row) => {
    const rowFold =
      row.kind === "user_message" || row.kind === "tool_call" ? row.agentFold : undefined;
    if (!rowFold) return row.id;
    const group = rowFold.group
      ? ` group(${rowFold.group.sender.id}:${rowFold.group.memberIds.join(",")}${rowFold.group.more ? " more" : ""}${rowFold.group.expanded ? " open" : ""})`
      : "";
    return `${row.id}${rowFold.line ? " line" : ""}${rowFold.nested ? " nested" : ""}${group}`;
  });
}

describe("foldAgentMessages", () => {
  it("folds only consecutive rows from the same agent, in time order", () => {
    const rows = [
      own("prompt"),
      received("a1", "a"),
      received("a2", "a"),
      ...["b1", "b2", "b3", "b4", "b5"].map((id) => received(id, "b")),
      received("a3", "a"),
      received("a4", "a"),
      received("a5", "a"),
      received("c1", "c"),
      own("reply", "assistant_message"),
    ];
    const result = fold(rows);
    expect(shape(result.rows)).toEqual([
      "prompt",
      "a1 line group(a:a1,a2)",
      "b1 line group(b:b1,b2,b3,b4,b5)",
      "a3 line group(a:a3,a4,a5 more)",
      "c1 line",
      "reply",
    ]);
    expect(result.hostIdByHiddenRowId.get("a2")).toBe("a1");
    expect(result.hostIdByHiddenRowId.get("b5")).toBe("b1");
    expect(result.hostIdByHiddenRowId.get("a5")).toBe("a3");
    expect(result.hostIdByFoldedMessageId.get("a4")).toBe("a3");
  });

  it("keeps A, B, A as three rows and marks the second A group as more", () => {
    expect(
      shape(fold([received("a1", "a"), received("b1", "b"), received("a2", "a")]).rows),
    ).toEqual(["a1 line", "b1 line", "a2 line"]);
    const rows = [
      received("a1", "a"),
      received("b1", "b"),
      received("a2", "a"),
      received("a3", "a"),
    ];
    expect(shape(fold(rows).rows)).toEqual(["a1 line", "b1 line", "a2 line group(a:a2,a3 more)"]);
  });

  it("puts an agent's finished notice in that agent's group", () => {
    const rows = [received("a1", "a"), finished("a-done", "a"), received("b1", "b")];
    expect(shape(fold(rows).rows)).toEqual(["a1 line group(a:a1,a-done)", "b1 line"]);
  });

  it("lists an open group's rows after its host", () => {
    const rows = [
      received("a1", "a"),
      received("a2", "a"),
      received("b1", "b"),
      received("b2", "b"),
    ];
    const result = fold(rows, { state: { toggledIds: new Set(), openGroupIds: new Set(["a1"]) } });
    expect(shape(result.rows)).toEqual([
      "a1 line group(a:a1,a2 open)",
      "a2 line nested",
      "b1 line group(b:b1,b2)",
    ]);
    expect([...result.hostIdByHiddenRowId]).toEqual([["b2", "b1"]]);
  });

  it("starts a new run, without more, after the user's or the agent's own row", () => {
    const rows = [
      received("a1", "a"),
      received("a2", "a"),
      own("prompt"),
      received("a3", "a"),
      received("a4", "a"),
      own("reply", "assistant_message"),
      received("a5", "a"),
    ];
    expect(shape(fold(rows).rows)).toEqual([
      "a1 line group(a:a1,a2)",
      "prompt",
      "a3 line group(a:a3,a4)",
      "reply",
      "a5 line",
    ]);
  });

  it("leaves the rows as sent when expanded, with a toggled message as one line", () => {
    const rows = [received("a1", "a"), received("a2", "a"), received("b1", "b")];
    const result = fold(rows, {
      display: "expanded",
      state: { toggledIds: new Set(["b1"]), openGroupIds: new Set() },
    });
    expect(shape(result.rows)).toEqual(["a1", "a2", "b1 line"]);
    expect(result.hostIdByHiddenRowId.size).toBe(0);
  });

  it("opens a toggled message in full when collapsed", () => {
    const toggled = { toggledIds: new Set(["a1"]), openGroupIds: new Set<string>() };
    expect(shape(fold([received("a1", "a")], { state: toggled }).rows)).toEqual(["a1"]);
  });

  it("keeps a row's identity while its fold is unchanged, and changes it when the fold does", () => {
    const rows = [received("a1", "a"), received("a2", "a"), own("prompt")];
    const first = fold(rows);
    expect(fold(rows).rows[0]).toBe(first.rows[0]);
    expect(first.rows[1]).toBe(rows[2]);
    const opened = fold(rows, { state: { toggledIds: new Set(), openGroupIds: new Set(["a1"]) } });
    expect(opened.rows[0]).not.toBe(first.rows[0]);
  });

  it("returns the source rows when nothing came from another agent", () => {
    const rows = [own("prompt"), own("reply", "assistant_message")];
    expect(fold(rows).rows).toBe(rows);
  });
});

describe("agentMessagePreview", () => {
  it("drops the agent header and Markdown marks and keeps the first line", () => {
    expect(agentMessagePreview("[agent abc · owner]\n\n## **Merged** the `fix`\nMore detail")).toBe(
      "Merged the fix",
    );
  });

  it("keeps a leading issue number", () => {
    expect(agentMessagePreview("#1116 is fixed")).toBe("#1116 is fixed");
  });
});
