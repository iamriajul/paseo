import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { formatTokenCount } from "@/components/context-window-meter.utils";
import { useSessionStore } from "@/stores/session-store";

/**
 * What one answer did to the prompt cache, from the daemon's request journal: the tokens its
 * requests read and wrote. Null while the journal has no request in the turn's span.
 */
export function useSideQuestionTurnUsage(input: {
  serverId: string;
  agentId: string;
  startedAtMs: number | undefined;
  completedAtMs: number | undefined;
}): string | null {
  const { t } = useTranslation();
  const history = useSessionStore(
    (state) => state.sessions[input.serverId]?.agents.get(input.agentId)?.promptCache?.history,
  );
  return useMemo(() => {
    const { startedAtMs, completedAtMs } = input;
    if (!history || startedAtMs === undefined || completedAtMs === undefined) return null;
    let read = 0;
    let written = 0;
    let seen = false;
    for (const entry of history) {
      const at = Date.parse(entry.at);
      // A request lands a little before the turn's recorded end, and a little after its start.
      if (at >= startedAtMs - 5_000 && at <= completedAtMs + 5_000) {
        read += entry.readTokens;
        written += entry.writeTokens;
        seen = true;
      }
    }
    if (!seen) return null;
    return t("sideQuestion.usage", {
      read: formatTokenCount(read),
      written: formatTokenCount(written),
    });
  }, [history, input, t]);
}
