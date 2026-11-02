import React, { type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Theme } from "@/styles/theme";

export type AgentRuntimeStatus = "running" | "stopped";

/** Undefined when the daemon does not report the agent's process, so no dot is shown. */
export function resolveAgentRuntimeStatus(
  runtimeActive: boolean | undefined,
): AgentRuntimeStatus | undefined {
  if (runtimeActive === undefined) return undefined;
  return runtimeActive ? "running" : "stopped";
}

function hint(status: AgentRuntimeStatus, providerLabel: string): string {
  return status === "running"
    ? `${providerLabel} is running. Its own timers and background tasks can still start a turn.`
    : `${providerLabel} is not running, so its own timers cannot wake it. Your next message starts it.`;
}

/** Green while the agent's process runs, hollow once it has stopped. */
export function RuntimeStatusDot({
  status,
  providerLabel,
}: {
  status: AgentRuntimeStatus;
  providerLabel: string;
}): ReactElement {
  const label = hint(status, providerLabel);
  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild triggerRefProp="ref">
        <View
          style={styles.hitArea}
          accessible
          accessibilityLabel={label}
          testID={`agent-runtime-status-${status}`}
        >
          <View style={status === "running" ? styles.running : styles.stopped} />
        </View>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{label}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const DOT_SIZE = 7;

const styles = StyleSheet.create((theme: Theme) => ({
  hitArea: {
    alignSelf: "center",
    paddingHorizontal: theme.spacing[1],
    paddingVertical: theme.spacing[2],
  },
  running: {
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: DOT_SIZE / 2,
    backgroundColor: theme.colors.statusSuccess,
  },
  stopped: {
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: DOT_SIZE / 2,
    borderWidth: 1.5,
    borderColor: theme.colors.foregroundMuted,
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.4,
  },
}));
