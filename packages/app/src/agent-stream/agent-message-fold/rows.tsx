import { memo, useCallback, useMemo, useState, type ComponentType } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ChevronsDownUp, ChevronsUpDown } from "lucide-react-native";
import type { AgentMessage } from "@getpaseo/protocol/agent-message";
import { PressHighlight } from "@/components/ui/press-highlight";
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

type IconComponent = ComponentType<{ size?: number; color?: string }>;

/**
 * The folded form of what another agent sent: one line in the shape of the message bubble, on
 * the bubble's side, so it reads as a message to this agent rather than as one of its own tool
 * rows. The sender leads in full color; what it said, or how many messages, follows muted.
 */
function AgentMessageChip({
  testID,
  icon: Icon,
  sender,
  detail,
  trailing,
  expanded,
  accessibilityLabel,
  onPress,
}: {
  testID: string;
  icon: IconComponent;
  sender: string;
  detail: string;
  trailing?: string;
  expanded: boolean;
  accessibilityLabel: string;
  onPress: () => void;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const hoverIn = useCallback(() => setIsHovered(true), []);
  const hoverOut = useCallback(() => setIsHovered(false), []);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const Chevron = expanded ? ChevronsDownUp : ChevronsUpDown;
  const iconColor = styles.icon.color;
  return (
    <View style={styles.row}>
      <PressHighlight
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={accessibilityState}
        onPress={onPress}
        onHoverIn={hoverIn}
        onHoverOut={hoverOut}
        style={[styles.chip, isHovered && styles.chipHovered]}
        highlightStyle={styles.chipHovered}
      >
        <View style={styles.glyph}>
          <Icon size={14} color={iconColor} />
        </View>
        <Text style={styles.sender} numberOfLines={1}>
          {sender}
        </Text>
        <Text style={styles.detail} numberOfLines={1}>
          {detail}
        </Text>
        {trailing ? <Text style={styles.time}>{trailing}</Text> : null}
        <View style={styles.glyph}>
          <Chevron size={14} color={iconColor} />
        </View>
      </PressHighlight>
    </View>
  );
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
  const icon = useProviderIcon(agent.provider, agent.host) as IconComponent;
  const preview = useMemo(() => agentMessagePreview(text), [text]);
  const time = useMemo(() => formatMessageTimestamp(new Date(timestamp)), [timestamp]);
  const toggle = useCallback(() => onToggle(id), [id, onToggle]);
  // A phone row keeps its width for the preview; the time shows once the message opens.
  const isCompact = useIsCompactFormFactor();
  const name = senderTitle(sender, agent.title);
  return (
    <AgentMessageChip
      testID="agent-message-line"
      icon={icon}
      sender={name}
      detail={preview}
      trailing={isCompact ? undefined : time}
      expanded={false}
      accessibilityLabel={`${name}: ${preview}`}
      onPress={toggle}
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
  const icon = useProviderIcon(agent.provider, agent.host) as IconComponent;
  const count = t(group.more ? "agentMessages.group.countMore" : "agentMessages.group.count", {
    count: group.memberIds.length,
  });
  const toggle = useCallback(() => onToggle(group.hostId), [group.hostId, onToggle]);
  const name = senderTitle(group.sender, agent.title);
  return (
    <AgentMessageChip
      testID="agent-message-group"
      icon={icon}
      sender={name}
      detail={`· ${count}`}
      expanded={group.expanded}
      accessibilityLabel={`${name} · ${count}`}
      onPress={toggle}
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    justifyContent: "flex-end",
    marginVertical: theme.spacing[1],
  },
  // The user bubble's fill and corners, one line tall.
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    maxWidth: "100%",
    minWidth: 0,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface3,
    borderRadius: theme.borderRadius["2xl"],
    borderTopRightRadius: theme.borderRadius.sm,
  },
  chipHovered: {
    backgroundColor: theme.colors.surface4,
  },
  icon: {
    color: theme.colors.foregroundMuted,
  },
  // On a phone the line is full; the icon and chevron keep their size while the text truncates.
  glyph: {
    flexShrink: 0,
  },
  // The sender names the message, so it keeps its full name up to half the line; a longer name
  // truncates there and leaves the rest to what it said.
  sender: {
    flexShrink: 0,
    maxWidth: "50%",
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  detail: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  time: {
    flexShrink: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));
