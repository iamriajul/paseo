import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { AgentBringToFrontOverride } from "@/utils/attention-interrupt-plan";

/**
 * Per-agent "Bring Paseo to the front" overrides, kept on this device and keyed by host then agent.
 *
 * Device-local on purpose: the global switch they override (`attentionIntrusiveMode`) is a
 * device-local app setting, and bringing a window forward only exists on the desktop app. A phone
 * has no use for the value, and syncing it through the daemon's ui_state store would need a new
 * protocol namespace gated on a host feature.
 */
type OverridesByServer = Record<string, Record<string, AgentBringToFrontOverride>>;

interface AgentBringToFrontState {
  overrides: OverridesByServer;
  setOverride: (serverId: string, agentId: string, value: AgentBringToFrontOverride | null) => void;
}

export const useAgentBringToFrontStore = create<AgentBringToFrontState>()(
  persist(
    (set) => ({
      overrides: {},
      setOverride: (serverId, agentId, value) =>
        set((state) => {
          const { [agentId]: _previous, ...rest } = state.overrides[serverId] ?? {};
          const next = value ? { ...rest, [agentId]: value } : rest;
          const { [serverId]: _server, ...otherServers } = state.overrides;
          return {
            overrides:
              Object.keys(next).length > 0 ? { ...otherServers, [serverId]: next } : otherServers,
          };
        }),
    }),
    {
      name: "@paseo:agent-bring-to-front",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ overrides: state.overrides }),
    },
  ),
);

export function getAgentBringToFrontOverride(
  serverId: string,
  agentId: string,
): AgentBringToFrontOverride | null {
  return useAgentBringToFrontStore.getState().overrides[serverId]?.[agentId] ?? null;
}

export function useAgentBringToFrontOverride(
  serverId: string,
  agentId: string,
): AgentBringToFrontOverride | null {
  return useAgentBringToFrontStore((state) => state.overrides[serverId]?.[agentId] ?? null);
}
