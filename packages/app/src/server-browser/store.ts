import { create } from "zustand";
import type {
  ServerBrowserStatus,
  ServerBrowserTab,
} from "@getpaseo/protocol/server-browser/rpc-schemas";

export type { ServerBrowserStatus, ServerBrowserTab };

interface ServerBrowserHostState {
  tabs: ServerBrowserTab[];
  status: ServerBrowserStatus;
}

interface ServerBrowserStore {
  hosts: Record<string, ServerBrowserHostState>;
  setHost(serverId: string, state: ServerBrowserHostState): void;
  clearHost(serverId: string): void;
}

/** Server browser tabs and status per host, fed by useServerBrowserSync. */
export const useServerBrowserStore = create<ServerBrowserStore>((set) => ({
  hosts: {},
  setHost: (serverId, state) => set((store) => ({ hosts: { ...store.hosts, [serverId]: state } })),
  clearHost: (serverId) =>
    set((store) => {
      const { [serverId]: _removed, ...hosts } = store.hosts;
      return { hosts };
    }),
}));

export function useServerBrowserTab(serverId: string, browserId: string): ServerBrowserTab | null {
  return useServerBrowserStore(
    (store) => store.hosts[serverId]?.tabs.find((tab) => tab.browserId === browserId) ?? null,
  );
}

/** True when the host runs the server browser and its switch is on. */
export function useServerBrowserEnabled(serverId: string): boolean {
  return useServerBrowserStore((store) => store.hosts[serverId]?.status.enabled === true);
}

export function useServerBrowserStatus(serverId: string): ServerBrowserStatus | null {
  return useServerBrowserStore((store) => store.hosts[serverId]?.status ?? null);
}

export function isServerBrowserEnabled(serverId: string): boolean {
  return useServerBrowserStore.getState().hosts[serverId]?.status.enabled === true;
}
