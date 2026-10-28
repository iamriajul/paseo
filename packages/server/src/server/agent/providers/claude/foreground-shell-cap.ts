import { FOREGROUND_SHELL_CAP_MS, type PromptCacheTtl } from "@getpaseo/protocol/agent-cache-warm";
import type { HookCallback, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";

/**
 * Claude Code's own default for a shell call that names no timeout. Bash and PowerShell both
 * read BASH_DEFAULT_TIMEOUT_MS. Paseo pins it in the flag settings layer, which outranks user,
 * project and local settings, because the cap hook cannot see the default a call without a
 * timeout will get.
 */
export const CLAUDE_BASH_DEFAULT_TIMEOUT_MS = 120_000;

/** Claude Code's shell tools; both take `timeout` and `run_in_background`. */
export const CAPPED_SHELL_TOOLS = ["Bash", "PowerShell"] as const;
export const CAPPED_SHELL_TOOL_MATCHER = CAPPED_SHELL_TOOLS.join("|");

const TTL_LABELS: Record<PromptCacheTtl, string> = { "5m": "5 minutes", "1h": "1 hour" };

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function isCappedShellTool(name: unknown): name is (typeof CAPPED_SHELL_TOOLS)[number] {
  return CAPPED_SHELL_TOOLS.some((tool) => tool === name);
}

function deny(reason: string): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

/**
 * Denies a foreground shell call whose timeout outlasts the session's prompt cache, so the
 * cache cannot expire unseen while the agent waits. Background calls stay uncapped. A deny,
 * not a clamp: Claude Code shortens a requested timeout silently, and a call that reaches its
 * timeout is moved to the background or stopped, so the model never sees a refusal naming the
 * cap. Input the hook cannot read is denied too, since an unread timeout is an unchecked one.
 */
export function decideForegroundShellCap(input: {
  hookInput: unknown;
  ttl: PromptCacheTtl;
}): HookJSONOutput {
  const hookInput = readRecord(input.hookInput);
  const toolName = hookInput?.tool_name;
  if (!isCappedShellTool(toolName)) return {};
  const toolInput = readRecord(hookInput?.tool_input);
  if (!toolInput) {
    return deny(
      `Paseo could not read this ${toolName} call's input, so it cannot check the timeout cap. Retry the call.`,
    );
  }
  if (toolInput.run_in_background === true) return {};
  const capMs = FOREGROUND_SHELL_CAP_MS[input.ttl];
  const timeout = toolInput.timeout;
  if (timeout === undefined) return {};
  if (typeof timeout !== "number" || !Number.isFinite(timeout)) {
    return deny(
      `The ${toolName} timeout must be a number of milliseconds, at most ${capMs} for a ` +
        `foreground call in this session. Retry with a numeric timeout, or set run_in_background: true.`,
    );
  }
  if (timeout <= capMs) return {};
  return deny(
    `Foreground ${toolName} calls are capped at ${capMs} ms in this session: its prompt cache ` +
      `expires ${TTL_LABELS[input.ttl]} after the last request, and nothing refreshes it while a ` +
      `command blocks. Retry with a timeout of at most ${capMs}, or set run_in_background: ` +
      `true for longer work and read its output when it finishes.`,
  );
}

export function createForegroundShellCapHook(resolveTtl: () => PromptCacheTtl): HookCallback {
  return async (hookInput) => decideForegroundShellCap({ hookInput, ttl: resolveTtl() });
}
