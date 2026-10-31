import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/shallow";
import { useProviderIcon } from "@/components/provider-icons";
import type { PanelDescriptor } from "@/panels/panel-registry";
import { useSessionStore, selectAgentTurnPresentation, type Agent } from "@/stores/session-store";
import { useIsRateLimitCooldownActive } from "@/rate-limit-cooldown/use-rate-limit-cooldown";
import { deriveSidebarStateBucket } from "@/utils/sidebar-agent-state";

function formatProviderLabel(provider: Agent["provider"]): string {
  if (!provider) {
    return "Agent";
  }
  return provider
    .split(/[-_\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function resolveAgentLabel(title: string | null | undefined): string | null {
  if (typeof title !== "string") {
    return null;
  }
  const normalized = title.trim();
  if (!normalized) {
    return null;
  }
  if (normalized.toLowerCase() === "new agent") {
    return null;
  }
  return normalized;
}

export function useAgentDescriptor(
  target: { kind: "agent"; agentId: string },
  context: { serverId: string },
): PanelDescriptor {
  const descriptorState = useSessionStore(
    useShallow((state) => {
      const session = state.sessions[context.serverId];
      const agent =
        session?.agents?.get(target.agentId) ?? session?.agentDetails?.get(target.agentId) ?? null;
      return {
        provider: agent?.provider ?? "codex",
        title: agent?.title ?? null,
        status: agent?.status ?? null,
        pendingPermissionCount: agent?.pendingPermissions.length ?? 0,
        requiresAttention: agent?.requiresAttention ?? false,
        attentionReason: agent?.attentionReason ?? null,
        isTurnActive: selectAgentTurnPresentation(session, target.agentId).isActive,
      };
    }),
  );
  const rateLimitCooldown = useSessionStore((state) => {
    const session = state.sessions[context.serverId];
    const agent =
      session?.agents?.get(target.agentId) ?? session?.agentDetails?.get(target.agentId);
    return agent?.rateLimitCooldown ?? null;
  });
  const { t } = useTranslation();
  const icon = useProviderIcon(descriptorState.provider, context.serverId);
  const isCooldown = useIsRateLimitCooldownActive(rateLimitCooldown);
  return buildAgentDescriptor({
    ...descriptorState,
    icon,
    cooldownTitle: isCooldown ? t("rateLimitCooldown.title") : null,
  });
}

export function buildAgentDescriptor(input: {
  provider: Agent["provider"];
  title: string | null;
  status: Agent["status"] | null;
  pendingPermissionCount: number;
  requiresAttention: boolean;
  attentionReason: Agent["attentionReason"];
  isTurnActive: boolean;
  icon: PanelDescriptor["icon"];
  /** Set while a rate-limit cooldown is active; the tab reads as waiting on the cooldown. */
  cooldownTitle?: string | null;
}): PanelDescriptor {
  const provider = input.provider;
  const label = resolveAgentLabel(input.title);
  const providerLabel = formatProviderLabel(provider);
  const cooldownTitle = input.cooldownTitle ?? null;

  return {
    label: label ?? "",
    subtitle: cooldownTitle ?? `${providerLabel} agent`,
    tooltip: cooldownTitle
      ? `${label ?? providerLabel} · ${cooldownTitle}`
      : (label ?? `${providerLabel} agent`),
    titleState: label ? "ready" : "loading",
    icon: input.icon,
    statusBucket: input.status
      ? deriveSidebarStateBucket({
          status: input.isTurnActive ? "running" : input.status,
          pendingPermissionCount: input.pendingPermissionCount,
          requiresAttention: input.requiresAttention || cooldownTitle !== null,
          attentionReason: cooldownTitle ? null : input.attentionReason,
        })
      : null,
  };
}
