import type { CanUseTool, HookCallback, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";

/**
 * What a side question may call. Everything else is denied at call time, never removed from the
 * tool list: removing a tool changes the tool definitions at the front of the prompt and the
 * whole prompt cache is written again. See docs/quotes-and-side-questions.md, "Read-only is
 * enforced by the daemon".
 */
export const SIDE_QUESTION_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Grep",
  "Glob",
  "WebFetch",
  "WebSearch",
  "ToolSearch",
]);

export const SIDE_QUESTION_DENY_MESSAGE = "Side questions are read-only.";

export function isSideQuestionToolAllowed(toolName: unknown): boolean {
  return typeof toolName === "string" && SIDE_QUESTION_ALLOWED_TOOLS.has(toolName);
}

/**
 * First layer. A hook runs before permission rules, so `bypassPermissions` and a user's
 * `permissions.allow` entries cannot let a tool through it. A hook input it cannot read has no
 * tool name on the allowlist and is denied.
 */
export const sideQuestionPreToolUseHook: HookCallback = async (
  hookInput,
): Promise<HookJSONOutput> => {
  const toolName =
    hookInput && typeof hookInput === "object"
      ? (hookInput as { tool_name?: unknown }).tool_name
      : undefined;
  if (isSideQuestionToolAllowed(toolName)) return {};
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: SIDE_QUESTION_DENY_MESSAGE,
    },
  };
};

/**
 * Second layer. An allowed tool goes on to `inner`, the session's normal permission flow, so a
 * read outside the project still asks.
 */
export function createSideQuestionCanUseTool(inner: CanUseTool): CanUseTool {
  return async (toolName, input, options) => {
    if (!isSideQuestionToolAllowed(toolName)) {
      return { behavior: "deny", message: SIDE_QUESTION_DENY_MESSAGE };
    }
    return inner(toolName, input, options);
  };
}
