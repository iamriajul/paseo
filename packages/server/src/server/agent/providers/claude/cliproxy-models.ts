// cliproxy-models.ts — decode mirrors CLIProxyAPI internal/util/claude_model.go
export const CLAUDE_DD_MODEL_PREFIX = "claude-fable-5-dd-";

const OFFICIAL_CPA_OWNERS = new Set([
  "anthropic",
  "openai",
  "codex",
  "xai",
  "x-ai",
  "grok",
  "gemini",
  "google",
  "vertex",
  "aistudio",
  "antigravity",
  "kimi",
  "moonshot",
]);

export function decodeCliproxyClaudeModelId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) return trimmed;

  const match = /^(.*)\(([^()]*)\)$/.exec(trimmed);
  const base = match?.[1] ?? trimmed;
  const suffix = match ? `(${match[2]})` : "";

  if (!base.startsWith(CLAUDE_DD_MODEL_PREFIX)) return trimmed;
  const encoded = base.slice(CLAUDE_DD_MODEL_PREFIX.length);
  if (!encoded) return trimmed;
  return [...encoded].toReversed().join("") + suffix;
}

export function isOfficialCpaOwner(ownedBy: string | null | undefined): boolean {
  if (typeof ownedBy !== "string") return false;
  return OFFICIAL_CPA_OWNERS.has(ownedBy.trim().toLowerCase());
}

export function isCliproxyNonChatModel(options: { id: string; displayName?: string }): boolean {
  const haystack = `${options.id} ${options.displayName ?? ""}`.toLowerCase();
  return (
    haystack.includes("image") ||
    haystack.includes("video") ||
    haystack.includes("gpt-image") ||
    haystack.includes("grok-imagine")
  );
}
