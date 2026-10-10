import { useMemo } from "react";
import { withUnistyles } from "react-native-unistyles";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import { useProviderIcon } from "@/components/provider-icons";
import type { CommandCenterIcon, CommandCenterIconProps } from "./contributions";

const commandCenterProviderIcons = new Map<AgentProvider, CommandCenterIcon>();

export function getCommandCenterProviderIcon(provider: AgentProvider): CommandCenterIcon {
  const cached = commandCenterProviderIcons.get(provider);
  if (cached) return cached;

  function CommandCenterProviderIcon({ size }: CommandCenterIconProps) {
    const Icon = useProviderIcon(provider);
    const ProviderIcon = useMemo(
      () =>
        withUnistyles(Icon, (theme) => ({
          color: theme.colors.foregroundMuted,
        })),
      [Icon],
    );
    return <ProviderIcon size={size} />;
  }
  commandCenterProviderIcons.set(provider, CommandCenterProviderIcon);
  return CommandCenterProviderIcon;
}
