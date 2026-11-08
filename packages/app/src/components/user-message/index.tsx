import { useState, useCallback, useMemo, type ReactNode } from "react";
import { View, type LayoutChangeEvent, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { AgentMessage } from "@getpaseo/protocol/agent-message";
import { ChevronsDownUp } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { EdgeFade } from "@/components/ui/edge-fade";
import { useProviderIcon } from "@/components/provider-icons";
import { useSessionStore } from "@/stores/session-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { isNative } from "@/constants/platform";

const PREVIEW_HEIGHT = 240;
// Native View still clips with "scroll", but Yoga measures its children without
// the height cap. "hidden" caps the measured body too, hiding the expand control.
const previewStyle: ViewStyle = {
  maxHeight: PREVIEW_HEIGHT,
  overflow: isNative ? "scroll" : "hidden",
};

export function MessagePreview({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const measure = useCallback(
    (event: LayoutChangeEvent) => setOverflowing(event.nativeEvent.layout.height > PREVIEW_HEIGHT),
    [],
  );
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  return (
    <>
      <View style={!expanded && previewStyle}>
        <View style={styles.body} onLayout={measure}>
          {children}
        </View>
        {overflowing && !expanded ? (
          <EdgeFade edge="bottom" solidFraction={0} backdrop="surface3" style={styles.fade} />
        ) : null}
      </View>
      {overflowing ? (
        <Button
          variant="ghost"
          size="sm"
          style={[styles.toggle, expanded && styles.expandedToggle]}
          accessibilityState={accessibilityState}
          onPress={toggle}
        >
          {t(expanded ? "turnSummary.showLess" : "turnSummary.showMore")}
        </Button>
      ) : null}
    </>
  );
}

export function MessageSender({
  sender,
  serverId,
  onCollapse,
}: {
  sender: AgentMessage["sender"];
  serverId?: string;
  /** Folds the message back to one line; shown as a chevron after the sender. */
  onCollapse?: () => void;
}) {
  const { t } = useTranslation();
  const host = sender.serverId ?? serverId;
  const agent = useSessionStore((state) => {
    const session = host ? state.sessions[host] : undefined;
    return session?.agents.get(sender.id) ?? session?.agentDetails.get(sender.id);
  });
  const ProviderIcon = useProviderIcon(agent?.provider ?? "", host);
  const renderProviderIcon = useCallback(
    (color: string) => <ProviderIcon size={16} color={color} />,
    [ProviderIcon],
  );
  const openSender = useCallback(() => {
    if (host) navigateToAgent({ serverId: host, agentId: sender.id });
  }, [host, sender.id]);
  const senderButton = (
    <Button
      variant="ghost"
      size="sm"
      leftIcon={renderProviderIcon}
      style={styles.sender}
      textStyle={styles.senderText}
      numberOfLines={1}
      disabled={!host}
      onPress={openSender}
    >
      {t("turnSummary.sentBy", { name: agent?.title ?? sender.title ?? sender.id })}
    </Button>
  );
  if (!onCollapse) return senderButton;
  return (
    <View style={styles.senderRow}>
      {senderButton}
      <Button
        variant="ghost"
        size="sm"
        leftIcon={ChevronsDownUp}
        style={styles.collapse}
        accessibilityLabel={t("agentMessages.collapseOne")}
        testID="agent-message-collapse"
        onPress={onCollapse}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { flexShrink: 0 },
  // minWidth 0 lets a long sender truncate inside the row instead of pushing its collapse chevron out.
  sender: { paddingRight: 0, borderRightWidth: 0, maxWidth: "100%", flexShrink: 1, minWidth: 0 },
  senderText: { flexShrink: 1 },
  senderRow: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-end",
    maxWidth: "100%",
  },
  collapse: { paddingHorizontal: theme.spacing[1], borderWidth: 0 },
  toggle: { alignSelf: "flex-start", paddingHorizontal: 0, minHeight: 0, borderWidth: 0 },
  expandedToggle: { marginTop: theme.spacing[2] },
  fade: { position: "absolute", bottom: 0, left: 0, right: 0, height: theme.spacing[12] },
}));
