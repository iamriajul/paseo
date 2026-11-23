import { getSideQuestionSourceId } from "@getpaseo/protocol/agent-labels";
import type { SideQuestionCacheEstimate } from "@getpaseo/protocol/messages";
import type { Agent } from "@/stores/session-store";

export { getSideQuestionSourceId };

/** Where a side question forked, as the daemon stamped it on the agent's labels. */
export const SIDE_QUESTION_POINT_LABEL = "paseo.side-question-point";

export type SideQuestionPoint = "latest" | "earlier";

export function readSideQuestionPoint(
  labels: Record<string, string> | undefined,
): SideQuestionPoint {
  return labels?.[SIDE_QUESTION_POINT_LABEL] === "earlier" ? "earlier" : "latest";
}

/**
 * Whether a chat can open a side question. The daemon forks only Claude sessions for one, since
 * the read-only enforcement is a Claude Code hook; Codex can native-fork, but not into a side
 * question.
 */
export function canAskSideQuestions(
  agent: Pick<Agent, "provider" | "capabilities" | "labels"> | undefined,
): boolean {
  return (
    agent?.provider === "claude" &&
    agent.capabilities?.supportsNativeFork === true &&
    getSideQuestionSourceId(agent.labels) === null
  );
}

/** The live, unarchived side questions of one chat, in the order they were asked. */
export function selectSideQuestionsOf(
  agents: ReadonlyMap<string, Agent> | undefined,
  sourceAgentId: string,
): Agent[] {
  if (!agents) return [];
  const rows: Agent[] = [];
  for (const agent of agents.values()) {
    if (!agent.archivedAt && getSideQuestionSourceId(agent.labels) === sourceAgentId) {
      rows.push(agent);
    }
  }
  return rows.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
}

/** What the line under a side question's composer says, and what its send button reads. */
export type SideQuestionCostLine =
  | { kind: "none"; confirm: false }
  | { kind: "warm"; tokens: number; confirm: false }
  | { kind: "expired"; tokens: number; expiredAgoMs: number; confirm: true }
  | { kind: "earlier_expired"; tokens: number; confirm: true };

export function describeSideQuestionCost(
  estimate: SideQuestionCacheEstimate | null | undefined,
): SideQuestionCostLine {
  if (!estimate || estimate.state === "unknown" || estimate.tokens === null) {
    return { kind: "none", confirm: false };
  }
  if (estimate.state === "warm") {
    return { kind: "warm", tokens: estimate.tokens, confirm: false };
  }
  if (estimate.point === "earlier") {
    return { kind: "earlier_expired", tokens: estimate.tokens, confirm: true };
  }
  return {
    kind: "expired",
    tokens: estimate.tokens,
    expiredAgoMs: estimate.expiredAgoMs ?? 0,
    confirm: true,
  };
}

export function minutesAgo(ms: number): number {
  return Math.max(1, Math.round(ms / 60_000));
}

/** `/btw <question>` typed in the composer asks a side question instead of messaging the agent. */
export function parseBtwCommand(text: string): { question: string } | null {
  const match = /^\/btw(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  return { question: (match[1] ?? "").trim() };
}
