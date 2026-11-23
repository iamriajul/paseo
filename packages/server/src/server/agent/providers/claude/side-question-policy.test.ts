import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, test, vi } from "vitest";
import {
  createSideQuestionCanUseTool,
  isSideQuestionToolAllowed,
  SIDE_QUESTION_DENY_MESSAGE,
  sideQuestionPreToolUseHook,
} from "./side-question-policy.js";

const hookSignal = { signal: new AbortController().signal };

async function runHook(toolName: unknown) {
  return sideQuestionPreToolUseHook(
    { hook_event_name: "PreToolUse", tool_name: toolName, tool_input: {} } as never,
    "tool-use-id",
    hookSignal,
  );
}

describe("side question PreToolUse hook", () => {
  test.each(["Read", "Grep", "Glob", "WebFetch", "WebSearch", "ToolSearch"])(
    "lets %s through",
    async (tool) => {
      expect(await runHook(tool)).toEqual({});
    },
  );

  test.each([
    "Bash",
    "PowerShell",
    "Edit",
    "Write",
    "NotebookEdit",
    "Agent",
    "Task",
    "Skill",
    "TodoWrite",
    "ExitPlanMode",
    "mcp__paseo__create_agent",
    "mcp__anything__read_file",
    "SomeToolAddedLater",
  ])("denies %s with the read-only reason", async (tool) => {
    expect(await runHook(tool)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: SIDE_QUESTION_DENY_MESSAGE,
      },
    });
  });

  test("denies a hook input it cannot read", async () => {
    expect(await runHook(undefined)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    const output = await sideQuestionPreToolUseHook(null as never, undefined, hookSignal);
    expect(output).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });
});

describe("side question canUseTool", () => {
  const options = {
    signal: new AbortController().signal,
    toolUseID: "t1",
  } as Parameters<CanUseTool>[2];

  test("denies a tool that is not on the allowlist without asking the session", async () => {
    const inner = vi.fn<CanUseTool>();
    const canUseTool = createSideQuestionCanUseTool(inner);
    expect(await canUseTool("Bash", { command: "rm -rf /" }, options)).toEqual({
      behavior: "deny",
      message: SIDE_QUESTION_DENY_MESSAGE,
    });
    expect(inner).not.toHaveBeenCalled();
  });

  test("hands an allowed tool to the session's own permission flow", async () => {
    const inner = vi.fn<CanUseTool>(async () => ({ behavior: "allow", updatedInput: {} }));
    const canUseTool = createSideQuestionCanUseTool(inner);
    expect(await canUseTool("Read", { file_path: "/x" }, options)).toEqual({
      behavior: "allow",
      updatedInput: {},
    });
    expect(inner).toHaveBeenCalledOnce();
  });

  test("allowlist is exactly the six read tools", () => {
    expect(
      ["Read", "Grep", "Glob", "WebFetch", "WebSearch", "ToolSearch"].every(
        isSideQuestionToolAllowed,
      ),
    ).toBe(true);
    expect(isSideQuestionToolAllowed("Bash")).toBe(false);
    expect(isSideQuestionToolAllowed("read")).toBe(false);
  });
});
