import type { AgentPromptCacheState } from "@getpaseo/protocol/agent-cache-warm";
import type { Agent } from "@/stores/session-store";

export type AgentDirectoryEntry = Pick<
  Agent,
  | "id"
  | "serverId"
  | "title"
  | "status"
  | "turn"
  | "lastActivityAt"
  | "cwd"
  | "workspaceId"
  | "provider"
  | "requiresAttention"
  | "attentionReason"
  | "attentionTimestamp"
  | "archivedAt"
  | "createdAt"
  | "labels"
  | "projectPlacement"
> & {
  pendingPermissionCount?: number;
  /** Set while warm-up has closed a question the user left unanswered, until they write. */
  questionClosedAt?: string | null;
  /** Set while warm-up has closed a permission the user left unanswered, until they write. */
  permissionClosedAt?: string | null;
};

/** What warm-up closed while the user was away, for the session list's badges. */
export function readWarmUpClosings(promptCache: AgentPromptCacheState | undefined): {
  questionClosedAt: string | null;
  permissionClosedAt: string | null;
} {
  return {
    questionClosedAt: promptCache?.questionClosedAt ?? null,
    permissionClosedAt: promptCache?.permissionClosed?.at ?? null,
  };
}
