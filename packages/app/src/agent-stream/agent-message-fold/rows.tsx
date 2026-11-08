import { memo, useCallback, useMemo, type ComponentType } from "react";
import { Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { MessagesSquare } from "lucide-react-native";
import type { AgentMessage } from "@getpaseo/protocol/agent-message";
import { ExpandableBadge } from "@/components/message";
import { useProviderIcon } from "@/components/provider-icons";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useSessionStore } from "@/stores/session-store";
import { formatMessageTimestamp } from "@/utils/time";
import type { AgentMessageGroup } from "@/types/stream";
import { agentMessagePreview } from "./model";

type Sender = AgentMessage["sender"];

function findAgent(
  state: ReturnType<typeof useSessionStore.getState>,
  host: string | undefined,
  id: string,
) {
  const session = host ? state.sessions[host] : undefined;
  return session?.agents.get(id) ?? session?.agentDetails.get(id);
}

/** Selects primitives, so an unrelated agent update does not re-render the row. */
function useSenderAgent(sender: Sender, serverId: string | undefined) {
  const host = sender.serverId ?? serverId;
  const title = useSessionStore((state) => findAgent(state, host, sender.id)?.title ?? null);
  const provider = useSessionStore((state) => findAgent(state, host, sender.id)?.provider ?? "");
  return { title, provider, host };
}

function senderTitle(sender: Sender, agentTitle: string | null | undefined): string {
  return agentTitle ?? sender.title ?? sender.id;
}

/**
 * A received agent message folded to one line: the sender, the first line of what it said, and
 * when. Pressing it opens the full message in place.
 */
export const AgentMessageLine = memo(function AgentMessageLine({
  id,
  sender,
  text,
  timestamp,
  serverId,
  onToggle,
}: {
  id: string;
  sender: Sender;
  text: string;
  timestamp: number;
  serverId: string | undefined;
  onToggle: (id: string) => void;
}) {
  const agent = useSenderAgent(sender, serverId);
  const ProviderIcon = useProviderIcon(agent.provider, agent.host);
  const icon = ProviderIcon as ComponentType<{ size?: number; color?: string }>;
  const preview = useMemo(() => agentMessagePreview(text), [text]);
  const time = useMemo(() => formatMessageTimestamp(new Date(timestamp)), [timestamp]);
  const toggle = useCallback(() => onToggle(id), [id, onToggle]);
  // A phone row keeps its width for the preview; the time shows once the message opens.
  const isCompact = useIsCompactFormFactor();
  const renderTrailing = useCallback(() => <Text style={styles.time}>{time}</Text>, [time]);
  return (
    <ExpandableBadge
      testID="agent-message-line"
      label={senderTitle(sender, agent.title)}
      secondaryLabel={preview}
      icon={icon}
      isExpanded={false}
      onToggle={toggle}
      renderTrailing={isCompact ? undefined : renderTrailing}
    />
  );
});

/**
 * Consecutive rows from one agent folded into one line, "Mautic owner · 3 messages", or "3 more
 * messages" after the agent's earlier row in the run; pressing it lists them below.
 */
export const AgentMessageGroupLine = memo(function AgentMessageGroupLine({
  group,
  serverId,
  onToggle,
}: {
  group: AgentMessageGroup;
  serverId: string | undefined;
  onToggle: (hostId: string) => void;
}) {
  const { t } = useTranslation();
  const agent = useSenderAgent(group.sender, serverId);
  const count = t(group.more ? "agentMessages.group.countMore" : "agentMessages.group.count", {
    count: group.memberIds.length,
  });
  const toggle = useCallback(() => onToggle(group.hostId), [group.hostId, onToggle]);
  return (
    <ExpandableBadge
      testID="agent-message-group"
      label={senderTitle(group.sender, agent.title)}
      secondaryLabel={`· ${count}`}
      icon={MessagesSquare}
      isExpanded={group.expanded}
      onToggle={toggle}
      borderlessWhenExpanded
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  time: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    marginLeft: theme.spacing[2],
  },
}));
